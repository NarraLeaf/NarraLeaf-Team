/**
 * The accounts Team issues tokens for.
 *
 * A user record carries no password hash. Reading one is a separate query,
 * made only by the code that is about to check a password, so that a record
 * which ends up in a log, a status line or a JSON reply cannot take the hash
 * with it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  booleanColumn,
  inTransaction,
  integerColumn,
  optionalIntegerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "./database.js";
import { MalformedPasswordHashError, type PasswordHasher } from "./passwords.js";
import { LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES, policyNumber } from "./policy.js";
import { storedProjectAccess } from "./settings.js";

/** One account. */
export interface UserRecord {
  /** Stable identifier; this is what a token's `sub` claim holds. */
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly isServiceAccount: boolean;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** When the account was disabled, or undefined while it may sign in. */
  readonly disabledAt: number | undefined;
  /** Bumped to make outstanding tokens unrenewable; see ./tokens.ts. */
  readonly tokenEpoch: number;
  /**
   * When the epoch above was last bumped, or undefined for an account whose
   * tokens have never been refused.
   *
   * Undefined also on an account whose tokens were refused before Team kept this
   * moment: migration 4 leaves the column NULL for rows that already existed
   * rather than inventing a timestamp for a bump nobody recorded.
   */
  readonly tokensInvalidatedAt: number | undefined;
  readonly groups: readonly string[];
  /** The SHA-256 of the account's avatar image, absent for an account with none. */
  readonly avatar?: string;
  /** A line about themselves, absent where they wrote none. */
  readonly bio?: string;
  /** An IANA time zone the person set, absent where they set none. */
  readonly timezone?: string;
  /**
   * When an operator deleted the account, absent for one that exists. A deleted account keeps
   * its row and its name and nothing else; see {@link deleteUser}.
   */
  readonly deletedAt?: number;
  /** Until when sign-ins are refused after too many wrong passwords, or by an operator. */
  readonly lockedUntil?: number;
}

/** Raised when a username does not fit the rules. */
export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(
      `"${username}" cannot be a username. A username is 2 to 32 characters of ` +
        "a-z, 0-9, dot, dash and underscore, and starts with a letter or a digit.",
    );
    this.name = "InvalidUsernameError";
  }
}

/** Raised when a username is already in use. */
export class UsernameTakenError extends Error {
  constructor(readonly username: string) {
    super(`there is already an account called ${username}.`);
    this.name = "UsernameTakenError";
  }
}

/** Raised when no account goes by a name a command was given. */
export class UnknownUserError extends Error {
  constructor(readonly username: string) {
    super(`there is no account called ${username}.`);
    this.name = "UnknownUserError";
  }
}

/** Raised when a password is too short to be worth hashing. */
export class WeakPasswordError extends Error {
  constructor() {
    super(
      `a password must be at least ${MINIMUM_PASSWORD_LENGTH} characters. There are no ` +
        "rules about which characters: length is what makes a password hard to guess, " +
        "and composition rules mostly make people choose predictably.",
    );
    this.name = "WeakPasswordError";
  }
}

/**
 * Raised when a display name is longer than Team will store.
 *
 * The sentence says why rather than only that, because the reason is not one
 * anybody would guess from a name being refused: this is not a limit about
 * screen space.
 */
export class InvalidDisplayNameError extends Error {
  constructor() {
    super(DISPLAY_NAME_REFUSAL);
    this.name = "InvalidDisplayNameError";
  }
}

/**
 * Raised when an email address is longer than one may be.
 *
 * The same failure as a display name too long, from the other claim: an address
 * reaches the `email` claim of every token this account is issued, and a token
 * travels in a header. What differs is only the figure.
 */
export class InvalidEmailError extends Error {
  constructor() {
    super(EMAIL_REFUSAL);
    this.name = "InvalidEmailError";
  }
}

/** Raised when a role is not a name a group can have. */
export class InvalidRoleError extends Error {
  constructor(role: string) {
    super(
      `"${role}" cannot be a role. A role is 1 to 32 characters of a-z, 0-9, dash and ` +
        "underscore, and starts with a letter.",
    );
    this.name = "InvalidRoleError";
  }
}

