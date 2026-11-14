/**
 * Activity, to-dos, notifications and avatars: who sees what.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { accountForAuthor, activityHeatmap, listActivity, recordActivity, recordCommits } from "../src/collab/activity.js";
import { listNotifications, markRead, mentionsIn, notify } from "../src/collab/notifications.js";
import { createTodo, listTodos, TodoRefusal, updateTodo } from "../src/collab/todos.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createWebSession, WEB_SESSION_COOKIE } from "../src/identity/websessions.js";
import { removeProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { judgeTopic } from "../src/team/topics.js";
import type { TeamService } from "../src/team/service.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-collab-");
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
  for (const [username, extra] of [
    ["ada", { email: "ada@example.com", displayName: "Ada Lovelace" }],
    ["bob", { displayName: "Bob" }],
    ["nora", { displayName: "Nora" }],
  ] as const) {
    await createUser(database, hasher, { username, password: "a password nobody guesses", ...extra });
  }
  const user = (name: string) => requireUser(database, name);
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: user("ada").id });
  removeProjectMember(database, project.id, user("nora").id);
  return { root, database, user, project };
}

describe("activity", () => {
  it("matches a commit author to an account by address, username or a unique name, and keeps the string", async () => {
    const { database, user } = await team();
    expect(accountForAuthor(database, "Somebody <ada@example.com>")?.username).toBe("ada");
    expect(accountForAuthor(database, "bob")?.username).toBe("bob");
    expect(accountForAuthor(database, "Ada Lovelace")?.username).toBe("ada");
    expect(accountForAuthor(database, "A Stranger <x@y.z>")).toBeUndefined();
    void user;
  });

  it("records a revision once however often it is seen", async () => {
    const { database, project } = await team();
    const revisions = [{ id: "r1", at: 1000, by: "ada", message: "first" }];
    expect(recordCommits(database, project.id, revisions)).toBe(1);
    expect(recordCommits(database, project.id, revisions)).toBe(0);
  });

  it("shows a project's activity to its members only, and a private row to its owner only", async () => {
    const { database, user, project } = await team();
    recordActivity(database, { accountId: user("ada").id, projectId: project.id, kind: "thread", ref: "t1", summary: "a thread" });
    recordActivity(database, { accountId: user("ada").id, kind: "todo-done", ref: "x", summary: "secret", private: true });

    expect(listActivity(database, user("ada"), { accountId: user("ada").id, limit: 10 }).activity).toHaveLength(2);
    expect(listActivity(database, user("bob"), { accountId: user("ada").id, limit: 10 }).activity.map((row) => row.kind)).toEqual(["thread"]);
    expect(listActivity(database, user("nora"), { accountId: user("ada").id, limit: 10 }).activity).toEqual([]);
  });

  it("counts a day in the viewer's time zone", async () => {
    const { database, user, project } = await team();
    // 2026-11-13T23:30Z is the 14th in UTC+8.
    const at = Date.UTC(2026, 10, 13, 23, 30);
    recordActivity(database, { accountId: user("ada").id, projectId: project.id, kind: "comment", at });
    const utc = activityHeatmap(database, user("ada"), { accountId: user("ada").id, tzOffsetMinutes: 0, days: 30, now: at + 1000 });
    const east = activityHeatmap(database, user("ada"), { accountId: user("ada").id, tzOffsetMinutes: -480, days: 30, now: at + 1000 });
    expect(utc).toEqual([{ day: "2026-11-13", count: 1 }]);
    expect(east).toEqual([{ day: "2026-11-14", count: 1 }]);
  });
});

describe("to-dos", () => {
  it("keeps a private to-do from everybody but its owner, and refuses to assign one", async () => {
    const { database, user, project } = await team();
    createTodo(database, user("ada"), { title: "my own note" });
    expect(() => createTodo(database, user("ada"), { title: "x", projectId: project.id, assigneeId: user("bob").id })).toThrow(TodoRefusal);
    expect(listTodos(database, user("ada"), { includeDone: false }).map((todo) => todo.title)).toEqual(["my own note"]);
    expect(listTodos(database, user("bob"), { includeDone: false })).toEqual([]);
  });

  it("shows a project to-do to its members, lets the assignee move it, and nothing else", async () => {
    const { database, user, project } = await team();
    const todo = createTodo(database, user("ada"), { title: "draw the harbour", projectId: project.id, visibility: "project", assigneeId: user("bob").id });
    expect(listTodos(database, user("bob"), { projectId: project.id, includeDone: false }).map((t) => t.id)).toEqual([todo.id]);
    expect(listTodos(database, user("bob"), { includeDone: false }).map((t) => t.id)).toEqual([todo.id]);
    expect(listTodos(database, user("nora"), { projectId: project.id, includeDone: false })).toEqual([]);

    expect(updateTodo(database, user("bob"), todo.id, { status: "done" }).doneAt).toBeDefined();
    expect(() => updateTodo(database, user("bob"), todo.id, { title: "renamed" })).toThrow(TodoRefusal);
    expect(() => updateTodo(database, user("nora"), todo.id, { status: "open" })).toThrow(TodoRefusal);
  });

  it("keeps the revision that finished a to-do while it stays done, and lets the assignee name it", async () => {
    const { database, user, project } = await team();
    const todo = createTodo(database, user("ada"), { title: "draw the harbour", projectId: project.id, visibility: "project", assigneeId: user("bob").id });
    expect(() => updateTodo(database, user("bob"), todo.id, { doneRevision: "r9" })).toThrow(TodoRefusal);
    expect(() => updateTodo(database, user("bob"), todo.id, { status: "doing", doneRevision: "r9" })).toThrow(TodoRefusal);

    const done = updateTodo(database, user("bob"), todo.id, { status: "done", doneRevision: "r9" });
    expect(done.doneRevision).toBe("r9");
    expect(updateTodo(database, user("ada"), todo.id, { title: "draw the harbour at night" }).doneRevision).toBe("r9");
    expect(updateTodo(database, user("bob"), todo.id, { status: "open" }).doneRevision).toBeUndefined();

    const mine = createTodo(database, user("ada"), { title: "a note" });
    expect(() => updateTodo(database, user("ada"), mine.id, { status: "done", doneRevision: "r9" })).toThrow(TodoRefusal);
    expect(() => createTodo(database, user("ada"), { title: "x", doneRevision: "r9" })).toThrow(TodoRefusal);
  });

  it("refuses to give a project to-do to somebody outside the project", async () => {
    const { database, user, project } = await team();
    expect(() =>
      createTodo(database, user("ada"), { title: "x", projectId: project.id, visibility: "project", assigneeId: user("nora").id }),
    ).toThrow(TodoRefusal);
  });
});

describe("notifications", () => {
  it("finds mentions, not addresses", () => {
    expect(mentionsIn("@bob look at this, and cc @ada. mail ada@example.com")).toEqual(["bob", "ada"]);
  });

  it("tells nobody about a project they cannot see, and nobody about their own act", async () => {
    const { database, user, project } = await team();
    const written = notify(database, [user("bob").id, user("nora").id, user("ada").id], {
      kind: "mention",
      projectId: project.id,
      ref: "t1",
      actorId: user("ada").id,
      summary: "@bob @nora",
    });
    expect([...written.keys()]).toEqual([user("bob").id]);
    expect(listNotifications(database, user("bob").id, { unreadOnly: true, limit: 10 }).unread).toBe(1);
    expect(markRead(database, user("bob").id, "all")).toBe(1);
    expect(listNotifications(database, user("bob").id, { unreadOnly: true, limit: 10 }).notifications).toEqual([]);
  });
});

describe("an account's own topics", () => {
  it("are held by that account alone", async () => {
    const { database, user } = await team();
    expect(judgeTopic(database, user("ada"), `account:${user("ada").id}/notifications`).kind).toBe("allowed");
    expect(judgeTopic(database, user("bob"), `account:${user("ada").id}/notifications`).kind).toBe("unknown");
    expect(judgeTopic(database, user("ada"), `account:${user("ada").id}/secrets`).kind).toBe("unknown");
  });
});

describe("avatars", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

  async function serve() {
    const context = await team();
    const keys = await KeyStore.open(identityLayout(context.root).keysDir);
    const service: TeamService = { database: context.database, keys, config: identityConfig({}), root: context.root, dataPort: 1, healthPort: 1 };
    const server = createServer(webHandler(() => ({}) as never, { console: { service } }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const cookie = `${WEB_SESSION_COOKIE}=${createWebSession(context.database, context.user("ada")).cookie}`;
    const ask = (method: string, path: string, headers: Record<string, string>, body?: Buffer) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
        const call = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        call.on("error", reject);
        call.end(body);
      });
    return { ...context, ask, cookie, origin: `https://127.0.0.1:${port}` };
  }

  it("takes a real image from this server's page, and serves it content-addressed", async () => {
    const t = await serve();
    const put = await t.ask("PUT", "/api/console/v1/avatar", { cookie: t.cookie, origin: t.origin, "content-type": "image/png" }, PNG);
    expect(put.status).toBe(200);
    const url = JSON.parse(put.body.toString()).avatarUrl as string;
    expect(url).toMatch(/^\/api\/team\/v1\/avatars\/ada\/[0-9a-f]{64}\.png$/);

    const got = await t.ask("GET", url, { cookie: t.cookie });
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toContain("immutable");
    expect((await t.ask("GET", url, {})).status).toBe(401);
  });

  it("refuses what is not an image, what is too big, and a request from elsewhere", async () => {
    const t = await serve();
    const headers = { cookie: t.cookie, origin: t.origin };
    expect((await t.ask("PUT", "/api/console/v1/avatar", headers, Buffer.from("<svg onload=x>"))).status).toBe(415);
    // Refused before the body is read: the answer is a 413, or - when the server closes the
    // connection while this client is still writing - the write failing. Either way nothing is kept.
    const big = await t.ask("PUT", "/api/console/v1/avatar", headers, Buffer.alloc(600 * 1024)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return { status: 413, headers: {}, body: Buffer.alloc(0) };
      throw error;
    });
    expect(big.status).toBe(413);
    expect(t.database.prepare("SELECT avatar FROM users WHERE username = 'ada'").get()).toEqual({ avatar: null });
    expect((await t.ask("PUT", "/api/console/v1/avatar", { cookie: t.cookie, origin: "https://evil.example" }, PNG)).status).toBe(403);
  });
});
