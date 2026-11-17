/**
 * The console's routes that are not a sign-in form: password-reset links,
 * single sign-on through an OpenID Connect provider, and the two downloads
 * (a server backup, a project export) that are files rather than JSON.
 *
 * OIDC is the authorization-code flow with PKCE. The id_token is checked here:
 * its signature against the provider's published keys (RS256, PS256 or
 * ES256, with node's own crypto), its issuer, audience, expiry and the nonce
 * this server sent. A provider's yes is trusted as the whole sign-in, so an
 * account's own second step is not asked for again on this path.
 */
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";

import { backupPath, exportProject } from "../backup.js";
import { recordDecision } from "../identity/audit.js";
import { describeRefusal } from "../identity/bearer.js";
import { defaultPasswordHasher } from "../identity/passwords.js";
import { OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, OIDC_LABEL, PUBLIC_URL, readPolicy } from "../identity/policy.js";
import { resetTarget, usePasswordReset } from "../identity/resets.js";
import { externalAccount } from "../identity/sso.js";
import { totpEnabled, twoFactorRequired } from "../identity/totp.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import {
  createWebSession,
  describeWebSessionRefusal,
  identifyWebSession,
  sessionCookieHeader,
  webSessionCookie,
} from "../identity/websessions.js";
import { projectRole } from "../projects/members.js";
import { findProject } from "../projects/registry.js";
import type { TeamService } from "../team/service.js";
import { sameOrigin } from "./origin.js";
import { answering, onlyMethods, readJson, refuse, sendJson } from "./studio.js";

const API_PREFIX = "/api/console/v1";
export const CONSOLE_RESET_PATH = `${API_PREFIX}/reset`;
export const OIDC_START_PATH = `${API_PREFIX}/sso/oidc/start`;
export const OIDC_CALLBACK_PATH = `${API_PREFIX}/sso/oidc/callback`;
const BACKUPS_PREFIX = `${API_PREFIX}/backups/`;
const PROJECTS_PREFIX = `${API_PREFIX}/projects/`;
const OIDC_COOKIE = "nlteam_oidc";
const OIDC_PENDING_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Whether single sign-on is set up, and the button's words. */
export function oidcButton(service: TeamService): string | undefined {
  const database = service.database;
  if (readPolicy(database, OIDC_ISSUER) === "" || readPolicy(database, OIDC_CLIENT_ID) === "") return undefined;
  const label = readPolicy(database, OIDC_LABEL);
  return label === "" ? "Single sign-on" : label;
}

/** Answer one of these routes, and say whether it was one. */
export function serveConsoleSecurity(service: TeamService, request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path === CONSOLE_RESET_PATH) {
    if (request.method === "GET") {
      const token = new URL(request.url ?? "/", "http://team.invalid").searchParams.get("token") ?? "";
      const user = token === "" ? undefined : resetTarget(service.database, token);
      if (user === undefined) {
        refuse(response, 404, "that link has been used, has expired, or was never made");
        return true;
      }
      sendJson(response, 200, { username: user.username, displayName: user.displayName });
      return true;
    }
    if (request.method !== "POST") {
      onlyMethods(response, "GET, POST", "GET, POST");
      return true;
    }
    if (!sameOrigin(request)) {
      refuse(response, 403, "that request came from somewhere else");
      return true;
    }
    answering(service, response, resetPassword(service, request, response));
    return true;
  }
  if (path === OIDC_START_PATH) {
    answering(service, response, oidcStart(service, request, response));
    return true;
  }
  if (path === OIDC_CALLBACK_PATH) {
    answering(service, response, oidcCallback(service, request, response));
    return true;
  }
  if (path.startsWith(BACKUPS_PREFIX)) {
    answering(service, response, downloadBackup(service, request, response, decodeURIComponent(path.slice(BACKUPS_PREFIX.length))));
    return true;
  }
  if (path.startsWith(PROJECTS_PREFIX) && path.endsWith("/export")) {
    const ref = decodeURIComponent(path.slice(PROJECTS_PREFIX.length, -"/export".length));
    answering(service, response, downloadExport(service, request, response, ref));
    return true;
  }
  return false;
}

