/**
 * A browser signed in to the web console.
 *
 * Studio and the command line carry stateless tokens and keep carrying them:
 * a token is checked against the signing keys and the account's epoch, and
 * nothing about it is stored. A browser is different in one way that decides
 * everything else. **A page's script must never be able to read what signs it
 * in**, because any script that runs on the page — a dependency, an injected
 * string that slipped past an escape — could otherwise send it somewhere. So a
 * browser holds an HttpOnly cookie, the cookie names a row here, and the row
 * is what can be ended: signing out deletes it, and so does an operator
 * revoking the account's tokens.
 *
 * What is stored is a hash of the cookie, never the cookie. A copy of the
 * database — a backup, a file somebody attached to a bug report — signs
 * nobody in.
 *
 * Two clocks:
 *
 *   - **Idle**: a session nobody has used for {@link WEB_SESSION_IDLE_MS} ends.
 *     Each use pushes it out again, written at most once a minute so that a
 *     busy page is not a write per call.
 *   - **Absolute**: whatever the use, a session ends {@link WEB_SESSION_MAX_MS}
 *     after it began, and the person signs in again.
 *
 * The account is read again on every use, exactly as a token's is: disabled,
 * deleted, or revoked since the session began, and the session is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { CallerRefusal } from "./bearer.js";
import { integerColumn, textColumn, type Row } from "./database.js";
import { findUserById, type UserRecord } from "./users.js";

/** The cookie's name. `__Host-` makes a browser refuse it unless it is Secure, on `/`, with no Domain. */
export const WEB_SESSION_COOKIE = "__Host-nlteam";

/** How long a session lasts unused. */
export const WEB_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a session lasts however much it is used. */
export const WEB_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** How stale `last_seen_at` may be before a use writes it again. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The most of a user-agent string kept, for the "signed in on" list. */
const USER_AGENT_LIMIT = 256;

/** Random bytes in a cookie: as many as a signing key, which is more than anybody guesses. */
const COOKIE_BYTES = 32;

/** A cookie is base64url of those bytes, and nothing else is looked up. */
const COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type WebSessionRefusal = CallerRefusal | "no-session" | "unknown-session" | "expired-session";

export type WebSessionIdentification =
  | { readonly kind: "identified"; readonly user: UserRecord; readonly session: WebSessionRecord }
  | { readonly kind: "refused"; readonly reason: WebSessionRefusal };

/** One session, as stored. The id is the hash; the cookie itself is never kept. */
export interface WebSessionRecord {
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | undefined;
}

const SESSION_REASONS: Readonly<Record<"no-session" | "unknown-session" | "expired-session", string>> = {
  "no-session": "the request carried no console session",
  "unknown-session": "that console session is not one this server holds; sign in again",
  "expired-session": "that console session has ended; sign in again",
};

/** A sentence for a refusal, for a log or a 401. */
export function describeWebSessionRefusal(
  reason: WebSessionRefusal,
  describe: (reason: CallerRefusal) => string,
): string {
  return reason in SESSION_REASONS
    ? SESSION_REASONS[reason as keyof typeof SESSION_REASONS]
    : describe(reason as CallerRefusal);
}

function hashOf(cookie: string): string {
  return createHash("sha256").update(cookie, "utf8").digest("base64url");
}

function toRecord(row: Row): WebSessionRecord {
  const agent = row.user_agent;
  return {
    idHash: textColumn(row, "id_hash"),
    userId: textColumn(row, "user_id"),
    createdAt: integerColumn(row, "created_at"),
    lastSeenAt: integerColumn(row, "last_seen_at"),
    expiresAt: integerColumn(row, "expires_at"),
    userAgent: typeof agent === "string" ? agent : undefined,
  };
}

/** The idle deadline from `now`, never past the absolute one. */
function deadline(createdAt: number, now: number): number {
  return Math.min(now + WEB_SESSION_IDLE_MS, createdAt + WEB_SESSION_MAX_MS);
}

