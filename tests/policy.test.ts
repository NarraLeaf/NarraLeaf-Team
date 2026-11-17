/**
 * Account policies and Studio's settings kept on the server: what a policy writes onto an
 * account, what it takes away, and the HTTP road Studio carries its settings by.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  accountPolicy,
  accountPolicyView,
  deletePolicyTemplate,
  parsePolicy,
  PolicyRefusal,
  savePolicyTemplate,
  setAccountPolicy,
} from "../src/identity/accountPolicy.js";
import { createApiToken, listApiTokens } from "../src/identity/apitokens.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { REQUIRE_TWO_FACTOR, setPolicy } from "../src/identity/policy.js";
import { twoFactorRequired } from "../src/identity/totp.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createWebSession, WEB_SESSION_COOKIE } from "../src/identity/websessions.js";
import { STUDIO_CONFIG_MAX_BYTES, STUDIO_CONFIG_PATH } from "../src/team/protocol.js";
import type { TeamService } from "../src/team/service.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-policy-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const databases: DatabaseSync[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases.splice(0)) db.close();
});

async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  for (const username of ["ada", "bob"]) {
    await createUser(database, hasher, { username, password: "a password nobody guesses" });
  }
  return { root, database, ada: requireUser(database, "ada"), bob: requireUser(database, "bob") };
}

describe("account policies", () => {
  it("reads only what it knows, and leaves out what changes nothing", () => {
    expect(parsePolicy({ apiTokens: "on", studioConfig: "read", unknown: 1, bio: {} })).toEqual({ studioConfig: "read", bio: {} });
    expect(() => parsePolicy({ apiTokens: "sometimes" })).toThrow(PolicyRefusal);
    expect(() => parsePolicy({ displayName: { value: "" } })).toThrow(PolicyRefusal);
    expect(() => parsePolicy({ apiTokenMaxDays: -1 })).toThrow(PolicyRefusal);
  });

  it("carries a template's change to every account that follows it, and leaves them a copy when it goes", async () => {
    const { database, ada, bob } = await team();
    const template = savePolicyTemplate(database, { name: "studio staff", policy: { timezone: { value: "Asia/Shanghai" } } });
    setAccountPolicy(database, ada.id, { template: template.id }, "root");
    setAccountPolicy(database, bob.id, { template: template.id }, "root");
    expect(requireUser(database, "ada").timezone).toBe("Asia/Shanghai");

    const changed = savePolicyTemplate(database, { id: template.id, name: "studio staff", policy: { timezone: { value: "Europe/London" } } });
    expect(changed.accounts).toBe(2);
    expect(requireUser(database, "bob").timezone).toBe("Europe/London");

    expect(deletePolicyTemplate(database, template.id)).toBe(true);
    const left = accountPolicy(database, bob.id);
    expect(left.template).toBeUndefined();
    expect(left.custom).toBe(true);
    expect(left.policy.timezone).toEqual({ value: "Europe/London" });
  });

  it("revokes the tokens a policy no longer allows", async () => {
    const { database, ada } = await team();
    const day = 24 * 60 * 60 * 1000;
    createApiToken(database, ada.id, { name: "reader", write: false, expiresAt: Date.now() + 10 * day });
    createApiToken(database, ada.id, { name: "writer", write: true, expiresAt: Date.now() + 10 * day });
    createApiToken(database, ada.id, { name: "forever", write: false });

    setAccountPolicy(database, ada.id, { policy: { apiTokens: "read", apiTokenMaxDays: 30 } }, "root");
    expect(listApiTokens(database, ada.id).map((token) => token.name)).toEqual(["reader"]);

    setAccountPolicy(database, ada.id, { policy: { apiTokens: "off" } }, "root");
    expect(listApiTokens(database, ada.id)).toEqual([]);
  });

  it("asks one account for a second step, or every account when the server says so", async () => {
    const { database, ada, bob } = await team();
    setAccountPolicy(database, ada.id, { policy: { requireTwoFactor: true } }, "root");
    expect(twoFactorRequired(database, ada.id)).toBe(true);
    expect(twoFactorRequired(database, bob.id)).toBe(false);

    setPolicy(database, REQUIRE_TWO_FACTOR, "true");
    expect(twoFactorRequired(database, bob.id)).toBe(true);
    expect(accountPolicyView(database, bob.id).serverRequiresTwoFactor).toBe(true);
  });
});

describe("Studio settings on the server", () => {
  async function serve() {
    const context = await team();
    const keys = await KeyStore.open(identityLayout(context.root).keysDir);
    const service: TeamService = { database: context.database, keys, config: identityConfig({}), root: context.root, dataPort: 1, healthPort: 1 };
    const server = createServer(webHandler(() => ({}) as never, { console: { service } }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const cookie = `${WEB_SESSION_COOKIE}=${createWebSession(context.database, context.ada).cookie}`;
    const ask = (method: string, headers: Record<string, string>, body?: Buffer) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
        const call = httpRequest({ host: "127.0.0.1", port, method, path: STUDIO_CONFIG_PATH, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        call.on("error", reject);
        call.end(body);
      });
    return { ...context, ask, cookie, origin: `https://127.0.0.1:${port}` };
  }

  const DOCUMENT = Buffer.from(JSON.stringify({ format: "narraleaf-studio-settings", version: 1, values: { theme: "dark" } }));

  it("keeps a document and gives the same bytes back", async () => {
    const t = await serve();
    const write = { cookie: t.cookie, origin: t.origin, "content-type": "application/json", "x-narraleaf-studio-version": "1.4.0" };

    const none = await t.ask("GET", { cookie: t.cookie });
    expect(none.status).toBe(404);
    expect(none.headers["x-narraleaf-studio-config"]).toBe("none");
    const put = await t.ask("PUT", write, DOCUMENT);
    expect(put.status).toBe(200);
    const status = JSON.parse(put.body.toString()) as { access: string; stored: { size: number; studioVersion: string; sha256: string } };
    expect(status.access).toBe("on");
    expect(status.stored.size).toBe(DOCUMENT.length);
    expect(status.stored.studioVersion).toBe("1.4.0");

    const got = await t.ask("GET", { cookie: t.cookie });
    expect(got.status).toBe(200);
    expect(got.body.equals(DOCUMENT)).toBe(true);
    expect(got.headers["etag"]).toBe(`"${status.stored.sha256}"`);
    expect((await t.ask("GET", { cookie: t.cookie, "if-none-match": `"${status.stored.sha256}"` })).status).toBe(304);
    expect((await t.ask("GET", {})).status).toBe(401);

    expect((await t.ask("DELETE", { cookie: t.cookie, origin: t.origin })).status).toBe(200);
    expect((await t.ask("GET", { cookie: t.cookie })).status).toBe(404);
  });

  it("refuses what is not JSON, what is too large, a write from elsewhere, and what the policy forbids", async () => {
    const t = await serve();
    const write = { cookie: t.cookie, origin: t.origin };
    expect((await t.ask("PUT", write, Buffer.from("not json"))).status).toBe(400);
    expect((await t.ask("PUT", write, Buffer.from("[1,2]"))).status).toBe(400);
    const big = await t.ask("PUT", write, Buffer.alloc(STUDIO_CONFIG_MAX_BYTES + 1, 0x20)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return { status: 413, headers: {}, body: Buffer.alloc(0) };
      throw error;
    });
    expect(big.status).toBe(413);
    expect((await t.ask("PUT", { cookie: t.cookie, origin: "https://evil.example" }, DOCUMENT)).status).toBe(403);

    await t.ask("PUT", write, DOCUMENT);
    setAccountPolicy(t.database, t.ada.id, { policy: { studioConfig: "read" } }, "root");
    expect((await t.ask("PUT", write, DOCUMENT)).status).toBe(403);
    expect((await t.ask("GET", { cookie: t.cookie })).status).toBe(200);

    // Turned off, what was kept goes with it.
    setAccountPolicy(t.database, t.ada.id, { policy: { studioConfig: "off" } }, "root");
    expect((await t.ask("GET", { cookie: t.cookie })).status).toBe(403);
    setAccountPolicy(t.database, t.ada.id, null, "root");
    expect((await t.ask("GET", { cookie: t.cookie })).status).toBe(404);
  });
});
