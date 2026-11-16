/**
 * Notifications: somebody wants one account's attention.
 *
 * Three causes: an `@username` in a comment, a reply in a thread the account
 * is part of, and a to-do given to it. Each is kept until read. Nobody is told
 * about a project they have no role in, and nobody is told about their own act.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUser, findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject } from "../projects/members.js";
import type { TeamNotification, TeamNotificationKind } from "../team/protocol.js";
import { categoryOf, switchOn } from "./prefs.js";
import { pushNotification } from "./push.js";

/** The longest summary kept. */
const SUMMARY_LIMIT = 200;

/** The most people one comment may mention and notify. */
const MENTION_LIMIT = 20;

/** The usernames a body mentions, as written: `@name`, not inside an address. */
export function mentionsIn(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/(^|[^A-Za-z0-9._@-])@([a-z0-9][a-z0-9._-]{1,31})/g)) {
    const name = match[2]?.replace(/[._-]+$/, "");
    if (name !== undefined) names.add(name);
    if (names.size >= MENTION_LIMIT) break;
  }
  return [...names];
}

export interface NewNotification {
  readonly kind: TeamNotificationKind;
  readonly projectId?: string;
  readonly ref?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

/**
 * Notify each of `recipients` who may see the project, except the actor.
 * Answers the notifications written, by account id, for the caller to announce.
 *
 * Each person's switches decide where it goes: with `inapp` off nothing is written (and so nothing
 * is announced or put in a digest); with `push` on, every browser they subscribed is pushed to.
 */
export function notify(
  database: DatabaseSync,
  recipients: Iterable<string>,
  entry: NewNotification,
  now = Date.now(),
): Map<string, TeamNotification> {
  const written = new Map<string, TeamNotification>();
  const summary = entry.summary === undefined ? null : entry.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);
  for (const accountId of new Set(recipients)) {
    if (accountId === entry.actorId) continue;
    const user = findUserById(database, accountId);
    if (user === undefined || user.disabledAt !== undefined) continue;
    if (entry.projectId !== undefined && !maySeeProject(database, entry.projectId, user)) continue;
    const category = categoryOf(entry.kind);
    if (!switchOn(database, accountId, category, "inapp")) continue;
    const result = database
      .prepare(
        `INSERT INTO notifications (account_id, kind, project_id, ref, actor_id, summary, at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(accountId, entry.kind, entry.projectId ?? null, entry.ref ?? null, entry.actorId ?? null, summary, now);
    const row = database.prepare("SELECT * FROM notifications WHERE id = ?").get(Number(result.lastInsertRowid));
    if (row === undefined) continue;
    const notification = toNotification(database, row as Row);
    written.set(accountId, notification);
    if (switchOn(database, accountId, category, "push")) pushNotification(database, accountId, notification);
  }
  return written;
}

/** Tells an account's open sessions about a new notification. */
export type NotificationAnnouncer = (accountId: string, notification: TeamNotification) => void;

let announcer: NotificationAnnouncer | undefined;

/**
 * Who announces notifications written away from any request - a commit found by a refresh, a
 * version saved on the hour. The server sets it once it has a hub; undefined while it has none.
 */
export function setNotificationAnnouncer(next: NotificationAnnouncer | undefined): void {
  announcer = next;
}

/** Announce what {@link notify} wrote, through the server's announcer. */
export function announceWritten(written: Map<string, TeamNotification>): void {
  if (announcer === undefined) return;
  for (const [accountId, notification] of written) announcer(accountId, notification);
}

/** The accounts a comment body mentions by username. */
export function mentionedAccounts(database: DatabaseSync, body: string): UserRecord[] {
  return mentionsIn(body).flatMap((name) => {
    const user = findUser(database, name);
    return user === undefined ? [] : [user];
  });
}

function toNotification(database: DatabaseSync, row: Row): TeamNotification {
  const project = optionalTextColumn(row, "project_id");
  const ref = optionalTextColumn(row, "ref");
  const actorId = optionalTextColumn(row, "actor_id");
  const actor = actorId === undefined ? undefined : findUserById(database, actorId);
  const summary = optionalTextColumn(row, "summary");
  const readAt = optionalIntegerColumn(row, "read_at");
  return {
    id: integerColumn(row, "id"),
    kind: textColumn(row, "kind") as TeamNotificationKind,
    ...(project === undefined ? {} : { project }),
    ...(ref === undefined ? {} : { ref }),
    ...(actor === undefined ? {} : { actor: actor.username }),
    ...(summary === undefined ? {} : { summary }),
    at: integerColumn(row, "at"),
    ...(readAt === undefined ? {} : { readAt }),
  };
}

export function listNotifications(
  database: DatabaseSync,
  accountId: string,
  query: { unreadOnly: boolean; before?: number; limit: number },
): { notifications: TeamNotification[]; unread: number; cursor?: number } {
  const rows = database
    .prepare(
      `SELECT * FROM notifications WHERE account_id = ?${query.unreadOnly ? " AND read_at IS NULL" : ""}
        ${query.before === undefined ? "" : "AND id < ?"} ORDER BY id DESC LIMIT ?`,
    )
    .all(...(query.before === undefined ? [accountId, query.limit + 1] : [accountId, query.before, query.limit + 1])) as Row[];
  const page = rows.slice(0, query.limit).map((row) => toNotification(database, row));
  const unread = integerColumn(
    database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE account_id = ? AND read_at IS NULL").get(accountId) as Row,
    "count",
  );
  const last = page.at(-1);
  return { notifications: page, unread, ...(rows.length > query.limit && last !== undefined ? { cursor: last.id } : {}) };
}

/** Mark some, or all, of an account's notifications read. Answers how many changed. */
export function markRead(database: DatabaseSync, accountId: string, ids: readonly number[] | "all", now = Date.now()): number {
  if (ids === "all") {
    return Number(database.prepare("UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL").run(now, accountId).changes);
  }
  let changed = 0;
  for (const id of ids) {
    changed += Number(
      database.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL").run(now, id, accountId)
        .changes,
    );
  }
  return changed;
}