/**
 * Begin a session for an account that has just proved who it is. Answers the
 * cookie to hand the browser, which is the only time it exists outside one.
 */
export function createWebSession(
  database: DatabaseSync,
  user: UserRecord,
  options: { userAgent?: string; now?: number } = {},
): { cookie: string; session: WebSessionRecord } {
  const now = options.now ?? Date.now();
  const cookie = randomBytes(COOKIE_BYTES).toString("base64url");
  const agent = options.userAgent?.slice(0, USER_AGENT_LIMIT);
  database
    .prepare(
      `INSERT INTO web_sessions (id_hash, user_id, token_epoch, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(hashOf(cookie), user.id, user.tokenEpoch, now, now, deadline(now, now), agent ?? null);
  // Expired rows go when somebody signs in, which bounds the table by how many
  // sessions are live rather than by how many ever were.
  database.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
  return {
    cookie,
    session: {
      idHash: hashOf(cookie),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: deadline(now, now),
      userAgent: agent,
    },
  };
}

/**
 * Who a cookie signs in, now, and push its idle deadline out.
 *
 * Every refusal leaves the row as it was except one that is over, which is
 * deleted on the way: there is nothing a session past its deadline could be
 * kept for.
 */
export function identifyWebSession(
  database: DatabaseSync,
  cookie: string | undefined,
  now: number = Date.now(),
): WebSessionIdentification {
  if (cookie === undefined) {
    return { kind: "refused", reason: "no-session" };
  }
  if (!COOKIE_PATTERN.test(cookie)) {
    return { kind: "refused", reason: "unknown-session" };
  }
  const idHash = hashOf(cookie);
  const row = database
    .prepare(
      `SELECT id_hash, user_id, token_epoch, created_at, last_seen_at, expires_at, user_agent
         FROM web_sessions WHERE id_hash = ?`,
    )
    .get(idHash);
  if (row === undefined) {
    return { kind: "refused", reason: "unknown-session" };
  }
  const session = toRecord(row as Row);
  if (session.expiresAt <= now) {
    endWebSession(database, cookie);
    return { kind: "refused", reason: "expired-session" };
  }
  const user = findUserById(database, session.userId);
  if (user === undefined) {
    return { kind: "refused", reason: "unknown-account" };
  }
  if (user.disabledAt !== undefined) {
    return { kind: "refused", reason: "disabled" };
  }
  if (integerColumn(row as Row, "token_epoch") < user.tokenEpoch) {
    return { kind: "refused", reason: "stale-epoch" };
  }
  if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    const expiresAt = deadline(session.createdAt, now);
    database
      .prepare("UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
      .run(now, expiresAt, idHash);
    return { kind: "identified", user, session: { ...session, lastSeenAt: now, expiresAt } };
  }
  return { kind: "identified", user, session };
}

/** End the session a cookie names. Answers whether there was one. */
export function endWebSession(database: DatabaseSync, cookie: string): boolean {
  const result = database.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(hashOf(cookie));
  return Number(result.changes) > 0;
}

/** Every live session one account holds, newest first: the "signed in on" list. */
export function listWebSessions(database: DatabaseSync, userId: string, now: number = Date.now()): WebSessionRecord[] {
  return database
    .prepare(
      `SELECT id_hash, user_id, created_at, last_seen_at, expires_at, user_agent FROM web_sessions
        WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(userId, now)
    .map((row) => toRecord(row as Row));
}

/** The cookie a request carries, if it carries ours. */
export function webSessionCookie(header: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(header) ? header.join("; ") : header;
  if (joined === undefined) {
    return undefined;
  }
  for (const part of joined.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === WEB_SESSION_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** The `set-cookie` value that hands a browser a session. */
export function sessionCookieHeader(cookie: string): string {
  return `${WEB_SESSION_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    WEB_SESSION_MAX_MS / 1000,
  )}`;
}

/** The `set-cookie` value that takes it away again. */
export function clearedCookieHeader(): string {
  return `${WEB_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
