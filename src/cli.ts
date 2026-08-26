import { parseArgs } from "./args.js";
import { describeDuration } from "./duration.js";
import { DEFAULT_IDENTITY, identityConfig } from "./identity/config.js";
import { SERVER_NAME_KEY, SETTING_KEYS } from "./identity/settings.js";
import { DEFAULT_ROLE } from "./identity/users.js";
import { init } from "./init.js";
import { terminalInterface } from "./interface.js";
import { keyList, keyRotate } from "./key.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";
import { projectCreate, projectList } from "./project.js";
import { settingsList, settingsSet } from "./settings.js";
import { tokenMint } from "./token.js";
import { trust } from "./trust.js";
import { up } from "./up.js";
import {
  userCreate,
  userDisable,
  userEnable,
  userList,
  userRevokeTokens,
  userSetAdmin,
} from "./user.js";
import { VERSION } from "./version.js";

/**
 * Somewhere to send a chunk of already-formatted output. `process.stdout.write`
 * satisfies it; a test can pass a function that appends to an array instead,
 * which is why `run` takes its two streams as parameters rather than reaching
 * for the process globals.
 */
export type WriteText = (text: string) => void;

/** Anything a command needs that does not come from the command line. */
export interface RunOptions {
  /**
   * Aborted when the operator interrupts the program. Commands that run until
   * stopped watch it; the rest ignore it.
   */
  readonly signal?: AbortSignal;
}

/**
 * The default sign-in lifetime, written the way the help text says it.
 *
 * Through {@link describeDuration} rather than divided by sixty: the number is
 * thirty days, and "43200m" is the same duration in a form nobody reads.
 */
const DEFAULT_SIGN_IN_LIFETIME = describeDuration(DEFAULT_IDENTITY.signInTokenLifetimeSeconds);

/** The text `--help` prints. */
export const USAGE = `Usage: nlteam <command> [options]

NarraLeaf Team is a self-hosted project server for teams using NarraLeaf Studio.

With no command it opens the terminal interface on the server at --root. A bare
nlteam, at a terminal, opens it on NLTEAM_ROOT or on the working directory when
that is a server already.

Commands:
  up                        Install and run loreserver, and serve the
                            sign-in endpoint
  init <username>           Make the first account, on a server with none
  user list                 List the accounts
  user create <username>    Make an account
  user disable <username>   Stop an account being issued anything new
  user enable <username>    Let an account sign in again
  user revoke-tokens <username>
                            Refuse every token already issued to an account,
                            leaving it able to sign in again
  user grant-admin <username>
                            Let an account open the operator's view, manage the
                            accounts, and make another admin
  user revoke-admin <username>
                            Take that away, leaving the account otherwise as it
                            was
  token mint <username>     Sign a token for an account
  project create <name>     Create a repository and record it
  project list              List the projects
  settings list             Show the settings this server keeps, and whether
                            each is the default or was set here
  settings set <key> <value>
                            Change one of them
  key list                  Show the signing keys
  key rotate                Generate a key and sign with it from now on
  trust                     Show this server's certificate authority and its
                            fingerprint, and change nothing

Every command takes --root <path>, the directory Team keeps its files in.

Options for up:
      --health-port <port>  loreserver's HTTP health check port (default ${DEFAULT_PORTS.healthPort})
      --no-identity         Configure loreserver to demand nothing, so that
                            anybody who can reach it may read and write every
                            repository on this server. It demands a Team token
                            unless this is given
      --identity            Ask for what happens anyway; accepted so that a
                            command line written before it was the default
                            still runs

Options for trust:
      --install             Trust this authority in this account's trust store
      --remove              Stop trusting it

Options for init:
      --display-name <name> Name shown to other people
      --email <address>

Options for user create:
      --role <name>         Group the account joins (default ${DEFAULT_ROLE}).
                            Only admin means anything to this server: it is
                            who may open the operator's view. Every account
                            reaches every project either way
      --display-name <name> Name shown to other people
      --email <address>
      --service-account     Mark the account as one no person signs in to

Options for project create:
      --description <text>
      --as <username>       The account to record as its creator, when the
                            server has more than one


Identity options, taken by up, token mint and project create. A token's
audience is built from these, so a command given a different set to the one
up was given mints a token that will not be accepted:
      --data-port <port>    Where loreserver serves data, which a client reaches
                            as lore://host:port (default ${DEFAULT_PORTS.dataPort})
      --hostname <host>     A name people reach this server by. Goes into the
                            auth endpoint's certificate and into every token's
                            audience. Repeatable; the loopback and localhost are
                            always included
      --team-port <port>    Team's own HTTP port (default ${DEFAULT_IDENTITY.teamPort})
      --auth-port <port>    Port loreserver asks about permissions on, in plain
                            HTTP/2 on the loopback (default ${DEFAULT_IDENTITY.authPort})
      --auth-tls-port <port>
                            Port clients sign in on, over TLS
                            (default ${DEFAULT_IDENTITY.authTlsPort})
      --issuer <name>       Token issuer (default ${DEFAULT_IDENTITY.issuer})
      --audience <name>     Audience loreserver requires (default ${DEFAULT_IDENTITY.audience})
      --auth-origin <host>  Host and port clients authenticate against, without
                            a scheme (default ${DEFAULT_IDENTITY.authOrigin})
      --env <name>          Environment claim (default ${DEFAULT_IDENTITY.env})
      --idp <name>          Identity provider claim (default ${DEFAULT_IDENTITY.idp})
      --token-lifetime <duration>
                            How long a sign-in token lasts, overriding this
                            server's stored setting for this run
                            (default ${DEFAULT_SIGN_IN_LIFETIME})

Options:
  -v, --version    Print the version and exit
  -h, --help       Print this message and exit

settings set takes the keys below. The two lifetimes take a duration written
the way --token-lifetime is: 30m, 48h, 7d, or a bare number of seconds.
${SERVER_NAME_KEY} takes the name this deployment is called in Studio, which is
its host until somebody chooses one. The keys are
${SETTING_KEYS.map((key) => `  ${key}`).join("\n")}

init, user create and token mint read the password from standard input.

up runs until it is interrupted, and stops loreserver on its way out.`;

