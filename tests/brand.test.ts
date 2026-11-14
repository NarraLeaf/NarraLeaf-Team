/**
 * A team's look: an accent and a logo, set by an operator, shown to everybody.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { discoveryDocument } from "../src/identity/discovery.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { setBrandAccent, storedBrand } from "../src/identity/settings.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createWebSession, WEB_SESSION_COOKIE } from "../src/identity/websessions.js";
import type { TeamService } from "../src/team/service.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-brand-");
const hasher = new ScryptPasswordHasher({ cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 } as ScryptParameters);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

const servers: Server[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases.splice(0)) db.close();
});

async function serve() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  const keys = await KeyStore.open(identityLayout(root).keysDir);
  await createUser(database, hasher, { username: "root", password: "a password nobody guesses", groups: ["admin"] });
  await createUser(database, hasher, { username: "bob", password: "a password nobody guesses" });
  const service: TeamService = { database, keys, config: identityConfig({}), root, dataPort: 1, healthPort: 1 };
  const discovery = () =>
    discoveryDocument({
      database,
      host: "team.example",
      auth: { required: true, url: "https://team.example:41402" },
      data: { url: "lore://team.example:41337" },
      capabilities: () => [],
      authority: { sha256: "x" },
      version: "test",
    });
  const server = createServer(webHandler(discovery, { console: { service } }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const cookieFor = (name: string) => `${WEB_SESSION_COOKIE}=${createWebSession(database, requireUser(database, name)).cookie}`;
  const ask = (method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const call = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      call.on("error", reject);
      call.end(body);
    });
  return { database, ask, cookieFor, origin: `https://127.0.0.1:${port}`, discovery };
}

describe("a team's brand", () => {
  it("keeps an accent only as #rrggbb, and says nothing until one is chosen", async () => {
    const team = await serve();
    expect(team.discovery().brand).toBeUndefined();
    expect(() => setBrandAccent(team.database, "red")).toThrow();
    setBrandAccent(team.database, "#C46A8F");
    expect(storedBrand(team.database)).toEqual({ accent: "#c46a8f" });
    expect(team.discovery().brand).toEqual({ accent: "#c46a8f" });
  });

  it("takes a logo from an operator only, and serves it to anybody, content-addressed", async () => {
    const team = await serve();
    const refused = await team.ask("PUT", "/api/console/v1/brand/logo", { cookie: team.cookieFor("bob"), origin: team.origin }, PNG);
    expect(refused.status).toBe(403);

    const put = await team.ask("PUT", "/api/console/v1/brand/logo", { cookie: team.cookieFor("root"), origin: team.origin }, PNG);
    expect(put.status).toBe(200);
    const url = JSON.parse(put.body).logoUrl as string;
    const got = await team.ask("GET", url);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(team.discovery().brand?.logoUrl).toBe(`https://team.example:41402${url}`);
  });
});
