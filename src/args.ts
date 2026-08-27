/**
 * Command line parsing for the `nlteam` executable.
 *
 * Parsing is kept separate from anything that writes output or exits, so the
 * decision the arguments describe can be inspected on its own.
 */
import { isIP } from "node:net";

import { parseServerAddress } from "./client/config.js";
import { DEFAULT_IDENTITY } from "./identity/config.js";
import {
  isLifetimeKey,
  isPublishLineageRule,
  PUBLISH_LINEAGE_KEY,
  PUBLISH_LINEAGE_RULES,
  isSettingKey,
  SETTING_KEYS,
  type SettingChange,
} from "./identity/settings.js";
import { ADMIN_ROLE, DEFAULT_ROLE } from "./identity/users.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";

/**
 * Identity settings named on a command line or in the environment. Anything
 * absent keeps what this server has stored, and then the default from
 * src/identity/config.ts.
 *
 * The same options are accepted by every command that mints a token or writes
 * loreserver's configuration, because both sides of the comparison loreserver
 * makes have to be described the same way.
 */
export interface IdentityOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly authOrigin?: string;
  readonly env?: string;
  readonly idp?: string;
  /** The sign-in token's lifetime; the repository token's has no option. */
  readonly signInTokenLifetimeSeconds?: number;
  readonly teamPort?: number;
  readonly authPort?: number;
  readonly authTlsPort?: number;
  readonly dataPort?: number;
  readonly hostnames?: readonly string[];
}

/**
 * Where a command does its work.
 *
 * The two hosts of this system divide by who is asking rather than by what is
 * asked, and this is where that division reaches the command line. A **root** is
 * a storage root on this machine, opened directly: it is how a server is rescued
 * when the protocol is not answering, and it is the only thing `init`, `up` and
 * `trust` will ever take. A **server** is an address and a session: it is how a
 * server is administered from anywhere else, by somebody who has logged in.
 *
 * They do not fall back to one another in either direction. A command given an
 * address it has no credentials for says to log in; it does not quietly read
 * whatever database happens to be under the current directory.
 */
export type CommandTarget =
  | { readonly kind: "root"; readonly root: string }
  | { readonly kind: "server"; readonly server: string };

/** What a command line asked the program to do. */
export type Invocation =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  /** Bring loreserver up under the storage root at `root`, and keep it up. */
  | {
      readonly kind: "up";
      readonly root: string;
      readonly dataPort: number;
      readonly healthPort: number;
      /**
       * True when loreserver is to be told to demand a Team server token.
       *
       * True unless `--no-identity` was given. Without it loreserver is
       * configured with no `[server.auth]` and no `auth_url`, so it demands
       * nothing and never asks Team about anybody: the whole of the
       * authorization layer is bypassed, and the safe configuration cannot be
       * the one that needs an extra word on the command line.
       */
      readonly identity: boolean;
      readonly overrides: IdentityOverrides;
    }
  /** Make the first account, on a server that has none. */
  | {
      readonly kind: "init";
      readonly root: string;
      readonly username: string;
      readonly displayName: string | undefined;
      readonly email: string | undefined;
    }
  /** List the accounts. */
  | { readonly kind: "user-list"; readonly target: CommandTarget }
  /**
   * Make an account.
   *
   * `role` and `isServiceAccount` describe a group and a mark that only the
   * local path can write. Over the protocol the command line has already
   * refused everything but the two roles `admin.users.create` carries — see
   * {@link parseUser} — so `role` there is `admin` or the default and nothing
   * else, and `isServiceAccount` is false.
   */
  | {
      readonly kind: "user-create";
      readonly target: CommandTarget;
      readonly username: string;
      readonly role: string;
      readonly displayName: string | undefined;
      readonly email: string | undefined;
      readonly isServiceAccount: boolean;
    }
  | { readonly kind: "user-disable"; readonly target: CommandTarget; readonly username: string }
  | { readonly kind: "user-enable"; readonly target: CommandTarget; readonly username: string }
  /** Put an account in the admin group, or take it out. */
  | {
      readonly kind: "user-set-admin";
      readonly target: CommandTarget;
      readonly username: string;
      readonly admin: boolean;
    }
  /**
   * Refuse every token already issued to an account, leaving the account able
   * to sign in and be given a working one straight away.
   */
  | {
      readonly kind: "user-revoke-tokens";
      readonly target: CommandTarget;
      readonly username: string;
    }
  /**
   * Sign a token for an account.
   *
   * `overrides` describes the deployment a token is minted for, and only the
   * local path settles it: a server asked to mint one mints from what it was
   * started with. It is read whichever path this is, because these settings can
   * come from the environment and a container that set them for `up` must not
   * find every `--server` command refused — what the command line refuses is one
   * written on the same line as `--server`.
   */
  | {
      readonly kind: "token-mint";
      readonly target: CommandTarget;
      readonly username: string;
      readonly overrides: IdentityOverrides;
    }
  /**
   * Make a project: a repository on loreserver, and the record of it.
   *
   * `as`, `dataPort` and `overrides` belong to the local path alone. Over the
   * protocol the account that asked is the account it belongs to, and where
   * loreserver is is the server's own business.
   */
  | {
      readonly kind: "project-create";
      readonly target: CommandTarget;
      readonly name: string;
      readonly description: string | undefined;
      /** The account it is created for; absent when the Team server has only one. */
      readonly as: string | undefined;
      readonly dataPort: number;
      readonly overrides: IdentityOverrides;
    }
  /** List the projects a server holds, over the protocol or off its own disk. */
  | { readonly kind: "project-list"; readonly target: CommandTarget }
  /**
   * Exchange a password for a token on one server, and keep what reaching it takes.
   *
   * The address is the one an author is given, which is also the one whose
   * certificate authority is pinned. The username is a positional for the reason
   * every other account name in this program is one.
   */
  | {
      readonly kind: "login";
      readonly server: string;
      readonly username: string;
      /** The authority this run was told to expect, and nothing else will do. */
      readonly fingerprint: string | undefined;
    }
  /** Forget one server's token and the authority it was obtained under. */
  | { readonly kind: "logout"; readonly server: string }
  /** Show the settings this Team server keeps in its database. */
  | { readonly kind: "settings-list"; readonly target: CommandTarget }
  /**
   * Change one setting.
   *
   * A lifetime arrives here as the seconds it will be stored as, because the
   * duration it was written with — `7d`, `30m`, a bare number of seconds — is a
   * question about the command line and belongs in this file. A name arrives as
   * it was typed, because there is nothing to read out of it. What is out of
   * range or malformed is not settled here: the bounds are the database's, and
   * src/identity/settings.ts refuses either with a sentence saying what they
   * are.
   */
  | {
      readonly kind: "settings-set";
      readonly target: CommandTarget;
      readonly change: SettingChange;
    }
  /** Show the signing keys. */
  | { readonly kind: "key-list"; readonly target: CommandTarget }
  /** Generate a key and sign with it from now on. */
  | { readonly kind: "key-rotate"; readonly target: CommandTarget }
  /**
   * Show this Team server's certificate authority, and optionally trust it here.
   *
   * With neither flag, nothing is changed: printing the fingerprint is the
   * whole of what it does, because that is what a person compares.
   */
  | {
      readonly kind: "trust";
      readonly root: string;
      readonly install: boolean;
      readonly remove: boolean;
    }
  /** The command line was not understood; `message` explains why, in one line. */
  | { readonly kind: "error"; readonly message: string };

