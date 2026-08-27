/**
 * The settings a Team server keeps in its database rather than in its source.
 *
 * There are the two token lifetimes, the name this deployment calls itself, the
 * two words an operator chooses about what their deployment is and how it is
 * used, and the identity a token's audience is built from — the issuer, the
 * audience, the auth origin, the host names and the ports. Everything but the
 * identity is changed with `settings set` and is read where it is used, as a
 * token is minted or as the discovery document is answered, so a change reaches
 * a running server without anything being restarted. The
 * identity is different in who owns it: `up` writes it from the configuration it
 * was started with, and the commands that mint a token in another process read
 * it — see {@link storedIdentity}, which is why a token minted by hand names the
 * same audience the running server does rather than whatever bare command line
 * asked for it.
 *
 * A setting nobody has chosen has no row here, and something else answers for
 * it: the defaults in ./config.ts for the lifetimes and the identity, and the
 * server's own host for the name. The comment on migration 3 in ./database.ts
 * says why nothing writes those defaults in.
 */
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_IDENTITY, type IdentityConfig } from "./config.js";
import { textColumn } from "./database.js";

/**
 * The two lifetimes, under the names the identity settings already give them.
 *
 * The same names on both sides mean one can be spread over the other, so that
 * "the stored value, unless the command line named one" is a line of code
 * rather than a translation table nobody remembers to extend.
 */
export type TokenLifetimes = Pick<
  IdentityConfig,
  "signInTokenLifetimeSeconds" | "repositoryTokenLifetimeSeconds"
>;

/** The key the sign-in token's lifetime is stored under. */
export const SIGN_IN_LIFETIME_KEY = "token.sign_in_lifetime_seconds";

/** The key the repository token's lifetime is stored under. */
export const REPOSITORY_LIFETIME_KEY = "token.repository_lifetime_seconds";

/** The key the name this server calls itself is stored under. */
export const SERVER_NAME_KEY = "server.name";

/** The key the rule for a repository this server already holds is stored under. */
export const PUBLISH_LINEAGE_KEY = "project.publish_lineage";

/**
 * What Studio does when somebody publishes a repository this server already has.
 *
 * **The case is ordinary rather than exotic**: a project folder copied to start a
 * variant carries the same repository, so the repository has been here before -
 * registered under whatever it was called the first time - and the author is now
 * publishing it under a name of their choosing.
 *
 *  - `merge` connects it under the name this server already holds it as. What is
 *    left is two histories of one project, which is what sending and getting are
 *    for: the divergence is settled by a person, once, with both sides in front
 *    of them.
 *  - `refuse` will not have it, and the author is told which project it already is.
 *    For a deployment where one repository is meant to be one project and a second
 *    copy of it is a mistake somebody should hear about rather than merge.
 *
 * ⚠ **A rule this server states and Studio keeps, not a permission this server
 * enforces.** What it governs is what an author's own machine writes into its own
 * repository, which nothing here can reach - so it belongs with the other things an
 * operator decides about how their deployment is used, and not with the things that
 * are checked before a write is allowed.
 */
export const PUBLISH_LINEAGE_RULES = ["merge", "refuse"] as const;

/** One of the two above. */
export type PublishLineageRule = (typeof PUBLISH_LINEAGE_RULES)[number];

/**
 * What a deployment does about it until somebody says otherwise.
 *
 * `merge`, because it is the answer that loses nothing: the two copies are one
 * project and the author is given the means to reconcile them. Refusing is the
 * stricter choice and stricter is not the safer default here - a refusal on a
 * server nobody configured would stop an ordinary act with no way to see why.
 */
export const DEFAULT_PUBLISH_LINEAGE: PublishLineageRule = "merge";

/** Raised when a rule is not one of the two this server has. */
export class InvalidPublishLineageError extends Error {
  constructor(readonly value: string) {
    super(
      `${PUBLISH_LINEAGE_KEY} cannot be "${value}". It is one of ` +
        `${PUBLISH_LINEAGE_RULES.join(" or ")}.`,
    );
    this.name = "InvalidPublishLineageError";
  }
}

