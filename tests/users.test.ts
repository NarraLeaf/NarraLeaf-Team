import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import {
  authenticate,
  countUsers,
  createUser,
  disableUser,
  DISPLAY_NAME_LIMIT,
  enableUser,
  findUser,
  InvalidDisplayNameError,
  InvalidUsernameError,
  listUsers,
  pageUsers,
  revokeUserTokens,
  UnknownUserError,
  UsernameTakenError,
  WeakPasswordError,
  type UserPage,
} from "../src/identity/users.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-users-");

/** Cheap parameters: these tests are about the records, not the cost. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";

const open: DatabaseSync[] = [];

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

describe("createUser", () => {
  it("records an account and puts it in the groups it was given", async () => {
    const connection = await database();

    const user = await createUser(connection, hasher, {
      username: "Ada",
      password: PASSWORD,
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      groups: ["admin", "admin", "authors"],
    });

    // The name is folded, so that Ada and ada cannot become two accounts that
    // read as one person.
    expect(user.username).toBe("ada");
    expect(user.displayName).toBe("Ada Lovelace");
    expect(user.email).toBe("ada@example.com");
    expect(user.isServiceAccount).toBe(false);
    expect(user.disabledAt).toBeUndefined();
    expect(user.tokenEpoch).toBe(1);
    expect(user.groups).toEqual(["admin", "authors"]);
    expect(countUsers(connection)).toBe(1);
  });

  it("refuses a second account with the same name", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    await expect(
      createUser(connection, hasher, { username: "ADA", password: PASSWORD }),
    ).rejects.toBeInstanceOf(UsernameTakenError);
    expect(countUsers(connection)).toBe(1);
  });

  it("refuses a name that is not one, and a password too short to bother with", async () => {
    const connection = await database();

    await expect(
      createUser(connection, hasher, { username: "a b", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidUsernameError);
    await expect(
      createUser(connection, hasher, { username: "ada", password: "short" }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    expect(countUsers(connection)).toBe(0);
  });

  it("refuses a display name longer than a token can carry", async () => {
    const connection = await database();

    // The store rather than the method, because the method is not the only way
    // in: `nlteam user create --root` and `nlteam init --root` reach this
    // function with nothing in front of them.
    await expect(
      createUser(connection, hasher, {
        username: "ada",
        password: PASSWORD,
        displayName: "n".repeat(DISPLAY_NAME_LIMIT + 1),
      }),
    ).rejects.toBeInstanceOf(InvalidDisplayNameError);
    expect(countUsers(connection)).toBe(0);
  });

  it("counts a display name in bytes, not in characters", async () => {
    const connection = await database();

    // What has to fit is a header, and a header is bytes. A name of a hundred
    // characters that are three bytes each is three hundred bytes on the wire,
    // and counting characters would have let it through.
    await expect(
      createUser(connection, hasher, {
        username: "ada",
        password: PASSWORD,
        displayName: "名".repeat(DISPLAY_NAME_LIMIT / 2),
      }),
    ).rejects.toBeInstanceOf(InvalidDisplayNameError);
  });

  it("says what is wrong with a display name it will not store", async () => {
    const connection = await database();

    const refusal = await createUser(connection, hasher, {
      username: "ada",
      password: PASSWORD,
      displayName: "n".repeat(DISPLAY_NAME_LIMIT + 1),
    }).catch((error: unknown) => error);

    // The command line prints this sentence and nothing else, so it has to
    // carry the figure and the reason - a name being refused for its length is
    // not something anybody would guess is about a header.
    expect((refusal as Error).message).toContain(String(DISPLAY_NAME_LIMIT));
    expect((refusal as Error).message).toContain("authorization header");
  });

  it("takes a display name of exactly the figure", async () => {
    const connection = await database();

    const user = await createUser(connection, hasher, {
      username: "ada",
      password: PASSWORD,
      displayName: "n".repeat(DISPLAY_NAME_LIMIT),
    });

    expect(user.displayName).toHaveLength(DISPLAY_NAME_LIMIT);
  });

  it("goes on reading a name stored before there was a figure for one", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const stored = "n".repeat(DISPLAY_NAME_LIMIT * 4);
    connection.prepare("UPDATE users SET display_name = ? WHERE username = ?").run(stored, "ada");

    // The bound is on the write and on nothing else. A name already in the
    // table is read back whole, so an account that has one is exactly as
    // usable — or as locked out — as it was before there was a bound, and
    // nothing that reads an account had to learn a second shape.
    expect(findUser(connection, "ada")?.displayName).toBe(stored);
  });

  it("keeps no password hash on the record it hands back", async () => {
    const connection = await database();
    const user = await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    // Whatever a caller does with a user record — log it, print it, serialise
    // it — the hash is not in it to leak.
    expect(JSON.stringify(user)).not.toContain("scrypt");
  });
});

describe("listUsers", () => {
  it("lists every account in name order", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "zoe", password: PASSWORD });
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    expect(listUsers(connection).map((user) => user.username)).toEqual(["ada", "zoe"]);
  });
});

describe("disableUser and enableUser", () => {
  it("marks the account and bumps the epoch that makes tokens unrenewable", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    const disabled = disableUser(connection, "ada");

    expect(disabled.disabledAt).toBeTypeOf("number");
    expect(disabled.tokenEpoch).toBe(2);
  });

  it("writes the moment the tokens were made unrenewable beside the bump", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const before = Date.now();

    const disabled = disableUser(connection, "ada");

    expect(disabled.tokensInvalidatedAt).toBeGreaterThanOrEqual(before);
    // One moment, not two: an account was disabled and its tokens refused in
    // the same act, and two clocks read a millisecond apart would read as two
    // separate things having happened.
    expect(disabled.tokensInvalidatedAt).toBe(disabled.disabledAt);
  });

  it("leaves that moment absent on an account nobody has done this to", async () => {
    const connection = await database();

    const ada = await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    expect(ada.tokensInvalidatedAt).toBeUndefined();
  });

  it("does not move it when the account is enabled again", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const when = disableUser(connection, "ada").tokensInvalidatedAt;

    const enabled = enableUser(connection, "ada");

    // Enabling puts nothing back — not the epoch, and so not the moment it was
    // bumped either. The tokens issued before it are still refused, and that
    // is still when they started being refused.
    expect(enabled.tokensInvalidatedAt).toBe(when);
  });

  it("does not put the epoch back when the account is enabled again", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    disableUser(connection, "ada");

    const enabled = enableUser(connection, "ada");

    expect(enabled.disabledAt).toBeUndefined();
    // Tokens minted before the account was disabled stay unrenewable: whatever
    // made disabling worth doing has not become untrue.
    expect(enabled.tokenEpoch).toBe(2);
  });

  it("names an account that is not there rather than doing nothing", async () => {
    const connection = await database();

    expect(() => disableUser(connection, "nobody")).toThrow(UnknownUserError);
  });
});

describe("revokeUserTokens", () => {
  it("bumps the epoch and leaves the account able to sign in", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    const revoked = revokeUserTokens(connection, "ada");

    // The whole of the difference from disabling: the tokens are refused and
    // the person is not shut out, so a token that got out costs them one sign
    // in rather than an operator's attention twice.
    expect(revoked.tokenEpoch).toBe(2);
    expect(revoked.disabledAt).toBeUndefined();
    await expect(authenticate(connection, hasher, "ada", PASSWORD)).resolves.toMatchObject({
      kind: "signed-in",
    });
  });

  it("writes the moment beside the bump, on an account that stays enabled", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const before = Date.now();

    const revoked = revokeUserTokens(connection, "ada");

    expect(revoked.tokensInvalidatedAt).toBeGreaterThanOrEqual(before);
    expect(revoked.disabledAt).toBeUndefined();
  });

  it("says nothing about a bump made before Team kept the moment", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    // The row as a Team server older than this column left it: the epoch moved, and
    // there was nowhere to write when. There is no honest timestamp for it, so
    // the record carries none and the screen says unknown.
    connection
      .prepare("UPDATE users SET token_epoch = token_epoch + 1 WHERE username = ?")
      .run("ada");

    const ada = findUser(connection, "ada");

    expect(ada?.tokenEpoch).toBe(2);
    expect(ada?.tokensInvalidatedAt).toBeUndefined();
  });

  it("leaves a disabled account disabled", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    disableUser(connection, "ada");

    const revoked = revokeUserTokens(connection, "ada");

    expect(revoked.disabledAt).toBeTypeOf("number");
    expect(revoked.tokenEpoch).toBe(3);
  });

  it("names an account that is not there rather than doing nothing", async () => {
    const connection = await database();

    expect(() => revokeUserTokens(connection, "nobody")).toThrow(UnknownUserError);
  });
});

describe("authenticate", () => {
  it("signs in with the right password", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    const result = await authenticate(connection, hasher, "Ada", PASSWORD);

    expect(result.kind).toBe("signed-in");
    expect(result.kind === "signed-in" && result.user.username).toBe("ada");
  });

  it("tells the caller apart the ways it can fail, in one shape", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    await expect(authenticate(connection, hasher, "ada", "wrong")).resolves.toEqual({
      kind: "refused",
      reason: "wrong-password",
    });
    await expect(authenticate(connection, hasher, "nobody", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "no-such-user",
    });

    disableUser(connection, "ada");
    await expect(authenticate(connection, hasher, "ada", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "disabled",
    });
  });

  it("refuses a stored hash it cannot read, without raising into the caller", async () => {
    const connection = await database();
    const user = await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    connection
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run("argon2id$m=65536,t=3,p=4$c2FsdA==$aGFzaA==", user.id);

    await expect(authenticate(connection, hasher, "ada", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "unreadable-password-hash",
    });
  });

  it("replaces a hash made with superseded parameters, on the way through", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const stored = (): string => {
      const row = connection.prepare("SELECT password_hash AS hash FROM users").get();
      return String(row?.["hash"]);
    };
    const before = stored();
    expect(before).toContain(`N=${CHEAP.cost}`);

    const raised = new ScryptPasswordHasher({ ...CHEAP, cost: CHEAP.cost * 4 });
    const result = await authenticate(connection, raised, "ada", PASSWORD);

    expect(result.kind).toBe("signed-in");
    expect(stored()).toContain(`N=${CHEAP.cost * 4}`);
    // And the new one is a working hash of the same password.
    expect(await raised.verify(PASSWORD, stored())).toBe(true);
  });

  it("leaves the hash alone when the parameters have not moved", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const before = findUser(connection, "ada");
    const row = connection.prepare("SELECT password_hash AS hash FROM users").get();

    await authenticate(connection, hasher, "ada", PASSWORD);

    expect(connection.prepare("SELECT password_hash AS hash FROM users").get()).toEqual(row);
    expect(before?.tokenEpoch).toBe(1);
  });
});

describe("pageUsers", () => {
  /**
   * Accounts with the moments they were made written by hand.
   *
   * `createUser` stamps the clock, and a test that let it would be asserting on
   * how long scrypt happened to take. Two of these share a moment, because two
   * accounts made by one script do.
   */
  async function accountsMadeAt(
    connection: DatabaseSync,
    moments: Readonly<Record<string, number>>,
  ): Promise<void> {
    for (const [username, createdAt] of Object.entries(moments)) {
      await createUser(connection, hasher, { username, password: PASSWORD });
      connection
        .prepare("UPDATE users SET created_at = ? WHERE username = ?")
        .run(createdAt, username);
    }
  }

  /** Every account a cursor walks to, in the order the pages handed them over. */
  function walk(connection: DatabaseSync, limit: number): string[] {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: UserPage = pageUsers(connection, {
        limit,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      seen.push(...page.users.map((user) => user.username));
      if (page.cursor === undefined) {
        return seen;
      }
      cursor = page.cursor;
    }
  }

  it("hands back a page at a time, newest first, and says where to carry on", async () => {
    const connection = await database();
    await accountsMadeAt(connection, { ada: 1000, bob: 2000, cleo: 3000 });

    const page = pageUsers(connection, { limit: 2 });

    expect(page.users.map((user) => user.username)).toEqual(["cleo", "bob"]);
    expect(page.cursor).toBeDefined();
  });

  it("walks every account without repeating one or skipping one", async () => {
    const connection = await database();
    // ada and bob were made in the same millisecond, which is what the id in
    // the cursor is there for: without it one of them is handed over twice and
    // the other never.
    await accountsMadeAt(connection, { ada: 1000, bob: 1000, cleo: 2000, dee: 3000 });

    expect(walk(connection, 2).sort()).toEqual(["ada", "bob", "cleo", "dee"]);
  });

  it("says nothing follows the last page", async () => {
    const connection = await database();
    await accountsMadeAt(connection, { ada: 1000, bob: 2000 });

    const page = pageUsers(connection, { limit: 2 });

    expect(page.users).toHaveLength(2);
    expect(page.cursor).toBeUndefined();
  });

  it("carries the groups an account is in, as every reader of a record does", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD, groups: ["admin"] });

    expect(pageUsers(connection, { limit: 10 }).users[0]?.groups).toEqual(["admin"]);
  });

  it("starts again from the top for a cursor it cannot read", async () => {
    const connection = await database();
    await accountsMadeAt(connection, { ada: 1000, bob: 2000 });

    expect(pageUsers(connection, { limit: 10, before: "not a cursor" }).users).toHaveLength(2);
  });
});
