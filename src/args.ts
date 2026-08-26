/**
 * Command line parsing for the `nlteam` executable.
 *
 * Parsing is kept separate from anything that writes output or exits, so the
 * decision the arguments describe can be inspected on its own.
 */
import { isIP } from "node:net";

import { DEFAULT_IDENTITY } from "./identity/config.js";
import {
  isLifetimeKey,
  isSettingKey,
  SETTING_KEYS,
  type SettingChange,
} from "./identity/settings.js";
import { DEFAULT_ROLE } from "./identity/users.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";

/**
 * Identity settings named on a command line. Anything absent keeps the default
 * from src/identity/config.ts.
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

/** What a command line asked the program to do. */
export type Invocation =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  /**
   * Open the terminal interface on the Team server at `root`.
   *
   * This is what a command line that names no command means. The identity
   * settings come along because the interface shows them: a Team server brought up
   * with `--data-port 41500` is reached at that port whether or not the
   * screen showing the address was told about it.
   */
  | {
      readonly kind: "interface";
      readonly root: string;
      readonly healthPort: number;
      readonly overrides: IdentityOverrides;
    }
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
  | { readonly kind: "user-list"; readonly root: string }
  /** Make an account. */
  | {
      readonly kind: "user-create";
      readonly root: string;
      readonly username: string;
      readonly role: string;
      readonly displayName: string | undefined;
      readonly email: string | undefined;
      readonly isServiceAccount: boolean;
    }
  | { readonly kind: "user-disable"; readonly root: string; readonly username: string }
  | { readonly kind: "user-enable"; readonly root: string; readonly username: string }
  /** Put an account in the admin group, or take it out. */
  | {
      readonly kind: "user-set-admin";
      readonly root: string;
      readonly username: string;
      readonly admin: boolean;
    }
  /**
   * Refuse every token already issued to an account, leaving the account able
   * to sign in and be given a working one straight away.
   */
  | { readonly kind: "user-revoke-tokens"; readonly root: string; readonly username: string }
  /** Sign a token for an account that has proved who it is. */
  | {
      readonly kind: "token-mint";
      readonly root: string;
      readonly username: string;
      readonly overrides: IdentityOverrides;
    }
  /** Create a repository on loreserver and record who owns it. */
  | {
      readonly kind: "project-create";
      readonly root: string;
      readonly name: string;
      readonly description: string | undefined;
      /** The account it is created for; absent when the Team server has only one. */
      readonly as: string | undefined;
      readonly dataPort: number;
      readonly overrides: IdentityOverrides;
    }
  /** List the projects this server holds. */
  | { readonly kind: "project-list"; readonly root: string }
  /** Show the settings this Team server keeps in its database. */
  | { readonly kind: "settings-list"; readonly root: string }
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
      readonly root: string;
      readonly change: SettingChange;
    }
  /** Show the signing keys. */
  | { readonly kind: "key-list"; readonly root: string }
  /** Generate a key and sign with it from now on. */
  | { readonly kind: "key-rotate"; readonly root: string }
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
  return error(`${command} needs --root <path>, the directory Team keeps its files in`);
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

/**
 * Collect the identity options out of a parsed command line.
 *
 * Returns a sentence instead when one of them was unusable.
 */