/** The shortest password Team will store. */
export const MINIMUM_PASSWORD_LENGTH = 10;

/**
 * The most a display name may be, in UTF-8 bytes.
 *
 * What a person is called, not a biography — which is the figure the protocol
 * method has always read one at. It lives here, beside the write that enforces
 * it, because the method is not the only way in: `nlteam user create --root` and
 * `nlteam init --root` reach this store with no frame reader in front of them,
 * and a bound only one of the three paths honoured is not a bound.
 *
 * **What it is really guarding is not the column.** A minted token carries the
 * display name, tokens are sent in an `authorization` header, and a header past
 * what Node will put on the wire means that account's socket cannot open. The
 * account is then locked out by its own name, from a client that has no way to
 * change it — so this is the one field here where storing what somebody typed
 * takes their access away rather than merely looking wrong.
 */
export const DISPLAY_NAME_LIMIT = 128;

/**
 * The most an email address may be, in bytes.
 *
 * What RFC 5321 allows a path to be, which is the figure the protocol method
 * has always read one at. It is here beside the display name's because both
 * ride in a token and both lock an account out at the same place if they are
 * let past.
 */
export const EMAIL_LIMIT = 320;

/**
 * What somebody is told when one of the two is too long.
 *
 * Written once and read by two places: the error this store raises, and the
 * frame reader in front of the protocol method, which would otherwise refuse
 * the same input with a shorter sentence of its own. A ceiling explained on
 * one road and merely stated on the other is one rule that reads as two.
 */
export const DISPLAY_NAME_REFUSAL =
  `a display name must be at most ${DISPLAY_NAME_LIMIT} bytes. It is carried by every ` +
  "token this account is issued, tokens travel in an authorization header, and a " +
  "header past what will be sent leaves the account unable to open a connection at " +
  "all — so a name too long is an account locked out by its own name.";

export const EMAIL_REFUSAL =
  `an email address must be at most ${EMAIL_LIMIT} bytes. It is carried by every ` +
  "token this account is issued, tokens travel in an authorization header, and a " +
  "header past what will be sent leaves the account unable to open a connection at " +
  "all — so an address too long is an account locked out by its own address.";

/** The group an account joins when no role is named. */
export const DEFAULT_ROLE = "member";

/**
 * The group that may administer this server.
 *
 * `nlteam init` puts the first account here because there is nobody to put it
 * there afterwards: a server whose only account could not administer it would
 * need a second command to fix a situation it had just created.
 */
export const ADMIN_ROLE = "admin";

/**
 * Whether an account may administer this server.
 *
 * The one question asked of a set of groups anywhere, and it is asked here
 * beside the groups themselves rather than beside any of the surfaces that ask
 * it: the label a session puts on an account and the door a request is let
 * through have to be decided by the same rule, or an account is shown as an
 * operator by one and refused by the other.
 */
export function isOperator(groups: readonly string[]): boolean {
  return groups.includes(ADMIN_ROLE);
}

/**
 * The group of accounts an operator has let make projects, which is what
 * `project.create_by = creators` asks about. Operators may whether or not they
 * are in it.
 */
export const PROJECT_CREATOR_ROLE = "project-creator";

