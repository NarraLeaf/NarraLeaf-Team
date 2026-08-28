/**
 * Reading what a server answered, before anything prints it.
 *
 * A server is a peer over a network rather than a function in this process. A
 * client that assumed the shape of an answer would report a protocol that had
 * moved as a row of the word "undefined", or as a blank column that looks
 * exactly like a value this server does not have — which is the one thing the
 * two halves of the command line must never be confused about. So every answer
 * is checked here, and an answer that is not the shape the contract describes
 * is a sentence naming the method rather than a silent absence.
 *
 * It is one module rather than a reader beside each command for the reason
 * src/identity/answers.ts is one builder: the same account comes back from a
 * list and from every change made to one, and two readers of it are how a field
 * comes to be understood on one path and not another.
 *
 * **Nothing here decides what to print.** These functions turn an answer into
 * the fields the contract says it has; whether a field is shown, and what a
 * missing one leaves behind, is the command's business — see the renderers in
 * src/user.ts and its neighbours, which are called from both paths.
 */
import {
  TEAM_METHODS,
  type TeamAdminDecision,
  type TeamAdminLoreserver,
  type TeamAdminReach,
  type TeamAdminStatus,
} from "@narraleaf/team-protocol";

/** An answer as a record, or an empty one when it was not even an object. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Raised when an answer is not the shape the contract describes. */
function malformed(method: string, what: string): Error {
  return new Error(`that server answered ${method} ${what}`);
}

/** A string field, or undefined where it is absent or is something else. */
function optionalText(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name];
  return typeof value === "string" ? value : undefined;
}

/** A number field, or undefined where it is absent or is something else. */
function optionalNumber(row: Record<string, unknown>, name: string): number | undefined {
  const value = row[name];
  return typeof value === "number" ? value : undefined;
}

/** A boolean field, false where it is absent. Every flag on this wire is one or the other. */
function flag(row: Record<string, unknown>, name: string): boolean {
  return row[name] === true;
}

/** One project, as `projects.list` and `projects.create` both carry it. */
export interface ListedProject {
  readonly id: string;
  readonly name: string;
  /** Who made it, by username; absent for an account this server no longer has. */
  readonly createdBy: string | undefined;
}

/**
 * One project out of an answer.
 *
 * Shared by the list and the create because the contract carries one project
 * body and not two — see src/projects/answers.ts, which composes it once on the
 * far side for exactly this reason.
 */
export function readProject(method: string, row: unknown): ListedProject {
  const project = objectOf(row);
  const id = optionalText(project, "id");
  const name = optionalText(project, "name");
  if (id === undefined || name === undefined) {
    throw malformed(method, "with a project that has no id or name");
  }
  return { id, name, createdBy: optionalText(project, "createdBy") };
}

/** The list `projects.list` answers with. */
export function readProjectList(answer: unknown): readonly ListedProject[] {
  const listed = objectOf(answer)["projects"];
  if (!Array.isArray(listed)) {
    throw malformed(TEAM_METHODS.projectsList, "without a list of projects");
  }
  return listed.map((row: unknown) => readProject(TEAM_METHODS.projectsList, row));
}

/** The one project `projects.create` answers with. */
export function readCreatedProject(answer: unknown): ListedProject {
  const project = objectOf(answer)["project"];
  if (project === undefined) {
    throw malformed(TEAM_METHODS.projectsCreate, "without the project it made");
  }
  return readProject(TEAM_METHODS.projectsCreate, project);
}

/** One account, as every method of the `admin.users` family hands one back. */
export interface ListedUser {
  readonly username: string;
  readonly groups: readonly string[];
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  /** The stable identifier a token's subject holds. */
  readonly id: string;
}

/** One account out of an answer. */
function readUserBody(method: string, value: unknown): ListedUser {
  const user = objectOf(value);
  const username = optionalText(user, "username");
  const id = optionalText(user, "id");
  if (username === undefined || id === undefined) {
    throw malformed(method, "with an account that has no username or id");
  }
  const groups = user["groups"];
  if (!Array.isArray(groups) || groups.some((group: unknown) => typeof group !== "string")) {
    throw malformed(method, "with an account whose groups are not a list of names");
  }
  return {
    username,
    groups: groups as readonly string[],
    disabled: flag(user, "disabled"),
    serviceAccount: flag(user, "serviceAccount"),
    id,
  };
}

/** The account a change to one answers with. */
export function readUser(method: string, answer: unknown): ListedUser {
  const user = objectOf(answer)["user"];
  if (user === undefined) {
    throw malformed(method, "without the account it acted on");
  }
  return readUserBody(method, user);
}

/** One page of the accounts, and where the next one carries on from. */
export interface UserPage {
  readonly users: readonly ListedUser[];
  /** Opaque, and absent when this page is the end of the list. */
  readonly cursor: string | undefined;
}

