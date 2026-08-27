/**
 * The note a repeatable write leaves when it has no row to leave one on.
 *
 * What is pinned here is the key. Everything else about idempotency is visible
 * from the outside — a second call does not act twice — and is asserted where
 * the methods are, in tests/team.test.ts. The key is not visible from the
 * outside until it is wrong, and the way it goes wrong is quiet: a client id
 * reused across two methods answering about whichever of them ran first.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { findWrite, recordWrite } from "../src/identity/writes.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-writes-");

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

async function database(): Promise<DatabaseSync> {
  const handle = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(handle);
  return handle;
}

describe("a write a client named", () => {
  it("is not there until it has happened, and is afterwards", async () => {
    const db = await database();
    const key = { account: "ada", method: "admin.users.disable", clientId: "one" };

    expect(findWrite(db, key)).toBeUndefined();
    recordWrite(db, key);

    expect(findWrite(db, key)?.at).toBeTypeOf("number");
  });

  it("is keyed by the method as well as the client's id", async () => {
    // The failure this catches: a client that reuses one id across two writes
    // being told about the wrong one, which looks like the write it asked for
    // having already happened.
    const db = await database();
    recordWrite(db, { account: "ada", method: "admin.users.disable", clientId: "one" });

    expect(
      findWrite(db, { account: "ada", method: "admin.users.enable", clientId: "one" }),
    ).toBeUndefined();
  });

  it("is keyed by the account, so one person's id is not another's", async () => {
    const db = await database();
    recordWrite(db, { account: "ada", method: "admin.users.disable", clientId: "one" });

    expect(
      findWrite(db, { account: "bob", method: "admin.users.disable", clientId: "one" }),
    ).toBeUndefined();
  });

  it("keeps what the first of two identical writes said", async () => {
    const db = await database();
    const key = { account: "ada", method: "admin.tokens.mint", clientId: "one" };
    recordWrite(db, key, { answer: "first", at: 1000 });

    recordWrite(db, key, { answer: "second", at: 2000 });

    expect(findWrite(db, key)).toEqual({ at: 1000, answer: "first" });
  });

  it("carries no answer for a write whose record can simply be read again", async () => {
    const db = await database();
    const key = { account: "ada", method: "admin.users.enable", clientId: "one" };

    recordWrite(db, key);

    expect(findWrite(db, key)).not.toHaveProperty("answer");
  });
});
