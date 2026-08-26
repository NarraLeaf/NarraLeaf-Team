/**
 * The things an operator has this server do.
 *
 * Every one of them is also a command — `nlteam user create`, `nlteam key
 * rotate`, `nlteam settings set` — and nothing here is implemented twice: both
 * reach the same operation underneath, so what a username may be, in what order
 * a project is created and what happens to an account that is disabled are
 * answered in one place.
 *
 * The sentences matter as much as the effects. Each one says how far the thing
 * that just happened reaches — "from their next request", "tokens already
 * minted keep the lifetime they were given" — because that is the part an
 * operator gets wrong, and it is the same wording the command of the same name
 * prints. They come from a catalogue rather than from a literal here, so a
 * caller with somebody to answer can ask for a language; English unless one
 * says otherwise, which is what the commands take.
 */
import { describeDuration } from "./duration.js";
import { en } from "./i18n/en.js";
import { identityConfig } from "./identity/config.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import {
  lifetimeUnder,
  SERVER_NAME_KEY,
  setServerName,
  setTokenLifetimes,
  SIGN_IN_LIFETIME_KEY,
  storedTokenLifetimes,
} from "./identity/settings.js";
import { mintToken } from "./identity/tokens.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import {
  ADMIN_ROLE,
  createUser,
  DEFAULT_ROLE,
  disableUser,
  enableUser,
  requireUser,
  revokeUserTokens,
} from "./identity/users.js";
import {
  createProject,
  forgetProject,
  newProjectId,
} from "./projects/registry.js";
import { loreserverUrl, repositoryCreate } from "./projects/repository.js";
import type { Messages } from "./i18n/messages.js";
import { settingKeyOf, settingRows, type ViewContext } from "./view.js";

import type { DatabaseSync } from "node:sqlite";

/** A duration written as digits and one letter, which every language accepts. */
const WRITTEN_DURATION = /^(\d+)([smhd])?$/;

/** How many seconds each letter is worth. */
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Read a duration the way it was written.
 *
 * A duration is shown in words — "30 days", "30 天", "30日" — so those exact
 * words have to be accepted back, which is why the unit words come from the
 * same catalogue that wrote them. English words and `7d` are accepted whatever
 * the language: `7d` is what every command line here takes, and somebody who
 * knows one spelling should not have to discover the other.
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

/** What is said after somebody's tokens were refused. */
function revokedMessage(
  database: DatabaseSync,
  username: string,
  messages: Messages,
): string {
  const lifetimes = storedTokenLifetimes(database);
  // The same two facts `nlteam user revoke-tokens` prints, for the same reason:
  // "every token" is read as including a session somebody has open, and it
  // does not.
  return messages.action.tokensRevoked({
    username,
    lifetime: describeDuration(lifetimes.repositoryTokenLifetimeSeconds, messages),
  });
}

/**
 * What one of these came to.
 *
 * The sentence is what a caller shows and what the log records. The secret is
 * neither: it is a credential the operation produced once — a token minted for
 * somebody to be handed — and it is answered separately precisely so that the
 * thing which logs the sentence cannot log it by accident.
 */
export interface Performed {
  readonly message: string;
  /**
   * Something to put in front of whoever asked, and nowhere else.
   *
   * Not written to the log, not kept in any view, and not stored anywhere: it
   * is shown once, and a person who missed it asks for another.
   */
  readonly secret?: string;
}

/** An operation that said something and produced nothing to keep. */
function said(message: string): Performed {
  return { message };
}

/** Generate a signing key and sign with it from now on. */
export async function rotateSigningKey(
  context: ViewContext,
  messages: Messages = en,
): Promise<Performed> {
  const keys = await KeyStore.open(identityLayout(context.root).keysDir);
  const key = await keys.rotate();
  return said(messages.action.keyRotated({ kid: key.kid, published: keys.published.length }));
}

/** Stop an account being issued anything new, or let it sign in again. */
export function setUserDisabled(
  context: ViewContext,
  username: string,
  disabled: boolean,
  messages: Messages = en,
): Performed {
  if (disabled) {
    disableUser(context.database, username);
    return said(messages.action.userDisabled({ username }));
  }
  enableUser(context.database, username);
  return said(messages.action.userEnabled({ username }));
}

/** Refuse every token already issued to an account. */
export function revokeTokens(
  context: ViewContext,
  username: string,
  messages: Messages = en,
): Performed {
  revokeUserTokens(context.database, username);
  return said(revokedMessage(context.database, username, messages));
}

/**
 * Change one setting, found by its position on the settings surface, and say
 * what it now is.
 */