/** Whether some text names one of the rules. */
export function isPublishLineageRule(value: string): value is PublishLineageRule {
  return PUBLISH_LINEAGE_RULES.some((rule) => rule === value.trim());
}

/** The key that says whether this deployment is a collaboration server at all. */
export const COLLABORATION_KEY = "server.collaboration";

/**
 * Whether people other than this server's operators may work together on it.
 *
 * **This is the one setting that decides what kind of deployment this is**, and
 * it is a switch an operator reaches for rather than a permission on an account:
 * it says nothing about who anybody is, and everything about what the deployment
 * is for.
 *
 *  - `open` is a collaboration server. Comments, live sessions, overlays, the
 *    client list and the files a live session carries are announced and answered,
 *    and every account of this server works on what is on it.
 *  - `closed` is a deployment that holds projects and is administered, and that
 *    is all. The five coordination capabilities are not announced and every
 *    method under them refuses - operators included, because an operator has no
 *    use for `live.say` and an exception for them would be a hole in a switch
 *    whose whole purpose is that there is nothing on the other side of it. And
 *    the projects become their operators' business: anybody else is refused the
 *    project list, one project, a project's history, the member list, and making
 *    a project or taking one off.
 *
 * ⚠ **Not a rule this server states and a client keeps, the way
 * {@link PUBLISH_LINEAGE_RULES} is.** Every part of this is refused here, on the
 * call, so a client that ignored the capability list gains nothing by it.
 */
export const COLLABORATION_MODES = ["open", "closed"] as const;

/** One of the two above. */
export type CollaborationMode = (typeof COLLABORATION_MODES)[number];

/**
 * What a deployment is until somebody says otherwise.
 *
 * `open`, because a Team server is a collaboration server: that is what somebody
 * installs one for, and a deployment that had to be switched on before the thing
 * it is for worked would be a deployment whose first hour is spent finding out
 * why nothing does.
 */
export const DEFAULT_COLLABORATION: CollaborationMode = "open";

/** Raised when a mode is not one of the two this server has. */
export class InvalidCollaborationModeError extends Error {
  constructor(readonly value: string) {
    super(
      `${COLLABORATION_KEY} cannot be "${value}". It is one of ` +
        `${COLLABORATION_MODES.join(" or ")}.`,
    );
    this.name = "InvalidCollaborationModeError";
  }
}

/** Whether some text names one of the modes. */
export function isCollaborationMode(value: string): value is CollaborationMode {
  return COLLABORATION_MODES.some((mode) => mode === value.trim());
}

/**
 * Every key a person may name, in the order they are shown.
 *
 * The keys are the ones the table stores rather than shorter names invented for
 * the command line. A second set of names would have to be mapped onto these,
 * and the mapping would be the thing that says one name and writes another.
 */
export const SETTING_KEYS = [
  SERVER_NAME_KEY,
  COLLABORATION_KEY,
  PUBLISH_LINEAGE_KEY,
  SIGN_IN_LIFETIME_KEY,
  REPOSITORY_LIFETIME_KEY,
] as const;

/** One of the keys above. */
export type SettingKey = (typeof SETTING_KEYS)[number];

/** True when `key` is a setting this Team server has. */
export function isSettingKey(key: string): key is SettingKey {
  return SETTING_KEYS.some((known) => known === key);
}

/**
 * The keys that hold a token lifetime, which is no longer all of them.
 *
 * Named as a pair of its own so that everything which reads a duration back —
 * a command line, a row being edited — says which settings it is talking about
 * rather than taking any key and treating whatever is not the sign-in lifetime
 * as the repository one.
 */
export const LIFETIME_KEYS = [SIGN_IN_LIFETIME_KEY, REPOSITORY_LIFETIME_KEY] as const;

/** One of the two above. */
export type LifetimeKey = (typeof LIFETIME_KEYS)[number];