function readIdentityOverrides(tokens: Tokens): IdentityOverrides | string {
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

  const issuer = tokens.values.get("--issuer");
  if (issuer !== undefined) {
    overrides.issuer = issuer;
  }
  const audience = tokens.values.get("--audience");
  if (audience !== undefined) {
    overrides.audience = audience;
  }
  const authOrigin = tokens.values.get("--auth-origin");
  if (authOrigin !== undefined) {
    // A scheme here would end up written twice, as https://https://host.
    if (authOrigin.includes("://")) {
      return "--auth-origin is a host, without a scheme, for example team.example.com";
    }
    overrides.authOrigin = authOrigin;
  }
  const env = tokens.values.get("--env");
  if (env !== undefined) {
    overrides.env = env;
  }
  const idp = tokens.values.get("--idp");
  if (idp !== undefined) {
    overrides.idp = idp;
  }
  const lifetime = tokens.values.get("--token-lifetime");
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
  const teamPort = tokens.values.get("--team-port");
  if (teamPort !== undefined) {
    const port = parsePort("--team-port", teamPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.teamPort = port;
  }
  const authPort = tokens.values.get("--auth-port");
  if (authPort !== undefined) {
    const port = parsePort("--auth-port", authPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.authPort = port;
  }
  const authTlsPort = tokens.values.get("--auth-tls-port");
  if (authTlsPort !== undefined) {
    const port = parsePort("--auth-tls-port", authTlsPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.authTlsPort = port;
  }
  const dataPort = tokens.values.get("--data-port");
  if (dataPort !== undefined) {
    const port = parsePort("--data-port", dataPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.dataPort = port;
  }

  const hostnames = tokens.lists.get("--hostname");
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
function parseUp(argv: readonly string[]): Invocation {
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

  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("up");
  }

  // Refused rather than settled one way, because the two say opposite things
  // and the safe reading and the recently-typed reading are not the same one.
  if (tokens.flags.has("--identity") && tokens.flags.has("--no-identity")) {
    return error("--identity and --no-identity cannot both be given");
  }

  let healthPort = DEFAULT_PORTS.healthPort;
  const healthPortText = tokens.values.get("--health-port");
  if (healthPortText !== undefined) {
    const port = parsePort("--health-port", healthPortText);
    if (typeof port === "string") {
      return error(port);
    }
    healthPort = port;
  }

  const overrides = readIdentityOverrides(tokens);
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
    identity: !tokens.flags.has("--no-identity"),
    overrides,
  };
}

/**
 * Parse a command line that names no command.
 *
 * It opens the terminal interface, and it takes the options that decide what
 * that interface is looking at and what it says about how this Team server is
 * reached. Nothing here starts anything: the interface reads.
 */
function parseInterface(argv: readonly string[]): Invocation {
  const result = readTokens(
    argv,
    ["--root", "--health-port", ...IDENTITY_OPTIONS],
    [],
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

  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("nlteam with no command");
  }

  let healthPort = DEFAULT_PORTS.healthPort;
  const healthPortText = tokens.values.get("--health-port");
  if (healthPortText !== undefined) {
    const port = parsePort("--health-port", healthPortText);
    if (typeof port === "string") {
      return error(port);
    }
    healthPort = port;
  }

  const overrides = readIdentityOverrides(tokens);
  if (typeof overrides === "string") {
    return error(overrides);
  }

  return { kind: "interface", root, healthPort, overrides };
}

/** Parse the arguments that follow `init`. */
function parseInit(argv: readonly string[]): Invocation {
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
  const root = tokens.values.get("--root");
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
function parseUser(argv: readonly string[]): Invocation {
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
    const result = readTokens(rest, ["--root"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const root = result.tokens.values.get("--root");
    return root === undefined ? missingRoot("user list") : { kind: "user-list", root };
  }

  if (verb === "create") {
    const result = readTokens(
      rest,
      ["--root", "--role", "--display-name", "--email"],
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
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot("user create");
    }
    return {
      kind: "user-create",
      root,
      username,
      role: tokens.values.get("--role") ?? DEFAULT_ROLE,
      displayName: tokens.values.get("--display-name"),
      email: tokens.values.get("--email"),
      isServiceAccount: tokens.flags.has("--service-account"),
    };
  }

  if (verb === "grant-admin" || verb === "revoke-admin") {
    const result = readTokens(rest, ["--root"]);
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
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot(`user ${verb}`);
    }
    return { kind: "user-set-admin", root, username, admin: verb === "grant-admin" };
  }

  if (verb === "disable" || verb === "enable" || verb === "revoke-tokens") {
    const result = readTokens(rest, ["--root"]);
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
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot(`user ${verb}`);
    }
    if (verb === "disable") {
      return { kind: "user-disable", root, username };
    }
    return verb === "enable"
      ? { kind: "user-enable", root, username }
      : { kind: "user-revoke-tokens", root, username };
  }

  return error(`unknown user command: ${verb}`);
}

/** Parse the arguments that follow `token`. */
function parseToken(argv: readonly string[]): Invocation {
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

  const result = readTokens(rest, ["--root", ...IDENTITY_OPTIONS], [], IDENTITY_LIST_OPTIONS);
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
  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("token mint");
  }
  const overrides = readIdentityOverrides(tokens);
  if (typeof overrides === "string") {
    return error(overrides);
  }

  return { kind: "token-mint", root, username, overrides };
}

/** Parse the arguments that follow `project`. */
function parseProject(argv: readonly string[]): Invocation {
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
      ["--root", "--description", "--as", ...IDENTITY_OPTIONS],
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
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot("project create");
    }

    const overrides = readIdentityOverrides(tokens);
    if (typeof overrides === "string") {
      return error(overrides);
    }

    return {
      kind: "project-create",
      root,
      name,
      description: tokens.values.get("--description"),
      as: tokens.values.get("--as"),
      // Where loreserver is, and also what a token's audience says about it.
      dataPort: overrides.dataPort ?? DEFAULT_PORTS.dataPort,
      overrides,
    };
  }

  if (verb === "list") {
    const result = readTokens(rest, ["--root"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;
    const extra = tokens.positionals[0];
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot("project list");
    }
    return { kind: "project-list", root };
  }

  return error(`unknown project command: ${verb}`);
}

/** Parse the arguments that follow `settings`. */
function parseSettings(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("settings needs a verb: list or set");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }

  if (verb === "list") {
    const result = readTokens(rest, ["--root"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const extra = result.tokens.positionals[0];
    if (extra !== undefined) {
      return error(`unexpected argument: ${extra}`);
    }
    const root = result.tokens.values.get("--root");
    return root === undefined ? missingRoot("settings list") : { kind: "settings-list", root };
  }

  if (verb === "set") {
    const result = readTokens(rest, ["--root"]);
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
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot("settings set");
    }
    // Named, rather than left as "unknown setting": somebody who has typed the
    // wrong one of the keys is one line away from the right one, and a message
    // that only says no is a message that sends them to the source.
    if (!isSettingKey(key)) {
      return error(
        `there is no setting called ${key}. The settings are ${SETTING_KEYS.join(", ")}.`,
      );
    }
    // A name is stored as it was written, and every check on it is the
    // database's: what is too long, empty or unprintable is the same question
    // wherever the name came from, and answering it twice would be two answers.
    if (!isLifetimeKey(key)) {
      return { kind: "settings-set", root, change: { key, name: value } };
    }
    // The durations `--token-lifetime` takes, read by the same function, so
    // that 7d means the same thing on every command line here.
    const milliseconds = parseDuration(key, value);
    if (typeof milliseconds === "string") {
      return error(milliseconds);
    }
    return {
      kind: "settings-set",
      root,
      change: { key, seconds: Math.floor(milliseconds / 1000) },
    };
  }

  return error(`unknown settings command: ${verb}`);
}

/** Parse the arguments that follow `key`. */
function parseKey(argv: readonly string[]): Invocation {
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

  const result = readTokens(rest, ["--root"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const extra = result.tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const root = result.tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot(`key ${verb}`);
  }
  return verb === "list" ? { kind: "key-list", root } : { kind: "key-rotate", root };
}

/** Parse the arguments that follow `trust`. */
function parseTrust(argv: readonly string[]): Invocation {
  const result = readTokens(argv, ["--root"], ["--install", "--remove"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const extra = tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const root = tokens.values.get("--root");
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
export function parseArgs(argv: readonly string[]): Invocation {
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
      return parseUp(rest);
    case "init":
      return parseInit(rest);
    case "user":
      return parseUser(rest);
    case "token":
      return parseToken(rest);
    case "project":
      return parseProject(rest);
    case "settings":
      return parseSettings(rest);
    case "key":
      return parseKey(rest);
    case "trust":
      return parseTrust(rest);
    default:
      // A command line of nothing but options names no command, and the one
      // thing it can mean is the interface. Anything else is still a mistake:
      // a mistyped command is a word, and a mistyped option starts with a
      // dash but is not one this takes.
      if (first.startsWith("--")) {
        return parseInterface(argv);
      }
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
