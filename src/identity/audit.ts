/**
 * The decisions Team has made, kept rather than only logged.
 *
 * Every authorization question loreserver asks is answered in
 * src/projects/service.ts, and until this table existed the answer went to the
 * log of the `up` process and nowhere else. That is fine for somebody watching
 * the terminal it is running in and no use to anybody else: the log is gone
 * when the process is restarted, the screen that shows the last few decisions
 * had nothing to show, and a Team server could not answer "who reached this project,
 * and who was refused".
 *
 * What is kept is what a person reads: when, which account, which resource,
 * whether it was allowed, and the short reason that was already in the log
 * line. Nothing here holds a token, a resource id nobody could read, or
 * anything else that would make this file worth stealing on its own.
 */
import type { DatabaseSync } from "node:sqlite";

import { booleanColumn, integerColumn, textColumn, type Row } from "./database.js";

/** One decision, as it was recorded. */
export interface Decision {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly username: string;
  /** The project's name where Team knew it, and the resource id where it did not. */
  readonly resource: string;
  readonly allowed: boolean;
  /** The short reason, as the log line says it: `owner`, `no grant`, `expired`. */
  readonly detail: string;
}

/** A decision on its way in; `at` is now unless a caller says otherwise. */
export interface NewDecision {
  readonly username: string;
  readonly resource: string;
  readonly allowed: boolean;
  readonly detail: string;
  /** When it was made. Named only by a test that needs a fixed clock. */
  readonly at?: number;
}

/**
 * What an account is called here when there is nobody to name.
 *
 * The same word the interface uses for anything it could not work out, which is
 * what this is: a caller whose token was missing, expired or not one of Team's.
 * Short enough to sit in the column a username is drawn in — a longer word runs
 * into the resource beside it, with no space between the two.
 */
export const UNIDENTIFIED_ACCOUNT = "unknown";

/**
 * How many decisions are kept.
 *
 * A busy Team answers a permission question on every repository access, so this
 * table is the one thing in `team.db` that would otherwise grow without anybody
 * doing anything: an afternoon of one team working is thousands of rows, and
 * there is no point at which it stops.
 *
 * Two thousand, and a count rather than an age. An age bound sounds fairer and
 * behaves worse at both ends: a Team server used twice a month would have its whole
 * history deleted between visits and show an empty screen, while a busy one
 * would keep hundreds of thousands of rows inside any window worth calling
 * recent. A count bounds the file the same way on both — at roughly a hundred
 * bytes a row, two thousand of them is a couple of hundred kilobytes, which is
 * small beside the accounts and projects the same file holds and small enough
 * that nobody has to be warned about it.
 *
 * It is also more than anybody reads. The screen shows the last few, and the
 * log window a screenful; the rest of the bound is there so that a refusal from
 * this morning is still findable after an afternoon of ordinary work.
 */
export const DECISION_LIMIT = 2000;

/**
 * How far above the limit the table is allowed to run before it is trimmed.
 *
 * Trimming on every decision would put a `DELETE` on the path that answers
 * every repository access, to remove one row. Trimming every five hundred puts
 * it there once in five hundred, and the cost of the slack is five hundred rows
 * — about a fiftieth of the file this table is bounded to.
 */
export const DECISION_TRIM_SLACK = 500;

/**
 * Decisions written on each connection since it last trimmed.
 *
 * Held against the connection rather than in a plain counter so that a second
 * database — a test's, or a second Team in the same process — is counted
 * separately, and so that nothing is kept alive by being counted.
 *
 * A connection that has never trimmed counts as due, so a Team server restarted every
 * few hundred decisions still trims once per run rather than never.
 */
const writesSinceTrim = new WeakMap<DatabaseSync, number>();

/** What this connection is currently set to sync at; 2 is SQLite's default. */
function synchronousSetting(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA synchronous").get();
  return row === undefined ? 2 : integerColumn(row, "synchronous");
}

/**
 * Write without waiting for the disk to confirm it.
 *
 * SQLite commits every statement outside a transaction on its own, and at the
 * default `synchronous = FULL` every commit is an fsync. Measured on Windows
 * that is 2.2ms, which would be 2.2ms added to every repository access on the
 * Team — for one row of a log. At `NORMAL`, in the WAL mode ./database.ts opens
 * with, the same insert is 0.02ms.
 *
 * What that trades is documented and small: WAL with `NORMAL` cannot corrupt
 * the file and cannot lose anything to a process that crashes or is killed. A
 * power cut or a kernel panic can lose the last few commits made this way —
 * meaning the last few decisions, and only those. Weighed against the
 * alternative, which is decisions that were never written down at all, and
 * against what it would cost to make every access wait for a platter, that is
 * the right side to be on. The setting is put back straight afterwards, so
 * nothing else Team writes — an account, an invitation, a grant — is affected by
 * it.
 *
 * Restored to whatever it was rather than to `FULL`, so a Team server whose connection
 * was opened at some other setting keeps it. SQLite ignores this pragma inside
 * a transaction; a caller that wrapped this in one would get a fully synced
 * write, which is slow rather than wrong.
 */
function withoutWaitingForTheDisk(database: DatabaseSync, write: () => void): void {
  const before = synchronousSetting(database);
  if (before <= 1) {
    write();
    return;
  }
  database.exec("PRAGMA synchronous = NORMAL");
  try {
    write();
  } finally {
    database.exec(`PRAGMA synchronous = ${before}`);
  }
}

function toDecision(row: Row): Decision {
  return {
    at: integerColumn(row, "at"),
    username: textColumn(row, "username"),
    resource: textColumn(row, "resource"),
    allowed: booleanColumn(row, "allowed"),
    detail: textColumn(row, "detail"),
  };
}