/** True when `key` names a lifetime rather than one of the other settings. */
export function isLifetimeKey(key: string): key is LifetimeKey {
  return LIFETIME_KEYS.some((known) => known === key);
}

/**
 * One setting and the value it is being given, in the shape it is stored in.
 *
 * A pair rather than a key and a string, because the settings are no longer all
 * of one kind: a lifetime is read out of `7d` where a command line is parsed,
 * and a name is stored as it was written. Carrying which of the two this is
 * means nothing downstream has to look at a key and guess.
 */
export type SettingChange =
  | { readonly key: LifetimeKey; readonly seconds: number }
  | { readonly key: typeof SERVER_NAME_KEY; readonly name: string }
  | { readonly key: typeof PUBLISH_LINEAGE_KEY; readonly rule: PublishLineageRule }
  | { readonly key: typeof COLLABORATION_KEY; readonly mode: CollaborationMode };

/**
 * The one thing about the repository lifetime that is not obvious from its
 * name, said in one sentence wherever it is being changed.
 *
 * Here rather than beside whatever is changing it, because more than one thing
 * says it and two copies would drift.
 */
export const REPOSITORY_LIFETIME_CAUTION =
  "loreserver accepts this one without asking Team, so revoking access cannot cut it short.";

/**
 * The range a stored lifetime has to fall in.
 *
 * The floor is a minute so that a lifetime stays longer than the exchange that
 * issues the token: one that has expired before its holder can present it is
 * refused as an expired token, which reads as a clock that is wrong rather
 * than as a setting that is. The ceiling is a year because a repository token
 * is bounded by its expiry and by nothing else, and a bound that far out is
 * not a bound. Neither number is a limit of the format.
 */
export const MINIMUM_TOKEN_LIFETIME_SECONDS = 60;

/** The longest a stored lifetime may be; see the floor above for why. */
export const MAXIMUM_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/** Raised when a setting is not a value Team can use. */
export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
  ) {
    super(
      `${key} cannot be "${value}". A token lifetime is a whole number of seconds, at ` +
        `least ${MINIMUM_TOKEN_LIFETIME_SECONDS} and at most ${MAXIMUM_TOKEN_LIFETIME_SECONDS}.`,
    );
    this.name = "InvalidSettingError";
  }
}

/**
 * The longest a chosen name may be.
 *
 * It is a label a person reads in a list of servers, beside the address they
 * would otherwise have read. Sixty characters is longer than any deployment
 * name anybody writes and shorter than a paragraph, which is the only thing
 * the bound is for.
 */
export const MAXIMUM_SERVER_NAME_LENGTH = 60;

/** Raised when a name is not one a server can be called. */
export class InvalidServerNameError extends Error {
  constructor(readonly value: string) {
    super(
      `"${value}" cannot be this server's name. A name is 1 to ` +
        `${MAXIMUM_SERVER_NAME_LENGTH} characters and carries no control characters. It is ` +
        "a label a person reads, not an address.",
    );
    this.name = "InvalidServerNameError";
  }
}

/**
 * Whether some text is a name a server may be given.
 *
 * Control characters are the one class refused, and they are refused because
 * this string is drawn in a terminal, in a browser and in Studio's list of
 * servers: a name carrying an escape or a newline is one interface writing a
 * line of another. Everything else a person might call a deployment is allowed,
 * in whatever language they call it.
 */
function isServerName(value: string): boolean {
  const name = value.trim();
  return name !== "" && name.length <= MAXIMUM_SERVER_NAME_LENGTH && !/\p{Cc}/u.test(name);
}

/** Whether a number of seconds is one a lifetime may be set to. */
function withinRange(seconds: number): boolean {
  return (
    Number.isSafeInteger(seconds) &&
    seconds >= MINIMUM_TOKEN_LIFETIME_SECONDS &&
    seconds <= MAXIMUM_TOKEN_LIFETIME_SECONDS
  );
}

