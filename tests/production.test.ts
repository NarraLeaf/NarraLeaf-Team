/**
 * Review requests, milestones, webhooks and what a to-do asks for.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMilestone, deleteMilestone, listMilestones, MilestoneRefusal } from "../src/collab/milestones.js";
import { createReview, listReviews, ReviewRefusal, updateReview } from "../src/collab/reviews.js";
import { createTodo, TodoRefusal, updateTodo } from "../src/collab/todos.js";
import {
  checkWebhookUrl,
  createWebhook,
  deliverOne,
  webhookBody,
  webhooksFor,
  WebhookRefusal,
  type WebhookFetch,
} from "../src/collab/webhooks.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { removeProjectMember, setProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-production-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  for (const username of ["ada", "bob", "vee", "nora"]) {
    await createUser(database, hasher, { username, password: "a password nobody guesses" });
  }
  const user = (name: string) => requireUser(database, name);
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("vee").id, role: "viewer", addedBy: user("ada").id });
  removeProjectMember(database, project.id, user("nora").id);
  return { database, user, project };
}

describe("review requests", () => {
  it("are asked of a member by anybody who may comment, and answered by the reviewer alone", async () => {
    const { database, user, project } = await team();
    const review = createReview(database, user("ada"), { projectId: project.id, reviewerId: user("bob").id, toRevision: "r9", title: "chapter 3" });
    expect(review.status).toBe("open");

    expect(() => createReview(database, user("vee"), { projectId: project.id, reviewerId: user("bob").id, toRevision: "r9", title: "x" })).toThrow(ReviewRefusal);
    expect(() => createReview(database, user("ada"), { projectId: project.id, reviewerId: user("nora").id, toRevision: "r9", title: "x" })).toThrow(ReviewRefusal);
    expect(() => createReview(database, user("ada"), { projectId: project.id, reviewerId: user("ada").id, toRevision: "r9", title: "x" })).toThrow(ReviewRefusal);

    expect(() => updateReview(database, user("ada"), review.id, { status: "approved" })).toThrow(ReviewRefusal);
    expect(updateReview(database, user("bob"), review.id, { status: "changes", verdictNote: "line 4" }).verdictNote).toBe("line 4");
    expect(() => updateReview(database, user("bob"), review.id, { status: "withdrawn" })).toThrow(ReviewRefusal);
    expect(updateReview(database, user("ada"), review.id, { status: "withdrawn" }).status).toBe("withdrawn");
    expect(() => updateReview(database, user("nora"), review.id, { status: "approved" })).toThrow(ReviewRefusal);
  });

  it("lists what the viewer asked for or is asked, open ones unless closed are wanted", async () => {
    const { database, user, project } = await team();
    const one = createReview(database, user("ada"), { projectId: project.id, reviewerId: user("bob").id, toRevision: "r1", title: "one" });
    createReview(database, user("bob"), { projectId: project.id, reviewerId: user("ada").id, toRevision: "r2", title: "two" });
    updateReview(database, user("bob"), one.id, { status: "approved" });
    expect(listReviews(database, user("bob"), { includeClosed: false }).map((r) => r.title)).toEqual(["two"]);
    expect(listReviews(database, user("bob"), { includeClosed: true }).map((r) => r.title).sort()).toEqual(["one", "two"]);
    expect(listReviews(database, user("nora"), { includeClosed: true })).toEqual([]);
  });
});

describe("milestones", () => {
  it("are named by owners and editors, once per name, and taken off by their maker or an owner", async () => {
    const { database, user, project } = await team();
    const demo = createMilestone(database, user("bob"), { projectId: project.id, name: "Demo 1", revision: "r5" });
    expect(() => createMilestone(database, user("ada"), { projectId: project.id, name: "Demo 1", revision: "r6" })).toThrow(MilestoneRefusal);
    expect(() => createMilestone(database, user("vee"), { projectId: project.id, name: "Demo 2", revision: "r6" })).toThrow(MilestoneRefusal);
    expect(() => listMilestones(database, user("nora"), project.id)).toThrow(MilestoneRefusal);
    expect(listMilestones(database, user("vee"), project.id).map((m) => m.name)).toEqual(["Demo 1"]);

    const other = createMilestone(database, user("ada"), { projectId: project.id, name: "Fest", revision: "r7" });
    expect(() => deleteMilestone(database, user("bob"), other.id)).toThrow(MilestoneRefusal);
    deleteMilestone(database, user("ada"), demo.id);
    expect(listMilestones(database, user("ada"), project.id).map((m) => m.name)).toEqual(["Fest"]);
  });
});

describe("what a to-do asks for", () => {
  it("keeps asset, translation and voice to-dos in a project, with a locale where one is about a language", async () => {
    const { database, user, project } = await team();
    expect(() => createTodo(database, user("ada"), { title: "x", kind: "asset" })).toThrow(TodoRefusal);
    expect(() => createTodo(database, user("ada"), { title: "x", kind: "translation", projectId: project.id, visibility: "project" })).toThrow(TodoRefusal);

    const ask = createTodo(database, user("ada"), {
      title: "crying sprite",
      kind: "asset",
      projectId: project.id,
      visibility: "project",
      assigneeId: user("bob").id,
      anchor: { document: "story:s1", element: "c1/b1" },
    });
    expect(ask.kind).toBe("asset");
    const done = updateTodo(database, user("bob"), ask.id, { status: "done", asset: "asset-42" });
    expect(done.asset).toBe("asset-42");

    const ja = createTodo(database, user("ada"), { title: "translate ch.1", kind: "translation", locale: "ja", projectId: project.id, visibility: "project" });
    expect([ja.kind, ja.locale]).toEqual(["translation", "ja"]);
    expect(createTodo(database, user("ada"), { title: "plain" }).kind).toBe("task");
  });
});

describe("webhooks", () => {
  it("post only to http and https, with no credentials in the address", () => {
    expect(checkWebhookUrl("https://hooks.example/abc?token=1")).toBe("https://hooks.example/abc?token=1");
    expect(() => checkWebhookUrl("file:///etc/passwd")).toThrow(WebhookRefusal);
    expect(() => checkWebhookUrl("https://user:pass@hooks.example/")).toThrow(WebhookRefusal);
    expect(() => checkWebhookUrl("not a url")).toThrow(WebhookRefusal);
  });

  it("shape the body for the service and sign it", () => {
    const event = { type: "commit" as const, projectId: "p", summary: "ada committed: tidy", actor: "ada", ref: "r1" };
    const hook = { secret: "s3cret" };
    expect(JSON.parse(webhookBody({ ...hook, format: "slack" }, event, "harbour", 1).body)).toEqual({ text: "[harbour] ada committed: tidy" });
    expect(JSON.parse(webhookBody({ ...hook, format: "discord" }, event, "harbour", 1).body)).toEqual({ content: "[harbour] ada committed: tidy" });
    expect(JSON.parse(webhookBody({ ...hook, format: "feishu" }, event, "harbour", 1).body)).toEqual({
      msg_type: "text",
      content: { text: "[harbour] ada committed: tidy" },
    });
    const json = webhookBody({ ...hook, format: "json" }, event, "harbour", 1);
    expect(JSON.parse(json.body)).toMatchObject({ event: "commit", project: { id: "p", name: "harbour" }, ref: "r1" });
    expect(json.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(webhookBody({ ...hook, format: "json" }, event, "harbour", 1).signature).toBe(json.signature);
  });

  it("go to the webhooks for that project or every project that want the event, and record how it went", async () => {
    const { database, user, project } = await team();
    const other = createProject(database, { id: newProjectId(), name: "other", createdBy: user("ada").id });
    const everywhere = createWebhook(database, user("ada"), { url: "https://a.example/", format: "json", events: ["commit"] });
    createWebhook(database, user("ada"), { projectId: other.id, url: "https://b.example/", format: "json", events: ["commit"] });
    createWebhook(database, user("ada"), { projectId: project.id, url: "https://c.example/", format: "slack", events: ["thread"] });
    const event = { type: "commit" as const, projectId: project.id, summary: "x" };
    expect(webhooksFor(database, event).map((hook) => hook.url)).toEqual(["https://a.example/"]);

    const seen: { url: string; headers: Record<string, string>; redirect: string }[] = [];
    const ok: WebhookFetch = async (url, init) => {
      seen.push({ url, headers: init.headers, redirect: init.redirect });
      return { status: 204 };
    };
    expect(await deliverOne(database, everywhere, event, ok, 1234)).toBe(204);
    expect(seen[0]).toMatchObject({ url: "https://a.example/", redirect: "manual" });
    expect(seen[0]!.headers["x-nlteam-signature"]).toMatch(/^sha256=/);
    expect(database.prepare("SELECT last_status, last_at FROM webhooks WHERE id = ?").get(everywhere.id)).toEqual({ last_status: 204, last_at: 1234 });

    const down: WebhookFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await deliverOne(database, everywhere, event, down)).toBe(0);
  });
});
