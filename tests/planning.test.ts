/**
 * A project's glossary, where its voiced lines stand, project templates, and to-dos that count
 * toward a milestone.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMilestone, deleteMilestone, findMilestone } from "../src/collab/milestones.js";
import { createTodo, findTodo, TodoRefusal, todoView, updateTodo } from "../src/collab/todos.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { findProjectMember, removeProjectMember, setProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { planningMethods } from "../src/team/methods/planning.js";
import type { MethodContext } from "../src/team/methods.js";
import { TEAM_METHODS } from "../src/team/protocol.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-planning-");
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
  for (const username of ["ada", "bob", "vee", "nora", "tess"]) {
    await createUser(database, hasher, { username, password: "a password nobody guesses" });
  }
  const user = (name: string) => requireUser(database, name);
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("bob").id, role: "editor", addedBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("vee").id, role: "viewer", addedBy: user("ada").id });
  removeProjectMember(database, project.id, user("nora").id);
  removeProjectMember(database, project.id, user("tess").id);
  return { database, user, project };
}

function contextFor(database: DatabaseSync, name: string, published: unknown[] = []): MethodContext {
  const user = requireUser(database, name);
  return {
    options: { database } as unknown as MethodContext["options"],
    user,
    account: { username: user.username, displayName: user.displayName } as unknown as MethodContext["account"],
    publish: (_topic, payload) => published.push(payload),
    connection: { id: "c", kernel: { agree: () => {}, forget: () => {}, agreed: () => true } },
    presence: {} as MethodContext["presence"],
  };
}

function method(name: string) {
  const found = planningMethods().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no method ${name}`);
  return (params: unknown, context: MethodContext) => Promise.resolve().then(() => found.handle(params, context)) as Promise<Record<string, unknown>>;
}

describe("glossary", () => {
  it("keeps a term and its agreed words, for the people who may edit localization", async () => {
    const { database, project } = await team();
    const set = method(TEAM_METHODS.glossarySet);
    const list = method(TEAM_METHODS.glossaryList);
    const remove = method(TEAM_METHODS.glossaryDelete);

    const made = (await set({ project: project.id, term: "灯塔", translations: { en: "lighthouse", ja: "灯台" }, note: "the place, not the job" }, contextFor(database, "bob")))[
      "entry"
    ] as { id: string; term: string; translations: Record<string, string>; updatedBy?: string };
    expect(made).toMatchObject({ term: "灯塔", translations: { en: "lighthouse", ja: "灯台" }, updatedBy: "bob" });

    await expect(set({ project: project.id, term: "灯塔", translations: {} }, contextFor(database, "ada"))).rejects.toThrow(/already/);
    await expect(set({ project: project.id, term: "港口", translations: { en: "harbour" } }, contextFor(database, "vee"))).rejects.toThrow();
    await expect(set({ project: project.id, term: "港口", translations: { "not a locale!": "x" } }, contextFor(database, "bob"))).rejects.toThrow();
    await expect(list({ project: project.id }, contextFor(database, "nora"))).rejects.toThrow(/no project/);

    const changed = (await set({ project: project.id, id: made.id, term: "灯塔", translations: { en: "beacon" } }, contextFor(database, "ada")))["entry"];
    expect(changed).toMatchObject({ id: made.id, translations: { en: "beacon" }, updatedBy: "ada" });
    expect(((await list({ project: project.id }, contextFor(database, "vee")))["entries"] as unknown[]).length).toBe(1);

    await expect(remove({ project: project.id, id: made.id }, contextFor(database, "vee"))).rejects.toThrow();
    await remove({ project: project.id, id: made.id }, contextFor(database, "bob"));
    expect((await list({ project: project.id }, contextFor(database, "vee")))["entries"]).toEqual([]);
  });
});

describe("voice", () => {
  it("marks lines recorded or for a retake, per language, and forgets them on none", async () => {
    const { database, project } = await team();
    const set = method(TEAM_METHODS.voiceSet);
    const list = method(TEAM_METHODS.voiceList);

    const recorded = (await set({ project: project.id, locale: "ja", lines: ["a1", "a2", "a1"], status: "recorded", take: 2 }, contextFor(database, "bob")))["lines"];
    expect(recorded).toEqual([
      expect.objectContaining({ locale: "ja", line: "a1", status: "recorded", take: 2, updatedBy: "bob" }),
      expect.objectContaining({ locale: "ja", line: "a2", status: "recorded", take: 2 }),
    ]);
    await set({ project: project.id, locale: "en", lines: ["a1"], status: "retake", note: "too quiet" }, contextFor(database, "bob"));
    await set({ project: project.id, locale: "ja", lines: ["a2"], status: "retake" }, contextFor(database, "ada"));

    const all = (await list({ project: project.id }, contextFor(database, "vee")))["lines"] as { locale: string; line: string; status: string }[];
    expect(all.map((line) => `${line.locale}/${line.line}/${line.status}`).sort()).toEqual(["en/a1/retake", "ja/a1/recorded", "ja/a2/retake"]);
    expect(((await list({ project: project.id, locale: "en" }, contextFor(database, "vee")))["lines"] as unknown[]).length).toBe(1);

    await set({ project: project.id, locale: "ja", lines: ["a1", "a2"], status: "none" }, contextFor(database, "bob"));
    expect(((await list({ project: project.id, locale: "ja" }, contextFor(database, "vee")))["lines"] as unknown[]).length).toBe(0);

    await expect(set({ project: project.id, locale: "ja", lines: ["a1"], status: "recorded" }, contextFor(database, "vee"))).rejects.toThrow();
    await expect(set({ project: project.id, locale: "ja", lines: [], status: "recorded" }, contextFor(database, "bob"))).rejects.toThrow(/lines/);
    await expect(set({ project: project.id, locale: "ja", lines: ["a1"], status: "recorded", take: 0 }, contextFor(database, "bob"))).rejects.toThrow(/take/);
    await expect(set({ project: project.id, locale: "ja", lines: ["a1"], status: "great" }, contextFor(database, "bob"))).rejects.toThrow();
    await expect(list({ project: project.id, locale: "../x" }, contextFor(database, "bob"))).rejects.toThrow(/locale/);
  });
});

describe("to-dos toward a milestone", () => {
  it("links a project's to-do to one of its own milestones, and lets go when the milestone does", async () => {
    const { database, user, project } = await team();
    const other = createProject(database, { id: newProjectId(), name: "elsewhere", createdBy: user("ada").id });
    const planned = createMilestone(database, user("ada"), { projectId: project.id, name: "Demo", revision: "" });
    expect(findMilestone(database, planned.id)?.revision).toBe("");
    const foreign = createMilestone(database, user("ada"), { projectId: other.id, name: "Beta", revision: "" });

    const todo = createTodo(database, user("ada"), { title: "write the first scene", projectId: project.id, visibility: "project", milestoneId: planned.id });
    expect(todo.milestoneId).toBe(planned.id);
    expect(() => createTodo(database, user("ada"), { title: "x", projectId: project.id, visibility: "project", milestoneId: foreign.id })).toThrow(TodoRefusal);

    const moved = updateTodo(database, user("ada"), todo.id, { projectId: other.id });
    expect(moved.milestoneId).toBeUndefined();
    const back = updateTodo(database, user("ada"), todo.id, { projectId: project.id, milestoneId: planned.id });
    expect(back.milestoneId).toBe(planned.id);

    deleteMilestone(database, user("ada"), planned.id);
    expect(findTodo(database, todo.id)?.milestoneId).toBeUndefined();
  });
});

describe("to-do priority", () => {
  it("keeps a priority from creation, changes it, and leaves it out of the view when none", async () => {
    const { database, user, project } = await team();
    const plain = createTodo(database, user("ada"), { title: "tidy the glossary", projectId: project.id, visibility: "project" });
    expect(plain.priority).toBe(0);
    expect(todoView(database, plain).priority).toBeUndefined();

    const urgent = createTodo(database, user("ada"), { title: "fix the crash", projectId: project.id, visibility: "project", priority: 3, dueAt: 1_800_000_000_000 });
    expect(todoView(database, urgent)).toMatchObject({ priority: 3, dueAt: 1_800_000_000_000 });

    // A change that does not name the priority keeps it.
    expect(updateTodo(database, user("ada"), urgent.id, { title: "fix the crash on load" }).priority).toBe(3);
    expect(updateTodo(database, user("ada"), urgent.id, { priority: 1 }).priority).toBe(1);
  });
});

describe("templates", () => {
  it("is saved from a body or a project, and applied by a project's owner", async () => {
    const { database, user } = await team();
    const save = method(TEAM_METHODS.templatesSave);
    const list = method(TEAM_METHODS.templatesList);
    const apply = method(TEAM_METHODS.templatesApply);
    const remove = method(TEAM_METHODS.templatesDelete);

    const body = {
      members: [
        { username: "nora", template: "translator" },
        { username: "ada", template: "viewer" },
        { username: "ghost", template: "writer" },
      ],
      milestones: [{ name: "Demo", note: "playable to the lighthouse", dueInDays: 14 }],
      todos: [
        { title: "translate chapter one", kind: "translation", locale: "ja", milestone: "Demo", dueInDays: 10 },
        { title: "pick a palette", labels: ["art"] },
      ],
    };
    const template = (await save({ name: "Short demo", description: "two weeks to a demo", body }, contextFor(database, "ada")))["template"] as { id: string; name: string };
    expect(template.name).toBe("Short demo");
    await expect(save({ name: "Short demo", body: {} }, contextFor(database, "bob"))).rejects.toThrow();
    await expect(save({ name: "broken", body: { members: [{ username: "x", template: "wizard" }] } }, contextFor(database, "ada"))).rejects.toThrow();
    expect(((await list({}, contextFor(database, "vee")))["templates"] as unknown[]).length).toBe(1);

    const fresh = createProject(database, { id: newProjectId(), name: "new-harbour", createdBy: user("ada").id });
    await expect(apply({ project: fresh.id, template: template.id }, contextFor(database, "bob"))).rejects.toThrow(/owner/);
    const published: unknown[] = [];
    const before = Date.now();
    const applied = await apply({ project: fresh.id, template: template.id }, contextFor(database, "ada", published));
    expect(applied).toEqual({ members: ["nora"], milestones: 1, todos: 2, skipped: ["@ada", "@ghost"] });
    expect(findProjectMember(database, fresh.id, user("nora").id)).toMatchObject({ role: "editor", areas: ["localization"] });
    expect(findProjectMember(database, fresh.id, user("ada").id)?.role).toBe("owner");

    const milestone = database.prepare("SELECT id, revision, due_at FROM milestones WHERE project_id = ?").get(fresh.id) as { id: string; revision: string; due_at: number };
    expect(milestone.revision).toBe("");
    expect(milestone.due_at).toBeGreaterThanOrEqual(before + 14 * 86_400_000);
    const todos = database.prepare("SELECT title, milestone_id, visibility FROM todos WHERE project_id = ? ORDER BY title").all(fresh.id) as {
      title: string;
      milestone_id: string | null;
      visibility: string;
    }[];
    expect(todos).toEqual([
      { title: "pick a palette", milestone_id: null, visibility: "project" },
      { title: "translate chapter one", milestone_id: milestone.id, visibility: "project" },
    ]);
    expect(published.some((event) => (event as { kind?: string }).kind === "member-set")).toBe(true);
    expect(published.some((event) => (event as { kind?: string }).kind === "milestone-set")).toBe(true);
    expect(published.some((event) => (event as { kind?: string }).kind === "todo-set")).toBe(true);

    // Applied twice: the milestone is there already, and the new to-dos join it.
    const again = await apply({ project: fresh.id, template: template.id }, contextFor(database, "ada"));
    expect(again).toMatchObject({ milestones: 0, todos: 2, skipped: ["@ada", "@ghost", "Demo"] });

    // From a project: its members but the one saving, its milestones, its open project to-dos.
    const copied = (await save({ name: "Like harbour", fromProject: fresh.id }, contextFor(database, "ada")))["template"] as {
      id: string;
      body: { members?: { username: string; template: string }[]; milestones?: { name: string; dueInDays?: number }[]; todos?: { title: string; milestone?: string }[] };
    };
    expect(copied.body.members).toContainEqual({ username: "nora", template: "translator" });
    expect(copied.body.members?.some((member) => member.username === "ada")).toBe(false);
    expect(copied.body.milestones).toEqual([expect.objectContaining({ name: "Demo", dueInDays: 14 })]);
    expect(copied.body.todos?.filter((todo) => todo.milestone === "Demo").length).toBe(2);
    await expect(save({ name: "Not mine", fromProject: fresh.id }, contextFor(database, "bob"))).rejects.toThrow(/owner/);

    await expect(remove({ template: template.id }, contextFor(database, "bob"))).rejects.toThrow();
    await remove({ template: template.id }, contextFor(database, "ada"));
    expect(((await list({}, contextFor(database, "ada")))["templates"] as { id: string }[]).map((entry) => entry.id)).toEqual([copied.id]);
  });
});