/** The highest port number a listener can be given. */
const MAXIMUM_PORT = 65_535;

function error(message: string): Invocation {
  return { kind: "error", message };
}

/** Every command that keeps state needs to be told which storage root. */
function missingRoot(command: string): Invocation {
  return error(
    `${command} needs --root <path> or NLTEAM_ROOT, the directory Team keeps its files in`,
  );
}

/**
 * The environment variable that stands in for each command-line option.
 *
 * A container entrypoint cannot compose a long flag list, so every option an
 * operator would otherwise write on the line has a variable it can be given
 * through instead. The mapping lives here, once, so that the rule "a flag beats
 * the environment" is expressed in one place rather than at every option — see
 * {@link optionValue}.
 */
const ENVIRONMENT: Readonly<Record<string, string>> = {
  "--root": "NLTEAM_ROOT",
  // The other half of where a command works. A deployment that administers a
  // server from a container sets this and never writes --server, exactly as one
  // that runs the server sets NLTEAM_ROOT and never writes --root.
  "--server": "NLTEAM_SERVER",
  // What an automated sign-in was told to trust. It is here rather than left to
  // the command line because the deployment that most needs to name a
  // fingerprint is the one that composes no command line at all.
  "--fingerprint": "NLTEAM_FINGERPRINT",
  "--issuer": "NLTEAM_ISSUER",
  "--audience": "NLTEAM_AUDIENCE",
  "--auth-origin": "NLTEAM_AUTH_ORIGIN",
  "--env": "NLTEAM_ENV",
  "--idp": "NLTEAM_IDP",
  "--token-lifetime": "NLTEAM_TOKEN_LIFETIME",
  "--team-port": "NLTEAM_TEAM_PORT",
  "--auth-port": "NLTEAM_AUTH_PORT",
  "--auth-tls-port": "NLTEAM_AUTH_TLS_PORT",
  "--data-port": "NLTEAM_DATA_PORT",
  "--health-port": "NLTEAM_HEALTH_PORT",
  // Repeatable on the line and comma-separated in the variable; the split is in
  // {@link hostnamesFrom}, because one host per entry is what the rest expects.
  "--hostname": "NLTEAM_HOSTNAME",
  // A flag on the line, and a boolean-ish variable off it; the reading is in
  // {@link identityFrom}, because a flag stands for itself and a variable does
  // not.
  "--identity": "NLTEAM_IDENTITY",
};

/**
 * The value of an environment variable, or undefined when it is unset or empty.
 *
 * An empty variable is treated as absent rather than as an empty value: a
 * container that declares `NLTEAM_ROOT` and leaves it blank has named no root,
 * not a root that is the empty string.
 */