/** Whether a set of groups includes the project creators' (or an operator's). */
export function isProjectCreator(groups: readonly string[]): boolean {
  return isOperator(groups) || groups.includes(PROJECT_CREATOR_ROLE);
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Fold a username to the form it is stored and compared in.
 *
 * Case is removed rather than preserved, so that `Ada` and `ada` cannot become
 * two accounts that look like one person in every list they appear in.
 */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

function groupsOf(database: DatabaseSync, userId: string): string[] {
  const rows = database
    .prepare("SELECT group_name FROM user_groups WHERE user_id = ? ORDER BY group_name")
    .all(userId);
  return rows.map((row) => textColumn(row, "group_name"));
}

function toUser(database: DatabaseSync, row: Row): UserRecord {
  const id = textColumn(row, "id");
  return {
    id,
    username: textColumn(row, "username"),
    displayName: textColumn(row, "display_name"),
    email: optionalTextColumn(row, "email"),
    isServiceAccount: booleanColumn(row, "is_service_account"),
    createdAt: integerColumn(row, "created_at"),
    disabledAt: optionalIntegerColumn(row, "disabled_at"),
    tokenEpoch: integerColumn(row, "token_epoch"),
    tokensInvalidatedAt: optionalIntegerColumn(row, "tokens_invalidated_at"),
    groups: groupsOf(database, id),
    ...optionalField("avatar", optionalTextColumn(row, "avatar")),
    ...optionalField("bio", optionalTextColumn(row, "bio")),
    ...optionalField("timezone", optionalTextColumn(row, "timezone")),
    ...optionalMoment("deletedAt", optionalIntegerColumn(row, "deleted_at")),
    ...optionalMoment("lockedUntil", optionalIntegerColumn(row, "locked_until")),
  };
}

function optionalMoment<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

function optionalField<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined || value === "" ? {} : { [key]: value }) as { [P in K]?: string };
}

const SELECT_USER =
  "SELECT id, username, display_name, email, is_service_account, created_at, " +
  "disabled_at, token_epoch, tokens_invalidated_at, avatar, bio, timezone, deleted_at, locked_until FROM users";

/**
 * Every account, in name order, one row at a time.
 *
 * For the caller that stops before the end. An answer over the session is
 * bounded by the bytes on it, and reading the table whole and then cutting it
 * down would have held every row first - and every row costs a second query for
 * the groups it is in. A caller that wants the lot has {@link listUsers}.
 */
export function* eachUser(database: DatabaseSync, options: ListOptions = {}): Generator<UserRecord> {
  const where = options.includeDeleted === true ? "" : "WHERE deleted_at IS NULL ";
  for (const row of database.prepare(`${SELECT_USER} ${where}ORDER BY username`).iterate()) {
    yield toUser(database, row as Row);
  }
}

export interface ListOptions {
  /**
   * Deleted accounts too. Left out by default: they are names kept for the history that holds
   * them, not accounts anybody can pick, add or sign in as.
   */
  readonly includeDeleted?: boolean;
}

/** Every account, in name order. */
export function listUsers(database: DatabaseSync, options: ListOptions = {}): UserRecord[] {
  return [...eachUser(database, options)];
}

export interface UserQuery {
  readonly limit: number;
  /**
   * Where the previous page ended, as `<createdAt>:<id>`.
   *
   * The id is in it because `nlteam init` and a script that makes a team's
   * accounts in one go write several within the same millisecond, and a cursor
   * that was only a time would either repeat one of them or skip one. Opaque to
   * whoever holds it, which passes back what it was given.
   */
  readonly before?: string;
}

export interface UserPage {
  readonly users: UserRecord[];
  /** Where to carry on from, absent when this is the end. */
  readonly cursor?: string;
}

/**
 * A page of the accounts, newest first.
 *
 * By when they were made rather than by name, which is what {@link listUsers}
 * orders by, because a page has to be cut somewhere both sides agree on and a
 * username can be neither compared across pages nor relied on to stay put — a
 * list ordered by something that can change under a cursor repeats and skips
 * rows as it is paged. Newest first because the accounts an operator is
 * checking on are the ones that have just appeared.
 *
 * One row more than asked for is read, which is how "is there more" is answered
 * without a second query.
 */
