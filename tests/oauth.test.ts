/**
 * Studio signing in through the browser: this server as an OAuth authorization
 * server, end to end over HTTP and rule by rule underneath.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identifyToken } from "../src/identity/bearer.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import {
  approveAuthorization,
  checkAuthorizeRequest,
  decideDevice,
  isLoopbackRedirect,
  listGrants,
  pollDevice,
  redeemCode,
  refreshGrant,
  revokeGrant,
  startDevice,
  type AuthorizeRequest,
} from "../src/identity/oauth.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { SignInLimiter } from "../src/identity/signin.js";
import { createUser, requireUser, revokeUserTokens } from "../src/identity/users.js";
import { WEB_SESSION_COOKIE } from "../src/identity/websessions.js";
import type { TeamService } from "../src/team/service.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-oauth-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const PASSWORD = "a password nobody guesses";
const REDIRECT = "http://127.0.0.1:53682/callback";

const servers: Server[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases.splice(0)) db.close();
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeQuery(challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: "narraleaf-studio",
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    device_name: "the studio iMac",
    ...extra,
  });
}

async function setup() {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  databases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});
  const service: TeamService = { database, keys, config, root, dataPort: 1, healthPort: 1, signIns: new SignInLimiter() };
  await createUser(database, hasher, { username: "ada", password: PASSWORD, displayName: "Ada" });
  return { database, keys, config, service, ada: () => requireUser(database, "ada") };
}

function approved(database: DatabaseSync, user: ReturnType<typeof requireUser>, challenge: string): string {
  const checked = checkAuthorizeRequest(authorizeQuery(challenge)) as AuthorizeRequest;
  return new URL(approveAuthorization(database, user, checked)).searchParams.get("code") ?? "";
}

describe("an authorization request", () => {
  it("accepts only Studio, a loopback redirect by IP, and a S256 challenge", () => {
    const { challenge } = pkce();
    expect("error" in checkAuthorizeRequest(authorizeQuery(challenge))).toBe(false);
    expect(checkAuthorizeRequest(authorizeQuery(challenge, { client_id: "other" }))).toMatchObject({
      error: "invalid_client",
    });
    expect(checkAuthorizeRequest(authorizeQuery(challenge, { code_challenge_method: "plain" }))).toMatchObject({
      error: "invalid_request",
    });
    for (const redirect of [
      "https://evil.example/cb",
      "http://localhost:4000/cb",
      "http://127.0.0.1/cb",
      "http://user@127.0.0.1:4000/cb",
    ]) {
      expect(isLoopbackRedirect(redirect)).toBe(false);
    }
    expect(isLoopbackRedirect("http://[::1]:4000/cb")).toBe(true);
  });
});

describe("redeeming a code", () => {
  it("issues a grant once, to the verifier that made the challenge", async () => {
    const { database, ada } = await setup();
    const { verifier, challenge } = pkce();
    const code = approved(database, ada(), challenge);

    const wrong = redeemCode(database, { code, clientId: "narraleaf-studio", redirectUri: REDIRECT, verifier: pkce().verifier });
    expect(wrong).toMatchObject({ error: "invalid_grant" });
    // The code went with the failed attempt: an intercepted code cannot be tried twice.
    expect(redeemCode(database, { code, clientId: "narraleaf-studio", redirectUri: REDIRECT, verifier })).toMatchObject({
      error: "invalid_grant",
    });

    const fresh = approved(database, ada(), challenge);
    const issued = redeemCode(database, { code: fresh, clientId: "narraleaf-studio", redirectUri: REDIRECT, verifier });
    expect("error" in issued).toBe(false);
    expect(listGrants(database, ada().id).map((grant) => grant.deviceName)).toEqual(["the studio iMac"]);
  });

  it("refuses a code redeemed for another redirect", async () => {
    const { database, ada } = await setup();
    const { verifier, challenge } = pkce();
    const code = approved(database, ada(), challenge);
    expect(
      redeemCode(database, { code, clientId: "narraleaf-studio", redirectUri: "http://127.0.0.1:1/x", verifier }),
    ).toMatchObject({ error: "invalid_grant" });
  });
});

describe("a grant", () => {
  async function granted() {
    const context = await setup();
    const { verifier, challenge } = pkce();
    const code = approved(context.database, context.ada(), challenge);
    const issued = redeemCode(context.database, { code, clientId: "narraleaf-studio", redirectUri: REDIRECT, verifier });
    if ("error" in issued) throw new Error(issued.description);
    return { ...context, issued };
  }

  it("rotates its refresh token, and revokes itself when an old one is replayed", async () => {
    const { database, issued } = await granted();
    const next = refreshGrant(database, { refreshToken: issued.refreshToken, clientId: "narraleaf-studio" });
    if ("error" in next) throw new Error(next.description);
    expect(next.grantId).toBe(issued.grantId);
    expect(next.refreshToken).not.toBe(issued.refreshToken);

    // The first one again: somebody else holds the chain.
    expect(refreshGrant(database, { refreshToken: issued.refreshToken, clientId: "narraleaf-studio" })).toMatchObject({
      error: "invalid_grant",
    });
    expect(refreshGrant(database, { refreshToken: next.refreshToken, clientId: "narraleaf-studio" })).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("ends when the account's tokens are revoked", async () => {
    const { database, issued } = await granted();
    revokeUserTokens(database, "ada");
    expect(refreshGrant(database, { refreshToken: issued.refreshToken, clientId: "narraleaf-studio" })).toMatchObject({
      error: "invalid_grant",
    });
  });
});

describe("the device flow", () => {
  it("waits, slows a hasty poller, and issues once somebody approves the code", async () => {
    const { database, ada } = await setup();
    const started = startDevice(database, { clientId: "narraleaf-studio", deviceName: "build box" }, 0);
    if ("error" in started) throw new Error(started.description);
    expect(started.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);

    const poll = (now: number) => pollDevice(database, { deviceCode: started.deviceCode, clientId: "narraleaf-studio" }, now);
    expect(poll(1000)).toMatchObject({ error: "authorization_pending" });
    expect(poll(2000)).toMatchObject({ error: "slow_down" });

    expect(decideDevice(database, started.userCode.toLowerCase().replace("-", " "), ada(), true, 3000)).toBe(true);
    const issued = poll(9000);
    expect("error" in issued).toBe(false);
    // Used up.
    expect(poll(20000)).toMatchObject({ error: "invalid_grant" });
  });

  it("tells a device it was refused", async () => {
    const { database, ada } = await setup();
    const started = startDevice(database, { clientId: "narraleaf-studio" }, 0);
    if ("error" in started) throw new Error(started.description);
    decideDevice(database, started.userCode, ada(), false, 1);
    expect(pollDevice(database, { deviceCode: started.deviceCode, clientId: "narraleaf-studio" }, 2)).toMatchObject({
      error: "access_denied",
    });
  });
});

describe("over HTTP", () => {
  async function serve() {
    const context = await setup();
    const server = createServer(webHandler(() => ({}) as never, { console: { service: context.service } }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const host = `127.0.0.1:${port}`;
    const ask = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
        const call = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }),
          );
        });
        call.on("error", reject);
        call.end(body);
      });
    const json = { "content-type": "application/json", origin: `https://${host}` };
    const signIn = await ask("POST", "/api/console/v1/sign-in", json, JSON.stringify({ username: "ada", password: PASSWORD }));
    const cookie = /__Host-nlteam=([^;]+)/.exec(String(signIn.headers["set-cookie"]))?.[1] ?? "";
    return { ...context, host, ask, json, session: `${WEB_SESSION_COOKIE}=${cookie}` };
  }

  it("signs Studio in: authorize, approve in the console, redeem, refresh, sign the device out", async () => {
    const team = await serve();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(challenge).toString();

    const redirect = await team.ask("GET", `/oauth/authorize?${query}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers["location"]).toBe(`/console/oauth/authorize?${query}`);

    const shown = await team.ask("GET", `/api/console/v1/oauth/authorize?${query}`, { cookie: team.session });
    expect(JSON.parse(shown.body)).toEqual({ clientName: "NarraLeaf Studio", deviceName: "the studio iMac" });

    // Approving needs this server's page, not merely the cookie.
    const forged = await team.ask(
      "POST",
      "/api/console/v1/oauth/authorize",
      { "content-type": "application/json", cookie: team.session, origin: "https://evil.example" },
      JSON.stringify({ query, approve: true }),
    );
    expect(forged.status).toBe(403);

    const approvedReply = await team.ask(
      "POST",
      "/api/console/v1/oauth/authorize",
      { ...team.json, cookie: team.session },
      JSON.stringify({ query, approve: true }),
    );
    const back = new URL(JSON.parse(approvedReply.body).redirect as string);
    expect(back.origin).toBe("http://127.0.0.1:53682");
    expect(back.searchParams.get("state")).toBe("xyz");

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: "narraleaf-studio",
      code_verifier: verifier,
    }).toString();
    const tokens = await team.ask("POST", "/oauth/token", { "content-type": "application/x-www-form-urlencoded" }, form);
    expect(tokens.status).toBe(200);
    expect(tokens.headers["cache-control"]).toBe("no-store");
    const answer = JSON.parse(tokens.body) as { access_token: string; refresh_token: string; expires_in: number };
    // A day by default, the "studio access token (hours)" setting.
    expect(answer.expires_in).toBe(Math.min(24 * 3600, team.config.signInTokenLifetimeSeconds));

    const identified = identifyToken(team.database, team.keys, team.config, answer.access_token);
    expect(identified.kind).toBe("identified");
    const grant = identified.kind === "identified" ? identified.claims.grant : undefined;
    expect(grant).toBeDefined();

    const refreshed = await team.ask(
      "POST",
      "/oauth/token",
      { "content-type": "application/json" },
      JSON.stringify({ grant_type: "refresh_token", refresh_token: answer.refresh_token, client_id: "narraleaf-studio" }),
    );
    expect(refreshed.status).toBe(200);

    // Signing the device out refuses the token it already holds, at once.
    revokeGrant(team.database, grant ?? "", team.ada().id);
    expect(identifyToken(team.database, team.keys, team.config, answer.access_token)).toEqual({
      kind: "refused",
      reason: "revoked-grant",
    });
  });

  it("answers a bad grant in RFC 6749's shape", async () => {
    const team = await serve();
    const reply = await team.ask(
      "POST",
      "/oauth/token",
      { "content-type": "application/x-www-form-urlencoded" },
      "grant_type=password&username=ada",
    );
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error).toBe("unsupported_grant_type");
  });

  it("hands out a device code pointing at the console", async () => {
    const team = await serve();
    const reply = await team.ask(
      "POST",
      "/oauth/device",
      { "content-type": "application/x-www-form-urlencoded" },
      "client_id=narraleaf-studio&device_name=build%20box",
    );
    const body = JSON.parse(reply.body) as { verification_uri: string; user_code: string };
    expect(body.verification_uri).toMatch(/\/console\/device$/);
    const shown = await team.ask("GET", `/api/console/v1/oauth/device?code=${body.user_code}`, { cookie: team.session });
    expect(JSON.parse(shown.body)).toMatchObject({ clientName: "NarraLeaf Studio", deviceName: "build box" });
  });
});
