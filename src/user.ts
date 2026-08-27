/**
 * The `user` commands: list the accounts, make one, take access away or give it
 * back, and refuse the tokens one account already has.
 *
 * The ones that change something say what they did and what they did not do.
 * An operator who has just disabled somebody is entitled to know how far that
 * reaches, and it is not the same distance everywhere: Team refuses every token
 * it has issued them from that moment on, while a data connection already open
 * is checked by loreserver's data plane rather than by Team and may last until
 * the token it was opened with expires. src/identity/tokens.ts is where the two
 * lifetimes are set out, and why they are two.
 *
 * Every one of them has two paths and one output. Given `--root` it opens the
 * database beside the server; given `--server` it calls the method of the same
 * name on a session. **What is printed is written once and called from both**,
 * which is the whole reason the renderers below take rows rather than records:
 * an operator who administers one server over ssh and another over the protocol
 * has to be reading the same thing, and two functions writing the same line are
 * how that stops being true.
 */
import { TEAM_METHODS } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { allUsers, repositoryTokenLifetime } from "./client/admin.js";
import { readUser, type ListedUser } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { describeDuration } from "./duration.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import { storedTokenLifetimes } from "./identity/settings.js";
import {
  createUser,
  disableUser,
  enableUser,
  listUsers,
  revokeUserTokens,
  setAdmin,
  type UserRecord,
} from "./identity/users.js";
import { readPassword } from "./stdin.js";

export interface UserListOptions {
  readonly root: string;
}

export interface UserCreateOptions {
  readonly root: string;
  readonly username: string;
  /** The group the account joins. */
  readonly role: string;
  readonly displayName: string | undefined;
  readonly email: string | undefined;
  readonly isServiceAccount: boolean;
}

export interface UserStateOptions {
  readonly root: string;
  readonly username: string;
}

/** What a command over the protocol is told: which server, and about whom. */
export interface UserOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
  readonly username: string;
}

export interface UserCreateOnServerOptions {
  readonly server: string;
  readonly username: string;
  readonly displayName: string | undefined;
  readonly email: string | undefined;
  /**
   * Whether the new account may administer this server.
   *
   * One flag rather than a group name, because that is the whole of what the
   * method carries and the whole of what a role decides here. The command line
   * refuses a `--role` that is neither, rather than sending something the server
   * would drop — see src/args.ts.
   */
  readonly operator: boolean;
}

