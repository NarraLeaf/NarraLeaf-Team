/**
 * Writes a client named, so that a repeat of one is not a second one.
 *
 * A call travels over a socket that can drop between the request and the
 * answer, and a client that never saw the answer retries. Four writes on this
 * server already survive that, and each of them does it out of the row it made:
 * a thread, a comment, an overlay record and a project all carry a `client_id`
 * column, so "have I done this already" is answered by looking for the row —
 * see src/comments/store.ts, src/overlay/store.ts and src/projects/create.ts.
 *
 * The writes an operator makes have no such row. Disabling an account does not
 * create anything to hang a client id on, changing a setting replaces a value,
 * and rotating a key writes a file. So the note is kept apart from the effect,
 * here, and this table is the whole of it.
 *
 * **The key is `(account, method, clientId)`, all three.** The account, because
 * one client's id is its own and must not match somebody else's. The method,
 * because a client that reuses one id across two different writes would
 * otherwise be told about the wrong one — a replayed `disable` answering about
 * the `enable` that shared its id is worse than doing the work twice. That is
 * the same rule the three stores above are keyed by, and it is written down
 * once more here because this is the place a fourth kind of write will reach
 * for.
 *
 * The note is written **after** the effect, not before. A process that died
 * between the two would let a replay act a second time, which is the same
 * window a crash between the effect and the answer already opens; claiming the
 * key first would trade it for the opposite failure — a write nothing did that
 * can never be retried — and that one cannot be recovered from by asking again.
 *
 * **A note does not outlive the retry it protects.** See
 * {@link CLIENT_WRITE_RETENTION_MS}: past that age a note is neither read nor
 * kept, because a caller sending the same id a long time later is not repeating
 * itself, it means it.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn } from "./database.js";

/**
 * How long a note is worth keeping.
 *
 * What the note protects is a **retry**: a call whose answer never arrived
 * because the socket dropped between the request and it, sent again by a client
 * that cannot tell "it did not happen" from "it happened and I did not hear".
 * That is seconds normally, minutes across a reconnection, and at the outside a
 * laptop closed with the call still queued and opened the next morning. A day
 * covers all of it with room to spare.
 *
 * Past that, remembering is not a kindness but a bug, and it is the reason for
 * this constant rather than the growth of the table. An id remembered forever
 * is an id that can never be used again: a client that numbers its writes and
 * starts over — a fresh install, a counter reset, an operator scripting against
 * the same names — sends one this server has seen, and is answered as though
 * the write had just happened when nothing did. Silently, and only for that one
 * write. A day is long past anything that is genuinely a repeat and far short
 * of the interval at which reuse is ordinary.
 *
 * The table stops growing as a consequence rather than as the point. Bounded by
 * what a team's operators can do in a day, it is a few dozen rows on a busy
 * deployment.
 */
export const CLIENT_WRITE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How many writes go by between one prune and the next.
 *
 * Pruned **on the write path and never on a timer**. A timer would be this
 * server waking up to do nothing on an idle deployment, which is a cost it has
 * paid before and will not pay again; a prune on every write would be a `DELETE`
 * to remove nothing on almost all of them.
 *
 * A hundred is far smaller than the five hundred the decisions table uses,
 * because these two paths are not comparable: a decision is written on every
 * repository access and one of these is written per management action a person
 * takes. A hundred management actions is a long afternoon of administering a
 * server, and the delete they eventually pay for is a scan of a table this
 * constant is what keeps small.
 */
export const CLIENT_WRITE_TRIM_SLACK = 100;

/**
 * Writes made on each connection since it last pruned.
 *
 * Against the connection rather than in a plain counter, so that a second
 * database — a test's, or a second Team in the same process — is counted
 * separately and nothing is kept alive by being counted. This is the same
 * arrangement `trimDecisions` is called under in ./audit.ts, for the same
 * reasons.
 *
 * A connection that has never pruned counts as due, so a server that takes
 * twenty management actions a day and is restarted nightly prunes once per run
 * rather than never.
 */
const writesSinceTrim = new WeakMap<DatabaseSync, number>();

