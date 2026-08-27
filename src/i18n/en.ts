/**
 * English, and the wording every other language is a translation of.
 *
 * What is here is small on purpose. A sentence earns a place in a catalogue
 * only where the same sentence has to reach a person in whatever language they
 * read, and the durations are that: a lifetime is shown to somebody in words,
 * so those words are what they type back, and a refusal to read one has to say
 * so in the language it was written in. Everything else this server says of its
 * own accord — a command's output, a line in the log, a refusal on the wire —
 * is English, because it is read by whoever is running the server or by a client
 * that writes the person's sentence itself.
 */
import type { Messages } from "./messages.js";

export const en: Messages = {
  locale: "en",
  name: "English",

  format: {
    duration: (amount, unit) => `${amount} ${unit}${amount === 1 ? "" : "s"}`,
    durationWords: [
      ["days", "d"],
      ["day", "d"],
      ["hours", "h"],
      ["hour", "h"],
      ["minutes", "m"],
      ["minute", "m"],
      ["seconds", "s"],
      ["second", "s"],
    ],
  },

  error: {
    notADuration: ({ value }) => `"${value}" is not a duration. Write it as 30 minutes, 48 hours or 7 days.`,
    durationTooSmall: "a lifetime must be more than zero",
  },
};
