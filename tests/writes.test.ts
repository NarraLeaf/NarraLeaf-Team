/**
 * The note a repeatable write leaves when it has no row to leave one on.
 *
 * What is pinned here is the key and the window. Everything else about
 * idempotency is visible from the outside — a second call does not act twice —
 * and is asserted where the methods are, in tests/team.test.ts. Neither of these
 * is visible from the outside until it is wrong, and both go wrong quietly: a
 * client id reused across two methods answering about whichever of them ran
 * first, and a client id remembered so long that reusing it a year later is
 * answered as a repeat of something nobody was repeating.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import {
  CLIENT_WRITE_RETENTION_MS,
  CLIENT_WRITE_TRIM_SLACK,
  countWrites,
  findWrite,
  recordWrite,
  trimWrites,
} from "../src/identity/writes.js";
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
    // Moments inside the window, because a note past it is deliberately taken
    // over rather than kept — which is the test below this one.
    const now = Date.now();
    recordWrite(db, key, { answer: "first", at: now - 2000 });

    recordWrite(db, key, { answer: "second", at: now - 1000 });

    expect(findWrite(db, key)).toEqual({ at: now - 2000, answer: "first" });
  });

  it("carries no answer for a write whose record can simply be read again", async () => {
    const db = await database();
    const key = { account: "ada", method: "admin.users.enable", clientId: "one" };

    recordWrite(db, key);

    expect(findWrite(db, key)).not.toHaveProperty("answer");
  });
});

describe("a note older than the retry it protects", () => {
  /** A moment far enough back that no window this server would choose covers it. */
  function longAgo(): number {
    return Date.now() - CLIENT_WRITE_RETENTION_MS - 60_000;
  }

  it("is not read, so the same id a long time later means it", async () => {
    // The failure this catches is silent: a client that numbers its writes and
    // starts over sends an id this server has seen, and is answered as though
    // the write had just happened when nothing did.
    const db = await database();
    const key = { account: "ada", method: "admin.users.disable", clientId: "one" };
    recordWrite(db, key, { at: longAgo() });

    expect(findWrite(db, key)).toBeUndefined();
  });

  it("is taken over by the write that reuses its id, rather than left in the way", async () => {
    // The row is still there when the id comes round again, because the prune
    // is opportunistic. Left as it was, the new write's note would carry the old
    // moment and this call's own retry would find nothing.
    const db = await database();
    const key = { account: "ada", method: "admin.tokens.mint", clientId: "one" };
    recordWrite(db, key, { answer: "last year", at: longAgo() });

    recordWrite(db, key, { answer: "today" });

    expect(findWrite(db, key)?.answer).toBe("today");
  });

  it("is dropped from the table, and a note still worth reading is not", async () => {
    const db = await database();
    // The first write on a connection is due a prune of its own — see the note
    // on writesSinceTrim — so this one spends that turn, and what follows is
    // swept deliberately or not at all.
    recordWrite(db, { account: "ada", method: "admin.users.enable", clientId: "first" });
    recordWrite(db, { account: "ada", method: "admin.users.disable", clientId: "old" }, {
      at: longAgo(),
    });

    expect(trimWrites(db)).toBe(1);
    expect(countWrites(db)).toBe(1);
  });

  it("is pruned by the write path itself, without anything on a timer", async () => {
    // A timer would be this server waking to do nothing on an idle deployment,
    // which it has paid for before. So the sweep rides on the only thing that
    // can make the table need one: writing to it.
    const db = await database();
    recordWrite(db, { account: "ada", method: "admin.users.enable", clientId: "first" });
    recordWrite(db, { account: "ada", method: "admin.users.disable", clientId: "old" }, {
      at: longAgo(),
    });

    // One more than the slack, so a sweep is certain rather than likely.
    for (let index = 0; index <= CLIENT_WRITE_TRIM_SLACK; index += 1) {
      recordWrite(db, { account: "bob", method: "admin.users.enable", clientId: `${index}` });
    }

    // Everything written here is still on record but the stale note, which
    // nothing asked to have removed.
    expect(countWrites(db)).toBe(CLIENT_WRITE_TRIM_SLACK + 2);
  });
});
