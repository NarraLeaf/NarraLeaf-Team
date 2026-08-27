/**
 * This server's own state, read and changed by whoever administers it.
 *
 * Everything here answers a question about the server rather than about a
 * project: who has an account on it, what it is set to, what it signs with,
 * what it has been asked, and whether the server beside it is answering. Before
 * these existed the only way to ask any of them was to open the database with a
 * command line on the machine the server runs on, which is a thing exactly one
 * person can do and only while sitting somewhere particular.
 *
 * **The gate is on every call, not at sign-in.** Every handler below reads the
 * caller's groups as the call arrives — see {@link administered} — because the
 * whole of this server's claim about revocation is that it takes effect at once
 * rather than at expiry. A session that decided once, when it opened, whether
 * its account could administer would leave an account demoted an hour ago still
 * administering until it happened to reconnect, and that is the one place the
 * claim would be untrue.
 *
 * **The capability is announced to everybody, including the people it refuses.**
 * That is not an oversight, and it is worth saying because it reads like one.
 * `capabilities` is a statement about the build — it says this server can be
 * administered over the socket, so that a client knows the methods exist before
 * it calls one. Whether *this* caller may administer is a different question,
 * and it is already answered in the same `hello` frame by `account.operator`.
 * A client draws a management surface from the two together: the capability
 * says the surface can exist here, the account says whether to draw it. Hiding
 * the capability would fold two facts into one and give a client no way to tell
 * "this server is too old to be administered over the socket" from "you are not
 * an operator" — which are different sentences to show a person, and only one of
 * them is about them.
 *
 * **Every write answers with the record it changed**, never with an
 * acknowledgement: the account as {@link adminUserBody} builds it, the setting
 * as the settings list carries it, the keys as the key list carries them. A
 * panel that has just changed a row wants that row, and a bare `{}` would send
 * every one of them back to re-read a page to find out what it had just done.
 *
 * **Nothing here is done twice.** Every write takes an optional `clientId` and
 * is keyed by the account, the method and that id together — see
 * src/identity/writes.ts, which says why the method is part of the key. And a
 * write that changed nothing announces nothing: enabling an account that is
 * already enabled is the state the caller asked for, so it is answered and not
 * published, exactly as `projects.create` answers a repeat.
 *
 * The operations themselves are the ones the command line makes, called here
 * rather than written a second time, so that what a username may be and what
 * happens to a disabled account are answered in one place for both.
 */
import { pageDecisions } from "../../identity/audit.js";
import { adminUserBody } from "../../identity/answers.js";
import type { KeyStore } from "../../identity/keys.js";
import { defaultPasswordHasher } from "../../identity/passwords.js";
import {
  InvalidServerNameError,
  InvalidSettingError,
  isLifetimeKey,
  PUBLISH_LINEAGE_KEY,
  SERVER_NAME_KEY,
  setPublishLineage,
  setServerName,
  setTokenLifetime,
} from "../../identity/settings.js";
import { DisabledAccountError, mintToken } from "../../identity/tokens.js";
import {
  ADMIN_ROLE,
  countEnabledAdmins,
  createUser,
  DEFAULT_ROLE,
  disableUser,
  enableUser,
  findUser,
  InvalidRoleError,
  InvalidUsernameError,
  isOperator,
  pageUsers,
  revokeUserTokens,
  setAdmin,
  UsernameTakenError,
  WeakPasswordError,
  type UserRecord,
} from "../../identity/users.js";
import {
  findWrite,
  recordWrite,
  type RecordedWrite,
  type WriteKey,
} from "../../identity/writes.js";
import { readDuration } from "../../duration.js";
import { settingKeyOf, settingRows } from "../../view.js";
import {
  boundedCount,
  flag,
  MethodError,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  TEAM_METHODS,
  TOPIC_ADMIN_KEYS,
  TOPIC_ADMIN_SETTINGS,
  TOPIC_ADMIN_USERS,
  type TeamAdminKey,
  type TeamAdminKeysEvent,
  type TeamAdminMintedToken,
  type TeamAdminSetting,
  type TeamAdminSettingsEvent,
  type TeamAdminUsersEvent,
} from "../protocol.js";
import { mintingConfig, type TeamService } from "../service.js";
import { serverStatus } from "../status.js";

/**
 * The most a cursor may be.
 *
 * Longer than any this server hands back, which is a number and an id. It is
 * here so that a cursor cannot become somewhere to put a payload, not because a
 * long one would be wrong: an unreadable cursor is answered with the first page.
 */