/** The stored text of one setting, or undefined when there is no row. */
function readSetting(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row === undefined ? undefined : textColumn(row, "value");
}

/** Put one setting in the table, over whatever was there. */
function writeSetting(database: DatabaseSync, key: string, value: string, at = Date.now()): void {
  database
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, at);
}

/**
 * One stored lifetime as a number, or `fallback` when nobody has set it.
 *
 * The value is checked here as well as on the way in. Validating on write
 * cannot be the whole of it: the file is SQLite and whoever has the storage
 * root can write to it with anything, and a lifetime that came back as NaN
 * would reach a token's `exp` and put it at the epoch — a token issued already
 * expired, from a Team server that says nothing is wrong.
 */
function lifetimeOf(database: DatabaseSync, key: string, fallback: number): number {
  const stored = readSetting(database, key);
  if (stored === undefined) {
    return fallback;
  }
  // Digits and nothing else: `Number` reads "1e9", " 60" and "0x10" as numbers,
  // and none of the three is what somebody meant to store.
  if (!/^\d+$/.test(stored) || !withinRange(Number(stored))) {
    throw new InvalidSettingError(key, stored);
  }
  return Number(stored);
}

/** True when somebody has stored a value for `key`, rather than left the default. */
export function isSettingStored(database: DatabaseSync, key: SettingKey): boolean {
  return readSetting(database, key) !== undefined;
}

/**
 * What this deployment calls itself, or `fallback` where nobody has chosen.
 *
 * Read as each answer is composed rather than once, which is what lets a name
 * chosen while the server is running reach the discovery document without a
 * restart — see {@link discoveryDocument} in ./discovery.ts.
 *
 * A stored value that is not a name Team would have accepted falls back to the
 * host rather than raising, which is the opposite of what {@link lifetimeOf}
 * does with a lifetime, and deliberately: a lifetime nobody can read would
 * reach a token's `exp`, while a name nobody can read is a label. Refusing to
 * answer at all would take out the one document that says where to sign in,
 * over a caption.
 */
export function storedServerName(database: DatabaseSync, fallback: string): string {
  const stored = readSetting(database, SERVER_NAME_KEY);
  if (stored === undefined) {
    return fallback;
  }
  return isServerName(stored) ? stored.trim() : fallback;
}

/** Store the name this server calls itself, and answer with it as stored. */
export function setServerName(database: DatabaseSync, name: string): string {
  if (!isServerName(name)) {
    throw new InvalidServerNameError(name);
  }
  const stored = name.trim();
  writeSetting(database, SERVER_NAME_KEY, stored);
  return stored;
}

/**
 * The rule this deployment states about a repository it already holds.
 *
 * A stored value nobody can read falls back to the default rather than raising,
 * for {@link storedServerName}'s reason and not {@link lifetimeOf}'s: this is
 * composed into the discovery document, and refusing to answer would take out the
 * one document that says where to sign in over a policy that has a sane default.
 */
export function storedPublishLineage(database: DatabaseSync): PublishLineageRule {
  const stored = readSetting(database, PUBLISH_LINEAGE_KEY);
  if (stored === undefined || !isPublishLineageRule(stored)) {
    return DEFAULT_PUBLISH_LINEAGE;
  }
  return stored.trim() as PublishLineageRule;
}

/** Store that rule, and answer with it as stored. */
export function setPublishLineage(database: DatabaseSync, rule: string): PublishLineageRule {
  if (!isPublishLineageRule(rule)) {
    throw new InvalidPublishLineageError(rule);
  }
  const stored = rule.trim() as PublishLineageRule;
  writeSetting(database, PUBLISH_LINEAGE_KEY, stored);
  return stored;
}

