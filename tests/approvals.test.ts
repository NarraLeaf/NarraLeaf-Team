/**
 * Approvals, asset locks, saved filters, to-do labels and milestone dates.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { approvalHistory, ApprovalRefusal, listApprovals, setApproval } from "../src/collab/approvals.js";
import { deleteFilter, FilterRefusal, listFilters, saveFilter } from "../src/collab/filters.js";
import { listLocks, lockAsset, lockedAgainst, LockRefusal, unlockAsset } from "../src/collab/locks.js";
import { createMilestone, MilestoneRefusal, milestoneView, updateMilestone } from "../src/collab/milestones.js";
import { createTodo, todoView, updateTodo } from "../src/collab/todos.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { removeProjectMember, setProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-approvals-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** ada owns harbour, bob edits it, rho reviews it, vee watches, nora is not in it. */
async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  for (const username of ["ada", "bob", "rho", "vee", "nora"]) {
    await createUser(database, hasher, { username, password: "a password nobody guesses" });
  }
  const user = (name: string) => requireUser(database, name);
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("bob").id, role: "editor", addedBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("rho").id, role: "reviewer", addedBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("vee").id, role: "viewer", addedBy: user("ada").id });
  removeProjectMember(database, project.id, user("nora").id);
  return { database, user, project };
}

describe("approvals", () => {
  it("are asked for by editors and decided by reviewers and owners, a send-back with its reason", async () => {
    const { database, user, project } = await team();
    const target = "scene:s1";
    expect(setApproval(database, user("bob"), { projectId: project.id, target, status: "pending" }, 1).status).toBe("pending");
    // An editor does not decide, a reviewer does not ask, a viewer does neither.
    expect(() => setApproval(database, user("bob"), { projectId: project.id, target, status: "approved" })).toThrow(ApprovalRefusal);
    expect(() => setApproval(database, user("rho"), { projectId: project.id, target, status: "pending" })).toThrow(ApprovalRefusal);
    expect(() => setApproval(database, user("vee"), { projectId: project.id, target, status: "draft" })).toThrow(ApprovalRefusal);
    expect(() => setApproval(database, user("nora"), { projectId: project.id, target, status: "draft" })).toThrow(ApprovalRefusal);
    // Sending back needs a reason.
    expect(() => setApproval(database, user("rho"), { projectId: project.id, target, status: "changes", note: "  " })).toThrow(ApprovalRefusal);
    setApproval(database, user("rho"), { projectId: project.id, target, status: "changes", note: "line 4 is too long" }, 2);
    setApproval(database, user("ada"), { projectId: project.id, target, status: "approved" }, 3);

    const [now] = listApprovals(database, user("vee"), project.id);
    expect(now).toMatchObject({ target, status: "approved", at: 3 });
    expect(approvalHistory(database, user("vee"), project.id, target).map((step) => [step.status, step.note])).toEqual([
      ["pending", undefined],
      ["changes", "line 4 is too long"],
      ["approved", undefined],
    ]);
    expect(() => listApprovals(database, user("nora"), project.id)).toThrow(ApprovalRefusal);
  });

  it("only take scene and asset targets", async () => {
    const { database, user, project } = await team();
    expect(() => setApproval(database, user("ada"), { projectId: project.id, target: "chapter:1", status: "draft" })).toThrow(ApprovalRefusal);
    expect(setApproval(database, user("ada"), { projectId: project.id, target: "asset:bg-1", status: "draft" }).target).toBe("asset:bg-1");
  });
});