/** A write that has already happened. */
export interface RecordedWrite {
  /** When it happened. */
  readonly at: number;
  /**
   * What it produced that cannot be worked out again, as JSON, where there was
   * any.
   *
   * Absent for almost everything, and deliberately so: the answer to a repeated
   * write is normally the record as it stands **now**, re-read rather than
   * replayed, because a stored copy would be a snapshot that has since been
   * overtaken — an account disabled and then made an operator would answer a
   * second `disable` with a record that says it is not one. The exception is a
   * write whose answer is not a record at all and cannot be looked up again;
   * see `admin.tokens.mint` in src/team/methods/admin.ts.
   */
  readonly answer?: string;
}

/** What names one write. */
export interface WriteKey {
  /** The account that asked for it, by id. */
  readonly account: string;
  /** The method it was asked of, which is why one client id can serve two writes. */
  readonly method: string;
  /** What the client called it. */
  readonly clientId: string;
}

/**
 * The write under this key, or undefined for one that has not happened.
 *
 * A note past {@link CLIENT_WRITE_RETENTION_MS} answers undefined, exactly as a
 * missing one does. The age is asked here rather than left to the prune because
 * the prune is opportunistic: a note that outlived its window until the next
 * hundred writes came along would go on swallowing a call in the meantime, and
 * the window is the rule while the prune is only the housekeeping that follows
 * it.
 */
export function findWrite(database: DatabaseSync, key: WriteKey): RecordedWrite | undefined {
  const row = database
    .prepare(
      "SELECT at, answer FROM client_writes " +
        "WHERE account = ? AND method = ? AND client_id = ? AND at >= ?",
    )
    .get(key.account, key.method, key.clientId, Date.now() - CLIENT_WRITE_RETENTION_MS);
  if (row === undefined) {
    return undefined;
  }
  const answer = optionalTextColumn(row, "answer");
  return { at: integerColumn(row, "at"), ...(answer === undefined ? {} : { answer }) };
}

/** How many notes are on record, whether or not they are still worth reading. */
export function countWrites(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM client_writes").get();
  return row === undefined ? 0 : integerColumn(row, "count");
}

/**
 * Drop every note older than the window, and answer with how many that removed.
 *
 * A scan rather than an index seek: there is no index on `at`, and there is no
 * point in one. The table is bounded by a day of management actions precisely
 * because this runs, so what it walks is a few dozen rows on a deployment being
 * administered hard.
 */
export function trimWrites(database: DatabaseSync): number {
  const removed = database
    .prepare("DELETE FROM client_writes WHERE at < ?")
    .run(Date.now() - CLIENT_WRITE_RETENTION_MS);
  return Number(removed.changes);
}

/**
 * Note that this write happened.
 *
 * A key that is somehow already there is left as it was rather than overwritten:
 * two copies of one request racing each other is the very thing this table
 * exists for, and the first of them to arrive is the one that says what
 * happened.
 *
 * A note that has **lapsed** is taken over rather than left alone, and that is
 * the difference between the two clauses below. The prune is opportunistic, so
 * the row under a reused id is usually still sitting there when the id comes
 * round again; leaving it would keep the new write's note at the old moment,
 * and the genuine retry of *this* call would find a note already too old to
 * read. A write nothing remembers is the failure this table exists to prevent,
 * so the row is rewritten wherever it was past reading anyway.
 */
export function recordWrite(
  database: DatabaseSync,
  key: WriteKey,
  produced?: { readonly answer?: string; readonly at?: number },
): void {
  database
    .prepare(
      `INSERT INTO client_writes (account, method, client_id, at, answer)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account, method, client_id) DO UPDATE
         SET at = excluded.at, answer = excluded.answer
         WHERE client_writes.at < ?`,
    )
    .run(
      key.account,
      key.method,
      key.clientId,
      produced?.at ?? Date.now(),
      produced?.answer ?? null,
      Date.now() - CLIENT_WRITE_RETENTION_MS,
    );

  // Once in CLIENT_WRITE_TRIM_SLACK writes, on the write path, because adding a
  // row is the only thing that can make this table need pruning.
  const since = (writesSinceTrim.get(database) ?? CLIENT_WRITE_TRIM_SLACK) + 1;
  if (since > CLIENT_WRITE_TRIM_SLACK) {
    trimWrites(database);
    writesSinceTrim.set(database, 0);
    return;
  }
  writesSinceTrim.set(database, since);
}