export interface UserListOnServerOptions {
  readonly server: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One account, as either path has it. */
interface UserRow {
  readonly username: string;
  readonly groups: readonly string[];
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
}

/** The row a record on this machine makes. */
function rowOf(user: UserRecord): UserRow {
  return {
    username: user.username,
    groups: user.groups,
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
  };
}

/** One account, on one line, with the columns padded to line up. */
function renderUser(user: UserRow, usernameWidth: number): string {
  const state = user.disabled ? "disabled" : "enabled ";
  const kind = user.serviceAccount ? "service" : "person ";
  const groups = user.groups.length === 0 ? "-" : user.groups.join(",");
  return `${user.username.padEnd(usernameWidth)}  ${state}  ${kind}  ${groups}`;
}

/**
 * The accounts, or the sentence that stands in for none.
 *
 * The empty sentence is the caller's because it names what to do about it, and
 * that is the one thing the two paths cannot share: off a disk it is the command
 * that makes a first account under that storage root, and over the protocol
 * there is no such list — an account had to sign in to ask, so it is on it.
 */
function renderUsers(rows: readonly UserRow[], empty: string, stdout: WriteText): void {
  if (rows.length === 0) {
    stdout(`${empty}\n`);
    return;
  }
  const width = Math.max(...rows.map((row) => row.username.length));
  for (const row of rows) {
    stdout(`${renderUser(row, width)}\n`);
  }
}

/**
 * What a new account looks like, written once for both paths.
 *
 * The last line names the command that produces a token, and it is the one
 * thing that differs: `where` is `--root <path>` on one path and
 * `--server <address>` on the other, because it is the command the person
 * reading this would actually run next. An account nobody was given a token for
 * reaches nothing, and that is the step it is easiest to stop one short of.
 */
function renderCreatedUser(
  user: { readonly username: string; readonly id: string; readonly groups: readonly string[] },
  where: string,
  stdout: WriteText,
): void {
  stdout(`created ${user.username} (${user.id})\n`);
  stdout(`groups: ${user.groups.join(", ")}\n`);
  stdout(`Give them a token to sign in with: nlteam token mint ${user.username} ${where}\n`);
}

/**
 * What disabling reached, said the same way on both paths.
 *
 * Stated every time, because the alternative is an operator believing either
 * more than happened or less. Nothing new is issued and nothing already issued
 * is accepted; a connection already open is the one thing neither of those
 * covers.
 */
function renderDisabled(username: string, repositoryLifetime: string, stdout: WriteText): void {
  stdout(`disabled ${username}\n`);
  stdout(
    "Nothing new is issued, and tokens already issued are refused from now on; a " +
      "connection already open may last until its repository token expires, at most " +
      `${repositoryLifetime} from now.\n`,
  );
}

/**
 * What refusing an account's tokens reached, said the same way on both paths.
 *
 * Two sentences after the first, because two things about this surprise people:
 * what it does not reach, and that it is not the same as disabling the account.
 */
function renderRevokedTokens(
  username: string,
  repositoryLifetime: string,
  stdout: WriteText,
): void {
  stdout(`revoked the tokens of ${username}\n`);
  stdout(
    "Tokens already issued are refused from now on; a connection already open may last " +
      `until its repository token expires, at most ${repositoryLifetime} from now.\n`,
  );
  stdout(
    `The account is not disabled, so ${username} can sign in and be issued a token ` +
      "that works.\n",
  );
}

/** What administering does and does not carry with it, said the same way on both paths. */
function renderAdminChange(username: string, admin: boolean, stdout: WriteText): void {
  stdout(
    admin
      ? `${username} is an admin: this server's settings, the accounts, and ` +
          "making another admin.\n"
      : `${username} is no longer an admin. The account is otherwise unchanged, and ` +
          "still reaches every project on this server.\n",
  );
}

/**
 * The accounts in the order the local path has always printed them.
 *
 * By username, and by code point rather than by locale: this is the order
 * SQLite's `ORDER BY username` gives on the other path, a username is lower-case
 * ASCII with dots, dashes and underscores in it, and a collation that ignored
 * punctuation would put `ada.b` and `adab` in different places on the two paths
 * for no reason a reader could see.
 */
function byUsername(rows: readonly UserRow[]): readonly UserRow[] {
  return [...rows].sort((left, right) =>
    left.username < right.username ? -1 : left.username > right.username ? 1 : 0,
  );
}

/** Print every account. Returns the process exit code. */
export async function userList(
  options: UserListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    renderUsers(
      listUsers(database).map(rowOf),
      `no accounts yet. Make the first one with: nlteam init <username> --root ${layout.root}`,
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** The row one of the protocol's accounts makes. */
function rowOfListed(user: ListedUser): UserRow {
  return {
    username: user.username,
    groups: user.groups,
    disabled: user.disabled,
    serviceAccount: user.serviceAccount,
  };
}

/**
 * Every account on a server, asked for over a session.
 *
 * Paged on the way in and sorted on the way out. The method hands back the
 * newest accounts first because that is the order a cursor can be cut in — a
 * name can move under one, a creation time cannot — and this command has always
 * printed them by name, so the whole list is collected and then ordered. See
 * src/client/admin.ts for why the paging is here and not on the far side.
 */
export async function userListOverProtocol(
  options: UserListOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const users = await withSession(options.server, async (session) => await allUsers(session));
    renderUsers(
      byUsername(users.map(rowOfListed)),
      // Unreachable rather than unlikely: an account had to sign in for this
      // call to be answered at all, so it is on the list it is asking for.
      "no accounts yet.",
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * Make an account. Returns the process exit code.
 *
 * What the person on the other end receives is not this account but a token
 * minted for it, so the last line says which command produces one.
 */
export async function userCreate(
  options: UserCreateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 2;
  }

  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = await createUser(database, defaultPasswordHasher(), {
      username: options.username,
      password,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      ...(options.email === undefined ? {} : { email: options.email }),
      isServiceAccount: options.isServiceAccount,
      groups: [options.role],
    });
    renderCreatedUser(user, `--root ${layout.root}`, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Make an account on a server this account administers.
 *
 * The password goes over the session, which is TLS to a server whose authority
 * this account pinned when it signed in. It still comes from standard input and
 * from nowhere else: an argument is visible to every process on the machine
 * through the process list and stays in the shell's history, and neither of
 * those is made better by the connection being encrypted. Nothing below puts it
 * in a message, and the one place a failure is reported prints the server's
 * sentence rather than what was sent.
 */
export async function userCreateOverProtocol(
  options: UserCreateOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 2;
  }

  try {
    const answer = await withSession(options.server, async (session) => {
      return await session.call(TEAM_METHODS.adminUsersCreate, {
        username: options.username,
        password,
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        ...(options.email === undefined ? {} : { email: options.email }),
        operator: options.operator,
      });
    });
    const user = readUser(TEAM_METHODS.adminUsersCreate, answer);
    renderCreatedUser(user, `--server ${options.server}`, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Stop an account getting anything new. Returns the process exit code. */
export async function userDisable(
  options: UserStateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = disableUser(database, options.username);
    const lifetimes = storedTokenLifetimes(database);
    renderDisabled(
      user.username,
      describeDuration(lifetimes.repositoryTokenLifetimeSeconds),
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Stop an account getting anything new, over a session. */
export async function userDisableOverProtocol(
  options: UserOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const { user, lifetime } = await withSession(options.server, async (session) => {
      // The lifetime first, so that a caller who may not administer this server
      // is refused before anything about the account has been changed.
      const repository = await repositoryTokenLifetime(session);
      const answer = await session.call(TEAM_METHODS.adminUsersDisable, {
        username: options.username,
      });
      return { user: readUser(TEAM_METHODS.adminUsersDisable, answer), lifetime: repository };
    });
    renderDisabled(user.username, lifetime, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Let an account sign in again. Returns the process exit code. */
export async function userEnable(
  options: UserStateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = enableUser(database, options.username);
    stdout(`enabled ${user.username}\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Let an account sign in again, over a session. */
export async function userEnableOverProtocol(
  options: UserOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const answer = await withSession(
      options.server,
      async (session) =>
        await session.call(TEAM_METHODS.adminUsersEnable, { username: options.username }),
    );
    stdout(`enabled ${readUser(TEAM_METHODS.adminUsersEnable, answer).username}\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * Refuse every token an account already holds. Returns the process exit code.
 *
 * What it prints is the whole of what it did, and the middle sentence is the
 * one that has to be there: an operator reading only the first would take the
 * word "every" to include a session somebody has open, and it does not.
 */
export async function userRevokeTokens(
  options: UserStateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = revokeUserTokens(database, options.username);
    const lifetimes = storedTokenLifetimes(database);
    renderRevokedTokens(
      user.username,
      describeDuration(lifetimes.repositoryTokenLifetimeSeconds),
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Refuse every token an account already holds, over a session. */
export async function userRevokeTokensOverProtocol(
  options: UserOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const { user, lifetime } = await withSession(options.server, async (session) => {
      const repository = await repositoryTokenLifetime(session);
      const answer = await session.call(TEAM_METHODS.adminUsersRevokeTokens, {
        username: options.username,
      });
      return { user: readUser(TEAM_METHODS.adminUsersRevokeTokens, answer), lifetime: repository };
    });
    renderRevokedTokens(user.username, lifetime, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * Put an account in the admin group, or take it out. Returns the exit code.
 *
 * **The last account in the group can be taken out of it here, and there is no
 * guard against doing so.** That is deliberate, and it is written down because
 * it reads like an omission and somebody will otherwise put one back.
 *
 * "This server must not be left with nobody who can administer it" is a rule of
 * the management plane, and the management plane enforces it — see
 * `refuseIfLastOperator` in src/team/methods/admin.ts, which refuses the same
 * change over the protocol and names this command as the way back. Whoever runs
 * `nlteam` holds the storage root. They are not a member of the admin group's
 * world and are not subject to its rules: they are the plane that repairs a
 * server the protocol can no longer reach, and a rescue plane that would not do
 * what nothing else can do would be no rescue at all.
 *
 * A guard here was also an inconsistency rather than a safeguard. `user disable
 * --root` has always disabled the only operator without a word, which leaves
 * exactly the same server as demoting them does — so refusing one and allowing
 * the other was two answers to one question, and the answer the command line
 * gives is that it does as it is told.
 */
export async function userSetAdmin(
  options: UserStateOptions & { readonly admin: boolean },
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = setAdmin(database, options.username, options.admin);
    renderAdminChange(user.username, options.admin, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Put an account in the admin group, or take it out, over a session.
 *
 * The refusal that guards the last operator lives here and nowhere else on this
 * command: it is the server's, and this path is the only one that can meet it.
 * It names the command to run on the machine that holds the storage root,
 * because a person reading it in a panel is exactly the person who needs to know
 * there is a way back — and {@link userSetAdmin} is that way back, which is why
 * it refuses nothing. Printed as it arrived, see the note on TeamCallError.
 */
export async function userSetAdminOverProtocol(
  options: UserOnServerOptions & { readonly admin: boolean },
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const method = options.admin
    ? TEAM_METHODS.adminUsersGrantAdmin
    : TEAM_METHODS.adminUsersRevokeAdmin;
  try {
    const answer = await withSession(
      options.server,
      async (session) => await session.call(method, { username: options.username }),
    );
    renderAdminChange(readUser(method, answer).username, options.admin, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