export function pageUsers(database: DatabaseSync, query: UserQuery): UserPage {
  const conditions: string[] = ["deleted_at IS NULL"];
  const values: (string | number)[] = [];
  const cursor = parseUserCursor(query.before);
  if (cursor !== undefined) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = database
    .prepare(
      `${SELECT_USER} WHERE ${conditions.join(" AND ")} ` +
        "ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(...values, query.limit + 1);

  const users = rows.slice(0, query.limit).map((row) => toUser(database, row));
  const last = users.at(-1);
  return {
    users,
    ...(rows.length > query.limit && last !== undefined
      ? { cursor: `${last.createdAt}:${last.id}` }
      : {}),
  };
}

function parseUserCursor(
  value: string | undefined,
): { readonly createdAt: number; readonly id: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  // A cursor nobody can read is treated as no cursor rather than as a refusal:
  // it came from this server, so one that does not parse is a caller that lost
  // its place, and the first page is where somebody who lost their place is.
  return Number.isInteger(createdAt) && id !== "" ? { createdAt, id } : undefined;
}

/** How many accounts exist. Zero is what makes a Team server need bootstrapping. */
export function countUsers(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM users").get();
  return row === undefined ? 0 : integerColumn(row, "count");
}

/** The account with this name, or undefined. */
export function findUser(database: DatabaseSync, username: string): UserRecord | undefined {
  const row = database
    .prepare(`${SELECT_USER} WHERE username = ?`)
    .get(normaliseUsername(username));
  return row === undefined ? undefined : toUser(database, row);
}

/**
 * The account with this id, or undefined.
 *
 * The id is what a token's `sub` claim holds, so this is how a caller who
 * presented one is turned back into an account. It is separate from lookup by
 * name because a name can be typed and an id cannot: nothing normalises here.
 */
export function findUserById(database: DatabaseSync, id: string): UserRecord | undefined {
  const row = database.prepare(`${SELECT_USER} WHERE id = ?`).get(id);
  return row === undefined ? undefined : toUser(database, row);
}

/** The account with this name, or a failure naming it. */
export function requireUser(database: DatabaseSync, username: string): UserRecord {
  const user = findUser(database, username);
  if (user === undefined) {
    throw new UnknownUserError(username);
  }
  return user;
}

/** What a new account is made from. */
export interface NewUser {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly isServiceAccount?: boolean;
  /** Group names, which become the token's `groups` claim. */
  readonly groups?: readonly string[];
}

/** An account checked and hashed, ready to be written. */
export interface PreparedUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly passwordHash: string;
  readonly isServiceAccount: boolean;
  readonly createdAt: number;
  readonly groups: readonly string[];
}

/**
 * Check an account and hash its password, touching no database.
 *
 * Hashing takes a good fraction of a second by design, which is why it happens
 * before any transaction is open rather than inside one.
 */
export async function prepareUser(
  hasher: PasswordHasher,
  input: NewUser,
): Promise<PreparedUser> {
  const username = normaliseUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidUsernameError(input.username);
  }
  if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }
  // The name an account falls back to is its username, which the pattern above
  // has already held to thirty-two characters - so this only ever refuses a
  // name somebody typed.
  const displayName = input.displayName ?? username;
  // Checked here for the reason a group name is: it reaches every token this
  // account is issued, and every path that writes an account comes through
  // here. The protocol method reads it at the same figure and refuses first, so
  // this is what covers the two `--root` commands, which have no frame reader
  // in front of them at all.
  if (Buffer.byteLength(displayName, "utf-8") > DISPLAY_NAME_LIMIT) {
    throw new InvalidDisplayNameError();
  }
  // The address, for the same reason and at the figure the protocol method has
  // always read one at. Absent is the ordinary case, and an account without one
  // carries no claim to be too long.
  if (input.email !== undefined && Buffer.byteLength(input.email, "utf-8") > EMAIL_LIMIT) {
    throw new InvalidEmailError();
  }
  // Checked here rather than where a role is read from a command line, because
  // a group name reaches the `groups` claim of every token this account is
  // issued, and every path that writes one comes through here.
  for (const group of input.groups ?? []) {
    if (!ROLE_PATTERN.test(group)) {
      throw new InvalidRoleError(group);
    }
  }

  return {
    id: randomUUID(),
    username,
    displayName,
    email: input.email,
    passwordHash: await hasher.hash(input.password),
    isServiceAccount: input.isServiceAccount === true,
    createdAt: Date.now(),
    groups: [...new Set(input.groups ?? [])].sort(),
  };
}

/**
 * Write a prepared account.
 *
 * No transaction is opened here, so that a caller which has more than the
 * account to write can put all of it inside one.
 */