describe("asset locks", () => {
  it("hold an asset against everybody else until let go or out of time", async () => {
    const { database, user, project } = await team();
    lockAsset(database, user("bob"), { projectId: project.id, assetId: "bg-1", minutes: 10, note: "repainting" }, 1_000);
    expect(lockedAgainst(database, project.id, user("ada").id, ["bg-0", "bg-1"], 2_000)?.assetId).toBe("bg-1");
    expect(lockedAgainst(database, project.id, user("bob").id, ["bg-1"], 2_000)).toBeUndefined();
    // Taken again by somebody else: refused. By its holder: extended.
    expect(() => lockAsset(database, user("ada"), { projectId: project.id, assetId: "bg-1" }, 2_000)).toThrow(LockRefusal);
    expect(lockAsset(database, user("bob"), { projectId: project.id, assetId: "bg-1", minutes: 20 }, 2_000).expiresAt).toBe(2_000 + 20 * 60_000);
    // Out of time, it is nobody's.
    expect(lockedAgainst(database, project.id, user("ada").id, ["bg-1"], 2_000 + 20 * 60_000)).toBeUndefined();
    expect(listLocks(database, user("vee"), project.id, 2_000 + 20 * 60_000)).toEqual([]);
  });

  it("are taken by those who may change assets and let go by the holder, an owner or an operator", async () => {
    const { database, user, project } = await team();
    expect(() => lockAsset(database, user("rho"), { projectId: project.id, assetId: "bg-1" })).toThrow(LockRefusal);
    expect(() => lockAsset(database, user("bob"), { projectId: project.id, assetId: "bg-1", minutes: 0 })).toThrow(LockRefusal);
    setProjectMember(database, { projectId: project.id, userId: user("vee").id, role: "editor", areas: ["story"], addedBy: user("ada").id });
    expect(() => lockAsset(database, user("vee"), { projectId: project.id, assetId: "bg-1" })).toThrow(LockRefusal);

    lockAsset(database, user("bob"), { projectId: project.id, assetId: "bg-1" });
    expect(() => unlockAsset(database, user("rho"), project.id, "bg-1")).toThrow(LockRefusal);
    expect(unlockAsset(database, user("ada"), project.id, "bg-1")?.assetId).toBe("bg-1");
    expect(unlockAsset(database, user("ada"), project.id, "bg-1")).toBeUndefined();
  });
});

describe("saved filters", () => {
  it("are an account's own, one per name and list, replaced when saved again", async () => {
    const { database, user } = await team();
    const mine = saveFilter(database, user("ada"), { scope: "todos", name: "art", query: '{"labels":["art"]}' });
    saveFilter(database, user("ada"), { scope: "todos", name: "art", query: '{"labels":["art","bg"]}' });
    saveFilter(database, user("bob"), { scope: "todos", name: "art", query: "{}" });
    expect(listFilters(database, user("ada"), "todos").map((f) => [f.name, f.query])).toEqual([["art", '{"labels":["art","bg"]}']]);
    expect(() => saveFilter(database, user("ada"), { scope: "todos", name: "x", query: "not json" })).toThrow(FilterRefusal);
    expect(() => deleteFilter(database, user("bob"), mine.id)).toThrow(FilterRefusal);
    deleteFilter(database, user("ada"), mine.id);
    expect(listFilters(database, user("ada"))).toEqual([]);
  });
});

describe("to-do labels and milestone dates", () => {
  it("keeps a to-do's labels, and clears them when given none", async () => {
    const { database, user, project } = await team();
    const todo = createTodo(database, user("ada"), { title: "bg", projectId: project.id, visibility: "project", labels: ["art", "ch2"] });
    expect(todoView(database, todo).labels).toEqual(["art", "ch2"]);
    expect(todoView(database, updateTodo(database, user("ada"), todo.id, { title: "bg 2" })).labels).toEqual(["art", "ch2"]);
    expect(todoView(database, updateTodo(database, user("ada"), todo.id, { labels: [] })).labels).toBeUndefined();
  });

  it("carries a due date and a gate, changed by whoever named it or an owner", async () => {
    const { database, user, project } = await team();
    const demo = createMilestone(database, user("bob"), { projectId: project.id, name: "Demo", revision: "r1", dueAt: 99, gate: true });
    expect(milestoneView(database, demo)).toMatchObject({ dueAt: 99, gate: true });
    expect(() => updateMilestone(database, user("rho"), demo.id, { dueAt: 5 })).toThrow(MilestoneRefusal);
    const moved = updateMilestone(database, user("ada"), demo.id, { dueAt: null, gate: false, name: "Demo 1" });
    expect(milestoneView(database, moved)).not.toHaveProperty("dueAt");
    expect(milestoneView(database, moved)).not.toHaveProperty("gate");
    expect(moved.name).toBe("Demo 1");
    createMilestone(database, user("ada"), { projectId: project.id, name: "Fest", revision: "r2" });
    expect(() => updateMilestone(database, user("ada"), demo.id, { name: "Fest" })).toThrow(MilestoneRefusal);
  });
});