/** A page of `admin.users.list`. */
export function readUserPage(answer: unknown): UserPage {
  const value = objectOf(answer);
  const listed = value["users"];
  if (!Array.isArray(listed)) {
    throw malformed(TEAM_METHODS.adminUsersList, "without a list of accounts");
  }
  return {
    users: listed.map((row: unknown) => readUserBody(TEAM_METHODS.adminUsersList, row)),
    cursor: optionalText(value, "cursor"),
  };
}

/** What `admin.tokens.mint` produced. */
export interface MintedToken {
  readonly username: string;
  /** When it expires, in milliseconds since the epoch. */
  readonly expiresAt: number;
  /**
   * The token itself, absent on a repeated mint.
   *
   * A repeat is answered with the account and the expiry of the mint that did
   * happen and with no token, because the server kept nothing of the one it
   * made. Nothing this program sends can produce that answer — see the note on
   * client ids in src/client/admin.ts — but the field is optional on the wire
   * and a reader that assumed it would print the word "undefined" as a
   * credential.
   */
  readonly token: string | undefined;
}

/** The token `admin.tokens.mint` answers with. */
export function readMintedToken(answer: unknown): MintedToken {
  const minted = objectOf(objectOf(answer)["minted"]);
  const username = optionalText(minted, "username");
  const expiresAt = minted["expiresAt"];
  if (username === undefined || typeof expiresAt !== "number") {
    throw malformed(TEAM_METHODS.adminTokensMint, "without an account and an expiry");
  }
  return { username, expiresAt, token: optionalText(minted, "token") };
}

/** One row of the settings surface. */
export interface ListedSetting {
  /** What the row is called, which is the key it is written by as well as its caption. */
  readonly label: string;
  readonly value: string;
  /**
   * The number `value` was written from, on the two rows that were written from one.
   *
   * A lifetime is shown in words, and this is what saves every reader of it
   * from taking those words apart again — in whatever language the server wrote
   * them in. Absent on every other row, which have no number behind them.
   */
  readonly seconds: number | undefined;
  /**
   * Whether somebody chose this value or a default is answering for it.
   *
   * Undefined where the server did not say — either a row that has no such
   * distinction, or a server older than the field. Both come out as a blank
   * column rather than a guess, for the reason the field exists: whether a value
   * was chosen is exactly the fact a reader cannot recover from the value.
   */
  readonly stored: boolean | undefined;
}

/** One setting out of an answer. */
function readSettingBody(method: string, value: unknown): ListedSetting {
  const setting = objectOf(value);
  const label = optionalText(setting, "label");
  const shown = optionalText(setting, "value");
  if (label === undefined || shown === undefined) {
    throw malformed(method, "with a setting that has no label or value");
  }
  const seconds = setting["seconds"];
  const stored = setting["stored"];
  return {
    label,
    value: shown,
    seconds: typeof seconds === "number" ? seconds : undefined,
    stored: typeof stored === "boolean" ? stored : undefined,
  };
}

/** Every row `admin.settings.list` answers with, read-only ones included. */
export function readSettings(answer: unknown): readonly ListedSetting[] {
  const listed = objectOf(answer)["settings"];
  if (!Array.isArray(listed)) {
    throw malformed(TEAM_METHODS.adminSettingsList, "without a list of settings");
  }
  return listed.map((row: unknown) => readSettingBody(TEAM_METHODS.adminSettingsList, row));
}

/** The row `admin.settings.set` answers with, as it now stands. */
export function readSetting(answer: unknown): ListedSetting {
  const setting = objectOf(answer)["setting"];
  if (setting === undefined) {
    throw malformed(TEAM_METHODS.adminSettingsSet, "without the setting it wrote");
  }
  return readSettingBody(TEAM_METHODS.adminSettingsSet, setting);
}

/** One signing key. */
export interface ListedKey {
  readonly kid: string;
  /** True for a key that is kept but no longer published or used. */
  readonly retired: boolean;
  /** Whether new tokens are signed with this one, which is true of at most one. */
  readonly signing: boolean;
}

/** The keys `admin.keys.list`, `admin.keys.rotate` and `admin.keys.retire` all answer with. */
export function readKeys(method: string, answer: unknown): readonly ListedKey[] {
  const listed = objectOf(answer)["keys"];
  if (!Array.isArray(listed)) {
    throw malformed(method, "without a list of signing keys");
  }
  return listed.map((row: unknown) => {
    const key = objectOf(row);
    const kid = optionalText(key, "kid");
    if (kid === undefined) {
      throw malformed(method, "with a signing key that has no kid");
    }
    return { kid, retired: flag(key, "retired"), signing: flag(key, "signing") };
  });
}

/**
 * What loreserver is, out of a status.
 *
 * `healthy` is read as a flag rather than insisted on, for the reason every
 * other flag here is: an answer that omits it is an answer saying no, and
 * "loreserver did not answer" is what a server says when it did not answer.
 */