function envValue(env: NodeJS.ProcessEnv, option: string): string | undefined {
  const name = ENVIRONMENT[option];
  if (name === undefined) {
    return undefined;
  }
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * One option's value: the flag if it was written, otherwise the environment.
 *
 * This is the whole of the precedence between a flag and its variable, in one
 * function: an explicit flag wins, and the environment answers for a flag that
 * was not given. What is stored in the database, and the built-in default, are
 * lower still and are settled where a token is minted rather than here.
 */
function optionValue(tokens: Tokens, env: NodeJS.ProcessEnv, option: string): string | undefined {
  return tokens.values.get(option) ?? envValue(env, option);
}

/** The storage root a command was given, on the line or in the environment. */
function rootOf(tokens: Tokens, env: NodeJS.ProcessEnv): string | undefined {
  return optionValue(tokens, env, "--root");
}

/**
 * An address, in the one spelling everything files it under.
 *
 * Returns a sentence instead when it was not one, so that a mistyped address is
 * refused where the command line is read rather than by whatever tried to dial
 * it.
 */
function addressOf(text: string): string | { message: string } {
  try {
    return parseServerAddress(text);
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Where one command is to do its work: a storage root, or a server.
 *
 * A flag beats a variable, which is the rule every option in this file is read
 * by. What is not that rule is the pair of refusals: naming both is refused
 * rather than settled, because the two do entirely different things and there is
 * no reading of `--root /srv/team --server team.example.lan` that is obviously
 * what somebody meant. The same goes for a container with both variables set —
 * choosing one silently is how an operator comes to administer the wrong server.
 *
 * Returns a sentence instead when the command line named neither, or both.
 */
function targetOf(tokens: Tokens, env: NodeJS.ProcessEnv, command: string): CommandTarget | string {
  const namedRoot = tokens.values.get("--root");
  const namedServer = tokens.values.get("--server");
  if (namedRoot !== undefined && namedServer !== undefined) {
    return (
      `${command} takes --root or --server, not both: --root works on a storage root on ` +
      "this machine, and --server speaks to a server over the network"
    );
  }
  const chosen = namedServer ?? envValue(env, "--server");
  const root = namedRoot ?? envValue(env, "--root");
  if (namedServer === undefined && namedRoot === undefined && chosen !== undefined && root !== undefined) {
    return (
      `NLTEAM_SERVER and NLTEAM_ROOT are both set, so ${command} cannot tell which was ` +
      "meant. Name one of them with --server or --root."
    );
  }
  if (namedServer !== undefined || (namedRoot === undefined && chosen !== undefined)) {
    const address = addressOf(chosen as string);
    return typeof address === "string" ? { kind: "server", server: address } : address.message;
  }
  if (root !== undefined) {
    return { kind: "root", root };
  }
  return (
    `${command} needs --root <path> or NLTEAM_ROOT, the directory Team keeps its files in, ` +
    "or --server <host:port> to reach a server this account has logged in to"
  );
}

/** Whether an option was written on the command line, in whichever of the three shapes it takes. */
function namedOnTheLine(tokens: Tokens, option: string): boolean {
  return tokens.values.has(option) || tokens.lists.has(option) || tokens.flags.has(option);
}

/**
 * Refuse an option that only means something against a storage root.
 *
 * Dropped silently, each of these would look exactly like it had been honoured:
 * a `--data-port` beside `--server` names a port the server settled for itself
 * when it started, and an `--as` names an account the session has already
 * decided. Something that looks like it worked is worse than something that
 * says it cannot — which is the same reading `admin.settings.set` takes of a
 * read-only setting, and it is taken here so that the refusal arrives before
 * anything is sent.
 *
 * Only what was **written on the line**. The identity settings all have
 * environment variables, and a container that sets them once so that `up` mints
 * the right audience must not find every `--server` command refused by its own
 * configuration. A flag is what somebody typed just now, and this is about that.
 *
 * Returns a sentence, or undefined when nothing local-only was named.
 */
function refuseWithServer(
  tokens: Tokens,
  command: string,
  options: readonly string[],
  because: string,
): string | undefined {
  const named = options.find((option) => namedOnTheLine(tokens, option));
  return named === undefined ? undefined : `${command} takes ${named} only with --root: ${because}`;
}

/**
 * The host names a command was given, on the line or in the environment.
 *
 * The flag is repeatable and wins as a whole: a command line naming any host at
 * all describes the set of them, and the variable does not add to it. In the
 * variable the hosts are comma-separated, because a variable cannot be repeated
 * the way a flag can. Undefined means neither named any, which is not the same
 * as an empty list — see the validation in {@link readIdentityOverrides}.
 */
function hostnamesFrom(tokens: Tokens, env: NodeJS.ProcessEnv): readonly string[] | undefined {
  const named = tokens.lists.get("--hostname");
  if (named !== undefined) {
    return named;
  }
  const fromEnv = envValue(env, "--hostname");
  if (fromEnv === undefined) {
    return undefined;
  }
  // Blank entries around a comma are dropped rather than kept as empty hosts, so
  // that a trailing comma or a doubled one is a typo without a consequence.
  return fromEnv
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

/** What `NLTEAM_IDENTITY` accepts for on, and for off. */
const IDENTITY_ON = ["1", "true", "yes"];
const IDENTITY_OFF = ["0", "false", "no"];

/**
 * Whether loreserver is to demand a token, from the flags and the environment.
 *
 * A flag stands for itself: `--identity` or `--no-identity` decides, and the
 * caller has already refused the command line that gives both. Without either,
 * `NLTEAM_IDENTITY` decides, so a deployment can turn identity off without a
 * flag. Without any of the three it is on, which is the safe reading and so the
 * one that needs nothing said. Returns a sentence when the variable is neither
 * on nor off.
 */
function identityFrom(tokens: Tokens, env: NodeJS.ProcessEnv): boolean | string {
  if (tokens.flags.has("--no-identity")) {
    return false;
  }
  if (tokens.flags.has("--identity")) {
    return true;
  }
  const value = envValue(env, "--identity");
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (IDENTITY_ON.includes(normalized)) {
    return true;
  }
  if (IDENTITY_OFF.includes(normalized)) {
    return false;
  }
  return (
    `NLTEAM_IDENTITY is on or off: ${IDENTITY_ON.join("/")} or ${IDENTITY_OFF.join("/")}, ` +
    `not "${value}"`
  );
}

/**
 * Read a port number written on the command line.
 *
 * Returns the number, or a sentence saying what was wrong with it. Anything
 * `Number` would accept but a listener would not — a fraction, a negative, a
 * number too large for a port — is rejected here rather than by the operating
 * system halfway through starting a server.
 */
function parsePort(option: string, text: string): number | string {
  if (!/^\d+$/.test(text)) {
    return `${option} needs a port number, not "${text}"`;
  }
  const port = Number(text);
  if (port < 1 || port > MAXIMUM_PORT) {
    return `${option} must be between 1 and ${MAXIMUM_PORT}, not ${port}`;
  }
  return port;
}

/** Milliseconds in each unit a duration may be written with. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Read a duration such as `30m`, `48h` or `7d`.
 *
 * A bare number is seconds. Returns milliseconds, or a sentence saying what
 * was wrong with it.
 */
export function parseDuration(option: string, text: string): number | string {
  const match = /^(\d+)([smhd])?$/.exec(text);
  if (match?.[1] === undefined) {
    return `${option} needs a duration such as 30m, 48h or 7d, not "${text}"`;
  }
  const amount = Number(match[1]);
  if (amount < 1) {
    return `${option} must be more than zero`;
  }
  return amount * (DURATION_UNITS[match[2] ?? "s"] ?? 1000);
}

/**
 * Split `--option=value` into its two halves.
 *
 * Both spellings are accepted, so that neither `--root /srv/team` nor
 * `--root=/srv/team` is a surprise.
 */
function splitInlineValue(token: string): { option: string; value: string | undefined } {
  const separator = token.indexOf("=");
  if (!token.startsWith("--") || separator === -1) {
    return { option: token, value: undefined };
  }
  return { option: token.slice(0, separator), value: token.slice(separator + 1) };
}

/** A command line taken apart, before any command has interpreted it. */
interface Tokens {
  /** Everything that was not an option, in the order it was written. */
  readonly positionals: readonly string[];
  /** Options that took a value, by option name including the dashes. */
  readonly values: ReadonlyMap<string, string>;
  /**
   * Options that may be written more than once, with every value in the order
   * they appeared. An option is one or the other, never both: a repeated
   * `--root` is a mistake, and a `--hostname` given once is a list of one.
   */
  readonly lists: ReadonlyMap<string, readonly string[]>;
  /** Options that stand alone. */
  readonly flags: ReadonlySet<string>;
}

type TokensResult =
  | { readonly kind: "tokens"; readonly tokens: Tokens }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Sort one command's arguments into options, flags and the rest.
 *
 * Every command reads its arguments through here, so that `--option value`,
 * `--option=value` and `-h` behave the same everywhere, and an option a
 * command does not have is reported rather than ignored.
 */
function readTokens(
  argv: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
  listOptions: readonly string[] = [],
): TokensResult {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }

    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const { option, value: inline } = splitInlineValue(token);
    if (flagOptions.includes(option)) {
      if (inline !== undefined) {
        return { kind: "error", message: `${option} takes no value` };
      }
      flags.add(option);
      continue;
    }
    const repeatable = listOptions.includes(option);
    if (!repeatable && !valueOptions.includes(option)) {
      return { kind: "error", message: `unknown argument: ${token}` };
    }

    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") {
      return { kind: "error", message: `${option} needs a value` };
    }
    if (repeatable) {
      lists.set(option, [...(lists.get(option) ?? []), value]);
    } else {
      values.set(option, value);
    }
  }

  return { kind: "tokens", tokens: { positionals, values, lists, flags } };
}

/** The identity options every command that mints or configures accepts. */
const IDENTITY_OPTIONS = [
  "--issuer",
  "--audience",
  "--auth-origin",
  "--env",
  "--idp",
  "--token-lifetime",
  "--team-port",
  "--auth-port",
  "--auth-tls-port",
  // Not only loreserver's setting: a token's audience has to name the data
  // remote, so every command that mints one has to know the port.
  "--data-port",
] as const;

/**
 * The identity options that may be written more than once.
 *
 * `--hostname` is one of the identity options rather than only an option of
 * `up`, for the same reason `--data-port` is: it decides what a token's
 * audience says, so a token minted without it is a token that works on the Team server
 * machine and nowhere else.
 */
const IDENTITY_LIST_OPTIONS = ["--hostname"] as const;

/** Every identity option, in the one list the commands that refuse them share. */
const ALL_IDENTITY_OPTIONS: readonly string[] = [...IDENTITY_OPTIONS, ...IDENTITY_LIST_OPTIONS];

/** Why the identity settings are a storage root's business, said once for both commands. */
const IDENTITY_IS_THE_SERVERS =
  "it describes the deployment a token is minted for, and a server asked to mint one mints " +
  "from what it was started with";

/**
 * Collect the identity options out of a command line and the environment.
 *
 * Every option is read through {@link optionValue}, so a flag beats its
 * variable and the variable answers for a flag that was not given. What each
 * value has to be is checked the same way whether it came from the line or the
 * environment: a port out of range in a variable is refused exactly as one out
 * of range in a flag, rather than silently coerced.
 *
 * Returns a sentence instead when one of them was unusable.
 */
function readIdentityOverrides(tokens: Tokens, env: NodeJS.ProcessEnv): IdentityOverrides | string {
  const overrides: {
    issuer?: string;
    audience?: string;
    authOrigin?: string;
    env?: string;
    idp?: string;
    signInTokenLifetimeSeconds?: number;
    teamPort?: number;
    authPort?: number;
    authTlsPort?: number;
    dataPort?: number;
    hostnames?: readonly string[];
  } = {};

  const issuer = optionValue(tokens, env, "--issuer");
  if (issuer !== undefined) {
    overrides.issuer = issuer;
  }
  const audience = optionValue(tokens, env, "--audience");
  if (audience !== undefined) {
    overrides.audience = audience;
  }
  const authOrigin = optionValue(tokens, env, "--auth-origin");
  if (authOrigin !== undefined) {
    // A scheme here would end up written twice, as https://https://host.
    if (authOrigin.includes("://")) {
      return "--auth-origin is a host, without a scheme, for example team.example.com";
    }
    overrides.authOrigin = authOrigin;
  }
  const environment = optionValue(tokens, env, "--env");
  if (environment !== undefined) {
    overrides.env = environment;
  }
  const idp = optionValue(tokens, env, "--idp");
  if (idp !== undefined) {
    overrides.idp = idp;
  }
  const lifetime = optionValue(tokens, env, "--token-lifetime");
  if (lifetime !== undefined) {
    const milliseconds = parseDuration("--token-lifetime", lifetime);
    if (typeof milliseconds === "string") {
      return milliseconds;
    }
    // The sign-in token's lifetime, which is what this option has always
    // named: it was the only lifetime there was. The repository token's is a
    // stored setting with no option of its own, because a lifetime that exists
    // to be the only bound on a token is not one to lengthen for a single run.
    overrides.signInTokenLifetimeSeconds = Math.floor(milliseconds / 1000);
  }
  const teamPort = optionValue(tokens, env, "--team-port");
  if (teamPort !== undefined) {
    const port = parsePort("--team-port", teamPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.teamPort = port;
  }
  const authPort = optionValue(tokens, env, "--auth-port");
  if (authPort !== undefined) {
    const port = parsePort("--auth-port", authPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.authPort = port;
  }
  const authTlsPort = optionValue(tokens, env, "--auth-tls-port");
  if (authTlsPort !== undefined) {
    const port = parsePort("--auth-tls-port", authTlsPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.authTlsPort = port;
  }
  const dataPort = optionValue(tokens, env, "--data-port");
  if (dataPort !== undefined) {
    const port = parsePort("--data-port", dataPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.dataPort = port;
  }

  const hostnames = hostnamesFrom(tokens, env);
  if (hostnames !== undefined) {
    for (const name of hostnames) {
      // A scheme, a path or a port here would go into a certificate as a name
      // no client asks for, and into an audience as a remote no client matches.
      // Both would look correct. A colon is allowed only in an address, where
      // it belongs to the address itself.
      if (name.includes("://") || name.includes("/") || (name.includes(":") && isIP(name) === 0)) {
        return `--hostname is a host on its own, without a scheme or a port, not "${name}"`;
      }
    }
    overrides.hostnames = hostnames;
  }

  return overrides;
}

/** Parse the arguments that follow `up`. */
function parseUp(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const result = readTokens(
    argv,
    ["--root", "--health-port", ...IDENTITY_OPTIONS],
    // `--identity` is still taken and means what it has always meant. It now
    // asks for what happens anyway, which is what keeps an operator's existing
    // command line working rather than becoming an unknown argument.
    ["--identity", "--no-identity"],
    IDENTITY_LIST_OPTIONS,
  );
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const extra = tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }

  const root = rootOf(tokens, env);
  if (root === undefined) {
    return missingRoot("up");
  }

  // Refused rather than settled one way, because the two say opposite things
  // and the safe reading and the recently-typed reading are not the same one.
  if (tokens.flags.has("--identity") && tokens.flags.has("--no-identity")) {
    return error("--identity and --no-identity cannot both be given");
  }

  const identity = identityFrom(tokens, env);
  if (typeof identity === "string") {
    return error(identity);
  }

  let healthPort = DEFAULT_PORTS.healthPort;
  const healthPortText = optionValue(tokens, env, "--health-port");
  if (healthPortText !== undefined) {
    const port = parsePort("--health-port", healthPortText);
    if (typeof port === "string") {
      return error(port);
    }
    healthPort = port;
  }

  const overrides = readIdentityOverrides(tokens, env);
  if (typeof overrides === "string") {
    return error(overrides);
  }
  // The data port is one of the identity settings as well as one of
  // loreserver's, because a token's audience names it. It is read once, there.
  const dataPort = overrides.dataPort ?? DEFAULT_PORTS.dataPort;

  // Five TCP listeners come up on one machine, and two on the same port would
  // leave whichever lost the race silently absent. loreserver's gRPC and QUIC
  // listeners deliberately share one number, one on TCP and one on UDP, which
  // is why only one of them is in this list.
  const listeners: readonly (readonly [string, number])[] = [
    ["--data-port", dataPort],
    ["--health-port", healthPort],
    ["--team-port", overrides.teamPort ?? DEFAULT_IDENTITY.teamPort],
    ["--auth-port", overrides.authPort ?? DEFAULT_IDENTITY.authPort],
    ["--auth-tls-port", overrides.authTlsPort ?? DEFAULT_IDENTITY.authTlsPort],
  ];
  for (const [index, listener] of listeners.entries()) {
    const clash = listeners.slice(index + 1).find(([, port]) => port === listener[1]);
    if (clash !== undefined) {
      return error(`${listener[0]} and ${clash[0]} cannot both be ${listener[1]}`);
    }
  }

  return {
    kind: "up",
    root,
    dataPort,
    healthPort,
    identity,
    overrides,
  };
}

/** Parse the arguments that follow `init`. */
function parseInit(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const result = readTokens(argv, ["--root", "--display-name", "--email"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const username = tokens.positionals[0];
  if (username === undefined) {
    return error("init needs a username for the first account");
  }
  if (tokens.positionals[1] !== undefined) {
    return error(`unexpected argument: ${tokens.positionals[1]}`);
  }
  const root = rootOf(tokens, env);
  if (root === undefined) {
    return missingRoot("init");
  }

  return {
    kind: "init",
    root,
    username,
    displayName: tokens.values.get("--display-name"),
    email: tokens.values.get("--email"),
  };
}

/** Parse the arguments that follow `user`. */
function parseUser(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error(
      "user needs a verb: list, create, disable, enable, revoke-tokens, grant-admin or " +
        "revoke-admin",
    );
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }

  if (verb === "list") {
    const result = readTokens(rest, ["--root", "--server"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const extra = result.tokens.positionals[0];
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const target = targetOf(result.tokens, env, "user list");
    return typeof target === "string" ? error(target) : { kind: "user-list", target };
  }

  if (verb === "create") {
    const result = readTokens(
      rest,
      ["--root", "--server", "--role", "--display-name", "--email"],
      ["--service-account"],
    );
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;

    const username = tokens.positionals[0];
    if (username === undefined) {
      return error("user create needs a username");
    }
    if (tokens.positionals[1] !== undefined) {
      return error(`unexpected argument: ${tokens.positionals[1]}`);
    }
    const target = targetOf(tokens, env, "user create");
    if (typeof target === "string") {
      return error(target);
    }
    const role = tokens.values.get("--role") ?? DEFAULT_ROLE;
    if (target.kind === "server") {
      // Being in the admin group is the whole of what a role decides on this
      // server, and `admin.users.create` therefore carries one flag rather than
      // a list of group names — a client naming groups freely would be
      // inventing a vocabulary nothing on the far side has an opinion about. So
      // the two roles that flag can express are the two this path takes, and
      // any other is refused here rather than sent and quietly turned into one
      // of them.
      if (role !== ADMIN_ROLE && role !== DEFAULT_ROLE) {
        return error(
          `user create --server takes --role ${ADMIN_ROLE} or --role ${DEFAULT_ROLE}: over ` +
            "the protocol an account either administers this server or does not, and a third " +
            `group would be dropped. Make it with --root to put it in ${role}.`,
        );
      }
      if (tokens.flags.has("--service-account")) {
        return error(
          "user create --server does not take --service-account: the mark is a fact this " +
            "server keeps about an account and nothing over the protocol writes it. Make the " +
            "account with --root to mark it.",
        );
      }
    }
    return {
      kind: "user-create",
      target,
      username,
      role,
      displayName: tokens.values.get("--display-name"),
      email: tokens.values.get("--email"),
      isServiceAccount: tokens.flags.has("--service-account"),
    };
  }

  if (
    verb === "grant-admin" ||
    verb === "revoke-admin" ||
    verb === "disable" ||
    verb === "enable" ||
    verb === "revoke-tokens"
  ) {
    // One reading for the five, because they take the same command line: a
    // username, and where to do it. They were two blocks while the second half
    // did not exist and the difference between them was which invocation came
    // out at the end.
    const result = readTokens(rest, ["--root", "--server"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;
    const username = tokens.positionals[0];
    if (username === undefined) {
      return error(`user ${verb} needs a username`);
    }
    if (tokens.positionals[1] !== undefined) {
      return error(`unexpected argument: ${tokens.positionals[1]}`);
    }
    const target = targetOf(tokens, env, `user ${verb}`);
    if (typeof target === "string") {
      return error(target);
    }
    switch (verb) {
      case "grant-admin":
      case "revoke-admin":
        return { kind: "user-set-admin", target, username, admin: verb === "grant-admin" };
      case "disable":
        return { kind: "user-disable", target, username };
      case "enable":
        return { kind: "user-enable", target, username };
      default:
        return { kind: "user-revoke-tokens", target, username };
    }
  }

  return error(`unknown user command: ${verb}`);
}

/** Parse the arguments that follow `token`. */
function parseToken(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("token needs a verb: mint");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb !== "mint") {
    return error(`unknown token command: ${verb}`);
  }

  const result = readTokens(
    rest,
    ["--root", "--server", ...IDENTITY_OPTIONS],
    [],
    IDENTITY_LIST_OPTIONS,
  );
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const username = tokens.positionals[0];
  if (username === undefined) {
    return error("token mint needs a username");
  }
  if (tokens.positionals[1] !== undefined) {
    return error(`unexpected argument: ${tokens.positionals[1]}`);
  }
  const target = targetOf(tokens, env, "token mint");
  if (typeof target === "string") {
    return error(target);
  }
  if (target.kind === "server") {
    const refusal = refuseWithServer(
      tokens,
      "token mint",
      ALL_IDENTITY_OPTIONS,
      IDENTITY_IS_THE_SERVERS,
    );
    if (refusal !== undefined) {
      return error(refusal);
    }
  }
  const overrides = readIdentityOverrides(tokens, env);
  if (typeof overrides === "string") {
    return error(overrides);
  }

  return { kind: "token-mint", target, username, overrides };
}

/** Parse the arguments that follow `project`. */
function parseProject(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("project needs a verb: create or list");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }

  if (verb === "create") {
    const result = readTokens(
      rest,
      ["--root", "--server", "--description", "--as", ...IDENTITY_OPTIONS],
      [],
      IDENTITY_LIST_OPTIONS,
    );
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;

    const name = tokens.positionals[0];
    if (name === undefined) {
      return error("project create needs a name");
    }
    if (tokens.positionals[1] !== undefined) {
      return error(`unexpected argument: ${tokens.positionals[1]}`);
    }
    const target = targetOf(tokens, env, "project create");
    if (typeof target === "string") {
      return error(target);
    }
    if (target.kind === "server") {
      const refusal =
        refuseWithServer(
          tokens,
          "project create",
          ["--as"],
          "over the protocol the account that asked is the account it belongs to, and " +
            "attributing work to somebody else is not something a session lets anybody do",
        ) ??
        refuseWithServer(tokens, "project create", ALL_IDENTITY_OPTIONS, IDENTITY_IS_THE_SERVERS);
      if (refusal !== undefined) {
        return error(refusal);
      }
    }

    const overrides = readIdentityOverrides(tokens, env);
    if (typeof overrides === "string") {
      return error(overrides);
    }

    return {
      kind: "project-create",
      target,
      name,
      description: tokens.values.get("--description"),
      as: tokens.values.get("--as"),
      // Where loreserver is, and also what a token's audience says about it.
      dataPort: overrides.dataPort ?? DEFAULT_PORTS.dataPort,
      overrides,
    };
  }

  if (verb === "list") {
    // The first command that took either half of the command line. What it
    // asks for is the same question on both paths — every project this server
    // holds — which is why it was the one that proved the seam.
    const result = readTokens(rest, ["--root", "--server"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;
    const extra = tokens.positionals[0];
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const target = targetOf(tokens, env, "project list");
    return typeof target === "string" ? error(target) : { kind: "project-list", target };
  }

  return error(`unknown project command: ${verb}`);
}

/** Parse the arguments that follow `login`. */
function parseLogin(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const result = readTokens(argv, ["--fingerprint"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const [server, username, extra] = tokens.positionals;
  if (server === undefined) {
    return error(
      "login needs the address of a server, for example team.example.lan:41402, and the " +
        "username to sign in as",
    );
  }
  if (username === undefined) {
    return error("login needs the username to sign in as, after the address");
  }
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const address = addressOf(server);
  if (typeof address !== "string") {
    return error(address.message);
  }
  return {
    kind: "login",
    server: address,
    username,
    fingerprint: optionValue(tokens, env, "--fingerprint"),
  };
}

/** Parse the arguments that follow `logout`. */
function parseLogout(argv: readonly string[]): Invocation {
  const result = readTokens(argv, []);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const [server, extra] = tokens.positionals;
  if (server === undefined) {
    return error("logout needs the address of a server this account is signed in to");
  }
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const address = addressOf(server);
  return typeof address === "string" ? { kind: "logout", server: address } : error(address.message);
}

/** Parse the arguments that follow `settings`. */
function parseSettings(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("settings needs a verb: list or set");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }

  if (verb === "list") {
    const result = readTokens(rest, ["--root", "--server"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const extra = result.tokens.positionals[0];
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const target = targetOf(result.tokens, env, "settings list");
    return typeof target === "string" ? error(target) : { kind: "settings-list", target };
  }

  if (verb === "set") {
    const result = readTokens(rest, ["--root", "--server"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;

    const [key, value, extra] = tokens.positionals;
    if (key === undefined || value === undefined) {
      return error("settings set needs a key and a value");
    }
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const target = targetOf(tokens, env, "settings set");
    if (typeof target === "string") {
      return error(target);
    }
    // Named, rather than left as "unknown setting": somebody who has typed the
    // wrong one of the keys is one line away from the right one, and a message
    // that only says no is a message that sends them to the source.
    //
    // Checked here on both paths. The keys are this program's names for what a
    // server stores, and a mistyped one is a mistyped one wherever the command
    // was aimed — there is no reason to spend a session finding that out.
    if (!isSettingKey(key)) {
      return error(
        `there is no setting called ${key}. The settings are ${SETTING_KEYS.join(", ")}.`,
      );
    }
    // One of the two words, checked here as well as on the way in: a command
    // line can say what it likes, and the answer to "is that a rule" is the same
    // question wherever it is asked.
    if (key === PUBLISH_LINEAGE_KEY) {
      if (!isPublishLineageRule(value)) {
        return error(
          `${PUBLISH_LINEAGE_KEY} is one of ${PUBLISH_LINEAGE_RULES.join(" or ")}, not ${value}.`,
        );
      }
      return {
        kind: "settings-set",
        target,
        change: { key, rule: value.trim() as "merge" | "refuse" },
      };
    }
    // A name is stored as it was written, and every check on it is the
    // database's: what is too long, empty or unprintable is the same question
    // wherever the name came from, and answering it twice would be two answers.
    if (!isLifetimeKey(key)) {
      return { kind: "settings-set", target, change: { key, name: value } };
    }
    // The durations `--token-lifetime` takes, read by the same function, so
    // that 7d means the same thing on every command line here.
    const milliseconds = parseDuration(key, value);
    if (typeof milliseconds === "string") {
      return error(milliseconds);
    }
    return {
      kind: "settings-set",
      target,
      change: { key, seconds: Math.floor(milliseconds / 1000) },
    };
  }

  return error(`unknown settings command: ${verb}`);
}

/** Parse the arguments that follow `key`. */
function parseKey(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("key needs a verb: list or rotate");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb !== "list" && verb !== "rotate") {
    return error(`unknown key command: ${verb}`);
  }

  const result = readTokens(rest, ["--root", "--server"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const extra = result.tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const target = targetOf(result.tokens, env, `key ${verb}`);
  if (typeof target === "string") {
    return error(target);
  }
  return verb === "list" ? { kind: "key-list", target } : { kind: "key-rotate", target };
}

/** Parse the arguments that follow `trust`. */
function parseTrust(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const result = readTokens(argv, ["--root"], ["--install", "--remove"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const extra = tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const root = rootOf(tokens, env);
  if (root === undefined) {
    return missingRoot("trust");
  }

  const install = tokens.flags.has("--install");
  const remove = tokens.flags.has("--remove");
  if (install && remove) {
    return error("trust takes --install or --remove, not both");
  }
  return { kind: "trust", root, install, remove };
}

/**
 * Interpret the arguments that follow the program name.
 *
 * Callers pass `process.argv.slice(2)` — the node executable and the script
 * path are not part of the command line as far as this function is concerned.
 *
 * An empty command line is treated as a request for help: a bare `nlteam` names
 * no command, and there is nothing else it could mean.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  const [first, ...rest] = argv;

  if (first === undefined) {
    return { kind: "help" };
  }

  let invocation: Invocation;
  switch (first) {
    case "-v":
    case "--version":
      invocation = { kind: "version" };
      break;
    case "-h":
    case "--help":
      invocation = { kind: "help" };
      break;
    // The only token a command consumes is its own name; the rest belong to
    // it, including any it does not recognise.
    case "up":
      return parseUp(rest, env);
    case "init":
      return parseInit(rest, env);
    case "login":
      return parseLogin(rest, env);
    case "logout":
      return parseLogout(rest);
    case "user":
      return parseUser(rest, env);
    case "token":
      return parseToken(rest, env);
    case "project":
      return parseProject(rest, env);
    case "settings":
      return parseSettings(rest, env);
    case "key":
      return parseKey(rest, env);
    case "trust":
      return parseTrust(rest, env);
    default:
      // Every option this program takes belongs to a command, so a command line
      // that names none is a mistake however it was spelled: a mistyped command
      // is a word, and a mistyped option starts with a dash but is not one of
      // the two below.
      return error(
        first.startsWith("-") ? `unknown argument: ${first}` : `unknown command: ${first}`,
      );
  }

  // Neither option takes a value, and no command follows one, so anything
  // after the first token is a mistake worth reporting rather than quietly
  // ignoring.
  const [extra] = rest;
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }

  return invocation;
}