/**
 * Whether this deployment is a collaboration server, as it stands now.
 *
 * Read wherever the answer is needed rather than once, which is what lets a
 * deployment be closed to collaboration over ssh and have that reach the next
 * request instead of the next restart — the capability list and every call under
 * it are worked out from this, and both ask each time. See
 * src/team/collaboration.ts.
 *
 * A stored value nobody can read falls back to the default rather than raising,
 * for {@link storedServerName}'s reason: this decides what is announced in the
 * document that says where to sign in, and refusing to answer it would take that
 * document out over an unreadable word. `open` is the value that fails towards
 * the server working rather than towards a deployment nobody can use and no
 * message explains — and a file only whoever holds the storage root can write is
 * not where an attacker turns collaboration on.
 */
export function storedCollaboration(database: DatabaseSync): CollaborationMode {
  const stored = readSetting(database, COLLABORATION_KEY);
  if (stored === undefined || !isCollaborationMode(stored)) {
    return DEFAULT_COLLABORATION;
  }
  return stored.trim() as CollaborationMode;
}

/** Store that mode, and answer with it as stored. */
export function setCollaboration(database: DatabaseSync, mode: string): CollaborationMode {
  if (!isCollaborationMode(mode)) {
    throw new InvalidCollaborationModeError(mode);
  }
  const stored = mode.trim() as CollaborationMode;
  writeSetting(database, COLLABORATION_KEY, stored);
  return stored;
}

/** The two lifetimes as they stand: stored where set, default where not. */
export function storedTokenLifetimes(database: DatabaseSync): TokenLifetimes {
  return {
    signInTokenLifetimeSeconds: lifetimeOf(
      database,
      SIGN_IN_LIFETIME_KEY,
      DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
    ),
    repositoryTokenLifetimeSeconds: lifetimeOf(
      database,
      REPOSITORY_LIFETIME_KEY,
      DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    ),
  };
}

/**
 * Store one lifetime or both, and answer with the pair as it now stands.
 *
 * Everything named is checked before anything is written, so a call carrying
 * one good value and one bad leaves neither behind rather than half of it.
 */
export function setTokenLifetimes(
  database: DatabaseSync,
  values: Partial<TokenLifetimes>,
): TokenLifetimes {
  const writes: (readonly [string, number])[] = [];
  if (values.signInTokenLifetimeSeconds !== undefined) {
    writes.push([SIGN_IN_LIFETIME_KEY, values.signInTokenLifetimeSeconds]);
  }
  if (values.repositoryTokenLifetimeSeconds !== undefined) {
    writes.push([REPOSITORY_LIFETIME_KEY, values.repositoryTokenLifetimeSeconds]);
  }
  for (const [key, seconds] of writes) {
    if (!withinRange(seconds)) {
      throw new InvalidSettingError(key, String(seconds));
    }
  }

  const now = Date.now();
  for (const [key, seconds] of writes) {
    writeSetting(database, key, String(seconds), now);
  }

  return storedTokenLifetimes(database);
}

/**
 * One lifetime out of the pair, by the key it is stored under.
 *
 * The pair is what everything else here passes around, and a caller working
 * from a key — a command line, or a row on a screen — would otherwise have to
 * write out the same two-way choice each time it needed the value back.
 */
export function lifetimeUnder(lifetimes: TokenLifetimes, key: LifetimeKey): number {
  return key === SIGN_IN_LIFETIME_KEY
    ? lifetimes.signInTokenLifetimeSeconds
    : lifetimes.repositoryTokenLifetimeSeconds;
}

/** Store one lifetime by its key, and answer with the pair as it now stands. */
export function setTokenLifetime(
  database: DatabaseSync,
  key: LifetimeKey,
  seconds: number,
): TokenLifetimes {
  return setTokenLifetimes(
    database,
    key === SIGN_IN_LIFETIME_KEY
      ? { signInTokenLifetimeSeconds: seconds }
      : { repositoryTokenLifetimeSeconds: seconds },
  );
}

/**
 * The lifetimes out of what a command line named, and nothing else.
 *
 * What an operator writes wins over what is stored, for as long as that
 * command runs: `--token-lifetime` is written for one invocation, and a stored
 * setting it could not beat would leave the option doing nothing the moment
 * somebody set one.
 */