const CURSOR_LIMIT = 128;

/** How many accounts one page holds when the caller did not say. */
const DEFAULT_USER_PAGE = 50;

/**
 * The most accounts one page may hold.
 *
 * A page is a bounded amount of work rather than however much was asked for,
 * and each account here costs a second query for the groups it is in. Somebody
 * wanting the whole of a large team pages through it, which is what the cursor
 * is for.
 */
const MAXIMUM_USER_PAGE = 200;

/** How many decisions one page holds when the caller did not say. */
const DEFAULT_AUDIT_PAGE = 50;

/**
 * The most decisions one page may hold.
 *
 * The table is bounded at a couple of thousand rows, so this is not about
 * protecting the database; it is about the size of one answer on the wire, and
 * about a caller that asked for everything getting a page it can draw rather
 * than a frame it has to wait for.
 */
const MAXIMUM_AUDIT_PAGE = 200;

/** The most a client id may be. Long enough for a UUID and a word, short of a payload. */
const CLIENT_ID_LIMIT = 128;

/** The most a username may be. The name pattern caps it tighter; this is the gross bound. */
const USERNAME_LIMIT = 64;

/**
 * The most a password may be.
 *
 * Generous, because a passphrase is longer than a password and length is the
 * whole of what makes either hard to guess. Bounded at all because it arrives
 * in a frame and is about to be hashed, and hashing is the most expensive thing
 * this server does while answering a call.
 */
const PASSWORD_LIMIT = 1024;

/** The most a display name may be: what a person is called, not a biography. */
const DISPLAY_NAME_LIMIT = 128;

/** The most an email address may be, which is what RFC 5321 allows a path to be. */
const EMAIL_LIMIT = 320;

/** The most a setting's label may be. They are short words; this is the gross bound. */
const SETTING_LABEL_LIMIT = 64;

/** The most a setting's value may be. A name is capped tighter where it is stored. */
const SETTING_VALUE_LIMIT = 256;

/**
 * Refuse anybody who is not an operator.
 *
 * Read off the record the session identified for this call, so an account that
 * was taken out of the admin group a moment ago is refused on its very next
 * call rather than when its token expires. `refused` rather than `not-found`:
 * pretending a method is not there would send whoever is fixing a client in the
 * wrong direction, and there is nothing secret about the existence of a
 * management surface that the capability list does not already say.
 */
function requireOperator(context: MethodContext): void {
  if (!isOperator(context.user.groups)) {
    throw new MethodError("refused", "administering this server is for its operators");
  }
}

/**
 * One method of this family, with the gate in front of it.
 *
 * A wrapper rather than a line at the top of each handler, because the gate is
 * the thing that must not be forgotten and a line one can forget to write is a
 * line somebody eventually will. Written once here, every method below has it.
 */
function administered(
  name: string,
  handle: (params: unknown, context: MethodContext) => Promise<unknown> | unknown,
): TeamMethod {
  return {
    name,
    capability: "admin",
    handle: (params, context) => {
      requireOperator(context);
      return handle(params, context);
    },
  };
}

/** What a write knows about having been asked for before. */
interface Repeatable {
  /**
   * How this write is keyed, absent when the caller named no client id.
   *
   * Handed to the handler rather than kept private because one write notes
   * itself early: see `admin.tokens.mint`, whose answer cannot be worked out a
   * second time and so has to be written down as it is given.
   */
  readonly key: WriteKey | undefined;
  /** The write this call repeats, where it has happened before. */
  readonly already: RecordedWrite | undefined;
}

/**
 * One write of this family: gated, and done at most once per client id.
 *
 * The note of a write is taken here, after the handler has answered, so that
 * every method below is repeatable without each of them having to remember to
 * say so. A handler that noted itself already finds this a no-op — the note
 * keeps whatever the first of two identical calls wrote.
 *
 * The note is taken after the effect rather than before it. A process that died
 * between the two would let a replay act a second time, which is the same window
 * a crash between the effect and the answer already opens; claiming the key
 * first would trade that for a write nothing did and nobody can retry.
 */
function administeredWrite(
  name: string,
  handle: (
    read: Record<string, unknown>,
    context: MethodContext,
    repeat: Repeatable,
  ) => Promise<unknown> | unknown,
): TeamMethod {
  return administered(name, async (params: unknown, context: MethodContext) => {
    const read = paramsObject(params);
    const clientId = optionalText(read, "clientId", CLIENT_ID_LIMIT);
    const key =
      clientId === undefined ? undefined : { account: context.user.id, method: name, clientId };
    const already = key === undefined ? undefined : findWrite(context.options.database, key);
    const value = await handle(read, context, { key, already });
    if (key !== undefined) {
      recordWrite(context.options.database, key);
    }
    return value;
  });
}

