/**
 * The web console's sign-in, its page, and the socket it opens with a cookie.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { SignInLimiter } from "../src/identity/signin.js";
import { createUser, disableUser, requireUser, revokeUserTokens } from "../src/identity/users.js";
import {
  createWebSession,
  identifyWebSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_IDLE_MS,
  WEB_SESSION_MAX_MS,
} from "../src/identity/websessions.js";
import { createTeamSocket } from "../src/team/endpoint.js";
import { TEAM_SOCKET_PATH } from "../src/team/protocol.js";
import type { TeamService } from "../src/team/service.js";
import { CONSOLE_CSP } from "../src/web/console.js";
import { UpdateCheck } from "../src/updates.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-console-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const PASSWORD = "a password nobody guesses";

const servers: Server[] = [];
const databases: DatabaseSync[] = [];
const sockets: WebSocket[] = [];
const connections = new Set<import("node:net").Socket>();

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.close();
  }
  for (const connection of connections) {
    connection.destroy();
  }
  connections.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
});

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

async function harness(options: { built?: boolean; updates?: UpdateCheck } = {}) {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  databases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const service: TeamService = {
    database,
    keys,
    config: identityConfig({}),
    root,
    dataPort: 1,
    healthPort: 1,
    signIns: new SignInLimiter(),
    ...(options.updates === undefined ? {} : { updates: options.updates }),
  };
  await createUser(database, hasher, { username: "ada", password: PASSWORD, displayName: "Ada" });
  await createUser(database, hasher, { username: "root", password: PASSWORD, displayName: "Root", groups: ["admin"] });

  let consoleDir: string | undefined;
  if (options.built !== false) {
    consoleDir = join(root, "console");
    await mkdir(join(consoleDir, "assets"), { recursive: true });
    await writeFile(join(consoleDir, "index.html"), "<!doctype html><title>console</title>");
    await writeFile(join(consoleDir, "assets", "app-1234.js"), "console.log(1)");
    await writeFile(join(root, "secret.txt"), "not for the page");
  }

  const socket = createTeamSocket({ service, version: "0.0.0-test", host: "127.0.0.1" });
  const server = createServer(
    webHandler(() => ({}) as never, { console: { service, ...(consoleDir === undefined ? {} : { root: consoleDir }) } }),
  );
  server.on("upgrade", (request, raw, head) => {
    if (!socket.handleUpgrade(request, raw, head)) {
      raw.destroy();
    }
  });
  server.on("connection", (connection) => {
    connections.add(connection);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ask = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const call = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(host.split(":")[1]),
          method,
          path,
          headers: {
            ...(text === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      call.on("error", reject);
      call.end(text);
    });

  const signIn = async (username = "ada"): Promise<string> => {
    const reply = await ask("POST", "/api/console/v1/sign-in", { origin: `https://${host}` }, {
      username,
      password: PASSWORD,
    });
    expect(reply.status).toBe(200);
    const setCookie = String(reply.headers["set-cookie"]);
    const match = new RegExp(`${WEB_SESSION_COOKIE}=([^;]+)`).exec(setCookie);
    if (match?.[1] === undefined) {
      throw new Error("no session cookie was set");
    }
    return match[1];
  };

  return { database, host, ask, signIn };
}

function upgrade(host: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      host: "127.0.0.1",
      port: Number(host.split(":")[1]),
      path: TEAM_SOCKET_PATH,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    call.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    call.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    call.on("error", reject);
    call.end();
  });
}

describe("the console's sign-in", () => {
  it("hands a browser an HttpOnly, Secure, host-only cookie for a right password", async () => {
    const team = await harness();
    const reply = await team.ask("POST", "/api/console/v1/sign-in", { origin: `https://${team.host}` }, {
      username: "ada",
      password: PASSWORD,
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      account: { username: "ada", displayName: "Ada", operator: false },
    });
    const cookie = String(reply.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-nlteam=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
  });

  it("refuses a wrong password, and a request with no origin or another one", async () => {
    const team = await harness();
    const wrong = await team.ask("POST", "/api/console/v1/sign-in", { origin: `https://${team.host}` }, {
      username: "ada",
      password: "not it",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const none = await team.ask("POST", "/api/console/v1/sign-in", {}, { username: "ada", password: PASSWORD });
    expect(none.status).toBe(403);
    const elsewhere = await team.ask("POST", "/api/console/v1/sign-in", { origin: "https://evil.example" }, {
      username: "ada",
      password: PASSWORD,
    });
    expect(elsewhere.status).toBe(403);
  });

  it("says who the cookie signs in, and stops once signed out", async () => {
    const team = await harness();
    const cookie = await team.signIn();
    const header = { cookie: `${WEB_SESSION_COOKIE}=${cookie}` };

    const who = await team.ask("GET", "/api/console/v1/session", header);
    expect(who.status).toBe(200);
    expect(JSON.parse(who.body).account.username).toBe("ada");

    // Sign-out is held to the origin like sign-in.
    expect((await team.ask("POST", "/api/console/v1/sign-out", header)).status).toBe(403);
    const out = await team.ask("POST", "/api/console/v1/sign-out", { ...header, origin: `https://${team.host}` });
    expect(out.status).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");

    expect((await team.ask("GET", "/api/console/v1/session", header)).status).toBe(401);
    expect((await team.ask("GET", "/api/console/v1/session")).status).toBe(401);
  });
});

describe("a console session", () => {
  it("ends when the account is disabled or its tokens are revoked", async () => {
    const team = await harness();
    const ada = requireUser(team.database, "ada");
    const first = createWebSession(team.database, ada).cookie;
    revokeUserTokens(team.database, "ada");
    expect(identifyWebSession(team.database, first)).toEqual({ kind: "refused", reason: "stale-epoch" });

    const second = createWebSession(team.database, requireUser(team.database, "ada")).cookie;
    expect(identifyWebSession(team.database, second).kind).toBe("identified");
    disableUser(team.database, "ada");
    expect(identifyWebSession(team.database, second).kind).toBe("refused");
  });

  it("ends when unused for its idle time, and in any case at its absolute limit", async () => {
    const team = await harness();
    const ada = requireUser(team.database, "ada");
    const start = 1_000_000;
    const { cookie } = createWebSession(team.database, ada, { now: start });

    expect(identifyWebSession(team.database, cookie, start + WEB_SESSION_IDLE_MS - 1).kind).toBe("identified");
    // Used at the end of its idle window, so it slides — but never past the absolute limit.
    let at = start + WEB_SESSION_IDLE_MS - 1;
    while (at + WEB_SESSION_IDLE_MS - 1 < start + WEB_SESSION_MAX_MS) {
      at += WEB_SESSION_IDLE_MS - 1;
      expect(identifyWebSession(team.database, cookie, at).kind).toBe("identified");
    }
    expect(identifyWebSession(team.database, cookie, start + WEB_SESSION_MAX_MS)).toEqual({
      kind: "refused",
      reason: "expired-session",
    });
    // And once over, the row is gone.
    expect(identifyWebSession(team.database, cookie, start)).toEqual({ kind: "refused", reason: "unknown-session" });
  });

  it("stores a hash of the cookie, never the cookie", async () => {
    const team = await harness();
    const { cookie } = createWebSession(team.database, requireUser(team.database, "ada"));
    const rows = team.database.prepare("SELECT id_hash FROM web_sessions").all() as { id_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_hash).not.toBe(cookie);
  });

  it("opens the socket from a page of this server, and only from one", async () => {
    const team = await harness();
    const cookie = await team.signIn();
    const header = { cookie: `${WEB_SESSION_COOKIE}=${cookie}` };

    expect(await upgrade(team.host, { ...header, origin: `https://${team.host}` })).toBe(101);
    // Another site's page starting the handshake would carry the cookie too.
    expect(await upgrade(team.host, { ...header, origin: "https://evil.example" })).toBe(403);
    expect(await upgrade(team.host, header)).toBe(403);
    expect(await upgrade(team.host, { cookie: `${WEB_SESSION_COOKIE}=nope`, origin: `https://${team.host}` })).toBe(
      401,
    );
  });

  it("receives hello over a socket signed in by the cookie", async () => {
    const team = await harness();
    const cookie = await team.signIn();
    const ws = new WebSocket(`ws://${team.host}${TEAM_SOCKET_PATH}`, {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${cookie}`, origin: `https://${team.host}` },
    } as unknown as string[]);
    sockets.push(ws);
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.onmessage = (message) => resolve(JSON.parse(String(message.data)) as Record<string, unknown>);
      ws.onerror = () => reject(new Error("the socket would not open"));
    });
    expect(hello["t"]).toBe("hello");
    expect((hello["account"] as { username: string }).username).toBe("ada");
  });
});

describe("the console's release notice", () => {
  it("tells an operator what GitHub last said, and nobody else anything", async () => {
    const tags = [{ name: "v9.0.0" }, { name: "v1.0.0" }];
    const updates = new UpdateCheck({
      enabled: true,
      current: "1.0.5",
      fetch: (async () => new Response(JSON.stringify(tags), { status: 200 })) as typeof fetch,
    });
    await updates.check();
    const team = await harness({ updates });

    const operator = { cookie: `${WEB_SESSION_COOKIE}=${await team.signIn("root")}` };
    const told = await team.ask("GET", "/api/console/v1/update", operator);
    expect(told.status).toBe(200);
    expect(JSON.parse(told.body)).toMatchObject({ current: "1.0.5", latest: "9.0.0", newer: true, enabled: true });

    const member = { cookie: `${WEB_SESSION_COOKIE}=${await team.signIn("ada")}` };
    expect((await team.ask("GET", "/api/console/v1/update", member)).status).toBe(403);
    expect((await team.ask("GET", "/api/console/v1/update")).status).toBe(401);
  });

  it("answers off rather than failing on a server that does not ask", async () => {
    const team = await harness();
    const operator = { cookie: `${WEB_SESSION_COOKIE}=${await team.signIn("root")}` };
    const told = await team.ask("GET", "/api/console/v1/update", operator);
    expect(JSON.parse(told.body)).toMatchObject({ enabled: false, newer: false });
  });
});

describe("the console's page", () => {
  it("serves the built page under a strict content security policy", async () => {
    const team = await harness();
    const page = await team.ask("GET", "/console/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>console</title>");
    expect(page.headers["content-security-policy"]).toBe(CONSOLE_CSP);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-cache");

    const asset = await team.ask("GET", "/console/assets/app-1234.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    // A screen rather than a file is the page, which routes itself.
    expect((await team.ask("GET", "/console/p/harbour")).body).toContain("<title>console</title>");
    // Even with dots in it, as a comparison's address has.
    expect((await team.ask("GET", "/console/p/harbour/compare/abc...current")).body).toContain("<title>console</title>");
    expect((await team.ask("GET", "/console/assets/gone.js")).status).toBe(404);
    expect((await team.ask("GET", "/")).headers["location"]).toBe("/console/");
  });

  it("never serves a file outside the page", async () => {
    const team = await harness();
    for (const path of ["/console/../secret.txt", "/console/%2e%2e/secret.txt", "/console/.env", "/console/x.txt"]) {
      const reply = await team.ask("GET", path);
      expect(reply.body).not.toContain("not for the page");
      expect(reply.status).toBe(404);
    }
  });

  it("says the console is not built rather than serving nothing", async () => {
    const team = await harness({ built: false });
    expect((await team.ask("GET", "/console/")).status).toBe(503);
  });
});
