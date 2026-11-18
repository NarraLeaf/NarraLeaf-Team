/**
 * Builds, pictures beside comments, and share links: who may do what with
 * each, what the HTTP routes hand over, and what a share link never shows.
 */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { deleteBuild, listBuilds, recordBuild, updateBuild, cleanFileName, BuildRefusal } from "../src/collab/builds.js";
import { createShare, listShares, revokeShare, shareByToken, shareShows, ShareRefusal } from "../src/collab/shares.js";
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

const temporaryRoot = useTemporaryRoots("nlteam-builds-");
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

const FILES: Record<string, string> = {
  "editor/story/index.json": "{}",
  "editor/story/main.json": "MAIN",
  "editor/story/side.json": "SIDE",
  "assets/content/ab/cd/ef01": "PNGBYTES",
  "notes/secret.txt": "SECRET",
};

class FakeReadings {
  get(): undefined {
    return undefined;
  }
  async revisionFiles<T>(_projectId: string, revision: string, use: (tree: RevisionTree) => Promise<T>): Promise<T | undefined> {
    return use({
      revision: revision === "head" ? REVISION : revision,
      files: Object.entries(FILES).map(([path, text]) => ({ path, size: text.length, hash: `h-${text}` })),
      read: (path) => Promise.resolve(FILES[path] === undefined ? undefined : Buffer.from(FILES[path] ?? "")),
      close: () => Promise.resolve(),
    });
  }
}

async function team() {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  databases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});
  const service: TeamService = { database, keys, config, root, dataPort: 1, healthPort: 1, readings: new FakeReadings() };
  for (const username of ["ada", "eve", "vic", "out"]) {
    await createUser(database, hasher, { username, password: "a password nobody guesses" });
  }
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: requireUser(database, "ada").id });
  removeProjectMember(database, project.id, requireUser(database, "out").id);
  setProjectMember(database, { projectId: project.id, userId: requireUser(database, "eve").id, role: "editor" });
  setProjectMember(database, { projectId: project.id, userId: requireUser(database, "vic").id, role: "viewer" });
  const user = (name: string) => requireUser(database, name);
  return { root, database, keys, config, service, project, user };
}