/** The settings surface, read from what this service was brought up with. */
function settingsOf(options: TeamService): TeamAdminSetting[] {
  return settingRows({
    root: options.root,
    database: options.database,
    config: options.config,
    fingerprint: options.fingerprint,
  });
}

/** One row of that surface, by the label it is both found and written by. */
function settingOf(options: TeamService, label: string): TeamAdminSetting | undefined {
  return settingsOf(options).find((row) => row.label === label);
}

/**
 * The keys this server holds, as both the list and a rotation answer with them.
 *
 * One builder, for the reason there is one builder for an account: the rows a
 * change hands back and the rows a list carries must not come to differ by a
 * field.
 */
function keyRows(keys: KeyStore): TeamAdminKey[] {
  const signing = keys.published[0];
  return keys.all.map((key) => ({
    kid: key.kid,
    serial: key.serial,
    retired: key.retired,
    signing: key.kid === signing?.kid,
  }));
}

/** The account a call names, or a refusal saying this server has no such name. */
function namedAccount(context: MethodContext, read: Record<string, unknown>): UserRecord {
  const username = requiredText(read, "username", USERNAME_LIMIT);
  const user = findUser(context.options.database, username);
  if (user === undefined) {
    throw new MethodError("not-found", "there is no account of that name on this server");
  }
  return user;
}

/**
 * A password, read without being tidied up.
 *
 * Every other string on this wire is trimmed, because a name with a space on
 * the end is a name somebody typed carelessly. A password is not: the spaces
 * are part of the credential, and trimming one would store something other than
 * what the person was told to type — quietly, and only for some of them.
 */
