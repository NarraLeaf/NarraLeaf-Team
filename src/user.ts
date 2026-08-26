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
 */
import type { WriteText } from "./cli.js";
import { describeDuration } from "./duration.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import { storedTokenLifetimes } from "./identity/settings.js";
import {
  ADMIN_ROLE,
  countAdmins,
  createUser,
  disableUser,
  enableUser,
  listUsers,
  requireUser,
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One account, on one line, with the columns padded to line up. */
function renderUser(user: UserRecord, usernameWidth: number): string {
  const state = user.disabledAt === undefined ? "enabled " : "disabled";
  const kind = user.isServiceAccount ? "service" : "person ";
  const groups = user.groups.length === 0 ? "-" : user.groups.join(",");
  return `${user.username.padEnd(usernameWidth)}  ${state}  ${kind}  ${groups}`;
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
    const users = listUsers(database);
    if (users.length === 0) {
      stdout(`no accounts yet. Make the first one with: nlteam init <username> --root ${layout.root}\n`);
      return 0;
    }
    const width = Math.max(...users.map((user) => user.username.length));
    for (const user of users) {
      stdout(`${renderUser(user, width)}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Make an account. Returns the process exit code.
 *
 * What the person on the other end receives is not this account but a token
 * minted for it, so the last line says which command produces one. An account
 * nobody was given a token for reaches nothing, and that is the step it is
 * easiest to stop one short of.
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
    stdout(`created ${user.username} (${user.id})\n`);
    stdout(`groups: ${user.groups.join(", ")}\n`);
    stdout(
      `Give them a token to sign in with: nlteam token mint ${user.username} --root ${layout.root}\n`,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
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
    stdout(`disabled ${user.username}\n`);
    // Stated every time, because the alternative is an operator believing
    // either more than happened or less. Nothing new is issued and nothing
    // already issued is accepted; a connection already open is the one thing
    // neither of those covers.
    stdout(
      "Nothing new is issued, and tokens already issued are refused from now on; a " +
        "connection already open may last until its repository token expires, at most " +
        `${describeDuration(lifetimes.repositoryTokenLifetimeSeconds)} from now.\n`,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
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
    stdout(`revoked the tokens of ${user.username}\n`);
    // Two sentences, because two things about this surprise people: what it
    // does not reach, and that it is not the same as disabling the account.
    stdout(
      "Tokens already issued are refused from now on; a connection already open may last " +
        `until its repository token expires, at most ` +
        `${describeDuration(lifetimes.repositoryTokenLifetimeSeconds)} from now.\n`,
    );
    stdout(
      `The account is not disabled, so ${user.username} can sign in and be issued a token ` +
        "that works.\n",
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Put an account in the admin group, or take it out. Returns the exit code.
 *
 * The last account in the group cannot be taken out of it. A server with no
 * admin has nobody who can put one back, and the way out of that would be to
 * edit the database by hand — so the refusal happens here, where there is
 * somebody to read it.
 */
export async function userSetAdmin(
  options: UserStateOptions & { readonly admin: boolean },
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    if (!options.admin) {
      const user = requireUser(database, options.username);
      if (user.groups.includes(ADMIN_ROLE) && countAdmins(database) <= 1) {
        stderr(
          `nlteam: ${user.username} is the only admin on this server, and a server with none ` +
            "has nobody who can make one. Make somebody else an admin first.\n",
        );
        return 1;
      }
    }
    const user = setAdmin(database, options.username, options.admin);
    stdout(
      options.admin
        ? `${user.username} is an admin: this server's settings, the accounts, and ` +
            "making another admin.\n"
        : `${user.username} is no longer an admin. The account is otherwise unchanged, and ` +
            "still reaches every project on this server.\n",
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