export function namedTokenLifetimes(overrides: Partial<IdentityConfig>): Partial<TokenLifetimes> {
  return {
    ...(overrides.signInTokenLifetimeSeconds === undefined
      ? {}
      : { signInTokenLifetimeSeconds: overrides.signInTokenLifetimeSeconds }),
    ...(overrides.repositoryTokenLifetimeSeconds === undefined
      ? {}
      : { repositoryTokenLifetimeSeconds: overrides.repositoryTokenLifetimeSeconds }),
  };
}

/**
 * The identity a token's audience depends on, stored so that a command run in a
 * different process than `up` mints the same token `up` would.
 *
 * These describe where this deployment is reached and what its tokens say: the
 * issuer and audience, the auth origin and the host names, and the four ports. A
 * token's audience is built from them, and a token whose audience names an
 * address nothing answers on is one that signs in and then fails every
 * repository operation — so `nlteam token mint` in one terminal must not derive
 * them from its own bare command line while `up` in another was brought up as
 * something else. `up` writes them here from its resolved configuration; the
 * mint commands read them as their default, under anything named again.
 *
 * They live in the same `settings` table the lifetimes and the server name do —
 * key to value, one row each — which is why nothing new had to be added to the
 * schema for them. The two token lifetimes have their own keys above and are
 * not repeated here; the server name is a label rather than part of an audience,
 * and is its own thing too.
 */
const IDENTITY_ISSUER_KEY = "identity.issuer";
const IDENTITY_AUDIENCE_KEY = "identity.audience";
const IDENTITY_AUTH_ORIGIN_KEY = "identity.auth_origin";
const IDENTITY_ENV_KEY = "identity.env";
const IDENTITY_IDP_KEY = "identity.idp";
const IDENTITY_TEAM_PORT_KEY = "identity.team_port";
const IDENTITY_AUTH_PORT_KEY = "identity.auth_port";
const IDENTITY_AUTH_TLS_PORT_KEY = "identity.auth_tls_port";
const IDENTITY_DATA_PORT_KEY = "identity.data_port";
const IDENTITY_HOSTNAMES_KEY = "identity.hostnames";

/** The lowest and highest a stored port may be; the range a listener accepts. */
const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;

/** Raised when a stored identity value is not one Team could have written. */
export class InvalidStoredIdentityError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
  ) {
    super(
      `team.db holds ${key} = "${value}", which is not a value Team writes. The file was ` +
        "written by something other than this version of Team.",
    );
    this.name = "InvalidStoredIdentityError";
  }
}

/** A stored string setting, or undefined where there is no row or it is blank. */
function storedString(database: DatabaseSync, key: string): string | undefined {
  const stored = readSetting(database, key);
  return stored === undefined || stored.trim() === "" ? undefined : stored;
}

/**
 * A stored port, or undefined where there is no row.
 *
 * Checked as it is read, for the reason {@link lifetimeOf} is: whoever has the
 * storage root has the SQLite file, and a port that came back as NaN or out of
 * range would reach a token's audience and name an address no client matches —
 * the very silent failure this whole thing exists to prevent. A value that will
 * not read back is refused with a sentence rather than defaulted around.
 */
function storedPort(database: DatabaseSync, key: string): number | undefined {
  const stored = readSetting(database, key);
  if (stored === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(stored)) {
    throw new InvalidStoredIdentityError(key, stored);
  }
  const port = Number(stored);
  if (port < MINIMUM_PORT || port > MAXIMUM_PORT) {
    throw new InvalidStoredIdentityError(key, stored);
  }
  return port;
}

/**
 * The stored host names, or undefined where there is no row.
 *
 * One comma-separated string, written by {@link persistIdentity} from the list
 * `up` resolved. A row that is present but empty is an operator who named no
 * host beyond the auth origin's, which is a real answer — an empty list — rather
 * than an absent one, so it comes back as `[]` and not as undefined.
 */