/* --------------------------------------------------------- password resets */

async function resetPassword(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (typeof body === "string") {
    refuse(response, 400, body);
    return;
  }
  const token = typeof body["token"] === "string" ? body["token"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  const outcome = await usePasswordReset(service.database, defaultPasswordHasher(), token, password);
  switch (outcome.kind) {
    case "weak":
      refuse(response, 400, "a password is at least 10 characters");
      return;
    case "gone":
      refuse(response, 410, "that link has been used, has expired, or was never made");
      return;
    case "done":
      recordDecision(service.database, { username: outcome.user.username, resource: `account:${outcome.user.username}`, allowed: true, detail: "password set from a reset link" });
      service.log?.(`console: ${outcome.user.username} set a new password from a reset link`);
      sendJson(response, 200, { username: outcome.user.username });
  }
}

/* -------------------------------------------------------------------- OIDC */

interface Discovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

interface Pending {
  readonly verifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly at: number;
}

const pending = new Map<string, Pending>();
let discovered: { readonly issuer: string; readonly at: number; readonly value: Discovery } | undefined;
let keySet: { readonly uri: string; readonly at: number; readonly keys: readonly (JsonWebKey & { kid?: string })[] } | undefined;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function origin(service: TeamService, request: IncomingMessage): string {
  const configured = readPolicy(service.database, PUBLIC_URL).replace(/\/+$/, "");
  if (configured !== "") return configured;
  const secure = (request.socket as TLSSocket).encrypted === true;
  return `${secure ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const answer = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!answer.ok) throw new Error(`${new URL(url).host} answered ${answer.status}`);
  return (await answer.json()) as Record<string, unknown>;
}

async function discovery(issuer: string, now = Date.now()): Promise<Discovery> {
  if (discovered !== undefined && discovered.issuer === issuer && now - discovered.at < DISCOVERY_TTL_MS) {
    return discovered.value;
  }
  const raw = await fetchJson(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof raw[key] !== "string") throw new Error(`the provider's configuration has no ${key}`);
  }
  const value = raw as unknown as Discovery;
  discovered = { issuer, at: now, value };
  return value;
}

async function signingKeys(uri: string, refresh: boolean, now = Date.now()): Promise<readonly (JsonWebKey & { kid?: string })[]> {
  if (!refresh && keySet !== undefined && keySet.uri === uri && now - keySet.at < DISCOVERY_TTL_MS) return keySet.keys;
  const raw = await fetchJson(uri);
  const keys = Array.isArray(raw["keys"]) ? (raw["keys"] as (JsonWebKey & { kid?: string })[]) : [];
  keySet = { uri, at: now, keys };
  return keys;
}

function oidcCookie(value: string, maxAge: number): string {
  return `${OIDC_COOKIE}=${value}; Path=${API_PREFIX}/sso/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(302, { location, "cache-control": "no-store", ...(cookies.length === 0 ? {} : { "set-cookie": cookies }) });
  response.end();
}

async function oidcStart(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const issuer = readPolicy(service.database, OIDC_ISSUER);
  const clientId = readPolicy(service.database, OIDC_CLIENT_ID);
  if (issuer === "" || clientId === "") {
    redirect(response, "/console/?sso=off");
    return;
  }
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > OIDC_PENDING_MS) pending.delete(key);
  if (pending.size > 1000) pending.clear();
  let config: Discovery;
  try {
    config = await discovery(issuer, now);
  } catch (error) {
    service.log?.(`console: oidc discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    redirect(response, "/console/?sso=unreachable");
    return;
  }
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(16));
  const redirectUri = `${origin(service, request)}${OIDC_CALLBACK_PATH}`;
  pending.set(state, { verifier, nonce, redirectUri, at: now });
  const target = new URL(config.authorization_endpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
  target.searchParams.set("code_challenge_method", "S256");
  redirect(response, target.toString(), [oidcCookie(state, Math.floor(OIDC_PENDING_MS / 1000))]);
}