export function insertUser(database: DatabaseSync, prepared: PreparedUser): void {
  try {
    database
      .prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash,
                            is_service_account, created_at, token_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        prepared.id,
        prepared.username,
        prepared.displayName,
        prepared.email ?? null,
        prepared.passwordHash,
        prepared.isServiceAccount ? 1 : 0,
        prepared.createdAt,
      );
    const addGroup = database.prepare(
      "INSERT INTO user_groups (user_id, group_name) VALUES (?, ?)",
    );
    for (const group of prepared.groups) {
      addGroup.run(prepared.id, group);
    }
    // What project.default_access gives: an editor of every project by
    // default, so a new account reaches what an account made before project
    // roles did; a viewer; or nothing, to join by asking. Written here rather
    // than through src/projects/members.ts, which reads this module, and inside
    // the same statement group so the account and its memberships arrive together.
    const access = storedProjectAccess(database);
    if (access !== "none") {
      database
        .prepare(
          `INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by, added_at)
           SELECT id, ?, ?, NULL, ? FROM projects`,
        )
        .run(prepared.id, access, prepared.createdAt);
    }
  } catch (error) {
    // SQLite reports the collision as a constraint failure naming the column.
    // Turning it into a sentence here keeps the caller from having to read
    // SQLite's wording to tell a taken name from a broken database.
    if (error instanceof Error && error.message.includes("users.username")) {
      throw new UsernameTakenError(prepared.username);
    }
    throw error;
  }
}

/**
 * Create an account.
 *
 * The password is hashed before anything is written, so a password that cannot
 * be stored does not leave a half-made account behind.
 */
export async function createUser(
  database: DatabaseSync,
  hasher: PasswordHasher,
  input: NewUser,
): Promise<UserRecord> {
  const prepared = await prepareUser(hasher, input);

  inTransaction(database, () => {
    insertUser(database, prepared);
  });

  return requireUser(database, prepared.username);
}

/**
 * Stop an account from getting anything new.
 *
 * Two things happen at once, and both are needed. `disabled_at` refuses the
 * next sign-in and the next mint; the bumped `token_epoch` makes any token
 * already issued unrenewable. Neither reaches back and cancels a token that is
 * already out there — ./tokens.ts sets out exactly what that leaves open.
 *
 * `tokens_invalidated_at` moves with the epoch, here and in
 * {@link revokeUserTokens}, and those are the only two places the epoch is
 * bumped. A moment written anywhere else, or left behind by one of them, would
 * be a screen saying an account's tokens were last refused at a time they were
 * not.
 */
export function disableUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireLiveUser(database, username);
  const now = Date.now();
  database
    .prepare(
      "UPDATE users SET disabled_at = ?, token_epoch = token_epoch + 1, " +
        "tokens_invalidated_at = ? WHERE id = ?",
    )
    .run(now, now, user.id);
  return requireUser(database, user.username);
}

/**
 * Let an account sign in again.
 *
 * The epoch is deliberately not put back: tokens minted before the account was
 * disabled stay unrenewable, because whatever made disabling worth doing has
 * not become untrue.
 */
export function enableUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireLiveUser(database, username);
  database.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(user.id);
  return requireUser(database, user.username);
}

/**
 * Refuse every token already issued to an account, and change nothing else.
 *
 * The same bump {@link disableUser} makes, without the `disabled_at` that goes
 * with it: the person may sign in a second later and be given a token that
 * works, while everything issued before this moment is refused wherever Team is
 * the one asked. That is the operation for a token that has got out, as
 * against an account that should not have one — ./tokens.ts sets out how far
 * either of them reaches, and where neither does.
 */
export function revokeUserTokens(database: DatabaseSync, username: string): UserRecord {
  const user = requireLiveUser(database, username);
  database
    .prepare(
      "UPDATE users SET token_epoch = token_epoch + 1, tokens_invalidated_at = ? WHERE id = ?",
    )
    .run(Date.now(), user.id);
  return requireUser(database, user.username);
}

