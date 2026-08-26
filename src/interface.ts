/**
 * The command behind a bare `nlteam`: open the terminal interface on a storage
 * root.
 *
 * Everything the interface asks for is carried out by src/operations.ts, which
 * calls what the command of the same name calls: `d` reaches `disableUser`,
 * `x` reaches `revokeUserTokens`, `k` reaches `KeyStore.rotate`. None of it is
 * implemented twice, and what each one answers with says the same thing the
 * command prints — including how far it reaches, which is the part an operator
 * gets wrong.
 */
import type { WriteText } from "./cli.js";
import { en } from "./i18n/en.js";
import type { IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import { prepareLoreEnvironment } from "./lore/environment.js";
import {
  createAccount,
  createProjectWithRepository,
  issueToken,
  revokeTokens,
  rotateSigningKey,
  setSetting,
  setUserDisabled,
} from "./operations.js";
import { ViewPublisher } from "./publisher.js";
import { runInterface } from "./tui/run.js";
import type { Action } from "./tui/state.js";
import { readAuthority } from "./tls/authority.js";

import type { ViewContext } from "./view.js";
import type { DatabaseSync } from "node:sqlite";

// The rule about what an operator may type into the setting editor, which is a
// rule about this interface however it is spelled.
export { readDuration } from "./operations.js";

/**
 * Carry out one thing the interface asked for, and answer with the sentence to
 * show for it.
 *
 * The interface names what it wants and knows nothing about how it is met,
 * which is what keeps it from becoming a second implementation of the rules.
 * The one that names a command rather than doing anything needs a process this
 * program does not supervise; naming the command is the honest answer, and a
 * key that pretended to do it would not be.
 */
async function perform(context: ViewContext, action: Action): Promise<string> {
  switch (action.kind) {
    case "rotate-key":
      return (await rotateSigningKey(context)).message;
    case "set-user-disabled":
      return setUserDisabled(context, action.username, action.disabled).message;
    case "revoke-tokens":
      return revokeTokens(context, action.username).message;
    case "set-setting":
      return setSetting(context, action.index, action.value).message;
    case "create-account":
      return (
        await createAccount(context, {
          username: action.username,
          password: action.password,
          ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
          ...(action.email === undefined ? {} : { email: action.email }),
          operator: action.operator,
        })
      ).message;
    case "issue-token":
      // The token itself has nowhere to go here: this interface is a screen of
      // one sentence, and a credential shown on it would be a credential in
      // whatever the terminal keeps of what it has drawn.
      return (await issueToken(context, action.username)).message;
    case "create-project":
      return (
        await createProjectWithRepository(context, {
          name: action.name,
          owner: action.owner,
        })
      ).message;
    case "restart-loreserver":
      return en.action.loreserverNotOurs;
    case "quit":
    case "refresh":
      // Neither reaches here: the interface acts on both itself.
      return "";
  }
}

export interface InterfaceOptions {
  readonly root: string;
  readonly healthPort: number;
  readonly config: IdentityConfig;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the interface on a storage root. Returns the process exit code.
 *
 * The database is opened once and closed on the way out, however the interface
 * ended: a handle left open outlives the screen it was for.
 */
export async function terminalInterface(
  options: InterfaceOptions,
  _stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let database: DatabaseSync;
  try {
    database = await openMigratedDatabase(layout.databasePath);
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }

  try {
    // A Team server that has not been brought up yet has no authority, which is a
    // thing to say on screen rather than a reason to refuse to draw one.
    let fingerprint: string | undefined;
    try {
      fingerprint = (await readAuthority(options.root)).fingerprint256;
    } catch {
      fingerprint = undefined;
    }

    // Before the reader below exists, for the reason src/lore/environment.ts
    // sets out. This command reaches the same repositories `up` does and is not
    // reached through it, so settling that environment in `up` alone would
    // leave the interface reading as somebody else's session.
    //
    // Nothing is printed about it. A root with no authority yet is drawn as a
    // server that has not been brought up, which this interface already says
    // better than a line above the screen would.
    prepareLoreEnvironment(options.root);

    // What is inside a repository is read over the network, so it is read
    // beside the interface rather than in front of it: the first view is
    // gathered from the database and drawn at once, and each project's history
    // and file replace the word unknown as it arrives.
    const publisher = new ViewPublisher({
      root: layout.root,
      database,
      config: options.config,
      healthPort: options.healthPort,
      fingerprint,
    });

    publisher.start();
    try {
      await runInterface(await publisher.gather(), {
        refresh: () => {
          publisher.request();
          return publisher.gather();
        },
        perform: (action) => perform(publisher.context, action),
        subscribe: (listen) => publisher.subscribe(listen),
      });
    } finally {
      publisher.stop();
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
