/**
 * The languages Team is written in, and how one is named.
 *
 * Three, and English is the one everything falls back to. It is not a default
 * in the sense of being preferred: it is the language the rest of this program
 * speaks — the commands, every sentence in the log — so it is the one thing a
 * sentence can always be said in, whatever a caller asks for and whatever a
 * catalogue is missing.
 *
 * Nothing here reads a file or a header; a list and a comparison is all it is.
 */

/** The languages there is a catalogue for. */
export type Locale = "en" | "zh" | "ja";

/** Every locale, in the order a chooser would list them. */
export const LOCALES: readonly Locale[] = ["en", "zh", "ja"];

/** The one everything falls back to, and the one the rest of Team speaks. */
export const FALLBACK_LOCALE: Locale = "en";

/** Whether some text names a language Team has. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale a language tag asks for, if it is one of ours.
 *
 * Only the primary subtag is compared, so `zh-Hans-CN`, `zh-TW` and `zh` all
 * reach the same catalogue. That is a decision rather than a shortcut: Team has
 * one Chinese, written in simplified characters, and pretending to tell `zh-TW`
 * apart from `zh-CN` while answering both with the same words would be a
 * promise it does not keep.
 */
export function localeOfTag(tag: string): Locale | undefined {
  const primary = tag.trim().toLowerCase().split("-")[0];
  return isLocale(primary) ? primary : undefined;
}
