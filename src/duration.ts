/**
 * Writing a duration the way somebody would say it.
 *
 * Every duration Team prints to a person is a setting they may have chosen, so
 * it has to come out in the unit they would have chosen it in. Minutes were
 * right while there was one token lifetime and it was fifteen of them, and
 * wrong the moment there was one of thirty days: the same arithmetic renders
 * that as 43200 minutes, which is correct and which nobody can compare with
 * what they set.
 *
 * The arithmetic is the same in every language; only the words differ, so the
 * words come from a catalogue and the choosing of the unit stays here. English
 * unless a caller says otherwise, because everything this program says of its
 * own accord — the commands, the log — is English.
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
