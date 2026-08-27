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
 */
import type { WriteText } from "./cli.js";
import { describeDuration } from "./duration.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import {
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
  storedPublishLineage,
  storedServerName,
  storedTokenLifetimes,
  type SettingChange,
  type SettingKey,
} from "./identity/settings.js";

import type { DatabaseSync } from "node:sqlite";

export interface SettingsListOptions {
  readonly root: string;
}

export interface SettingsSetOptions {
  readonly root: string;
  /** The setting and its new value, as src/args.ts read them off the line. */
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
 * What answers for the name on a server nobody has named.
 *
 * The host, and this command cannot say which host: the auth origin is named on
 * the command line that starts `up`, not stored here, so a run of `settings
 * list` on a server that is not up has nothing to read it from. Describing it
 * is honest where printing 127.0.0.1 would be a guess, and the column beside it
 * already says the value was nobody's choice.
 */
const THE_SERVERS_HOST = "the server's host";

/** One setting as it stands, in the words somebody would have typed. */
function settingValue(database: DatabaseSync, key: SettingKey): string {
  if (key === SERVER_NAME_KEY) {
    return storedServerName(database, THE_SERVERS_HOST);
  }
  if (key === PUBLISH_LINEAGE_KEY) {
    return storedPublishLineage(database);
  }
  // The duration in the words somebody would have typed, not the seconds
  // the key names: 2592000 is correct and nobody can hold it up against
  // what they set.
  return describeDuration(lifetimeUnder(storedTokenLifetimes(database), key));
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
    const values = SETTING_KEYS.map((key) => settingValue(database, key));
    // Wide enough for the widest value there is, rather than a number chosen
    // for the two durations: a name is as long as somebody made it, and a
    // column that fitted only the old settings would put the last column of one
    // row five characters right of the others.
    const width = Math.max(MINIMUM_VALUE_WIDTH, ...values.map((value) => value.length));
    for (const [index, key] of SETTING_KEYS.entries()) {
      const source = isSettingStored(database, key) ? "set here" : "default";
      stdout(`${key.padEnd(KEY_WIDTH)}  ${(values[index] ?? "").padEnd(width)}  ${source}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Change one setting, and say what it was and what it now is.
 *
 * Both values, because the reason somebody runs this is to make a change and
 * the thing they want to see is the change. The sentence after it is the part
 * that surprises people, and it is a different surprise for each: a shorter
 * lifetime does not shorten a token that has already been minted, and on the
 * repository lifetime it does not shorten a connection either — while a name
 * reaches everything reading this server's address without anything being
 * restarted, which is the thing nobody expects to be true.
 */
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

    if (change.key === SERVER_NAME_KEY) {
      const after = setServerName(database, change.name);
      stdout(`${change.key} is ${after}, and was ${before}\n`);
      stdout(
        "The next client to read this server's address is told the new name; nothing is " +
          "restarted.\n",
      );
      return 0;
    }

    if (change.key === PUBLISH_LINEAGE_KEY) {
      const after = setPublishLineage(database, change.rule);
      stdout(`${change.key} is ${after}, and was ${before}\n`);
      // Said because it is the one thing an operator would otherwise have to
      // find out by watching somebody publish: this is a rule Studio keeps, so
      // it reaches a machine the next time that machine reads this server.
      stdout(
        "Studio reads this with the rest of what this server says about itself, so a machine " +
          "already open picks it up the next time it looks.\n",
      );
      return 0;
    }

    const after = lifetimeUnder(setTokenLifetime(database, change.key, change.seconds), change.key);
    stdout(`${change.key} is ${describeDuration(after)}, and was ${before}\n`);
    stdout("Tokens already minted keep the lifetime they were given.\n");
    if (change.key === REPOSITORY_LIFETIME_KEY) {
      stdout(`${REPOSITORY_LIFETIME_CAUTION}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
