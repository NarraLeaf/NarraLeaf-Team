/**
 * English, and the wording every other language is a translation of.
 *
 * These are the sentences Team already said. They are not rewritten here to fit
 * a catalogue: `nlteam user revoke-tokens` prints the same two facts in the same
 * order, and a sentence that drifted from the command's would be a second
 * account of what Team does. When one of these has to change, it changes with
 * the command it belongs to.
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

  action: {
    keyRotated: ({ kid, published }) =>
      `signing with ${kid}; tokens signed by any of the ${published} published keys still verify`,
    userDisabled: ({ username }) =>
      `disabled ${username}; nothing new is issued and tokens already issued are refused from now on`,
    userEnabled: ({ username }) => `enabled ${username}`,
    tokensRevoked: ({ username, lifetime }) =>
      `revoked the tokens of ${username}; a connection already open may last until its ` +
      `repository token expires, at most ${lifetime} from now`,
    settingReadOnly: "that row is read only",
    settingChanged: ({ label, value }) =>
      `${label} is ${value}; tokens already minted keep the lifetime they were given`,
    accountCreated: ({ username, group }) =>
      `created ${username} in ${group}; issue a token for them to sign in with`,
    tokenIssued: ({ username, lifetime }) =>
      `a sign-in token for ${username}, good for ${lifetime}`,
    projectCreated: ({ project, owner }) => `created ${project}, owned by ${owner}`,
  },

  error: {
    notADuration: ({ value }) => `"${value}" is not a duration. Write it as 30 minutes, 48 hours or 7 days.`,
    durationTooSmall: "a lifetime must be more than zero",
  },
};
