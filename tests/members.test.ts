import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser, type UserRecord } from "../src/identity/users.js";
import {
  listProjectMembers,
  mayOpenRepository,
  maySeeProject,
  projectRole,
  removeProjectMember,
  repositoryProjectIds,
  setProjectMember,
  UnknownRoleError,
  visibleProjectIds,
} from "../src/projects/members.js";
import { createProject, forgetProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-members-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const opened: DatabaseSync[] = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

async function database(): Promise<DatabaseSync> {
  const db = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  opened.push(db);
  return db;
}

async function account(db: DatabaseSync, username: string, groups?: string[]): Promise<UserRecord> {
  await createUser(db, hasher, {
    username,
    password: "a password nobody guesses",
    ...(groups === undefined ? {} : { groups }),
  });
  return requireUser(db, username);
}

/**
 * Who belongs to a project, and the two questions asked of that: may they open
 * the repository, and may they see the project at all.
 */
describe("project members", () => {
  it("makes a new project's creator its owner and every other account an editor", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const bob = await account(db, "bob");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    expect(projectRole(db, project.id, ada)).toBe("owner");
    expect(projectRole(db, project.id, bob)).toBe("editor");
    expect(listProjectMembers(db, project.id).map((member) => member.role)).toEqual(["owner", "editor"]);
  });

  it("makes a new account an editor of every project already there", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });
    const cleo = await account(db, "cleo");

    expect(projectRole(db, project.id, cleo)).toBe("editor");
  });

  it("opens the repository to owners and editors only, and shows the project to every role", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const rita = await account(db, "rita");
    const vic = await account(db, "vic");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });
    setProjectMember(db, { projectId: project.id, userId: rita.id, role: "reviewer" });
    setProjectMember(db, { projectId: project.id, userId: vic.id, role: "viewer" });

    expect(mayOpenRepository(db, project.id, ada)).toBe(true);
    expect(mayOpenRepository(db, project.id, rita)).toBe(false);
    expect(mayOpenRepository(db, project.id, vic)).toBe(false);
    expect(maySeeProject(db, project.id, rita)).toBe(true);
    expect(maySeeProject(db, project.id, vic)).toBe(true);
    expect(repositoryProjectIds(db, rita).size).toBe(0);
    expect(visibleProjectIds(db, rita)).toEqual(new Set([project.id]));
  });

  it("hides a project from an account taken out of it", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const nora = await account(db, "nora");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    expect(removeProjectMember(db, project.id, nora.id)).toBe(true);
    expect(removeProjectMember(db, project.id, nora.id)).toBe(false);
    expect(projectRole(db, project.id, nora)).toBeUndefined();
    expect(maySeeProject(db, project.id, nora)).toBe(false);
    expect(visibleProjectIds(db, nora).size).toBe(0);
  });

  it("treats an operator as the owner of every project, with or without a row", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });
    const root = await account(db, "root", ["admin"]);
    removeProjectMember(db, project.id, root.id);

    expect(projectRole(db, project.id, root)).toBe("owner");
    expect(visibleProjectIds(db, root)).toEqual(new Set([project.id]));
  });

  it("changes a member's role in place, and refuses a role that is not one", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const bob = await account(db, "bob");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    expect(setProjectMember(db, { projectId: project.id, userId: bob.id, role: "reviewer" }).role).toBe("reviewer");
    expect(listProjectMembers(db, project.id)).toHaveLength(2);
    expect(() => setProjectMember(db, { projectId: project.id, userId: bob.id, role: "admin" })).toThrow(
      UnknownRoleError,
    );
  });

  it("reads a role this build does not know as the least able one", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const bob = await account(db, "bob");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });
    db.prepare("UPDATE project_members SET role = 'maintainer' WHERE user_id = ?").run(bob.id);

    expect(projectRole(db, project.id, bob)).toBe("viewer");
    expect(mayOpenRepository(db, project.id, bob)).toBe(false);
  });

  it("goes with the project when it is forgotten", async () => {
    const db = await database();
    const ada = await account(db, "ada");
    const project = createProject(db, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    forgetProject(db, project.id);

    expect(listProjectMembers(db, project.id)).toEqual([]);
  });
});
