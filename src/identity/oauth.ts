/**
 * This server as an OAuth 2.0 authorization server, for one client: Studio.
 *
 * Studio used to ask a person for their password inside the app and post it
 * here. Now it opens the system browser at this server's console, the person
 * signs in there (or already is) and approves "NarraLeaf Studio on <device>",
 * and the browser hands Studio a code it redeems for tokens — RFC 8252, a
 * native app as a public client: authorization code, PKCE (S256, required),
 * redirect to the loopback interface on any port. Where no browser can be
 * opened on Studio's machine, the device flow (RFC 8628) does the same with a
 * short code typed into the console on any device.
 *
 * What Studio receives is the token it always received — the same claims,
 * minted by the same function, so loreserver sees nothing new — plus a refresh
 * token. Two things are new and both are about ending it:
 *
 *   - **A grant per device.** Every token issued through this path carries
 *     `grant`, and Team refuses a token whose grant is revoked
 *     (src/identity/bearer.ts). Signing a device out is therefore immediate,
 *     and touches nobody else's devices, where revoking an account's tokens
 *     ends all of them.
 *   - **Refresh rotation with replay detection.** A refresh token is good for
 *     one use and is replaced by the next. The one replaced is remembered: if
 *     it is ever presented again, two parties hold the chain, and the grant is
 *     revoked for both.
 *
 * Only hashes of codes, refresh tokens and device codes are stored.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, textColumn, type Row } from "./database.js";
import { findUserById, type UserRecord } from "./users.js";

/** The clients this server knows. Public clients: there is no secret to hold. */
export const OAUTH_CLIENTS: Readonly<Record<string, { readonly name: string }>> = {
  "narraleaf-studio": { name: "NarraLeaf Studio" },
};

/** How long a browser approval waits for Studio to redeem it. */
export const CODE_LIFETIME_MS = 5 * 60 * 1000;

/** How long a refresh token lasts unused. Each use starts it again. */
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

/*
 * An access token issued here lasts as long as any sign-in token (the stored
 * sign-in lifetime, thirty days unless changed) rather than an hour. The usual
 * reason for a short one — that a leaked token cannot be withdrawn — does not
 * hold here: every token carries its grant, and Team refuses it the moment the
 * grant is revoked. A short one would cost something real instead: a Studio
 * session re-verifies its token on every call and would be ended hourly.
 * Studio refreshes well before expiry, which rotates the refresh token.
 */

/** How long a device code waits for somebody to type its user code. */
export const DEVICE_LIFETIME_MS = 10 * 60 * 1000;

/** How often a device may poll, in seconds (RFC 8628 §3.2 `interval`). */
export const DEVICE_INTERVAL_SECONDS = 5;

/** The most of a device name kept: "the studio iMac", not a payload. */
const DEVICE_NAME_LIMIT = 64;

/** Letters a person reads off one screen and types on another without confusing them (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** What a refused OAuth request is, as RFC 6749 §5.2 names it, with a sentence for a person. */
export interface OAuthError {
  readonly error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unsupported_grant_type"
    | "unsupported_response_type"
    | "access_denied"
    | "authorization_pending"
    | "slow_down"
    | "expired_token";
  readonly description: string;
}

function refused(error: OAuthError["error"], description: string): OAuthError {
  return { error, description };
}

function hashOf(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

/** A device name as stored: trimmed, bounded, and never empty. */
export function cleanDeviceName(name: string | undefined): string {
  const cleaned = [...(name ?? "")]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, DEVICE_NAME_LIMIT);
  return cleaned === "" ? "an unnamed device" : cleaned;
}

/* ---------------------------------------------------------- authorize */

/** An authorization request that has been checked, ready to show a person. */
export interface AuthorizeRequest {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string | undefined;
  readonly deviceName: string;
}

/**
 * Whether a redirect is one a native app on this machine owns: plain http to
 * the loopback address, by IP, any port (RFC 8252 §7.3, §8.3). `localhost` is
 * refused, as §8.3 advises, because a name can resolve somewhere else.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

/**
 * Check what a browser was sent to `/oauth/authorize` with.
 *
 * Errors about the client or the redirect are shown to the person and never
 * redirected: sending an error to a redirect that is not known to belong to
 * the client would make this server an open redirector.
 */