/** How many decisions are on record. */
export function countDecisions(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM decisions").get();
  return row === undefined ? 0 : integerColumn(row, "count");
}

/**
 * Bring the table back to {@link DECISION_LIMIT}, and answer with how many rows
 * that removed.
 *
 * Allowances go first. When the bound forces a choice, an allowance is the
 * routine outcome — it is what every working repository access produces — and a
 * refusal is the row somebody will come looking for. So the oldest allowances
 * are dropped before any refusal is, and a refusal is only dropped on a Team server
 * whose refusals alone have filled the table, which is a Team server with a problem
 * worth noticing.
 */
export function trimDecisions(database: DatabaseSync): number {
  const surplus = countDecisions(database) - DECISION_LIMIT;
  if (surplus <= 0) {
    return 0;
  }
  // `allowed DESC` puts the allowances at the front of the queue to be deleted;
  // `at ASC` takes the oldest of whichever kind is being deleted.
  database
    .prepare(
      `DELETE FROM decisions WHERE id IN (
         SELECT id FROM decisions ORDER BY allowed DESC, at ASC, id ASC LIMIT ?
       )`,
    )
    .run(surplus);
  return surplus;
}

/**
 * Keep one decision.
 *
 * This is called on the path that answers every repository access, so it is one
 * insert and, once in {@link DECISION_TRIM_SLACK} decisions, one delete —
 * neither of which waits for the disk, for the reason set out above
 * {@link withoutWaitingForTheDisk}.
 *
 * A failure is not swallowed. A Team server that cannot write to its own database has a
 * larger problem than the access it is about to refuse, and quietly carrying on
 * would put back exactly the gap this table exists to close: decisions made and
 * kept nowhere.
 */
export function recordDecision(database: DatabaseSync, decision: NewDecision): void {
  withoutWaitingForTheDisk(database, () => {
    database
      .prepare(
        "INSERT INTO decisions (at, username, resource, allowed, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        decision.at ?? Date.now(),
        decision.username,
        decision.resource,
        decision.allowed ? 1 : 0,
        decision.detail,
      );

    const since = (writesSinceTrim.get(database) ?? DECISION_TRIM_SLACK) + 1;
    if (since > DECISION_TRIM_SLACK) {
      trimDecisions(database);
      writesSinceTrim.set(database, 0);
      return;
    }
    writesSinceTrim.set(database, since);
  });
}

/**
 * The most recent decisions, newest first.
 *
 * Newest first because that is the order somebody looking for a refusal reads
 * in, and because a caller that wants a screenful wants the last screenful.
 */
export function listDecisions(
  database: DatabaseSync,
  limit: number = DECISION_LIMIT,
): Decision[] {
  return database
    .prepare(
      "SELECT at, username, resource, allowed, detail FROM decisions " +
        "ORDER BY at DESC, id DESC LIMIT ?",
    )
    .all(limit)
    .map(toDecision);
}

/**
 * One decision with the key of the row it was read from.
 *
 * Apart from {@link Decision} rather than folded into it, because the key is
 * about the table and not about the decision: a caller that only wants to know
 * what this server was asked has no use for it, and a reader that pages does —
 * it is what a cursor is built from, and what a list of rows that are otherwise
 * identical can be keyed on.
 */
export interface RecordedDecision extends Decision {
  readonly id: number;
}

export interface DecisionQuery {
  readonly limit: number;
  /**
   * Where the previous page ended, as `<at>:<id>`.
   *
   * The key is in it because this table takes a decision on every repository
   * access, so several land in the same millisecond as a matter of course, and
   * a cursor that was only a time would either repeat one of them or skip one.
   * Opaque to whoever holds it, which passes back what it was given.
   */
  readonly before?: string;
}

export interface DecisionPage {
  readonly decisions: RecordedDecision[];
  /** Where to carry on from, absent when this is the end. */
  readonly cursor?: string;
}

/**
 * A page of the decisions, newest first.
 *
 * The same order {@link listDecisions} reads in and for the same reason, but
 * bounded by a cursor rather than by a number that has to be raised every time
 * somebody wants to look further back. One row more than asked for is read,
 * which is how "is there more" is answered without counting a table that is
 * being written to on every repository access.
 */
export function pageDecisions(database: DatabaseSync, query: DecisionQuery): DecisionPage {
  const conditions: string[] = [];
  const values: number[] = [];
  const cursor = parseDecisionCursor(query.before);
  if (cursor !== undefined) {
    conditions.push("(at < ? OR (at = ? AND id < ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = database
    .prepare(
      "SELECT id, at, username, resource, allowed, detail FROM decisions " +
        `${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")} `}` +
        "ORDER BY at DESC, id DESC LIMIT ?",
    )
    .all(...values, query.limit + 1);

  const decisions = rows
    .slice(0, query.limit)
    .map((row) => ({ id: integerColumn(row, "id"), ...toDecision(row) }));
  const last = decisions.at(-1);
  return {
    decisions,
    ...(rows.length > query.limit && last !== undefined
      ? { cursor: `${last.at}:${last.id}` }
      : {}),
  };
}

function parseDecisionCursor(
  value: string | undefined,
): { readonly at: number; readonly id: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const at = Number(value.slice(0, separator));
  const key = value.slice(separator + 1);
  const id = Number(key);
  // A cursor nobody can read is treated as no cursor rather than as a refusal:
  // it came from this server, so one that does not parse is a caller that lost
  // its place, and the first page is where somebody who lost their place is.
  // `key` is checked for being written at all, because an empty string reads as
  // nought rather than as nothing.
  return key !== "" && Number.isInteger(at) && Number.isInteger(id) ? { at, id } : undefined;
}
