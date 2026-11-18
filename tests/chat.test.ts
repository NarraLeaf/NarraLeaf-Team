/**
 * A project's channel: kept, paged, members only, and taken back by its author.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ChatRefusal, deleteChat, listChat, sendChat } from "../src/collab/chat.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { removeProjectMember, setProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-chat-");
const hasher = new ScryptPasswordHasher({ cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 } as ScryptParameters);
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

describe("a project's channel", () => {
  it("keeps what members write, newest first, a page at a time", async () => {
    const { database, user, project } = await team();
    for (let n = 1; n <= 5; n += 1) sendChat(database, user(n % 2 === 0 ? "bob" : "ada"), project.id, `line ${n}`, 1000 + n);
    const first = listChat(database, user("vee"), project.id, { limit: 3 });
    expect(first.messages.map((m) => m.body)).toEqual(["line 5", "line 4", "line 3"]);
    expect(first.messages[0]?.author).toBe("ada");
    const second = listChat(database, user("vee"), project.id, { limit: 3, ...(first.cursor === undefined ? {} : { before: first.cursor }) });
    expect(second.messages.map((m) => m.body)).toEqual(["line 2", "line 1"]);
    expect(second.cursor).toBeUndefined();
  });

  it("is for members, and a viewer reads it without writing", async () => {
    const { database, user, project } = await team();
    expect(() => sendChat(database, user("vee"), project.id, "hello")).toThrow(ChatRefusal);
    expect(() => sendChat(database, user("nora"), project.id, "hello")).toThrow(ChatRefusal);
    expect(() => listChat(database, user("nora"), project.id, { limit: 10 })).toThrow(ChatRefusal);
    expect(() => sendChat(database, user("ada"), project.id, "   ")).toThrow(ChatRefusal);
    expect(() => sendChat(database, user("ada"), project.id, "x".repeat(5000))).toThrow(ChatRefusal);
  });

  it("lets only the author take a message back, keeping its place", async () => {
    const { database, user, project } = await team();
    const message = sendChat(database, user("ada"), project.id, "oops");
    expect(() => deleteChat(database, user("bob"), message.id)).toThrow(ChatRefusal);
    deleteChat(database, user("ada"), message.id);
    const [kept] = listChat(database, user("bob"), project.id, { limit: 5 }).messages;
    expect(kept?.body).toBe("");
    expect(kept?.deletedAt).toBeDefined();
  });
});
