/**
 * The `init` command: make this server's first account.
 *
 * Every other account is made by somebody who already has one. The first is the
 * exception, and this command is the whole of that exception: it works only
 * while the server has no accounts at all, and refuses from the moment it has
 * one. That refusal is the point — without it there would be a second,
 * unrecorded way to become an administrator of a server other people are
 * already on.
 *
 * The account joins the admin group, because it is the only account there is:
 * one that could not administer its own server would leave the operator needing
 * a second command to undo what the first had just done.
 *
 * The password is read from standard input, for the reason set out in
 * ./stdin.ts. The check for emptiness and the write are one transaction, so two
 * of these racing end with one account and one refusal.
 */
import type { WriteText } from "./cli.js";
import { inTransaction, openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import {
  ADMIN_ROLE,
  countUsers,
  insertUser,
  prepareUser,
  requireUser,
} from "./identity/users.js";
import { readPassword } from "./stdin.js";

export interface InitOptions {
  readonly root: string;
  readonly username: string;
  readonly displayName: string | undefined;
  readonly email: string | undefined;
}

/** Raised when there is already somebody who could make the next account. */
class ServerAlreadyInitialisedError extends Error {
  constructor(root: string) {
    super(
      "this server already has an account, so it is past being initialised. Make " +
        `another with: nlteam user create <username> --root ${root}`,
    );
    this.name = "ServerAlreadyInitialisedError";
  }
}

/** Make the first account. Returns the process exit code. */
export async function init(
  options: InitOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);

  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const database = await openMigratedDatabase(layout.databasePath);
  try {
    // Refused before hashing as well as inside the transaction, so that running
    // this on a server that already has people on it costs a moment rather than
    // half a second of scrypt.
    if (countUsers(database) > 0) {
      throw new ServerAlreadyInitialisedError(layout.root);
    }

    const prepared = await prepareUser(defaultPasswordHasher(), {
      username: options.username,
      password,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      ...(options.email === undefined ? {} : { email: options.email }),
      groups: [ADMIN_ROLE],
    });

    inTransaction(database, () => {
      if (countUsers(database) > 0) {
        throw new ServerAlreadyInitialisedError(layout.root);
      }
      insertUser(database, prepared);
    });

    const user = requireUser(database, prepared.username);
    stdout(`created ${user.username} (${user.id})\n`);
    stdout(`groups: ${user.groups.join(", ")}\n`);
    // What that group is for, said once, where somebody has just been put in
    // it. Every account reaches every project; this one may also change who
    // else has one.
    stdout(`It may administer this server: the accounts, the projects and the settings.\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