/**
 * Carry out one command line and return the process exit code.
 *
 * `--version` prints the bare version and nothing else, so that a script can
 * read it without having to strip a label off the front.
 */
export async function run(
  argv: readonly string[],
  stdout: WriteText,
  stderr: WriteText,
  options: RunOptions = {},
): Promise<number> {
  const invocation = parseArgs(argv);

  switch (invocation.kind) {
    case "version":
      stdout(`${VERSION}\n`);
      return 0;
    case "help":
      stdout(`${USAGE}\n`);
      return 0;
    case "interface":
      return await terminalInterface(
        {
          root: invocation.root,
          healthPort: invocation.healthPort,
          config: identityConfig(invocation.overrides),
        },
        stdout,
        stderr,
      );
    case "up":
      return await up(
        {
          root: invocation.root,
          dataPort: invocation.dataPort,
          healthPort: invocation.healthPort,
          identity: invocation.identity,
          overrides: invocation.overrides,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        stdout,
        stderr,
      );
    case "init":
      return await init(
        {
          root: invocation.root,
          username: invocation.username,
          displayName: invocation.displayName,
          email: invocation.email,
        },
        stdout,
        stderr,
      );
    case "user-list":
      return await userList({ root: invocation.root }, stdout, stderr);
    case "user-create":
      return await userCreate(
        {
          root: invocation.root,
          username: invocation.username,
          role: invocation.role,
          displayName: invocation.displayName,
          email: invocation.email,
          isServiceAccount: invocation.isServiceAccount,
        },
        stdout,
        stderr,
      );
    case "user-disable":
      return await userDisable(
        { root: invocation.root, username: invocation.username },
        stdout,
        stderr,
      );
    case "user-enable":
      return await userEnable(
        { root: invocation.root, username: invocation.username },
        stdout,
        stderr,
      );
    case "user-set-admin":
      return await userSetAdmin(
        { root: invocation.root, username: invocation.username, admin: invocation.admin },
        stdout,
        stderr,
      );
    case "user-revoke-tokens":
      return await userRevokeTokens(
        { root: invocation.root, username: invocation.username },
        stdout,
        stderr,
      );
    case "token-mint":
      return await tokenMint(
        {
          root: invocation.root,
          username: invocation.username,
          overrides: invocation.overrides,
        },
        stdout,
        stderr,
      );
    case "project-create":
      return await projectCreate(
        {
          root: invocation.root,
          name: invocation.name,
          description: invocation.description,
          as: invocation.as,
          dataPort: invocation.dataPort,
          overrides: invocation.overrides,
        },
        stdout,
        stderr,
      );
    case "project-list":
      return await projectList({ root: invocation.root }, stdout, stderr);
    case "settings-list":
      return await settingsList({ root: invocation.root }, stdout, stderr);
    case "settings-set":
      return await settingsSet(
        { root: invocation.root, change: invocation.change },
        stdout,
        stderr,
      );
    case "key-list":
      return await keyList({ root: invocation.root }, stdout, stderr);
    case "key-rotate":
      return await keyRotate({ root: invocation.root }, stdout, stderr);
    case "trust":
      return await trust(
        { root: invocation.root, install: invocation.install, remove: invocation.remove },
        stdout,
        stderr,
      );
    case "error":
      // Prefix the program name the way command line tools conventionally do,
      // so the line still identifies its source in a wall of build output.
      stderr(`nlteam: ${invocation.message}\n`);
      return 2;
  }
}