function password(read: Record<string, unknown>, name: string): string {
  const value = read[name];
  if (typeof value !== "string" || value === "") {
    throw new MethodError("bad-params", `${name} has to be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf-8") > PASSWORD_LIMIT) {
    throw new MethodError("bad-params", `${name} is longer than this server hashes`);
  }
  return value;
}

/**
 * Refuse a change that would leave this server with no operator who can reach it.
 *
 * A management surface that lets a person lock themselves out with one click is
 * a trap, and this is the click: taking the last operator's administration away,
 * or disabling the last operator's account, leaves a server nobody can
 * administer over this protocol and nobody who can put that right over it
 * either.
 *
 * It is refused here and **not** on the command line, and that difference is the
 * whole of the design. `nlteam` runs on the machine that holds the storage root:
 * it is the rescue plane, it is how a server in this state is repaired, and a
 * rescue plane that would not do what nothing else can do would be no rescue at
 * all. Neither `user revoke-admin --root` nor `user disable --root` refuses
 * anything — both do as they are told, because the rule this function enforces
 * is the management plane's and whoever holds the disk is not inside it. So the
 * refusal names the command, because a person reading it in a panel is exactly
 * the person who needs to know there is a way back.
 */
function refuseIfLastOperator(context: MethodContext, user: UserRecord, rescue: string): void {
  if (!isOperator(user.groups)) {
    return;
  }
  if (countEnabledAdmins(context.options.database) > 1) {
    return;
  }
  throw new MethodError(
    "refused",
    `${user.username} is the only operator this server has who can sign in, and a server ` +
      "with none has nobody who can make one over this protocol. Make somebody else an " +
      `operator first, or run \`${rescue}\` on the machine this server runs on, against the ` +
      "storage root it was started with.",
  );
}

/** Say that an account changed, to whoever is watching the accounts. */
function announceUser(context: MethodContext, event: TeamAdminUsersEvent): void {
  context.publish(TOPIC_ADMIN_USERS, event);
}

/**
 * What a repeated mint already produced, where this server can still say.
 *
 * The note is the only record a mint leaves — nothing else keeps one, on
 * purpose — so a note that cannot be read is a mint this server can say nothing
 * true about. Undefined then, and the caller mints afresh, because an invented
 * expiry would be worse than a second token.
 */
function mintedBefore(note: RecordedWrite): TeamAdminMintedToken | undefined {
  if (note.answer === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(note.answer);
  } catch {
    return undefined;
  }
  const kept = parsed as { username?: unknown; expiresAt?: unknown };
  if (typeof kept.username !== "string" || typeof kept.expiresAt !== "number") {
    return undefined;
  }
  // No `token`. It was shown once and this server kept nothing; the protocol
  // says what a caller that lost one does about it.
  return { username: kept.username, expiresAt: kept.expiresAt };
}

export function adminMethods(): TeamMethod[] {
  return [
    administered(TEAM_METHODS.adminUsersList, (params: unknown, context: MethodContext) => {
      const read = paramsObject(params);
      const cursor = optionalText(read, "cursor", CURSOR_LIMIT);
      const page = pageUsers(context.options.database, {
        limit: boundedCount(read, "limit", DEFAULT_USER_PAGE, MAXIMUM_USER_PAGE),
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      return {
        // Composed by the builder every answer carrying an account uses, so
        // that the record a change hands back and the record a list carries
        // cannot come to differ by a field.
        users: page.users.map((user) => adminUserBody(user)),
        // Opaque to the caller: `<createdAt>:<id>` as this server wrote it,
        // passed straight back. Absent when no page follows this one.
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    }),
    administeredWrite(TEAM_METHODS.adminUsersCreate, async (read, context, repeat) => {
      const username = requiredText(read, "username", USERNAME_LIMIT);
      const secret = password(read, "password");
      const displayName = optionalText(read, "displayName", DISPLAY_NAME_LIMIT);
      const email = optionalText(read, "email", EMAIL_LIMIT);
      // Which group it joins, as one flag rather than a list of names. Being in
      // the admin group is the whole of what a role decides on this server, and
      // a client naming groups freely would be inventing a vocabulary nothing
      // here has an opinion about.
      const operator = flag(read, "operator", false);

      if (repeat.already !== undefined) {
        const made = findUser(context.options.database, username);
        if (made !== undefined) {
          // The create already happened; this is the account it made, as it
          // stands now rather than as it was. Nothing changed, so — like every
          // idempotent write here — nothing is announced.
          return { user: adminUserBody(made) };
        }
      }

      let user: UserRecord;
      try {
        // The same call `nlteam user create` makes, with the same hasher, so
        // that what a username may be, how short a password may be and what
        // happens to a name already taken are answered once for both.
        user = await createUser(context.options.database, defaultPasswordHasher(), {
          username,
          password: secret,
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
          groups: [operator ? ADMIN_ROLE : DEFAULT_ROLE],
        });
      } catch (error) {
        if (error instanceof UsernameTakenError) {
          throw new MethodError("conflict", error.message);
        }
        if (
          error instanceof InvalidUsernameError ||
          error instanceof WeakPasswordError ||
          error instanceof InvalidRoleError
        ) {
          // Carried through as they were written rather than reworded. These
          // sentences say what a name or a password may be, which is what
          // somebody retyping one needs, and a second wording here would be a
          // second set of rules to keep in step with the first.
          throw new MethodError("bad-params", error.message);
        }
        throw error;
      }

      const body = adminUserBody(user);
      announceUser(context, { kind: "user-created", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminUsersDisable, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined || user.disabledAt !== undefined) {
        // Already disabled is the state the caller asked for. Answered rather
        // than done again, and doing it again would not be free: disabling
        // bumps the token epoch, so a second one would refuse whatever had been
        // minted in between.
        return { user: adminUserBody(user) };
      }
      refuseIfLastOperator(context, user, `nlteam user enable ${user.username}`);
      const body = adminUserBody(disableUser(context.options.database, user.username));
      announceUser(context, { kind: "user-disabled", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminUsersEnable, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined || user.disabledAt === undefined) {
        return { user: adminUserBody(user) };
      }
      const body = adminUserBody(enableUser(context.options.database, user.username));
      announceUser(context, { kind: "user-enabled", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminUsersGrantAdmin, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined || isOperator(user.groups)) {
        return { user: adminUserBody(user) };
      }
      const body = adminUserBody(setAdmin(context.options.database, user.username, true));
      announceUser(context, { kind: "user-granted-admin", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminUsersRevokeAdmin, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined || !isOperator(user.groups)) {
        return { user: adminUserBody(user) };
      }
      refuseIfLastOperator(context, user, `nlteam user grant-admin ${user.username}`);
      const body = adminUserBody(setAdmin(context.options.database, user.username, false));
      announceUser(context, { kind: "user-revoked-admin", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminUsersRevokeTokens, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined) {
        return { user: adminUserBody(user) };
      }
      // The one write here that is never a no-op: the epoch moves every time it
      // is called, and calling it twice refuses whatever was minted in between.
      // That is why it is worth a client id though nothing about it looks like
      // a collision.
      const body = adminUserBody(revokeUserTokens(context.options.database, user.username));
      announceUser(context, { kind: "user-tokens-revoked", user: body });
      return { user: body };
    }),
    administeredWrite(TEAM_METHODS.adminTokensMint, (read, context, repeat) => {
      const user = namedAccount(context, read);
      if (repeat.already !== undefined) {
        const before = mintedBefore(repeat.already);
        if (before !== undefined) {
          return { minted: before };
        }
      }

      let minted;
      try {
        // What `nlteam token mint` mints, minus the password: whoever asked for
        // this has already proved who they are, and somebody who can disable
        // the account can hardly be stopped from issuing it a token.
        //
        // Signed with the store this server holds rather than one opened again
        // from the keys directory, so a token minted here is signed by the key
        // this server is actually publishing. The lifetimes are read as it is
        // minted, so one shortened a moment ago applies to it.
        minted = mintToken(user, context.options.keys.signingKey, mintingConfig(context.options), {
          purpose: "sign-in",
          // The claim that lets the machine this is pasted into decide whether
          // to trust this server, on a token that is about to leave the
          // building.
          ...(context.options.fingerprint === undefined
            ? {}
            : { authorityFingerprint: context.options.fingerprint }),
        });
      } catch (error) {
        if (error instanceof DisabledAccountError) {
          throw new MethodError("refused", error.message);
        }
        throw error;
      }

      // Milliseconds, as every other moment on this wire is; a token's own
      // `exp` is seconds, because that is what a JWT says.
      const answer = { username: user.username, expiresAt: minted.claims.exp * 1000 };
      if (repeat.key !== undefined) {
        // Noted here rather than left to the wrapper, because this is the one
        // answer that cannot be worked out again: nothing keeps a minted token,
        // so a repeat is told which account and until when, and nothing else.
        // What goes in the note is what is safe to keep, which is not the token.
        recordWrite(context.options.database, repeat.key, { answer: JSON.stringify(answer) });
      }
      // Nothing is published. A mint changes no record anybody is watching, and
      // the one thing it produced is a credential that must reach exactly one
      // pair of eyes — which is also why it is beside the rest of the answer
      // and not inside a sentence something might log.
      return { minted: { ...answer, token: minted.token } };
    }),
    administered(TEAM_METHODS.adminSettingsList, (_params: unknown, context: MethodContext) => ({
      // Whole rather than paged, and that is a decision rather than a gap. The
      // rows are a literal in settingRows: ten of them today, and however many
      // that function is written to build tomorrow. There is no query behind
      // this that could return more of them, so a cursor would be a cursor over
      // a list whose length is a line of source, and a caller would page
      // through it once for nothing every time it drew the surface. If that
      // function ever came to build a row per something a server can have many
      // of, this is the sentence that would have to change.
      settings: settingsOf(context.options),
    })),
    administeredWrite(TEAM_METHODS.adminSettingsSet, (read, context, repeat) => {
      // Found by its label, which the settings list says is the key as well as
      // the caption. By label rather than by position, because a position only
      // means anything against the list a caller happened to read, and a row
      // added above another would silently move somebody's edit onto a
      // different setting.
      const label = requiredText(read, "label", SETTING_LABEL_LIMIT);
      const before = settingOf(context.options, label);
      if (before === undefined) {
        throw new MethodError("not-found", `this server has no setting called ${label}`);
      }
      const key = settingKeyOf(before.label);
      if (!before.editable || key === undefined) {
        // Refused rather than accepted and dropped. The identity settings and
        // the ports are named on the command line that started this server, so
        // a value written here would be thrown away — and something that looks
        // like it worked is worse than something that says it cannot.
        throw new MethodError(
          "refused",
          `${label} is read only: it is named on the command line this server was started ` +
            "with, so a value written here would be thrown away",
        );
      }
      if (repeat.already !== undefined) {
        return { setting: before };
      }

      const value = requiredText(read, "value", SETTING_VALUE_LIMIT);
      try {
        if (key === SERVER_NAME_KEY) {
          // Not every setting is a duration. A name is stored as it was typed,
          // and reading it as one would refuse every name that is not a number.
          setServerName(context.options.database, value);
        } else if (key === PUBLISH_LINEAGE_KEY) {
          // Nor is every setting free text. This one is a word out of a closed
          // set, and the set is checked where it is stored rather than here, so
          // that "is that a rule" has one answer wherever the question arrives
          // from.
          setPublishLineage(context.options.database, value);
        } else if (isLifetimeKey(key)) {
          // The words this server wrote, taken back: a lifetime is shown as
          // "30 days" and a caller sending that back means it. `7d` and bare
          // seconds are taken too, the second being what a panel holding the
          // `seconds` a row carries beside its words would send.
          const seconds = readDuration(value);
          if (typeof seconds === "string") {
            throw new MethodError("bad-params", seconds);
          }
          setTokenLifetime(context.options.database, key, seconds);
        } else {
          // Asked rather than assumed, and refused rather than guessed at. A
          // setting added to this server without a branch here would otherwise
          // be read as a duration and refuse every value that is not a number,
          // which reads to a caller as its value being wrong rather than as
          // this server not knowing what to do with the row it just offered.
          throw new MethodError(
            "internal",
            `this server offers the ${label} setting but does not know how to write it`,
          );
        }
      } catch (error) {
        if (error instanceof MethodError) {
          throw error;
        }
        if (error instanceof InvalidServerNameError || error instanceof InvalidSettingError) {
          throw new MethodError("bad-params", error.message);
        }
        throw error;
      }

      const after = settingOf(context.options, label);
      if (after === undefined) {
        // The row was there a moment ago and is the one just written. Nothing
        // can take a row off this surface, so this is unreachable rather than a
        // case worth designing for; it is here because the alternative is
        // asserting away a lookup that really can answer with nothing.
        throw new MethodError("internal", `the ${label} setting could not be read back`);
      }
      if (after.value !== before.value) {
        const event: TeamAdminSettingsEvent = { kind: "setting-changed", setting: after };
        context.publish(TOPIC_ADMIN_SETTINGS, event);
      }
      return { setting: after };
    }),
    administered(TEAM_METHODS.adminKeysList, async (_params: unknown, context: MethodContext) => {
      // Read out of the store this server already holds rather than by opening
      // the keys directory again: the store is what mints and verifies with
      // these keys, and a second reader of the same files could answer with a
      // set this server is not actually using.
      //
      // Re-read first, so that a `nlteam key rotate` run in another terminal is
      // on this list without the server being restarted. The store throttles
      // its own re-reads, so asking on every call is a scan every few seconds
      // at worst.
      await context.options.keys.reload();
      return {
        // Whole rather than paged, for the reason the settings are: this is
        // however many times a server has rotated its keys, which is a number
        // that goes up when an operator decides it should.
        keys: keyRows(context.options.keys),
      };
    }),
    administeredWrite(TEAM_METHODS.adminKeysRotate, async (_read, context, repeat) => {
      const keys = context.options.keys;
      // Re-read before anything else, because a key file this process has not
      // seen — one a `nlteam key rotate` in another terminal wrote — would make
      // the next serial a name that is already taken, and the rotation would
      // then fail on a file that exists rather than on anything an operator did.
      await keys.reload();
      if (repeat.already !== undefined) {
        return { keys: keyRows(keys) };
      }
      // Safe at any moment, which is why nothing here asks for confirmation:
      // the new key signs from now on, every key that is not retired goes on
      // being published, and a token signed a second ago still verifies.
      await keys.rotate();
      const rotated = keyRows(keys);
      const event: TeamAdminKeysEvent = { kind: "keys-rotated", keys: rotated };
      context.publish(TOPIC_ADMIN_KEYS, event);
      return { keys: rotated };
    }),
    administered(TEAM_METHODS.adminAuditList, (params: unknown, context: MethodContext) => {
      const read = paramsObject(params);
      const cursor = optionalText(read, "cursor", CURSOR_LIMIT);
      const page = pageDecisions(context.options.database, {
        limit: boundedCount(read, "limit", DEFAULT_AUDIT_PAGE, MAXIMUM_AUDIT_PAGE),
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      return {
        // Newest first, because the order somebody looks for a refusal in is
        // backwards from now.
        decisions: page.decisions,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    }),
    administered(TEAM_METHODS.adminServerStatus, (_params: unknown, context: MethodContext) =>
      // Worked out when somebody asks and kept for a stated moment, never on a
      // timer - see src/team/status.ts for what that costs and why it is worth
      // it. The answer carries when it was worked out, so a panel can say "as
      // of" instead of implying it is live.
      serverStatus(context.options),
    ),
  ];
}
