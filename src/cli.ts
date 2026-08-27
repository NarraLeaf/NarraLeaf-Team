import { parseArgs } from "./args.js";
import { describeDuration } from "./duration.js";
import { DEFAULT_IDENTITY } from "./identity/config.js";
import { SERVER_NAME_KEY, SETTING_KEYS } from "./identity/settings.js";
import { ADMIN_ROLE, DEFAULT_ROLE } from "./identity/users.js";
import { init } from "./init.js";
import { keyList, keyListOverProtocol, keyRotate, keyRotateOverProtocol } from "./key.js";
import { login, logout } from "./login.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";
import {
  projectCreate,
  projectCreateOverProtocol,
  projectList,
  projectListOverProtocol,
} from "./project.js";
import {
  settingsList,
  settingsListOverProtocol,
  settingsSet,
  settingsSetOverProtocol,
} from "./settings.js";
import { tokenMint, tokenMintOverProtocol } from "./token.js";
import { trust } from "./trust.js";
import { up } from "./up.js";
import {
  userCreate,
  userCreateOverProtocol,
  userDisable,
  userDisableOverProtocol,
  userEnable,
  userEnableOverProtocol,
  userList,
  userListOverProtocol,
  userRevokeTokens,
  userRevokeTokensOverProtocol,
  userSetAdmin,
  userSetAdminOverProtocol,
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

It is a service with no interface of its own: up runs it, the commands below
administer it, and the people who use it reach it from NarraLeaf Studio.

Commands:
  up                        Install and run loreserver, and serve the
                            sign-in endpoint
  init <username>           Make the first account, on a server with none
  login <server> <username>
                            Sign in to a server and keep what reaching it takes,
                            so that this machine can administer it
  logout <server>           Forget one server's token and its authority
  user list                 List the accounts
  user create <username>    Make an account
  user disable <username>   Stop an account being issued anything new
  user enable <username>    Let an account sign in again
  user revoke-tokens <username>
                            Refuse every token already issued to an account,
                            leaving it able to sign in again
  user grant-admin <username>
                            Let an account manage the accounts and the projects
                            on this server, and make another admin
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

Every command takes --root <path>, the directory Team keeps its files in, or
reads it from NLTEAM_ROOT when the flag is not given. That is the storage root
on the machine the server runs on, opened directly.

Every command above except up, init and trust also takes --server <host:port>,
or NLTEAM_SERVER: the address of a server this account has logged in to,
administered over the protocol from any machine. What a command prints is the
same either way. The two do not stand in for one another. A command given an
address it holds no token for says to log in; it does not quietly read whatever
database is nearby. up, init and trust take --root alone, because they are what
a server is rescued with, and a rescue that worked only over the thing being
rescued would not be one.

Two commands ask for different things on the two paths, and both are deliberate:

  token mint --root reads a password, because on that machine the password is
  how the operator shows the account is theirs to mint for. token mint --server
  reads none: the caller has already proved who they are by holding an
  operator's session, and minting for somebody whose password nobody knows is
  the whole point of asking a server to do it.

  settings list --server leaves the last column blank. A server says what each
  setting is; it does not say whether the value was chosen there or is the
  default answering, and that is not a thing to guess at.

Every option below has an environment variable that stands in for it, named for
the option: --root is NLTEAM_ROOT, --server is NLTEAM_SERVER, --data-port is
NLTEAM_DATA_PORT, --hostname is NLTEAM_HOSTNAME (comma-separated), and so on. A
flag on the line beats its variable, the variable beats what this server has
stored, and that beats the built-in default. It is what lets a container be
configured without composing a command line.

Options for up:
      --health-port <port>  loreserver's HTTP health check port (default ${DEFAULT_PORTS.healthPort})
      --no-identity         Configure loreserver to demand nothing, so that
                            anybody who can reach it may read and write every
                            repository on this server. It demands a Team token
                            unless this is given, or unless NLTEAM_IDENTITY is
                            set to 0, false or no
      --identity            Ask for what happens anyway; accepted so that a
                            command line written before it was the default
                            still runs

Options for trust:
      --install             Trust this authority in this account's trust store
      --remove              Stop trusting it

Options for init:
      --display-name <name> Name shown to other people
      --email <address>

Options for login:
      --fingerprint <sha256>
                            The certificate authority that server must present,
                            written as nlteam trust prints it or without the
                            colons. Given, nothing else is accepted and nothing
                            is printed about it, which is the path an automated
                            deployment takes. Left out, whatever is presented is
                            pinned and its fingerprint printed for comparing

Options for user create:
      --role <name>         Group the account joins (default ${DEFAULT_ROLE}).
                            Only admin means anything to this server: it is
                            who may administer it. Every account reaches every
                            project either way. With --server it is ${ADMIN_ROLE} or
                            ${DEFAULT_ROLE} and nothing else, because that is the whole
                            of what the protocol carries about a role
      --display-name <name> Name shown to other people
      --email <address>
      --service-account     Mark the account as one no person signs in to.
                            --root only: nothing over the protocol writes it

Options for project create:
      --description <text>
      --as <username>       The account to record as its creator, when the
                            server has more than one. --root only: over the
                            protocol the account that asked is the one it
                            belongs to


Identity options, taken by up, token mint and project create with --root. A
token's audience is built from these, so a command given a different set to the
one up was given mints a token that will not be accepted. Written beside
--server they are refused rather than dropped: a server asked to mint a token
mints from what it was started with:
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

init, user create, token mint --root and login read the password from standard
input. user create --server sends the password over the session, which is TLS to
a server whose authority this account pinned when it signed in; it still comes
from standard input and never from an argument, which would be in the process
list and in your shell history.

login keeps a token, the server's address and the certificate authority it
verified against under this account's own configuration directory, never under a
server's storage root: the token belongs to whoever signed in rather than to the
deployment. That directory is %APPDATA%\\nlteam on Windows, ~/Library/Application
Support/nlteam on macOS, and $XDG_CONFIG_HOME/nlteam or ~/.config/nlteam
elsewhere; NLTEAM_CONFIG_DIR names another outright. The file is created 0600 and
the directory 0700 where the platform has such things. More than one server may
be signed in to at once, and logout forgets one of them.

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
    // Everything from here to `project list` is wired to both halves of the
    // command line. Which half it is was settled where the arguments were read;
    // nothing about credentials, addresses or databases is decided here, and
    // neither branch knows anything about the other's.
    case "user-list":
      return invocation.target.kind === "server"
        ? await userListOverProtocol({ server: invocation.target.server }, stdout, stderr)
        : await userList({ root: invocation.target.root }, stdout, stderr);
    case "user-create":
      return invocation.target.kind === "server"
        ? await userCreateOverProtocol(
            {
              server: invocation.target.server,
              username: invocation.username,
              displayName: invocation.displayName,
              email: invocation.email,
              // The command line has already refused any role but these two on
              // this path, so this is the whole of what a role means here.
              operator: invocation.role === ADMIN_ROLE,
            },
            stdout,
            stderr,
          )
        : await userCreate(
            {
              root: invocation.target.root,
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
      return invocation.target.kind === "server"
        ? await userDisableOverProtocol(
            { server: invocation.target.server, username: invocation.username },
            stdout,
            stderr,
          )
        : await userDisable(
            { root: invocation.target.root, username: invocation.username },
            stdout,
            stderr,
          );
    case "user-enable":
      return invocation.target.kind === "server"
        ? await userEnableOverProtocol(
            { server: invocation.target.server, username: invocation.username },
            stdout,
            stderr,
          )
        : await userEnable(
            { root: invocation.target.root, username: invocation.username },
            stdout,
            stderr,
          );
    case "user-set-admin":
      return invocation.target.kind === "server"
        ? await userSetAdminOverProtocol(
            {
              server: invocation.target.server,
              username: invocation.username,
              admin: invocation.admin,
            },
            stdout,
            stderr,
          )
        : await userSetAdmin(
            {
              root: invocation.target.root,
              username: invocation.username,
              admin: invocation.admin,
            },
            stdout,
            stderr,
          );
    case "user-revoke-tokens":
      return invocation.target.kind === "server"
        ? await userRevokeTokensOverProtocol(
            { server: invocation.target.server, username: invocation.username },
            stdout,
            stderr,
          )
        : await userRevokeTokens(
            { root: invocation.target.root, username: invocation.username },
            stdout,
            stderr,
          );
    case "token-mint":
      return invocation.target.kind === "server"
        ? await tokenMintOverProtocol(
            { server: invocation.target.server, username: invocation.username },
            stdout,
            stderr,
          )
        : await tokenMint(
            {
              root: invocation.target.root,
              username: invocation.username,
              overrides: invocation.overrides,
            },
            stdout,
            stderr,
          );
    case "project-create":
      return invocation.target.kind === "server"
        ? await projectCreateOverProtocol(
            {
              server: invocation.target.server,
              name: invocation.name,
              description: invocation.description,
            },
            stdout,
            stderr,
          )
        : await projectCreate(
            {
              root: invocation.target.root,
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
      return invocation.target.kind === "server"
        ? await projectListOverProtocol({ server: invocation.target.server }, stdout, stderr)
        : await projectList({ root: invocation.target.root }, stdout, stderr);
    case "login":
      return await login(
        {
          server: invocation.server,
          username: invocation.username,
          fingerprint: invocation.fingerprint,
        },
        stdout,
        stderr,
      );
    case "logout":
      return await logout({ server: invocation.server }, stdout, stderr);
    case "settings-list":
      return invocation.target.kind === "server"
        ? await settingsListOverProtocol({ server: invocation.target.server }, stdout, stderr)
        : await settingsList({ root: invocation.target.root }, stdout, stderr);
    case "settings-set":
      return invocation.target.kind === "server"
        ? await settingsSetOverProtocol(
            { server: invocation.target.server, change: invocation.change },
            stdout,
            stderr,
          )
        : await settingsSet(
            { root: invocation.target.root, change: invocation.change },
            stdout,
            stderr,
          );
    case "key-list":
      return invocation.target.kind === "server"
        ? await keyListOverProtocol({ server: invocation.target.server }, stdout, stderr)
        : await keyList({ root: invocation.target.root }, stdout, stderr);
    case "key-rotate":
      return invocation.target.kind === "server"
        ? await keyRotateOverProtocol({ server: invocation.target.server }, stdout, stderr)
        : await keyRotate({ root: invocation.target.root }, stdout, stderr);
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