/** The claims of an id_token whose signature and fields have been checked, or a reason it is not one. */
export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; nonce: string },
  keys: (refresh: boolean) => Promise<readonly (JsonWebKey & { kid?: string })[]>,
  now = Date.now(),
): Promise<Record<string, unknown> | string> {
  const parts = token.split(".");
  if (parts.length !== 3) return "the id_token is not a JWT";
  const [rawHeader = "", rawClaims = "", rawSignature = ""] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf-8")) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(rawClaims, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return "the id_token is not readable";
  }
  const alg = header["alg"];
  if (alg !== "RS256" && alg !== "PS256" && alg !== "ES256") return `the id_token is signed with ${String(alg)}, which this server does not take`;
  const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
  const pick = (list: readonly (JsonWebKey & { kid?: string })[]): JsonWebKey | undefined =>
    list.find((key) => (kid === undefined || key.kid === kid) && (alg === "ES256" ? key.kty === "EC" : key.kty === "RSA"));
  let jwk = pick(await keys(false));
  // A key rotated since the set was cached: one fresh look before giving up.
  if (jwk === undefined) jwk = pick(await keys(true));
  if (jwk === undefined) return "the provider publishes no key that signed this id_token";
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return "the provider's key is not readable";
  }
  const input = Buffer.from(`${rawHeader}.${rawClaims}`);
  const signature = Buffer.from(rawSignature, "base64url");
  const ok =
    alg === "ES256"
      ? verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, signature)
      : alg === "PS256"
        ? verify("sha256", input, { key, padding: 6, saltLength: 32 }, signature)
        : verify("sha256", input, key, signature);
  if (!ok) return "the id_token's signature does not verify";
  if (claims["iss"] !== expected.issuer) return "the id_token is from another issuer";
  const audience = claims["aud"];
  if (!(audience === expected.audience || (Array.isArray(audience) && audience.includes(expected.audience)))) {
    return "the id_token is for another client";
  }
  const seconds = Math.floor(now / 1000);
  if (typeof claims["exp"] !== "number" || claims["exp"] < seconds - 60) return "the id_token has expired";
  if (typeof claims["iat"] === "number" && claims["iat"] > seconds + 300) return "the id_token is from the future";
  if (claims["nonce"] !== expected.nonce) return "the id_token is not an answer to this sign-in";
  if (typeof claims["sub"] !== "string" || claims["sub"] === "") return "the id_token names nobody";
  return claims;
}