/** Raised for a change to an account an operator has deleted: there is nothing left to change. */
export class DeletedUserError extends Error {
  constructor(username: string) {
    super(`${username} was deleted`);
    this.name = "DeletedUserError";
  }
}

function requireLiveUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireUser(database, username);
  if (user.deletedAt !== undefined) {
    throw new DeletedUserError(user.username);
  }
  return user;
}

/** A stored password hash no password matches: it is not in any form a hasher reads. */
const NO_PASSWORD = "deleted";

/**
 * The tables whose rows go with an account when it goes, which the schema says with
 * `ON DELETE CASCADE`. Reviews are kept although they say so: a review somebody gave is part of
 * the project's history, and the account's row - which is what the history points at - stays.
 */
const KEPT_ON_DELETE = new Set(["reviews"]);

function personalTables(database: DatabaseSync): { table: string; column: string }[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => textColumn(row, "name"));
  const found: { table: string; column: string }[] = [];
  for (const table of tables) {
    if (KEPT_ON_DELETE.has(table)) continue;
    for (const key of database.prepare(`PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`).all()) {
      if (key["table"] === "users" && String(key["on_delete"]).toUpperCase() === "CASCADE") {
        found.push({ table, column: textColumn(key, "from") });
      }
    }
  }
  return found;
}

/**
 * Delete an account.
 *
 * The row stays, because comments, history, audit and the projects it made name it by id, and
 * the name stays with it so nobody can later take it and be read as the person who wrote those.
 * Everything else goes: the password, the address, the picture and the line about themselves,
 * every session and token, the second step, its memberships and groups, and every other row the
 * schema marks as going with the account. It can never sign in again, and an operator cannot
 * bring it back: that is what makes this different from disabling it.
 */
export function deleteUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireLiveUser(database, username);
  const now = Date.now();
  inTransaction(database, () => {
    for (const { table, column } of personalTables(database)) {
      database.prepare(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE "${column.replaceAll('"', '""')}" = ?`).run(user.id);
    }
    database
      .prepare(
        "UPDATE users SET deleted_at = ?, disabled_at = COALESCE(disabled_at, ?), " +
          "token_epoch = token_epoch + 1, tokens_invalidated_at = ?, display_name = username, " +
          "email = NULL, avatar = NULL, bio = NULL, timezone = NULL, notify_hook = NULL, " +
          "password_hash = ?, failed_signins = 0, locked_until = NULL WHERE id = ?",
      )
      .run(now, now, now, NO_PASSWORD, user.id);
  });
  return requireUser(database, user.username);
}

/**
 * Refuse an account's sign-ins until a moment, or for good with no moment named.
 *
 * Unlike disabling, the tokens it holds are left alone: a lock is about the door, and it is what
 * too many wrong passwords puts on an account by itself.
 */
export function lockUser(database: DatabaseSync, username: string, until?: number): UserRecord {
  const user = requireLiveUser(database, username);
  database
    .prepare("UPDATE users SET locked_until = ?, failed_signins = 0 WHERE id = ?")
    .run(until ?? Number.MAX_SAFE_INTEGER, user.id);
  return requireUser(database, user.username);
}

/** Take a lock off, and forget the wrong passwords that led to it. */
export function unlockUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireLiveUser(database, username);
  database.prepare("UPDATE users SET locked_until = NULL, failed_signins = 0 WHERE id = ?").run(user.id);
  return requireUser(database, user.username);
}

/** Whether an account is locked at this moment. */
export function isLocked(user: UserRecord, now = Date.now()): boolean {
  return user.lockedUntil !== undefined && user.lockedUntil > now;
}

/** What an operator may change of somebody else's account. */
export interface ProfileChange {
  readonly displayName?: string;
  /** An empty string takes the address away. */
  readonly email?: string;
}