function readLoreserver(method: string, value: unknown): TeamAdminLoreserver {
  const lore = objectOf(value);
  const version = optionalText(lore, "version");
  const storageRoot = optionalText(lore, "storageRoot");
  if (version === undefined || storageRoot === undefined) {
    throw malformed(method, "without loreserver's version and where it keeps what it holds");
  }
  const storageBytes = optionalNumber(lore, "storageBytes");
  return {
    version,
    healthy: flag(lore, "healthy"),
    storageRoot,
    // Left out rather than carried as undefined, because the two are different
    // facts on this field: a store that could not be added up has no size, and
    // one written in as undefined is a size somebody would go looking for.
    ...(storageBytes === undefined ? {} : { storageBytes }),
  };
}

/** The addresses out of a status, and the ports that server is holding locally. */
function readReach(method: string, value: unknown): TeamAdminReach {
  const reach = objectOf(value);
  const signIn = optionalText(reach, "signIn");
  const data = optionalText(reach, "data");
  const fingerprint = optionalText(reach, "fingerprint");
  if (signIn === undefined || data === undefined || fingerprint === undefined) {
    throw malformed(method, "without the addresses somebody reaches it at");
  }
  const listed = reach["loopback"];
  if (!Array.isArray(listed)) {
    throw malformed(method, "without the ports it holds on the loopback");
  }
  return {
    signIn,
    data,
    fingerprint,
    loopback: listed.map((row: unknown) => {
      const entry = objectOf(row);
      const port = optionalNumber(entry, "port");
      const what = optionalText(entry, "what");
      if (port === undefined || what === undefined) {
        throw malformed(method, "with a loopback port that has no number or no name");
      }
      return { port, what };
    }),
  };
}

/**
 * What `admin.server.status` answers with, read as the type the server built it.
 *
 * The wire type rather than a shape declared again here, which is the opposite
 * of what the listings above do and is deliberate. A listing is narrowed on the
 * way in, so that a server too old to carry a field and a row that has none read
 * alike. A status is not narrowed at all, because the other half of
 * `nlteam status` produces one of these by running the same collection the
 * server runs, and both are handed to one renderer. Two spellings of this struct
 * would be the two paths agreeing for exactly as long as nobody edited either.
 *
 * Every field the contract calls required is checked. An answer missing one
 * would otherwise be a blank where a version should be, or the word "undefined"
 * in the middle of a description of a server, which is the reading an operator
 * is least able to check.
 */
export function readServerStatus(answer: unknown): TeamAdminStatus {
  const method = TEAM_METHODS.adminServerStatus;
  const status = objectOf(answer);
  const gatheredAt = optionalNumber(status, "gatheredAt");
  const freshnessMs = optionalNumber(status, "freshnessMs");
  const version = optionalText(status, "version");
  const root = optionalText(status, "root");
  if (
    gatheredAt === undefined ||
    freshnessMs === undefined ||
    version === undefined ||
    root === undefined
  ) {
    throw malformed(method, "without its version, its storage root and when it was gathered");
  }
  const accounts = optionalNumber(status, "accounts");
  const projects = optionalNumber(status, "projects");
  const decisions = optionalNumber(status, "decisions");
  const signingKeys = optionalNumber(status, "signingKeys");
  if (
    accounts === undefined ||
    projects === undefined ||
    decisions === undefined ||
    signingKeys === undefined
  ) {
    throw malformed(method, "without the counts of what it holds");
  }
  return {
    gatheredAt,
    freshnessMs,
    version,
    root,
    loreserver: readLoreserver(method, status["loreserver"]),
    reach: readReach(method, status["reach"]),
    accounts,
    projects,
    decisions,
    signingKeys,
  };
}

/** One page of the decisions, and where the next one carries on from. */
export interface ListedDecisionPage {
  readonly decisions: readonly TeamAdminDecision[];
  /** Opaque, and absent when this page is the end of the log. */
  readonly cursor: string | undefined;
}

/**
 * A page of `admin.audit.list`, newest first as the method sends them.
 *
 * The rows are the wire type, for the reason a status is: the other half of
 * `nlteam audit` reads the same rows out of the table beside the server and the
 * two are printed by one function.
 */
export function readDecisionPage(answer: unknown): ListedDecisionPage {
  const method = TEAM_METHODS.adminAuditList;
  const value = objectOf(answer);
  const listed = value["decisions"];
  if (!Array.isArray(listed)) {
    throw malformed(method, "without a list of decisions");
  }
  return {
    decisions: listed.map((row: unknown) => {
      const decision = objectOf(row);
      const id = optionalNumber(decision, "id");
      const at = optionalNumber(decision, "at");
      const username = optionalText(decision, "username");
      const resource = optionalText(decision, "resource");
      const detail = optionalText(decision, "detail");
      if (
        id === undefined ||
        at === undefined ||
        username === undefined ||
        resource === undefined ||
        detail === undefined
      ) {
        throw malformed(method, "with a decision that is missing when, who or about what");
      }
      // Read as a flag, so that an answer which omits it is a refusal rather
      // than an allowance. Of the two ways to be wrong about a decision nobody
      // can check any more, showing a refusal that was an allowance is the one
      // somebody investigates; the other is the one nobody ever sees.
      return { id, at, username, resource, allowed: flag(decision, "allowed"), detail };
    }),
    cursor: optionalText(value, "cursor"),
  };
}
