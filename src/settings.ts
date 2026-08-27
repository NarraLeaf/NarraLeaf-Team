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
 * Both verbs have two paths and one output, this listing's third column
 * included. `admin.settings.list` carries `stored` beside each value it can be
 * asked about, so a server answers the same question the disk does: was this
 * chosen, or is a default answering for a setting nobody has touched. The
 * column is only ever **blank** for a server too old to say — which is a blank
 * meaning "not said", where either word would be a claim about what happens
 * when a later version of Team moves the default.
 *
 * The rows themselves are the four settings a person may change, on both paths.
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
  PUBLISH_LINEAGE_KEY,
  REPOSITORY_LIFETIME_CAUTION,
  REPOSITORY_LIFETIME_KEY,
  SERVER_NAME_KEY,
  setPublishLineage,
  setServerName,
  setTokenLifetime,
  SETTING_KEYS,
  SIGN_IN_LIFETIME_KEY,
  storedPublishLineage,
  storedServerName,
  storedTokenLifetimes,
  type LifetimeKey,
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

/**
 * One setting as it stands, in the words somebody would have typed.
 *
 * A branch per kind of setting and a refusal for a key that has none, which is
 * the shape `admin.settings.set` is written to and the shape everything here
 * that reads or writes one keeps. The settings are not all of a kind — a name,
 * a word out of a closed set, a duration — and a fall-through would read a new
 * one as a duration: `lifetimeUnder` answers with the repository lifetime for
 * any key that is not the sign-in one, so a setting added to this server and
 * not to this function would print a plausible wrong number rather than say
 * anything was amiss.
 *
 * The last branch is unreachable while the union is what it is, and the type
 * checker says so. It is written out anyway because the type checker is not who
 * this has to be legible to, and because the failure it stands in the way of is
 * a value nobody can tell is wrong.
 */
function settingValue(database: DatabaseSync, key: SettingKey): string {
  switch (key) {
    case SERVER_NAME_KEY: {
      // The host this deployment was brought up as, which `up` writes and every
      // command that mints a token already reads — the same host the discovery
      // document names and the same one this server's own settings surface falls
      // back to. It was described rather than read while nothing stored it.
      const origin = storedIdentity(database).authOrigin;
      return storedServerName(database, origin === undefined ? THE_SERVERS_HOST : hostOf(origin));
    }
    case PUBLISH_LINEAGE_KEY:
      return storedPublishLineage(database);
    case SIGN_IN_LIFETIME_KEY:
    case REPOSITORY_LIFETIME_KEY:
      // The duration in the words somebody would have typed, not the seconds
      // the key names: 2592000 is correct and nobody can hold it up against
      // what they set.
      return describeDuration(lifetimeUnder(storedTokenLifetimes(database), key));
    default: {
      // `key` is `never` here, which is the type checker saying the branches
      // above cover every setting there is today. The cast is what lets this
      // sentence name the one they do not, on the day there is one.
      const unreadable = key as SettingKey;
      throw new Error(`this nlteam lists the ${unreadable} setting but cannot read it`);
    }
  }
}

/** One setting on its way to a terminal, whichever path read it. */
interface SettingRow {
  readonly key: SettingKey;
  readonly value: string;
  /**
   * Whether somebody chose this value or a default is answering for it.
   *
   * Undefined where nothing said, which leaves the column blank. See the note
   * at the top of this file for why blank and not a guess.
   */
  readonly source: string | undefined;
}

/**
 * The word that column carries, written once so both paths write the same one.
 *
 * Undefined in, undefined out: only a server too old to carry the fact answers
 * without it, and a blank is the honest thing to print for a question nothing
 * answered.
 */
function describeSource(stored: boolean | undefined): string | undefined {
  if (stored === undefined) {
    return undefined;
  }
  return stored ? "set here" : "default";
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
        source: describeSource(isSettingStored(database, key)),
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
 * The ones a person may change, in the order the other path prints them, and
 * with the same third column: a row carries whether its value was chosen, so
 * this prints the word rather than leaving a gap where the other path has one.
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
      rows.push({ key, value: valueOfListed(key, row), source: describeSource(row.stored) });
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
  if (key === PUBLISH_LINEAGE_KEY) {
    // Said because it is the one thing an operator would otherwise have to
    // find out by watching somebody publish: this is a rule Studio keeps, so
    // it reaches a machine the next time that machine reads this server.
    stdout(
      "Studio reads this with the rest of what this server says about itself, so a machine " +
        "already open picks it up the next time it looks.\n",
    );
    return;
  }
  // Not a fall-through but the last kind there is, and this line is what makes
  // the type checker say so: a setting added with no sentence of its own here
  // would refuse to compile rather than be told something untrue about tokens.
  const lifetime: LifetimeKey = key;
  stdout("Tokens already minted keep the lifetime they were given.\n");
  if (lifetime === REPOSITORY_LIFETIME_KEY) {
    stdout(`${REPOSITORY_LIFETIME_CAUTION}\n`);
  }
}

/**
 * Write one setting into the database beside the server, and answer with what
 * it now is in the words this command prints.
 *
 * A branch per kind of setting, and a refusal for a change this program cannot
 * write, which is the shape {@link settingValue} reads with and the shape
 * `admin.settings.set` writes with on the other path. A fall-through would send
 * a new setting to `setTokenLifetime`, and what an operator would then be told
 * is that their value was not a whole number of seconds — which reads as their
 * value being wrong rather than as this program not knowing what to do with the
 * setting it just offered them.
 */
function writtenValue(database: DatabaseSync, change: SettingChange): string {
  switch (change.key) {
    case SERVER_NAME_KEY:
      return setServerName(database, change.name);
    case PUBLISH_LINEAGE_KEY:
      return setPublishLineage(database, change.rule);
    case SIGN_IN_LIFETIME_KEY:
    case REPOSITORY_LIFETIME_KEY:
      return describeDuration(
        lifetimeUnder(setTokenLifetime(database, change.key, change.seconds), change.key),
      );
    default: {
      // `change` is `never` here, which is the type checker saying the branches
      // above cover every kind of setting there is today. The cast is what lets
      // this sentence name the setting on the day they no longer do.
      const unwritable = change as SettingChange;
      throw new Error(`this nlteam offers the ${unwritable.key} setting but cannot write it`);
    }
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
    const after = writtenValue(database, change);
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
 * The text one change is sent as, which is a different kind of thing for each
 * kind of setting: a name as it was typed, one word out of a closed set, or a
 * count of seconds.
 *
 * A branch apiece and a refusal for a change that has none, for
 * {@link writtenValue}'s reason. A fall-through here sends `undefined` written
 * out as a word, and the server refuses it as a value that is not what that
 * setting takes — a refusal about the operator's typing, arriving from a
 * machine they have no way to look at, over a mistake that is entirely this
 * program's.
 */
function sentValue(change: SettingChange): string {
  switch (change.key) {
    case SERVER_NAME_KEY:
      return change.name;
    case PUBLISH_LINEAGE_KEY:
      return change.rule;
    case SIGN_IN_LIFETIME_KEY:
    case REPOSITORY_LIFETIME_KEY:
      return String(change.seconds);
    default: {
      // Cast for the reason the same branch in {@link writtenValue} is.
      const unsendable = change as SettingChange;
      throw new Error(`this nlteam cannot say what it would write to ${unsendable.key}`);
    }
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
          value: sentValue(change),
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
