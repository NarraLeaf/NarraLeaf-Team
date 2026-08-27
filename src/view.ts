/**
 * The settings surface, and the two measurements of this server's disk that
 * everything else here is built out of.
 *
 * What a person may change about a running Team server is decided in one place —
 * {@link settingRows} — and so is which row stands for which stored setting.
 * Both a command line and a management panel find a row by its position and
 * write it by its key, and two answers to "which setting is this row" would put
 * a new value in the wrong place the first time a row was added above another.
 *
 * Everything here reads the database or the disk and nothing here waits on the
 * network. What a Team server *is* — whether the server beside it is answering,
 * how much it is holding — is asked for rather than gathered on a schedule, and
 * that lives in src/team/status.ts, which reads the two measurements below.
 *
 * What Team cannot work out is left out, not guessed at.
 */
import { stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describeDuration } from "./duration.js";
import { audienceHosts, hostOf, type IdentityConfig } from "./identity/config.js";
import {
  REPOSITORY_LIFETIME_CAUTION,
  REPOSITORY_LIFETIME_KEY,
  SERVER_NAME_KEY,
  SIGN_IN_LIFETIME_KEY,
  storedServerName,
  storedTokenLifetimes,
  type SettingKey,
} from "./identity/settings.js";
import { instanceLayout } from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import type { SettingView } from "./teamview.js";

import type { DatabaseSync } from "node:sqlite";

/** What the settings surface is read from. */
export interface ViewContext {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  /** The fingerprint of this Team server's authority, absent until one exists. */
  readonly fingerprint: string | undefined;
}

/**
 * How many files a storage measurement will stat before giving up on it.
 *
 * A size is worth having and not worth waiting for: past this the answer is
 * "unknown" rather than holding up whoever asked while it walks a store with
 * half a million objects in it.
 */
const STORAGE_FILE_LIMIT = 50_000;

/**
 * The labels of the three rows Team has somewhere to write.
 *
 * Named here rather than typed twice, because the settings surface finds a row
 * by its position and the writer finds it by its label; two spellings of the
 * same string would put a new value in the wrong place.
 */
export const SERVER_NAME_SETTING = "name";
export const SIGN_IN_SETTING = "sign-in token";
export const REPOSITORY_SETTING = "repository token";

/**
 * The setting one of those labels stands for, or undefined for a row nothing
 * is stored for.
 *
 * The row a person edits is found by its position on the screen and written by
 * its key in the table, and this is the one place the two are put together. A
 * writer that worked it out for itself would be a second answer to "which
 * setting is this row", and the two would disagree the first time a row was
 * added above another.
 */
export function settingKeyOf(label: string): SettingKey | undefined {
  switch (label) {
    case SERVER_NAME_SETTING:
      return SERVER_NAME_KEY;
    case SIGN_IN_SETTING:
      return SIGN_IN_LIFETIME_KEY;
    case REPOSITORY_SETTING:
      return REPOSITORY_LIFETIME_KEY;
    default:
      return undefined;
  }
}

/** The word for a value Team has but cannot show. */
const UNKNOWN_FINGERPRINT = "unknown";

/**
 * Add up what a directory holds.
 *
 * Returns nothing rather than a number it is not sure of: a partial total
 * looks exactly like a real one, and a store that shrank by half would be read
 * as a store that lost half its objects.
 */
export async function directoryBytes(path: string): Promise<number | undefined> {
  try {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length > STORAGE_FILE_LIMIT) {
      return undefined;
    }
    let total = 0;
    for (const file of files) {
      const stats = await stat(join(file.parentPath, file.name));
      total += stats.size;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** The name loreserver's executable has here, which decides none of the paths read below. */
function binaryName(): string {
  try {
    return resolveArtifact().binaryName;
  } catch {
    // A machine with no pinned build still has a storage root, and the name of
    // an executable it will never run is not what this is reading.
    return "loreserver";
  }
}

/** Where loreserver keeps what it holds, under one storage root. */
export function storageRootOf(root: string): string {
  return dirname(instanceLayout(root, binaryName()).immutableStoreDir);
}

/**
 * The settings surface, and the one place that decides what may be changed
 * from it.
 *
 * A row is editable only where Team has somewhere to put the new value. The
 * identity settings and the ports are named on the command line that started
 * `up`, so they are shown and marked read-only: offering to change a value that
 * would be thrown away is worse than refusing, because it looks like it worked.
 */
export function settingRows(context: ViewContext): SettingView[] {
  const lifetimes = storedTokenLifetimes(context.database);
  const storageRoot = storageRootOf(context.root);
  const { config } = context;
  return [
    {
      group: "server",
      label: SERVER_NAME_SETTING,
      // The host until somebody chooses otherwise, which is what the discovery
      // document says too. The row shows what is in effect rather than what is
      // stored, so a server nobody has named reads as the address people
      // already reach it at rather than as a blank.
      value: storedServerName(context.database, hostOf(config.authOrigin)),
      editable: true,
    },
    {
      group: "tokens",
      label: SIGN_IN_SETTING,
      value: describeDuration(lifetimes.signInTokenLifetimeSeconds),
      seconds: lifetimes.signInTokenLifetimeSeconds,
      editable: true,
    },
    {
      group: "tokens",
      label: REPOSITORY_SETTING,
      value: describeDuration(lifetimes.repositoryTokenLifetimeSeconds),
      seconds: lifetimes.repositoryTokenLifetimeSeconds,
      editable: true,
      caution: REPOSITORY_LIFETIME_CAUTION,
    },
    { group: "identity", label: "issuer", value: config.issuer, editable: false },
    { group: "identity", label: "audience", value: config.audience, editable: false },
    {
      group: "identity",
      label: "hostnames",
      value: audienceHosts(config).join(", "),
      editable: false,
    },
    { group: "loreserver", label: "pinned version", value: LORESERVER_VERSION, editable: false },
    {
      group: "loreserver",
      label: "data port",
      value: String(config.dataPort),
      editable: false,
    },
    { group: "loreserver", label: "storage root", value: storageRoot, editable: false },
    {
      group: "authority",
      label: "fingerprint",
      value: context.fingerprint ?? UNKNOWN_FINGERPRINT,
      editable: false,
    },
  ];
}
