/**
 * The `settings` commands: show what this Team server keeps in its database, and change
 * one of them.
 *
 * What is shown is what is in effect, which is not the same as what is stored:
 * a setting nobody has chosen has no row at all and something else answers for
 * it, so the listing says which of the two each value is. Changing one reaches
 * a Team that is already running, because every setting is read where it is
 * used — a lifetime as each token is minted, the name as each discovery
 * document is answered — rather than held from the moment `up` started.
 *
 * Both verbs have two paths and one output, and this is the one place where the
 * protocol carries less than the disk does. `admin.settings.list` says what
 * every setting is; it does not say whether a value was chosen here or is the
 * default answering for a setting nobody has touched. So over the protocol that
 * last column is **blank** rather than filled in with a guess: a row that said
 * "default" because this program could not tell would be a claim about what
 * happens when a later version of Team moves the default, and that is exactly
 * the fact the column exists to carry.
 *
 * The rows themselves are the three settings a person may change, on both paths.
 * The server's surface has seven more on it — the issuer, the ports, the
 * authority's fingerprint — which it marks read-only and shows for a panel to
 * draw. They are left out here rather than shown on one path only, because a
 * listing that grew seven rows the moment you passed `--server` would be the two
 * halves of this command disagreeing about what `settings list` means.
 */
import { TEAM_METHODS } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readSetting, readSettings, type ListedSetting } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { describeDuration } from "./duration.js";
import { hostOf } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import {
  isLifetimeKey,
  storedIdentity,
  isSettingStored,
  lifetimeUnder,
  REPOSITORY_LIFETIME_CAUTION,
  REPOSITORY_LIFETIME_KEY,
  SERVER_NAME_KEY,
  setServerName,
  setTokenLifetime,
  SETTING_KEYS,
  storedServerName,
  storedTokenLifetimes,
  type SettingChange,
  type SettingKey,
} from "./identity/settings.js";
import { settingKeyOf } from "./view.js";

import type { DatabaseSync } from "node:sqlite";

export interface SettingsListOptions {
  readonly root: string;
}

export interface SettingsSetOptions {
  readonly root: string;
  /** The setting and its new value, as src/args.ts read them off the line. */
  readonly change: SettingChange;
}

export interface SettingsListOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
}

