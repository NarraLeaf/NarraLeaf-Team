/**
 * A project's files at a revision, as the web console reads them: who may, what
 * is served as itself, and what can never be reached.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { removeProjectMember, setProjectMember } from "../src/projects/members.js";
import type { RevisionTree } from "../src/projects/read.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import type { TeamService } from "../src/team/service.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-files-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const REVISION = "abcdef0123456789";

const servers: Server[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases.splice(0)) db.close();
});

/** A revision with a handful of files, standing in for Team's checkout. */
const FILES: Record<string, string> = {
  "project.json": '{"name":"harbour"}',
  "editor/story/index.json": '{"scenes":[]}',
  "assets/bg/sea.png": "PNGBYTES",
  "assets/evil.svg": "<svg onload=alert(1)></svg>",
  "notes/archive.zip": "ZIP",
  "assets/content/ab/cd/ef01": "PNGBYTES",
};

function fakeTree(revision: string): RevisionTree {
  return {
    revision: revision === "head" ? REVISION : revision,
    files: Object.entries(FILES).map(([path, text]) => ({ path, size: text.length })),
    read: (path) => Promise.resolve(FILES[path] === undefined ? undefined : Buffer.from(FILES[path] ?? "")),
    close: () => Promise.resolve(),
  };
}

class FakeReadings {
  private readonly missing = "0000000000";
  get(): undefined {
    return undefined;
  }
  async revisionFiles<T>(_projectId: string, revision: string, use: (tree: RevisionTree) => Promise<T>): Promise<T | undefined> {
    return revision === this.missing ? undefined : use(fakeTree(revision));
  }
}

async function serve() {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  databases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});
  const service: TeamService = {
    database,
    keys,
    config,
    root,
    dataPort: 1,
    healthPort: 1,
    // A class, not an object literal: the real reader is one, and a method lifted
    // off a class loses `this` — which a literal would never show.
    readings: new FakeReadings(),
  };
  await createUser(database, hasher, { username: "ada", password: "a password nobody guesses" });
  await createUser(database, hasher, { username: "vic", password: "a password nobody guesses" });
  await createUser(database, hasher, { username: "nora", password: "a password nobody guesses" });
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: requireUser(database, "ada").id });
  setProjectMember(database, { projectId: project.id, userId: requireUser(database, "vic").id, role: "viewer" });
  removeProjectMember(database, project.id, requireUser(database, "nora").id);

  const server = createServer(webHandler(() => ({}) as never, { console: { service } }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const tokenFor = (name: string) => mintToken(requireUser(database, name), keys.signingKey, config, {}).token;
  const get = (path: string, token?: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const call = httpRequest(
        { host: "127.0.0.1", port, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      call.on("error", reject);
      call.end();
    });
  return { project, get, tokenFor };
}

describe("a revision's files", () => {
  it("lists the tree to any member, a viewer included, and resolves head", async () => {
    const team = await serve();
    const reply = await team.get(`/api/team/v1/projects/${team.project.id}/tree/head`, team.tokenFor("vic"));
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as { revision: string; files: { path: string }[]; total: number };
    expect(body.revision).toBe(REVISION);
    expect(body.total).toBe(6);
    expect(reply.headers["cache-control"]).toBe("private, no-cache");

    const pinned = await team.get(`/api/team/v1/projects/harbour/tree/${REVISION}`, team.tokenFor("ada"));
    expect(pinned.headers["cache-control"]).toContain("immutable");
  });

  it("is not there for an account with no role, or nobody at all", async () => {
    const team = await serve();
    expect((await team.get(`/api/team/v1/projects/${team.project.id}/tree/head`, team.tokenFor("nora"))).status).toBe(404);
    expect((await team.get(`/api/team/v1/projects/${team.project.id}/tree/head`)).status).toBe(401);
  });

  it("serves a known type as itself, under a sandbox, and anything else as an attachment", async () => {
    const team = await serve();
    const token = team.tokenFor("ada");
    const story = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/editor/story/index.json`, token);
    expect(story.status).toBe(200);
    expect(story.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(story.body).toBe('{"scenes":[]}');
    expect(story.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(story.headers["content-security-policy"])).toContain("sandbox");

    const svg = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/assets/evil.svg`, token);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(String(svg.headers["content-security-policy"])).toMatch(/^sandbox;/);

    const zip = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/notes/archive.zip`, token);
    expect(zip.headers["content-type"]).toBe("application/octet-stream");
    expect(String(zip.headers["content-disposition"])).toContain("attachment");
  });

  it("serves an asset's extensionless bytes as the type the page names, from that directory only", async () => {
    const team = await serve();
    const token = team.tokenFor("ada");
    const asset = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/assets/content/ab/cd/ef01?as=png`, token);
    expect(asset.headers["content-type"]).toBe("image/png");
    const bogus = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/assets/content/ab/cd/ef01?as=html`, token);
    expect(bogus.headers["content-type"]).toBe("application/octet-stream");
    const elsewhere = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/notes/archive.zip?as=png`, token);
    expect(elsewhere.headers["content-type"]).toBe("application/octet-stream");
  });

  it("names nothing outside the revision's own tree", async () => {
    const team = await serve();
    const token = team.tokenFor("ada");
    for (const path of ["../../team.db", "%2e%2e/%2e%2e/team.db", "assets%2F..%2Fproject.json", "missing.json"]) {
      const reply = await team.get(`/api/team/v1/projects/${team.project.id}/raw/head/${path}`, token);
      expect(reply.status).toBe(404);
    }
    expect((await team.get(`/api/team/v1/projects/${team.project.id}/raw/not-a-revision!/x`, token)).status).toBe(400);
    expect((await team.get(`/api/team/v1/projects/${team.project.id}/tree/0000000000`, token)).status).toBe(404);
  });
});