export function checkAuthorizeRequest(query: URLSearchParams): AuthorizeRequest | OAuthError {
  const clientId = query.get("client_id") ?? "";
  const client = OAUTH_CLIENTS[clientId];
  if (client === undefined) {
    return refused("invalid_client", "this server does not know that application");
  }
  const redirectUri = query.get("redirect_uri") ?? "";
  if (!isLoopbackRedirect(redirectUri)) {
    return refused("invalid_request", "the application asked to be answered somewhere that is not this machine");
  }
  if (query.get("response_type") !== "code") {
    return refused("unsupported_response_type", "only the authorization code flow is served");
  }
  const challenge = query.get("code_challenge") ?? "";
  if (query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return refused("invalid_request", "a PKCE challenge (S256) is required");
  }
  const state = query.get("state") ?? undefined;
  if (state !== undefined && state.length > 512) {
    return refused("invalid_request", "the state is longer than this server carries");
  }
  return {
    clientId,
    clientName: client.name,
    redirectUri,
    challenge,
    state,
    deviceName: cleanDeviceName(query.get("device_name") ?? undefined),
  };
}

/** Where to send the browser once a person has approved: the redirect, with a code. */
export function approveAuthorization(
  database: DatabaseSync,
  user: UserRecord,
  request: AuthorizeRequest,
  now: number = Date.now(),
): string {
  const code = secret();
  database.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
  database
    .prepare(
      `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, challenge, device_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(hashOf(code), user.id, request.clientId, request.redirectUri, request.challenge, request.deviceName, now + CODE_LIFETIME_MS);
  const target = new URL(request.redirectUri);
  target.searchParams.set("code", code);
  if (request.state !== undefined) {
    target.searchParams.set("state", request.state);
  }
  return target.toString();
}

/** Where to send the browser when a person said no. */
export function denyAuthorization(request: AuthorizeRequest): string {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", "access_denied");
  if (request.state !== undefined) {
    target.searchParams.set("state", request.state);
  }
  return target.toString();
}

/* -------------------------------------------------------------- grants */

/** One signed-in device. */
export interface OAuthGrant {
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  readonly deviceName: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | undefined;
}

function toGrant(row: Row): OAuthGrant {
  const revoked = row.revoked_at;
  return {
    id: textColumn(row, "id"),
    userId: textColumn(row, "user_id"),
    clientId: textColumn(row, "client_id"),
    deviceName: textColumn(row, "device_name"),
    createdAt: integerColumn(row, "created_at"),
    lastUsedAt: integerColumn(row, "last_used_at"),
    expiresAt: integerColumn(row, "expires_at"),
    revokedAt: typeof revoked === "number" || typeof revoked === "bigint" ? Number(revoked) : undefined,
  };
}

/** What issuing or refreshing answers: who, under which grant, with the next refresh token. */
export interface IssuedGrant {
  readonly user: UserRecord;
  readonly grantId: string;
  readonly refreshToken: string;
}

function createGrant(
  database: DatabaseSync,
  user: UserRecord,
  clientId: string,
  deviceName: string,
  now: number,
): IssuedGrant {
  const id = randomUUID();
  const refreshToken = secret();
  database
    .prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, device_name, refresh_hash, previous_hash,
                                 token_epoch, created_at, last_used_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    )
    .run(id, user.id, clientId, deviceName, hashOf(refreshToken), user.tokenEpoch, now, now, now + REFRESH_IDLE_MS);
  return { user, grantId: id, refreshToken };
}

/** Whether a user may be issued anything right now. */
function admissible(user: UserRecord | undefined): user is UserRecord {
  return user !== undefined && user.disabledAt === undefined && !user.isServiceAccount;
}

/**
 * Redeem an authorization code (grant_type=authorization_code).
 *
 * The code is deleted whatever the outcome, so a code that was intercepted
 * and tried with the wrong verifier is not left to be tried again.
 */
export function redeemCode(
  database: DatabaseSync,
  input: { code: string; clientId: string; redirectUri: string; verifier: string },
  now: number = Date.now(),
): IssuedGrant | OAuthError {
  const codeHash = hashOf(input.code);
  const row = database
    .prepare("SELECT user_id, client_id, redirect_uri, challenge, device_name, expires_at FROM oauth_codes WHERE code_hash = ?")
    .get(codeHash) as Row | undefined;
  database.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
  if (row === undefined || integerColumn(row, "expires_at") <= now) {
    return refused("invalid_grant", "that sign-in has expired or was already used; start again");
  }
  if (textColumn(row, "client_id") !== input.clientId || textColumn(row, "redirect_uri") !== input.redirectUri) {
    return refused("invalid_grant", "that code was issued to a different application");
  }
  const challenge = createHash("sha256").update(input.verifier, "utf8").digest("base64url");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || challenge !== textColumn(row, "challenge")) {
    return refused("invalid_grant", "the PKCE verifier does not match");
  }
  const user = findUserById(database, textColumn(row, "user_id"));
  if (!admissible(user)) {
    return refused("invalid_grant", "that account may not sign in");
  }
  return createGrant(database, user, input.clientId, textColumn(row, "device_name"), now);
}

/**
 * Exchange a refresh token for the next one (grant_type=refresh_token).
 *
 * A token that matches a grant's *previous* refresh token has been used twice,
 * by two parties: the grant is revoked, and both are signed out.
 */
export function refreshGrant(
  database: DatabaseSync,
  input: { refreshToken: string; clientId: string },
  now: number = Date.now(),
): IssuedGrant | OAuthError {
  const presented = hashOf(input.refreshToken);
  const replayed = database
    .prepare("SELECT id FROM oauth_grants WHERE previous_hash = ? AND revoked_at IS NULL")
    .get(presented) as Row | undefined;
  if (replayed !== undefined) {
    database.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?").run(now, textColumn(replayed, "id"));
    return refused("invalid_grant", "that refresh token was already used; this device has been signed out");
  }
  const row = database
    .prepare(
      `SELECT id, user_id, client_id, device_name, token_epoch, created_at, last_used_at, expires_at, revoked_at
         FROM oauth_grants WHERE refresh_hash = ?`,
    )
    .get(presented) as Row | undefined;
  if (row === undefined) {
    return refused("invalid_grant", "this device is not signed in; sign in again");
  }
  const grant = toGrant(row);
  if (grant.revokedAt !== undefined || grant.expiresAt <= now || grant.clientId !== input.clientId) {
    return refused("invalid_grant", "this device is not signed in; sign in again");
  }
  const user = findUserById(database, grant.userId);
  if (!admissible(user) || integerColumn(row, "token_epoch") < user.tokenEpoch) {
    database.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?").run(now, grant.id);
    return refused("invalid_grant", "this account's sign-ins were ended; sign in again");
  }
  const next = secret();
  database
    .prepare(
      `UPDATE oauth_grants SET previous_hash = refresh_hash, refresh_hash = ?, last_used_at = ?, expires_at = ?
        WHERE id = ?`,
    )
    .run(hashOf(next), now, now + REFRESH_IDLE_MS, grant.id);
  return { user, grantId: grant.id, refreshToken: next };
}

/** Whether a grant named in a token is still in force for that account. */
export function grantIsLive(database: DatabaseSync, grantId: string, userId: string, now: number = Date.now()): boolean {
  const row = database
    .prepare("SELECT user_id, expires_at, revoked_at FROM oauth_grants WHERE id = ?")
    .get(grantId) as Row | undefined;
  return (
    row !== undefined &&
    textColumn(row, "user_id") === userId &&
    row.revoked_at === null &&
    integerColumn(row, "expires_at") > now
  );
}

/** The devices an account is signed in on, most recently used first. */
export function listGrants(database: DatabaseSync, userId: string, now: number = Date.now()): OAuthGrant[] {
  return database
    .prepare(
      `SELECT id, user_id, client_id, device_name, created_at, last_used_at, expires_at, revoked_at
         FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_used_at DESC`,
    )
    .all(userId, now)
    .map((row) => toGrant(row as Row));
}

/** Sign one device out. Answers whether it was signed in. Scoped to the account when one is named. */
export function revokeGrant(database: DatabaseSync, grantId: string, userId?: string, now: number = Date.now()): boolean {
  const result =
    userId === undefined
      ? database.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, grantId)
      : database
          .prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
          .run(now, grantId, userId);
  return Number(result.changes) > 0;
}

/* -------------------------------------------------------------- device */

function userCode(): string {
  const bytes = randomBytes(8);
  const letters = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/** A user code as typed: upper case, the dash optional, spaces ignored. */
export function normaliseUserCode(typed: string): string {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/** Begin a device sign-in (RFC 8628 §3.1). */
export function startDevice(
  database: DatabaseSync,
  input: { clientId: string; deviceName?: string },
  now: number = Date.now(),
): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | OAuthError {
  if (OAUTH_CLIENTS[input.clientId] === undefined) {
    return refused("invalid_client", "this server does not know that application");
  }
  database.prepare("DELETE FROM oauth_devices WHERE expires_at <= ?").run(now);
  const deviceCode = secret();
  // A collision on eight letters among the handful of live codes is unlikely,
  // and a retry is cheap; three tries is far more than will ever be needed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = userCode();
    try {
      database
        .prepare(
          `INSERT INTO oauth_devices (device_hash, user_code, client_id, device_name, user_id, decision, expires_at, polled_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)`,
        )
        .run(hashOf(deviceCode), code, input.clientId, cleanDeviceName(input.deviceName), now + DEVICE_LIFETIME_MS);
      return { deviceCode, userCode: code, expiresIn: DEVICE_LIFETIME_MS / 1000, interval: DEVICE_INTERVAL_SECONDS };
    } catch {
      // try another code
    }
  }
  return refused("invalid_request", "could not issue a code; try again");
}

/** What a typed user code names, for the console to show before somebody approves it. */
export function findDevice(
  database: DatabaseSync,
  typed: string,
  now: number = Date.now(),
): { userCode: string; clientName: string; deviceName: string } | undefined {
  const row = database
    .prepare("SELECT user_code, client_id, device_name, expires_at, decision FROM oauth_devices WHERE user_code = ?")
    .get(normaliseUserCode(typed)) as Row | undefined;
  if (row === undefined || integerColumn(row, "expires_at") <= now || row.decision !== null) {
    return undefined;
  }
  return {
    userCode: textColumn(row, "user_code"),
    clientName: OAUTH_CLIENTS[textColumn(row, "client_id")]?.name ?? textColumn(row, "client_id"),
    deviceName: textColumn(row, "device_name"),
  };
}

/** Approve or refuse a device sign-in, as the person signed in to the console. */
export function decideDevice(
  database: DatabaseSync,
  typed: string,
  user: UserRecord,
  approve: boolean,
  now: number = Date.now(),
): boolean {
  const result = database
    .prepare(
      `UPDATE oauth_devices SET user_id = ?, decision = ?
        WHERE user_code = ? AND decision IS NULL AND expires_at > ?`,
    )
    .run(user.id, approve ? "approved" : "denied", normaliseUserCode(typed), now);
  return Number(result.changes) > 0;
}

/** Poll a device sign-in (grant_type=urn:ietf:params:oauth:grant-type:device_code). */
export function pollDevice(
  database: DatabaseSync,
  input: { deviceCode: string; clientId: string },
  now: number = Date.now(),
): IssuedGrant | OAuthError {
  const deviceHash = hashOf(input.deviceCode);
  const row = database
    .prepare("SELECT client_id, device_name, user_id, decision, expires_at, polled_at FROM oauth_devices WHERE device_hash = ?")
    .get(deviceHash) as Row | undefined;
  if (row === undefined || textColumn(row, "client_id") !== input.clientId) {
    return refused("invalid_grant", "that device code is not one this server issued");
  }
  if (integerColumn(row, "expires_at") <= now) {
    database.prepare("DELETE FROM oauth_devices WHERE device_hash = ?").run(deviceHash);
    return refused("expired_token", "the code expired before anybody entered it; start again");
  }
  const polled = row.polled_at;
  database.prepare("UPDATE oauth_devices SET polled_at = ? WHERE device_hash = ?").run(now, deviceHash);
  if (row.decision === "denied") {
    database.prepare("DELETE FROM oauth_devices WHERE device_hash = ?").run(deviceHash);
    return refused("access_denied", "the sign-in was refused");
  }
  if (row.decision !== "approved") {
    if (typeof polled === "number" && now - polled < DEVICE_INTERVAL_SECONDS * 1000) {
      return refused("slow_down", `poll no more than every ${DEVICE_INTERVAL_SECONDS} seconds`);
    }
    return refused("authorization_pending", "nobody has entered the code yet");
  }
  database.prepare("DELETE FROM oauth_devices WHERE device_hash = ?").run(deviceHash);
  const user = findUserById(database, textColumn(row, "user_id"));
  if (!admissible(user)) {
    return refused("invalid_grant", "that account may not sign in");
  }
  return createGrant(database, user, input.clientId, textColumn(row, "device_name"), now);
}
