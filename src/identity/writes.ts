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
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn } from "./database.js";

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

/** The write under this key, or undefined for one that has not happened. */
export function findWrite(database: DatabaseSync, key: WriteKey): RecordedWrite | undefined {
  const row = database
    .prepare(
      "SELECT at, answer FROM client_writes WHERE account = ? AND method = ? AND client_id = ?",
    )
    .get(key.account, key.method, key.clientId);
  if (row === undefined) {
    return undefined;
  }
  const answer = optionalTextColumn(row, "answer");
  return { at: integerColumn(row, "at"), ...(answer === undefined ? {} : { answer }) };
}

/**
 * Note that this write happened.
 *
 * A key that is somehow already there is left as it was rather than overwritten:
 * two copies of one request racing each other is the very thing this table
 * exists for, and the first of them to arrive is the one that says what
 * happened.
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
       ON CONFLICT (account, method, client_id) DO NOTHING`,
    )
    .run(
      key.account,
      key.method,
      key.clientId,
      produced?.at ?? Date.now(),
      produced?.answer ?? null,
    );
}
