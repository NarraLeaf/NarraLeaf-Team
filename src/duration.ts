/**
 * Writing a duration the way somebody would say it, and reading back what was
 * written.
 *
 * Every duration Team prints to a person is a setting they may have chosen, so
 * it has to come out in the unit they would have chosen it in. Minutes were
 * right while there was one token lifetime and it was fifteen of them, and
 * wrong the moment there was one of thirty days: the same arithmetic renders
 * that as 43200 minutes, which is correct and which nobody can compare with
 * what they set.
 *
 * The two directions are here together because they are one bargain rather than
 * two functions that happen to be about time: what a person is shown is what
 * the editor opens on, so every string {@link describeDuration} writes has to be
 * a string {@link readDuration} takes. A test walks every language proving it.
 *
 * The arithmetic is the same in every language; only the words differ, so the
 * words come from a catalogue and the choosing of the unit stays here. English
 * unless a caller says otherwise, because everything this program says of its
 * own accord — the commands, the log, the protocol — is English.
 */
import { en } from "./i18n/en.js";

import type { DurationUnit, Messages } from "./i18n/messages.js";

/** The units a duration is written in, largest first. */
const UNITS: readonly (readonly [DurationUnit, number])[] = [
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/**
 * `seconds` in the largest unit it divides into exactly.
 *
 * Exactly, rather than rounded to the nearest: an hour and a half is 90
 * minutes here and not "2 hours", because the reader may be holding it up
 * against a number they typed.
 */
export function describeDuration(seconds: number, messages: Messages = en): string {
  for (const [unit, size] of UNITS) {
    if (seconds >= size && seconds % size === 0) {
      return messages.format.duration(seconds / size, unit);
    }
  }
  return messages.format.duration(seconds, "second");
}

/** A duration written as digits and one letter, which every language accepts. */
const WRITTEN_DURATION = /^(\d+)([smhd])?$/;

/** How many seconds each letter is worth. */
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Read a duration the way it was written, or say why it could not be.
 *
 * A duration is shown in words — "30 days", "30 天", "30日" — so those exact
 * words have to be accepted back, which is why the unit words come from the
 * same catalogue that wrote them. English words and `7d` are accepted whatever
 * the language: `7d` is what every command line here takes, and somebody who
 * knows one spelling should not have to discover the other. Bare digits are
 * seconds, which is what a client sending back the number a settings row
 * carries beside its words is sending.
 *
 * A refusal comes back as the sentence rather than as a throw, because both
 * callers have somebody to show it to and neither has anything else to do with
 * it.
 */
export function readDuration(text: string, messages: Messages = en): number | string {
  const written = stripUnitWords(text.trim().toLowerCase(), messages);
  const match = WRITTEN_DURATION.exec(written);
  if (match?.[1] === undefined) {
    return messages.error.notADuration({ value: text.trim() });
  }
  const amount = Number(match[1]);
  if (amount < 1) {
    return messages.error.durationTooSmall;
  }
  return amount * (UNIT_SECONDS[match[2] ?? "s"] ?? 1);
}

/**
 * Turn whatever unit was written into its letter, and drop the spaces.
 *
 * This language's words are tried before English's, so that a language whose
 * word for something happens to contain an English one cannot be read as the
 * English. Within each, longest first, for the same reason.
 */
function stripUnitWords(text: string, messages: Messages): string {
  for (const [word, letter] of [...messages.format.durationWords, ...en.format.durationWords]) {
    if (text.endsWith(word)) {
      return `${text.slice(0, -word.length).trim()}${letter}`.replace(/\s+/g, "");
    }
  }
  return text.replace(/\s+/g, "");
}
