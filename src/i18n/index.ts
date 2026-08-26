/**
 * One way in: give it a locale, get the language.
 *
 * Every catalogue is bundled rather than read from disk, which is the only
 * thing it could be — the executable carries its own version number for the
 * same reason, and a language it had to find on disk would be the one thing
 * about it that could go missing once it had been copied somewhere.
 */
import { en } from "./en.js";
import { ja } from "./ja.js";
import type { Messages } from "./messages.js";
import { FALLBACK_LOCALE, type Locale } from "./locales.js";
import { zh } from "./zh.js";

const CATALOGUES: Readonly<Record<Locale, Messages>> = { en, zh, ja };

/** The language of a locale, or English when it names none. */
export function messagesFor(locale: Locale | undefined): Messages {
  return CATALOGUES[locale ?? FALLBACK_LOCALE];
}

/** Every language, in the order a switcher lists them. */
export function everyLanguage(): readonly Messages[] {
  return [en, zh, ja];
}

export { en, zh, ja };
export type { Messages, DurationUnit } from "./messages.js";
export { FALLBACK_LOCALE, isLocale, localeOfTag, LOCALES, type Locale } from "./locales.js";