/** Change an account's display name or address, held to the limits an account is made with. */
export function updateUserProfile(database: DatabaseSync, username: string, change: ProfileChange): UserRecord {
  const user = requireLiveUser(database, username);
  if (change.displayName !== undefined) {
    const name = change.displayName.trim();
    if (name === "" || Buffer.byteLength(name, "utf-8") > DISPLAY_NAME_LIMIT) {
      throw new InvalidDisplayNameError();
    }
    database.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, user.id);
  }
  if (change.email !== undefined) {
    const email = change.email.trim();
    if (Buffer.byteLength(email, "utf-8") > EMAIL_LIMIT) {
      throw new InvalidEmailError();
    }
    database.prepare("UPDATE users SET email = ? WHERE id = ?").run(email === "" ? null : email, user.id);
  }
  return requireUser(database, user.username);
}

/**
 * Count one wrong password, or one wrong second step, against an account, and lock it when
 * `security.lockout_attempts` of them have come in a row. Nothing is counted while that is 0.
 */
export function recordFailedSignIn(database: DatabaseSync, userId: string, now = Date.now()): void {
  const attempts = policyNumber(database, LOCKOUT_ATTEMPTS);
  if (attempts <= 0) return;
  const row = database
    .prepare("UPDATE users SET failed_signins = failed_signins + 1 WHERE id = ? RETURNING failed_signins")
    .get(userId);
  if (row === undefined || integerColumn(row, "failed_signins") < attempts) return;
  const until = now + policyNumber(database, LOCKOUT_MINUTES) * 60_000;
  database.prepare("UPDATE users SET locked_until = ?, failed_signins = 0 WHERE id = ?").run(until, userId);
}

/** Forget the wrong passwords counted against an account, once it has signed in. */
export function clearFailedSignIns(database: DatabaseSync, userId: string): void {
  database.prepare("UPDATE users SET failed_signins = 0 WHERE id = ? AND failed_signins <> 0").run(userId);
}

/**
 * Put an account in the admin group, or take it out.
 *
 * That group is the whole of what `admin` means on this server: it is who may
 * administer it, and who may put somebody else in the group. It says nothing
 * about projects — every account of this server reaches every project on it,
 * and src/projects/registry.ts is where that is written down.
 *
 * Doing it twice is doing it once. An account already in the group is left in
 * it rather than failing, because the outcome the caller asked for is the
 * outcome either way.
 */
export function setAdmin(
  database: DatabaseSync,
  username: string,
  admin: boolean,
): UserRecord {
  const user = requireLiveUser(database, username);
  if (admin) {
    database
      .prepare(
        "INSERT INTO user_groups (user_id, group_name) VALUES (?, ?) " +
          "ON CONFLICT (user_id, group_name) DO NOTHING",
      )
      .run(user.id, ADMIN_ROLE);
  } else {
    database
      .prepare("DELETE FROM user_groups WHERE user_id = ? AND group_name = ?")
      .run(user.id, ADMIN_ROLE);
  }
  return requireUser(database, user.username);
}

/** Let an account make projects, or stop it. Doing it twice is doing it once. */
export function setProjectCreator(database: DatabaseSync, username: string, allowed: boolean): UserRecord {
  const user = requireLiveUser(database, username);
  if (allowed) {
    database
      .prepare(
        "INSERT INTO user_groups (user_id, group_name) VALUES (?, ?) " +
          "ON CONFLICT (user_id, group_name) DO NOTHING",
      )
      .run(user.id, PROJECT_CREATOR_ROLE);
  } else {
    database
      .prepare("DELETE FROM user_groups WHERE user_id = ? AND group_name = ?")
      .run(user.id, PROJECT_CREATOR_ROLE);
  }
  return requireUser(database, user.username);
}

/**
 * How many accounts are in the admin group and can still sign in.
 *
 * Asked by the management plane and by nothing else: it is the one place that
 * has to refuse a change leaving this server with no operator who can reach it,
 * because it is the one place that would then have no way of putting that right.
 * The command line asks nothing of the sort — it runs on the machine that holds
 * the storage root, which is the way back from every state this count is about.
 *
 * Enabled rather than merely present, and that is the whole point of the join. A
 * disabled account is refused a sign-in and every token it holds is refused too,
 * so counting it would let the last usable operator be taken away by a check
 * that said one was left.
 */