export interface SettingsSetOnServerOptions {
  readonly server: string;
  /** The same change the other path makes, read off the line by the same parser. */
  readonly change: SettingChange;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The widest key, so the values line up under each other. */
const KEY_WIDTH = Math.max(...SETTING_KEYS.map((key) => key.length));

/** How wide the value column is even where every value is short. */
const MINIMUM_VALUE_WIDTH = 12;

/**
 * What answers for the name on a server nobody has named and nobody has started.
 *
 * The host, described rather than printed, because there is no host to print:
 * the auth origin is written into the database by `up`, and a storage root that
 * has never had `up` run against it holds none. Describing it is honest where
 * printing 127.0.0.1 would be a guess, and the column beside it already says the
 * value was nobody's choice.
 *
 * A server that is answering a session has necessarily been started, so this is
 * the one row where the two paths can differ — and only on a storage root the
 * other path could not have reached at all.
 */
const THE_SERVERS_HOST = "the server's host";

/** One setting as it stands, in the words somebody would have typed. */
function settingValue(database: DatabaseSync, key: SettingKey): string {
  if (key === SERVER_NAME_KEY) {
    // The host this deployment was brought up as, which `up` writes and every
    // command that mints a token already reads — the same host the discovery
    // document names and the same one this server's own settings surface falls
    // back to. It was described rather than read while nothing stored it.
    const origin = storedIdentity(database).authOrigin;
    return storedServerName(database, origin === undefined ? THE_SERVERS_HOST : hostOf(origin));
  }
  // The duration in the words somebody would have typed, not the seconds
  // the key names: 2592000 is correct and nobody can hold it up against
  // what they set.
  return describeDuration(lifetimeUnder(storedTokenLifetimes(database), key));
}

/** One setting on its way to a terminal, whichever path read it. */
interface SettingRow {
  readonly key: SettingKey;
  readonly value: string;
  /**
   * Whether somebody chose this value or a default is answering for it.
   *
   * Undefined on the path that cannot tell, which leaves the column blank. See
   * the note at the top of this file for why blank and not a guess.
   */
  readonly source: string | undefined;
}

/** The settings, laid out the same way whichever path read them. */
function renderSettings(rows: readonly SettingRow[], stdout: WriteText): void {
  // Wide enough for the widest value there is, rather than a number chosen
  // for the two durations: a name is as long as somebody made it, and a
  // column that fitted only the old settings would put the last column of one
  // row five characters right of the others.
  const width = Math.max(MINIMUM_VALUE_WIDTH, ...rows.map((row) => row.value.length));
  for (const row of rows) {
    const line = `${row.key.padEnd(KEY_WIDTH)}  ${row.value.padEnd(width)}  ${row.source ?? ""}`;
    stdout(`${line.trimEnd()}\n`);
  }
}

/** Print every setting, its value, and where that value came from. */
export async function settingsList(
  options: SettingsListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    renderSettings(
      SETTING_KEYS.map((key) => ({
        key,
        value: settingValue(database, key),
        source: isSettingStored(database, key) ? "set here" : "default",
      })),
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * The value one row of a server's settings surface stands for.
 *
 * A lifetime is rewritten from the number the row carries beside its words
 * rather than printed as the words arrived, and by the same function the other
 * path writes them with: the number is a fact and the words are that server's,
 * so a build answering in another language still reads as this command line
 * writes. Everything else is taken as it came, because there is nothing behind
 * it to rewrite from.
 */
function valueOfListed(key: SettingKey, row: ListedSetting): string {
  return isLifetimeKey(key) && row.seconds !== undefined
    ? describeDuration(row.seconds)
    : row.value;
}

/**
 * The row on a server's settings surface that stands for one stored setting.
 *
 * Found by asking {@link settingKeyOf} what each label means rather than by
 * matching a label this file spells out again. That function is the one place
 * the caption a person reads and the key a value is written under are put
 * together, and a second answer here would put an edit on the wrong row the
 * first time a row was renamed.
 */
function rowFor(
  settings: readonly ListedSetting[],
  key: SettingKey,
): ListedSetting | undefined {
  return settings.find((setting) => settingKeyOf(setting.label) === key);
}

/**
 * Every setting, asked for over a session.
 *
 * The three a person may change, in the order the other path prints them, with
 * the source column left blank because this answer does not carry it.
 */
export async function settingsListOverProtocol(
  options: SettingsListOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const settings = await withSession(
      options.server,
      async (session) => readSettings(await session.call(TEAM_METHODS.adminSettingsList)),
    );
    const rows: SettingRow[] = [];
    for (const key of SETTING_KEYS) {
      const row = rowFor(settings, key);
      if (row === undefined) {
        throw new Error(
          `that server answered ${TEAM_METHODS.adminSettingsList} without a row for ${key}`,
        );
      }
      rows.push({ key, value: valueOfListed(key, row), source: undefined });
    }
    renderSettings(rows, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * What a change looks like, written once for both paths.
 *
 * Both values, because the reason somebody runs this is to make a change and
 * the thing they want to see is the change. The sentence after it is the part
 * that surprises people, and it is a different surprise for each: a shorter
 * lifetime does not shorten a token that has already been minted, and on the
 * repository lifetime it does not shorten a connection either — while a name
 * reaches everything reading this server's address without anything being
 * restarted, which is the thing nobody expects to be true.
 */
function renderSettingChange(
  key: SettingKey,
  before: string,
  after: string,
  stdout: WriteText,
): void {
  stdout(`${key} is ${after}, and was ${before}\n`);
  if (key === SERVER_NAME_KEY) {
    stdout(
      "The next client to read this server's address is told the new name; nothing is " +
        "restarted.\n",
    );
    return;
  }
  stdout("Tokens already minted keep the lifetime they were given.\n");
  if (key === REPOSITORY_LIFETIME_KEY) {
    stdout(`${REPOSITORY_LIFETIME_CAUTION}\n`);
  }
}

/** Change one setting in the database beside the server, and say what changed. */
export async function settingsSet(
  options: SettingsSetOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  const { change } = options;
  try {
    const before = settingValue(database, change.key);
    const after =
      change.key === SERVER_NAME_KEY
        ? setServerName(database, change.name)
        : describeDuration(
            lifetimeUnder(setTokenLifetime(database, change.key, change.seconds), change.key),
          );
    renderSettingChange(change.key, before, after, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Change one setting on a server, and say what changed.
 *
 * Two calls rather than one, because `admin.settings.set` answers with the row
 * as it now stands and this command prints what it was as well. The list is
 * read first — which also settles which label stands for the key that was named
 * on the line, and refuses a caller who may not administer this server before
 * anything is written.
 *
 * What is sent is the seconds rather than the words for a lifetime. The method
 * takes either, and the number is the one form that cannot be misread by a
 * server whose words for a duration are not this one's.
 */
export async function settingsSetOverProtocol(
  options: SettingsSetOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const { change } = options;
  try {
    const { before, after } = await withSession(options.server, async (session) => {
      const settings = readSettings(await session.call(TEAM_METHODS.adminSettingsList));
      const row = rowFor(settings, change.key);
      if (row === undefined) {
        throw new Error(
          `that server has no setting this ${change.key} could be written to. It may be older ` +
            "than this nlteam.",
        );
      }
      const written = readSetting(
        await session.call(TEAM_METHODS.adminSettingsSet, {
          label: row.label,
          value: change.key === SERVER_NAME_KEY ? change.name : String(change.seconds),
        }),
      );
      return {
        before: valueOfListed(change.key, row),
        after: valueOfListed(change.key, written),
      };
    });
    renderSettingChange(change.key, before, after, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
