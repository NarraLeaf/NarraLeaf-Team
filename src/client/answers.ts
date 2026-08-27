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
import { TEAM_METHODS } from "@narraleaf/team-protocol";

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

/** The keys `admin.keys.list` and `admin.keys.rotate` both answer with. */
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