function storedHostnames(database: DatabaseSync, key: string): readonly string[] | undefined {
  const stored = readSetting(database, key);
  if (stored === undefined) {
    return undefined;
  }
  return stored
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

/**
 * The identity this server was brought up as, as far as it is stored.
 *
 * Only the settings that have a row are named; everything else is left for the
 * default in ./config.ts to answer, exactly as the lifetimes are. On a server
 * that has never been brought up this is empty, and a token minted from it
 * carries the defaults — which is right, because there is no deployment identity
 * to speak of until `up` has written one.
 */
export function storedIdentity(database: DatabaseSync): Partial<IdentityConfig> {
  const identity: {
    issuer?: string;
    audience?: string;
    authOrigin?: string;
    env?: string;
    idp?: string;
    teamPort?: number;
    authPort?: number;
    authTlsPort?: number;
    dataPort?: number;
    hostnames?: readonly string[];
  } = {};

  const issuer = storedString(database, IDENTITY_ISSUER_KEY);
  if (issuer !== undefined) {
    identity.issuer = issuer;
  }
  const audience = storedString(database, IDENTITY_AUDIENCE_KEY);
  if (audience !== undefined) {
    identity.audience = audience;
  }
  const authOrigin = storedString(database, IDENTITY_AUTH_ORIGIN_KEY);
  if (authOrigin !== undefined) {
    identity.authOrigin = authOrigin;
  }
  const env = storedString(database, IDENTITY_ENV_KEY);
  if (env !== undefined) {
    identity.env = env;
  }
  const idp = storedString(database, IDENTITY_IDP_KEY);
  if (idp !== undefined) {
    identity.idp = idp;
  }
  const teamPort = storedPort(database, IDENTITY_TEAM_PORT_KEY);
  if (teamPort !== undefined) {
    identity.teamPort = teamPort;
  }
  const authPort = storedPort(database, IDENTITY_AUTH_PORT_KEY);
  if (authPort !== undefined) {
    identity.authPort = authPort;
  }
  const authTlsPort = storedPort(database, IDENTITY_AUTH_TLS_PORT_KEY);
  if (authTlsPort !== undefined) {
    identity.authTlsPort = authTlsPort;
  }
  const dataPort = storedPort(database, IDENTITY_DATA_PORT_KEY);
  if (dataPort !== undefined) {
    identity.dataPort = dataPort;
  }
  const hostnames = storedHostnames(database, IDENTITY_HOSTNAMES_KEY);
  if (hostnames !== undefined) {
    identity.hostnames = hostnames;
  }

  return identity;
}

/**
 * Write the deployment's identity, over whatever was there.
 *
 * Called by `up` from its own resolved configuration, on every start rather than
 * only the first: an operator moving the server to a new host runs
 * `up --hostname newname`, and this is where that becomes the default every
 * other command mints by. It is `up` that owns this identity and refreshes it;
 * the mint commands only read it.
 */
export function persistIdentity(database: DatabaseSync, config: IdentityConfig): void {
  const now = Date.now();
  const writes: readonly (readonly [string, string])[] = [
    [IDENTITY_ISSUER_KEY, config.issuer],
    [IDENTITY_AUDIENCE_KEY, config.audience],
    [IDENTITY_AUTH_ORIGIN_KEY, config.authOrigin],
    [IDENTITY_ENV_KEY, config.env],
    [IDENTITY_IDP_KEY, config.idp],
    [IDENTITY_TEAM_PORT_KEY, String(config.teamPort)],
    [IDENTITY_AUTH_PORT_KEY, String(config.authPort)],
    [IDENTITY_AUTH_TLS_PORT_KEY, String(config.authTlsPort)],
    [IDENTITY_DATA_PORT_KEY, String(config.dataPort)],
    [IDENTITY_HOSTNAMES_KEY, config.hostnames.join(",")],
  ];
  for (const [key, value] of writes) {
    writeSetting(database, key, value, now);
  }
}