export function countEnabledAdmins(database: DatabaseSync): number {
  // A deleted account is also disabled, so the condition below already leaves it out.
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM user_groups JOIN users ON users.id = user_groups.user_id " +
        "WHERE user_groups.group_name = ? AND users.disabled_at IS NULL",
    )
    .get(ADMIN_ROLE);
  return row === undefined ? 0 : integerColumn(row, "count");
}

/** Read the stored password hash of one account. */
function passwordHashOf(database: DatabaseSync, id: string): string | undefined {
  const row = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(id);
  return row === undefined ? undefined : textColumn(row, "password_hash");
}

/** Replace a stored hash with one made under the current parameters. */
function setPasswordHash(database: DatabaseSync, id: string, hash: string): void {
  database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
}

/** Why a sign-in did not succeed. The person signing in is told none of this. */
export type SignInFailure =
  | "no-such-user"
  | "wrong-password"
  | "disabled"
  | "locked"
  | "unreadable-password-hash";

/** The outcome of checking a name and a password. */
export type SignInResult =
  | { readonly kind: "signed-in"; readonly user: UserRecord }
  | { readonly kind: "refused"; readonly reason: Exclude<SignInFailure, "locked"> }
  | { readonly kind: "refused"; readonly reason: "locked"; readonly until: number };

/**
 * The one sentence a failed sign-in is reported with, whichever way it failed.
 *
 * Saying "no such user" would let anyone with a browser enumerate the accounts
 * on a Team server, and saying "your stored password could not be read" would tell them
 * which account to attack next.
 */
export const SIGN_IN_REFUSED_MESSAGE = "the username or password is not right";

/**
 * A hash to check a password against when there is no account to check it
 * against, so that an unknown username costs the same time as a known one.
 *
 * Without it, a wrong username answers in a millisecond and a wrong password
 * answers in half a second, and the difference is a list of who has an account
 * here. It is derived once per process from bytes nobody knows, so no password
 * ever matches it.
 */
let decoyHash: Promise<string> | undefined;

function decoy(hasher: PasswordHasher): Promise<string> {
  decoyHash ??= hasher.hash(randomUUID());
  return decoyHash;
}

/**
 * Check a username and password.
 *
 * A successful sign-in against a hash made with superseded parameters replaces
 * it, here and nowhere else: this is the only moment the plain password exists
 * in the process, so it is the only moment the stored hash can be upgraded.
 */
export async function authenticate(
  database: DatabaseSync,
  hasher: PasswordHasher,
  username: string,
  password: string,
): Promise<SignInResult> {
  const user = findUser(database, username);
  // A deleted account is answered exactly as one that never existed.
  if (user === undefined || user.deletedAt !== undefined) {
    await hasher.verify(password, await decoy(hasher));
    return { kind: "refused", reason: "no-such-user" };
  }
  // Locked: the password is not checked at all, or the lock would not stop anybody guessing.
  // The decoy keeps the answer as slow as a real check.
  if (isLocked(user)) {
    await hasher.verify(password, await decoy(hasher));
    return { kind: "refused", reason: "locked", until: user.lockedUntil ?? 0 };
  }

  const stored = passwordHashOf(database, user.id);
  if (stored === undefined) {
    return { kind: "refused", reason: "unreadable-password-hash" };
  }

  let matches: boolean;
  try {
    matches = await hasher.verify(password, stored);
  } catch (error) {
    if (error instanceof MalformedPasswordHashError) {
      return { kind: "refused", reason: "unreadable-password-hash" };
    }
    throw error;
  }
  if (!matches) {
    recordFailedSignIn(database, user.id);
    return { kind: "refused", reason: "wrong-password" };
  }

  // Checked after the password, not before: an attacker who learns that a name
  // exists but is disabled has learned the password was right.
  if (user.disabledAt !== undefined) {
    return { kind: "refused", reason: "disabled" };
  }

  if (hasher.needsRehash(stored)) {
    setPasswordHash(database, user.id, await hasher.hash(password));
  }
  return { kind: "signed-in", user };
}