async function oidcCallback(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const database = service.database;
  const query = new URL(request.url ?? "/", "http://team.invalid").searchParams;
  const state = query.get("state") ?? "";
  const clear = oidcCookie("", 0);
  const fail = (reason: string, detail: string): void => {
    service.log?.(`console: oidc sign-in refused: ${detail}`);
    redirect(response, `/console/?sso=${reason}`, [clear]);
  };
  const waiting = pending.get(state);
  pending.delete(state);
  if (waiting === undefined || cookieValue(request.headers.cookie, OIDC_COOKIE) !== state || Date.now() - waiting.at > OIDC_PENDING_MS) {
    fail("expired", "no sign-in of that state was started from this browser");
    return;
  }
  if (query.get("error") !== null) {
    fail("refused", `the provider said ${query.get("error") ?? ""}`);
    return;
  }
  const code = query.get("code") ?? "";
  const issuer = readPolicy(database, OIDC_ISSUER);
  const clientId = readPolicy(database, OIDC_CLIENT_ID);
  const secret = readPolicy(database, OIDC_CLIENT_SECRET);
  let claims: Record<string, unknown> | string;
  try {
    const config = await discovery(issuer);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: waiting.redirectUri,
      client_id: clientId,
      code_verifier: waiting.verifier,
      ...(secret === "" ? {} : { client_secret: secret }),
    });
    const tokens = await fetchJson(config.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    const idToken = typeof tokens["id_token"] === "string" ? tokens["id_token"] : "";
    claims = await verifyIdToken(idToken, { issuer: config.issuer, audience: clientId, nonce: waiting.nonce }, (refresh) => signingKeys(config.jwks_uri, refresh));
  } catch (error) {
    fail("unreachable", error instanceof Error ? error.message : String(error));
    return;
  }
  if (typeof claims === "string") {
    fail("invalid", claims);
    return;
  }
  const text = (name: string): string | undefined => (typeof claims[name] === "string" && claims[name] !== "" ? (claims[name] as string) : undefined);
  const email = claims["email_verified"] === false ? undefined : text("email");
  const outcome = await externalAccount(database, {
    provider: "oidc",
    subject: `${issuer}#${String(claims["sub"])}`,
    ...(text("preferred_username") === undefined ? {} : { username: text("preferred_username") as string }),
    ...(email === undefined ? {} : { email }),
    ...(text("name") === undefined ? {} : { displayName: text("name") as string }),
  });
  if (outcome.kind !== "matched") {
    fail(outcome.kind === "disabled" ? "disabled" : "unknown", outcome.kind === "disabled" ? "that account is disabled" : "no account matches and none is made");
    return;
  }
  const agent = request.headers["user-agent"];
  const { cookie } = createWebSession(database, outcome.user, agent === undefined ? {} : { userAgent: agent });
  recordDecision(database, { username: outcome.user.username, resource: `account:${outcome.user.username}`, allowed: true, detail: outcome.created ? "account made by single sign-on" : "signed in by single sign-on" });
  service.log?.(`console: ${outcome.user.username} signed in through oidc`);
  redirect(response, "/console/", [clear, sessionCookieHeader(cookie)]);
}

/* --------------------------------------------------------------- downloads */

function cookieUser(service: TeamService, request: IncomingMessage, response: ServerResponse): UserRecord | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") {
    onlyMethods(response, "GET", "GET");
    return undefined;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  if (identified.kind === "refused") {
    refuse(response, 401, describeWebSessionRefusal(identified.reason, describeRefusal));
    return undefined;
  }
  if (twoFactorRequired(service.database, identified.user.id) && !totpEnabled(service.database, identified.user.id)) {
    refuse(response, 403, "set up two-step sign-in first");
    return undefined;
  }
  return identified.user;
}

async function downloadBackup(service: TeamService, request: IncomingMessage, response: ServerResponse, name: string): Promise<void> {
  const user = cookieUser(service, request, response);
  if (user === undefined) return;
  if (!isOperator(user.groups)) {
    refuse(response, 403, "only an admin downloads backups");
    return;
  }
  const path = backupPath(service.root, name);
  const info = path === undefined ? undefined : await stat(path).catch(() => undefined);
  if (path === undefined || info === undefined) {
    refuse(response, 404, "there is no backup of that name");
    return;
  }
  recordDecision(service.database, { username: user.username, resource: "server:backup", allowed: true, detail: `downloaded ${name}` });
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": info.size,
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path).pipe(response);
}

async function downloadExport(service: TeamService, request: IncomingMessage, response: ServerResponse, ref: string): Promise<void> {
  const user = cookieUser(service, request, response);
  if (user === undefined) return;
  const project = findProject(service.database, ref);
  if (project === undefined || projectRole(service.database, project.id, user) !== "owner") {
    refuse(response, 404, "there is no project of that id you own");
    return;
  }
  recordDecision(service.database, { username: user.username, resource: `project:${project.name}`, allowed: true, detail: "exported" });
  const stamp = new Date().toISOString().slice(0, 10);
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${project.name}-export-${stamp}.tar.gz"`,
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await exportProject(service.root, service.database, project.id, response);
}