export function setSetting(
  context: ViewContext,
  index: number,
  value: string,
  messages: Messages = en,
): Performed {
  const row = settingRows(context)[index];
  const key = row === undefined ? undefined : settingKeyOf(row.label);
  if (row === undefined || !row.editable || key === undefined) {
    return said(messages.action.settingReadOnly);
  }

  // Named by the label the view carries, which is what it was found by.
  const label = row.label;

  // Not every setting is a duration. The name is stored as it was typed, and
  // reading it as one would refuse every name that is not a number.
  if (key === SERVER_NAME_KEY) {
    return said(
      messages.action.settingChanged({
        label,
        value: setServerName(context.database, value),
      }),
    );
  }

  const seconds = readDuration(value, messages);
  if (typeof seconds === "string") {
    return said(seconds);
  }
  const lifetimes = setTokenLifetimes(
    context.database,
    key === SIGN_IN_LIFETIME_KEY
      ? { signInTokenLifetimeSeconds: seconds }
      : { repositoryTokenLifetimeSeconds: seconds },
  );
  return said(
    messages.action.settingChanged({
      label,
      value: describeDuration(lifetimeUnder(lifetimes, key), messages),
    }),
  );
}

/** What an account is made from. */
export interface NewAccount {
  readonly username: string;
  /**
   * Hashed and forgotten inside this call.
   *
   * An account is created with one and there is nowhere else it could be.
   * Nothing keeps it and nothing writes it down.
   */
  readonly password: string;
  readonly displayName?: string;
  readonly email?: string;
  /** Whether it joins the admin group rather than the default one. */
  readonly operator: boolean;
}

/** Make an account, the way `nlteam user create` makes one. */
export async function createAccount(
  context: ViewContext,
  account: NewAccount,
  messages: Messages = en,
): Promise<Performed> {
  // The same call `nlteam user create` makes, with the same hasher, so that
  // what a username may be, which group is the default and what happens to a
  // name already taken are answered once for both.
  const user = await createUser(context.database, defaultPasswordHasher(), {
    username: account.username,
    password: account.password,
    ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
    ...(account.email === undefined ? {} : { email: account.email }),
    groups: [account.operator ? ADMIN_ROLE : DEFAULT_ROLE],
  });
  // The same thing the command says last, for the same reason: an account
  // nobody was given a token for reaches nothing, and that is the step it is
  // easiest to stop one short of.
  return said(
    messages.action.accountCreated({
      username: user.username,
      group: user.groups.join(", "),
    }),
  );
}

/** Mint a sign-in token for an account, to be handed to the person. */
export async function issueToken(
  context: ViewContext,
  username: string,
  messages: Messages = en,
): Promise<Performed> {
  // What `nlteam token mint` mints, minus the password: whoever asked for this
  // has already proved who they are, and somebody who can disable the account
  // can hardly be stopped from issuing it a token.
  const user = requireUser(context.database, username);
  const keys = await KeyStore.open(identityLayout(context.root).keysDir);
  const config = identityConfig({
    ...context.config,
    ...storedTokenLifetimes(context.database),
  });
  const minted = mintToken(user, keys.signingKey, config, {
    purpose: "sign-in",
    // The claim that lets the machine this is pasted into decide whether to
    // trust this server, on a token that is about to leave the building.
    ...(context.fingerprint === undefined ? {} : { authorityFingerprint: context.fingerprint }),
  });
  return {
    message: messages.action.tokenIssued({
      username: user.username,
      lifetime: describeDuration(config.signInTokenLifetimeSeconds, messages),
    }),
    // Beside the sentence rather than inside it, so that what is logged and
    // what is shown are two different strings.
    secret: minted.token,
  };
}

/** Create a repository and record who it belongs to. */
export async function createProjectWithRepository(
  context: ViewContext,
  project: { readonly name: string; readonly owner: string },
  messages: Messages = en,
): Promise<Performed> {
  const { database } = context;
  // The same sequence `project create` runs, and for the same reason it runs it
  // in that order: the row is written first so that a repository is never made
  // without something recording who it belongs to, and it is withdrawn again if
  // loreserver refuses, so a failure leaves nothing.
  const owner = requireUser(database, project.owner);
  const keys = await KeyStore.open(identityLayout(context.root).keysDir);
  const config = identityConfig({ ...context.config, ...storedTokenLifetimes(database) });
  const minted = mintToken(owner, keys.signingKey, config, { purpose: "repository" });
  const record = createProject(database, {
    id: newProjectId(),
    name: project.name,
    createdBy: owner.id,
  });
  try {
    await repositoryCreate({
      url: loreserverUrl(config.dataPort),
      token: minted.token,
      id: record.id,
      name: record.name,
      description: record.description,
    });
  } catch (error) {
    forgetProject(database, record.id);
    throw error;
  }
  return said(
    messages.action.projectCreated({
      project: record.name,
      owner: owner.username,
    }),
  );
}