async function serve() {
  const made = await team();
  const published: { topic: string; payload: unknown }[] = [];
  const server = createServer(
    webHandler(() => ({}) as never, { console: { service: made.service, publish: (topic, payload) => published.push({ topic, payload }) } }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const tokenFor = (name: string) => mintToken(made.user(name), made.keys.signingKey, made.config, {}).token;
  const call = (method: string, path: string, options: { token?: string; body?: Buffer | string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const headers: Record<string, string> = { ...options.headers };
      if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
      const request = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end(options.body);
    });
  return { ...made, port, call, tokenFor, published };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe("the builds store", () => {
  it("makes a project's first build the one to play, and moves that mark when asked", async () => {
    const { database, project, user } = await team();
    const base = { projectId: project.id, file: "game.zip", size: 3, sha256: "x".repeat(64), uploadedBy: user("eve").id };
    const first = recordBuild(database, { ...base, id: "b1", name: "one" }, 1);
    expect(first.latest).toBe(true);
    const second = recordBuild(database, { ...base, id: "b2", name: "two" }, 2);
    expect(second.latest).toBe(false);
    recordBuild(database, { ...base, id: "b3", name: "three", latest: true }, 3);
    const listed = listBuilds(database, user("vic"), project.id);
    expect(listed.map((build) => [build.id, build.latest])).toEqual([
      ["b3", true],
      ["b2", false],
      ["b1", false],
    ]);
    const moved = updateBuild(database, user("ada"), "b1", { latest: true });
    expect(moved.build.latest).toBe(true);
    expect(moved.unset?.id).toBe("b3");
    expect(moved.unset?.latest).toBe(false);
  });

  it("lets owners and editors change a build, a viewer not, and an outsider not even see it", async () => {
    const { database, project, user } = await team();
    recordBuild(database, { id: "b1", projectId: project.id, name: "one", file: "g.zip", size: 1, sha256: "s", uploadedBy: user("eve").id });
    expect(() => updateBuild(database, user("vic"), "b1", { name: "mine" })).toThrow(BuildRefusal);
    expect(() => updateBuild(database, user("out"), "b1", { name: "mine" })).toThrow(/no build/);
    expect(() => updateBuild(database, user("eve"), "b1", { name: "  " })).toThrow(/needs a name/);
    expect(updateBuild(database, user("eve"), "b1", { name: "renamed", note: "fixed" }).build).toMatchObject({ name: "renamed", note: "fixed" });
  });

  it("removes a build for its uploader or an owner, not another editor", async () => {
    const { root, database, project, user } = await team();
    setProjectMember(database, { projectId: project.id, userId: user("out").id, role: "editor" });
    recordBuild(database, { id: "b1", projectId: project.id, name: "one", file: "g.zip", size: 1, sha256: "s", uploadedBy: user("eve").id });
    await expect(deleteBuild(database, root, user("out"), "b1")).rejects.toThrow(/whoever uploaded/);
    await expect(deleteBuild(database, root, user("eve"), "b1")).resolves.toMatchObject({ id: "b1" });
    expect(listBuilds(database, user("ada"), project.id)).toEqual([]);
  });

  it("keeps file names safe to put in a header", () => {
    expect(cleanFileName('ga"me\r\n/../x.zip', "build")).toBe("game..x.zip");
    expect(cleanFileName("  ", "build")).toBe("build");
  });
});

describe("the share links store", () => {
  it("lets only owners make, list and take back links, and keeps only the token's hash", async () => {
    const { database, project, user } = await team();
    expect(() => createShare(database, user("eve"), { projectId: project.id })).toThrow(ShareRefusal);
    expect(() => listShares(database, user("eve"), project.id)).toThrow(/owners/);
    const { share, token } = createShare(database, user("ada"), { projectId: project.id, label: "proofs", allowComments: true, days: 7 }, 1000);
    expect(share).toMatchObject({ label: "proofs", scope: "project", revision: "head", allowComments: true, expiresAt: 1000 + 7 * 86_400_000 });
    const stored = database.prepare("SELECT token_hash FROM share_links WHERE id = ?").get(share.id) as { token_hash: string };
    expect(stored.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.token_hash).not.toContain(token);
    expect(shareByToken(database, token, 2000)?.id).toBe(share.id);
    expect(shareByToken(database, token, share.expiresAt!)).toBeUndefined();
    expect(shareByToken(database, "not-a-token-at-all-zz")).toBeUndefined();
    expect(() => revokeShare(database, user("eve"), share.id)).toThrow(/owners/);
    revokeShare(database, user("ada"), share.id);
    expect(shareByToken(database, token, 2000)).toBeUndefined();
  });

  it("refuses a path that climbs out, a bad revision, and an expiry out of range", async () => {
    const { database, project, user } = await team();
    const ada = user("ada");
    expect(() => createShare(database, ada, { projectId: project.id, paths: ["../etc/passwd"] })).toThrow(/not a path/);
    expect(() => createShare(database, ada, { projectId: project.id, paths: [] })).toThrow(/show something/);
    expect(() => createShare(database, ada, { projectId: project.id, revision: "../x" })).toThrow(/revision/);
    expect(() => createShare(database, ada, { projectId: project.id, days: 0 })).toThrow(/days/);
    expect(() => createShare(database, ada, { projectId: project.id, days: 366 })).toThrow(/days/);
  });

  it("shows exactly the listed paths, and everything under one ending in a slash", async () => {
    const { database, project, user } = await team();
    const { share } = createShare(database, user("ada"), { projectId: project.id, scope: "story:main", paths: ["editor/story/main.json", "assets/content/"] });
    expect(shareShows(share, "editor/story/main.json")).toBe(true);
    expect(shareShows(share, "assets/content/ab/cd/ef01")).toBe(true);
    expect(shareShows(share, "editor/story/side.json")).toBe(false);
    expect(shareShows(share, "editor/story/main.json.bak")).toBe(false);
  });
});

describe("the build routes", () => {
  it("takes a build from an editor, keeps its checksum, and hands the same bytes back", async () => {
    const t = await serve();
    const bytes = Buffer.from("a playable build");
    const sent = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/builds?name=Demo&file=demo.zip&platform=windows`, {
      token: t.tokenFor("eve"),
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(sent.status).toBe(200);
    const answer = JSON.parse(sent.body) as { build: { id: string; sha256: string; size: number; latest: boolean; uploadedBy: string } };
    expect(answer.build).toMatchObject({ size: bytes.length, latest: true, uploadedBy: "eve", sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(t.published.some((event) => event.topic === `project:${t.project.id}/builds`)).toBe(true);

    const got = await t.call("GET", `/api/team/v1/projects/${t.project.id}/builds/${answer.build.id}`, { token: t.tokenFor("vic") });
    expect(got.status).toBe(200);
    expect(got.body).toBe("a playable build");
    expect(got.headers["x-team-sha256"]).toBe(answer.build.sha256);
    expect(String(got.headers["content-disposition"])).toContain("demo.zip");
  });

  it("refuses a viewer's upload, an outsider's download, and nobody's at all", async () => {
    const t = await serve();
    const viewer = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/builds?name=x&file=x.zip`, { token: t.tokenFor("vic"), body: "x" });
    expect(viewer.status).toBe(403);
    const outsider = await t.call("GET", `/api/team/v1/projects/${t.project.id}/builds/nothing`, { token: t.tokenFor("out") });
    expect(outsider.status).toBe(404);
    const nobody = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/builds?name=x&file=x.zip`, { body: "x" });
    expect(nobody.status).toBe(401);
  });
});

describe("the picture routes", () => {
  it("keeps a PNG from a member who may comment and refuses what is not a picture", async () => {
    const t = await serve();
    const kept = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/attachments`, { token: t.tokenFor("eve"), body: PNG });
    expect(kept.status).toBe(200);
    const answer = JSON.parse(kept.body) as { attachment: { id: string; type: string }; url: string };
    expect(answer.attachment.type).toBe("png");
    const shown = await t.call("GET", answer.url, { token: t.tokenFor("vic") });
    expect(shown.status).toBe(200);
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["content-security-policy"]).toContain("sandbox");

    const svg = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/attachments`, { token: t.tokenFor("eve"), body: "<svg onload=alert(1)>" });
    expect(svg.status).toBe(415);
    const viewer = await t.call("PUT", `/api/team/v1/projects/${t.project.id}/attachments`, { token: t.tokenFor("vic"), body: PNG });
    expect(viewer.status).toBe(403);
  });
});

describe("a share link's routes", () => {
  it("opens for anybody with the token, shows only its paths, and always at its own revision", async () => {
    const t = await serve();
    const { token } = createShare(t.database, t.user("ada"), {
      projectId: t.project.id,
      scope: "story:main",
      revision: "1234567890abcdef",
      paths: ["editor/story/index.json", "editor/story/main.json", "assets/content/"],
      allowComments: true,
    });
    const view = await t.call("GET", `/api/team/v1/share/${token}`);
    expect(view.status).toBe(200);
    expect(JSON.parse(view.body)).toMatchObject({ projectName: "harbour", scope: "story:main", revision: "1234567890abcdef", allowComments: true });
    expect(view.body).not.toMatch(/\bada\b/);

    const tree = await t.call("GET", `/api/team/v1/share/${token}/tree/head`);
    expect(tree.status).toBe(200);
    const listed = JSON.parse(tree.body) as { revision: string; files: { path: string }[] };
    expect(listed.revision).toBe("1234567890abcdef");
    expect(listed.files.map((file) => file.path).sort()).toEqual(["assets/content/ab/cd/ef01", "editor/story/index.json", "editor/story/main.json"]);

    expect((await t.call("GET", `/api/team/v1/share/${token}/raw/head/editor/story/main.json`)).body).toBe("MAIN");
    expect((await t.call("GET", `/api/team/v1/share/${token}/raw/head/editor/story/side.json`)).status).toBe(404);
    expect((await t.call("GET", `/api/team/v1/share/${token}/raw/head/notes/secret.txt`)).status).toBe(404);
    expect((await t.call("GET", `/api/team/v1/share/not-a-real-token-here/tree/head`)).status).toBe(404);

    const counted = t.database.prepare("SELECT uses FROM share_links").get() as { uses: number };
    expect(counted.uses).toBe(1);
  });

  it("takes a guest's note from this page only, on the shared story only, and never once the link is taken back", async () => {
    const t = await serve();
    const { share, token } = createShare(t.database, t.user("ada"), {
      projectId: t.project.id,
      scope: "story:main",
      paths: ["editor/story/main.json"],
      allowComments: true,
    });
    const origin = { origin: `http://127.0.0.1:${t.port}`, "content-type": "application/json" };
    const note = (body: unknown, headers: Record<string, string> = origin) =>
      t.call("POST", `/api/team/v1/share/${token}/comments`, { body: JSON.stringify(body), headers });

    expect((await note({ name: "Kim", body: "typo here" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await note({ name: "Kim", body: "typo", document: "story:side" })).status).toBe(400);
    expect((await note({ name: "", body: "typo" })).status).toBe(400);

    const sent = await note({ name: "Kim:\u0007", body: "typo here", document: "story:main", element: "scene/line" });
    expect(sent.status).toBe(200);
    const id = (JSON.parse(sent.body) as { thread: string }).thread;
    const row = t.database.prepare("SELECT created_by, document, element FROM threads WHERE id = ?").get(id) as Record<string, unknown>;
    expect({ ...row }).toEqual({ created_by: "guest:Kim", document: "story:main", element: "scene/line" });
    expect(t.published.some((event) => event.topic === `project:${t.project.id}/threads`)).toBe(true);

    revokeShare(t.database, t.user("ada"), share.id);
    expect((await note({ name: "Kim", body: "again" })).status).toBe(404);
  });

  it("refuses a note on a link that takes none", async () => {
    const t = await serve();
    const { token } = createShare(t.database, t.user("ada"), { projectId: t.project.id });
    const sent = await t.call("POST", `/api/team/v1/share/${token}/comments`, {
      body: JSON.stringify({ name: "Kim", body: "hello" }),
      headers: { origin: `http://127.0.0.1:${t.port}`, "content-type": "application/json" },
    });
    expect(sent.status).toBe(403);
  });
});
