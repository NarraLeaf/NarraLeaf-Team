/**
 * Everything Team says to a person, as a shape a language has to fill in.
 *
 * There is no lookup by string key here and no template syntax. A message is a
 * field, and one that needs a value is a function of exactly the values it
 * needs, so a catalogue that is missing a message or that forgot a name inside
 * one does not compile. The alternative — `t("action.granted", {...})` — moves
 * every one of those mistakes to the moment somebody in Tokyo reads it.
 *
 * What is **not** here is anything the server recorded rather than said: a
 * username, a project's name, the `detail` of a decision the authorization
 * service wrote down, the name of a group. Those are data. Translating them
 * would mean saying something the database does not hold.
 */
import type { Locale } from "./locales.js";

/** The units a duration is written in. */
export type DurationUnit = "day" | "hour" | "minute" | "second";

/** Turning a length of time into words. */
export interface FormatMessages {
  /** `30 days`, `30 天`, `30日`. */
  readonly duration: (amount: number, unit: DurationUnit) => string;
  /**
   * The words this language writes a duration with, and what each one means.
   *
   * Read back rather than only written: a duration is shown in words, so those
   * exact words have to be accepted when somebody hands one back. Every locale
   * also accepts `7d`, which is what the command line takes.
   *
   * Longest first, so that a language whose word for an hour contains its word
   * for a day cannot have the shorter one matched inside the longer.
   */
  readonly durationWords: ReadonlyArray<readonly [string, "d" | "h" | "m" | "s"]>;
}

/** What an action answers with, once it has happened. */
export interface ActionMessages {
  readonly keyRotated: (fields: { readonly kid: string; readonly published: number }) => string;
  readonly userDisabled: (fields: { readonly username: string }) => string;
  readonly userEnabled: (fields: { readonly username: string }) => string;
  readonly tokensRevoked: (fields: {
    readonly username: string;
    readonly lifetime: string;
  }) => string;
  readonly settingReadOnly: string;
  readonly settingChanged: (fields: {
    readonly label: string;
    readonly value: string;
  }) => string;
  readonly accountCreated: (fields: {
    readonly username: string;
    readonly group: string;
  }) => string;
  readonly tokenIssued: (fields: {
    readonly username: string;
    readonly lifetime: string;
  }) => string;
  readonly projectCreated: (fields: {
    readonly project: string;
    readonly owner: string;
  }) => string;
}

/** What went wrong, where somebody wrote a value this could not read. */
export interface ErrorMessages {
  readonly notADuration: (fields: { readonly value: string }) => string;
  readonly durationTooSmall: string;
}

/** One language, whole. */
export interface Messages {
  readonly locale: Locale;
  /** What this language calls itself, which is what a switcher has to show. */
  readonly name: string;
  readonly format: FormatMessages;
  readonly action: ActionMessages;
  readonly error: ErrorMessages;
}
