/**
 * Deleting an account and locking one after wrong passwords, at the store: what goes, what
 * stays, and what a sign-in is answered with.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createApiToken, listApiTokens } from "../src/identity/apitokens.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES, setPolicy } from "../src/identity/policy.js";
import {
  ADMIN_ROLE,
  authenticate,
  createUser,
  deleteUser,
  DeletedUserError,
  enableUser,
  findUser,
  listUsers,
  lockUser,
  recordFailedSignIn,
  requireUser,
  unlockUser,
  updateUserProfile,
} from "../src/identity/users.js";
import { createWebSession } from "../src/identity/websessions.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-accounts-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const PASSWORD = "a password nobody guesses";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function team(): Promise<DatabaseSync> {
  const database = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  databases.push(database);
  await createUser(database, hasher, { username: "ada", password: PASSWORD, groups: [ADMIN_ROLE] });
  await createUser(database, hasher, { username: "bob", password: PASSWORD, email: "bob@example.com" });
  return database;
}

describe("deleting an account", () => {
  it("keeps the row and the name, and clears everything personal", async () => {
    const database = await team();
    const bob = requireUser(database, "bob");
    createWebSession(database, bob);
    createApiToken(database, bob.id, { name: "script", write: false });

    deleteUser(database, "bob");

    const gone = requireUser(database, "bob");
    expect(gone.id).toBe(bob.id);
    expect(gone.deletedAt).toBeTypeOf("number");
    expect(gone.email).toBeUndefined();
    expect(gone.groups).toEqual([]);
    expect(gone.tokenEpoch).toBe(bob.tokenEpoch + 1);
    expect(listApiTokens(database, bob.id)).toEqual([]);
    const sessions = database.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE user_id = ?").get(bob.id);
    expect(sessions?.["count"]).toBe(0);
    expect(listUsers(database).map((user) => user.username)).toEqual(["ada"]);
    expect(listUsers(database, { includeDeleted: true })).toHaveLength(2);
  });

  it("is answered at sign-in as an account that never was, and cannot be brought back", async () => {
    const database = await team();
    deleteUser(database, "bob");

    expect(await authenticate(database, hasher, "bob", PASSWORD)).toEqual({ kind: "refused", reason: "no-such-user" });
    expect(() => enableUser(database, "bob")).toThrow(DeletedUserError);
    expect(() => deleteUser(database, "bob")).toThrow(DeletedUserError);
    // The name stays taken.
    await expect(createUser(database, hasher, { username: "bob", password: PASSWORD })).rejects.toThrow();
  });
});

describe("locking an account", () => {
  it("locks after the wrong passwords the server allows, and refuses even the right one", async () => {
    const database = await team();
    setPolicy(database, LOCKOUT_ATTEMPTS, "3");
    setPolicy(database, LOCKOUT_MINUTES, "5");

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await authenticate(database, hasher, "bob", "wrong")).kind).toBe("refused");
    }
    const locked = requireUser(database, "bob");
    expect(locked.lockedUntil).toBeGreaterThan(Date.now() + 4 * 60_000);

    const answer = await authenticate(database, hasher, "bob", PASSWORD);
    expect(answer).toMatchObject({ kind: "refused", reason: "locked" });

    unlockUser(database, "bob");
    expect((await authenticate(database, hasher, "bob", PASSWORD)).kind).toBe("signed-in");
  });

  it("counts nothing when the server says not to", async () => {
    const database = await team();
    setPolicy(database, LOCKOUT_ATTEMPTS, "0");
    const bob = requireUser(database, "bob");
    for (let attempt = 0; attempt < 20; attempt++) recordFailedSignIn(database, bob.id);
    expect(requireUser(database, "bob").lockedUntil).toBeUndefined();
  });

  it("is lifted by itself once its time has passed", async () => {
    const database = await team();
    lockUser(database, "bob", Date.now() - 1);
    expect((await authenticate(database, hasher, "bob", PASSWORD)).kind).toBe("signed-in");
  });
});

describe("an operator changing a profile", () => {
  it("changes the name and the address, and takes the address away when it is empty", async () => {
    const database = await team();
    updateUserProfile(database, "bob", { displayName: "Bob Li", email: "li@example.com" });
    expect(findUser(database, "bob")).toMatchObject({ displayName: "Bob Li", email: "li@example.com" });
    updateUserProfile(database, "bob", { email: "" });
    expect(findUser(database, "bob")?.email).toBeUndefined();
    expect(() => updateUserProfile(database, "bob", { displayName: " " })).toThrow();
  });
});
