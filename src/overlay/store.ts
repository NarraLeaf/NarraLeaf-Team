/**
 * Things attached to a project at a revision, which are not in its repository.
 *
 * The conversations in ../comments/store.ts were the first content this server
 * held that an author wrote. This is the second, and the difference between them
 * is worth stating once because the two tables look alike:
 *
 *  - A **thread** is a conversation. It has a shape - who replied to whom, what
 *    was withdrawn, whether it was settled - and this server knows that shape
 *    because a person reads it.
 *  - An **overlay record** is a fact a client keeps beside a place in a project.
 *    This server knows its `kind` as a word to group by and its `body` as a
 *    string to hand back. What it means is entirely Studio's.
 *
 * They are not one table with a discriminator, because a thread's semantics -
 * replies, resolution, withdrawal that keeps its row - are exactly what a record
 * must not have. A record is put, replaced, and dropped, and that is all.
 *
 * **A record names the revision it was written against, and this file never
 * judges it.** Whether a note about a story row is still about anything is a
 * question about whether that row survived the revision after it, and the half
 * of this system that can answer it is the half holding the document. So the
 * store hands back what it has - the record's revision - and what this server
 * last read the project's head to be is added a layer up, in the method. The
 * client decides.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  integerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "../identity/database.js";
import { TEAM_METHODS } from "../team/protocol.js";
import type { TeamAnchor } from "../team/protocol.js";

const SELECT_RECORD = `SELECT id, project_id, revision, document, element, kind, body,
  author_id, instance, created_at, updated_at FROM overlay`;

/**
 * The most overlay records one project may hold.
 *
 * A bound on what one project can grow to, so that a client looping on
 * `overlay.put` costs one project rather than this server — the same argument
 * LIVE_SESSION_LIMIT makes about rooms, and it is stronger here because a room
 * ends with the process that held it and a record is on the disk until somebody
 * takes it off. Without this, an authenticated account may put sixty-four
 * kilobytes into this server's database as often as it likes, for as long as it
 * likes, and nothing anywhere says stop.
 *
 * **Twenty thousand, and the figure is reasoned from what an overlay is.** These
 * are marks against anchors in a document — a review note on a story row, a
 * translator's flag, something from a playtest — put while work is outstanding
 * and taken off with `overlay.drop` when it is dealt with. It is a working set
 * rather than a log that accumulates, so what has to fit under the ceiling is
 * the most a project can have open at one time, not the most it will ever have
 * written. Twenty thousand outstanding marks on one project is far past a team
 * working: it is ten reads of `overlay.list` at its own ceiling of two
 * thousand, so the whole of a project's overlay is still readable, and a
 * project that reaches it is one where something is writing rather than
 * somebody. **Biased generous deliberately**, because a team hitting this in
 * ordinary work would be worse than the hole it closes.
 *
 * What it bounds is what one account can make this server store: twenty
 * thousand records at OVERLAY_BODY_LIMIT each is a little over a gibibyte for
 * one project, which is a figure an operator can plan a disk around, where the
 * hole has no figure at all.
 */
export const PROJECT_OVERLAY_LIMIT = 20_000;

/**
 * Raised when a project has as many records as it may hold.
 *
 * The sentence names the way out, because there is one and it is the caller's
 * to take: a record is dropped, not aged out, and nothing on this server
 * decides which of somebody's marks has stopped mattering.
 */
export class TooManyOverlayRecordsError extends Error {
  constructor() {
    super(
      "this project holds as many overlay records as it may. Take some off with " +
        "overlay.drop — a record is kept until somebody drops it, so a project reaches " +
        "this by keeping marks rather than by having too much to say.",
    );
    this.name = "TooManyOverlayRecordsError";
  }
}

/** One row, before an author id is turned into a name. */
export interface OverlayRecord {
  readonly id: string;
  readonly projectId: string;
  readonly revision: string;
  readonly anchor: TeamAnchor;
  readonly kind: string;
  readonly body: string;
  readonly authorId: string;
  readonly instance?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toRecord(row: Row): OverlayRecord {
  const document = optionalTextColumn(row, "document");
  const element = optionalTextColumn(row, "element");
  const instance = optionalTextColumn(row, "instance");
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    revision: textColumn(row, "revision"),
    anchor: {
      ...(document === undefined ? {} : { document }),
      ...(element === undefined ? {} : { element }),
      revision: textColumn(row, "revision"),
    },
    kind: textColumn(row, "kind"),
    body: textColumn(row, "body"),
    authorId: textColumn(row, "author_id"),
    ...(instance === undefined ? {} : { instance }),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

/* -------------------------------------------------------------- reading */

/**
 * What to read, and every field of it is a narrowing rather than a requirement.
 *
 * A window opening asks for a whole project and gets the lot; a row on screen
 * asks for one element. Both are the same query with different columns pinned,
 * which is why there is one function rather than three.
 */
export interface OverlayQuery {
  readonly projectId: string;
  readonly document?: string;
  readonly element?: string;
  readonly kind?: string;
  /**
   * Only what was written against one revision.
   *
   * Rarely what a reader wants: the ordinary case is "everything attached to
   * this project, and I will decide what is stale". Here for the reader that
   * genuinely means one version, such as a comparison between two.
   */
  readonly revision?: string;
  readonly limit: number;
  /**
   * The most the records on one page may weigh.
   *
   * A second ceiling because the first one is not a bound on memory: a body may
   * be as large as the protocol lets one be, so a page of the maximum count
   * could be a hundred times the size of a page of ordinary records. Whichever
   * of the two is reached first ends the page.
   */
  readonly limitBytes: number;
  /**
   * Where the previous page ended, as `<updatedAt>:<id>`.
   *
   * The same two parts a thread cursor has, and for the same reason: two
   * records can be touched in the same millisecond, and a cursor that was only
   * a time would either repeat one of them or skip one. Opaque to the client,
   * which passes back whatever it was given.
   */
  readonly before?: string;
}

export interface OverlayPage {
  readonly records: OverlayRecord[];
  /** Where to carry on from, absent when this is the end. */
  readonly cursor?: string;
}

/**
 * What one record adds to an answer, in UTF-8 bytes.
 *
 * Everything a client wrote, rather than the body alone. The anchor is most of
 * the difference: three fields of ANCHOR_FIELD_LIMIT each, on however many
 * records the count ceiling allows, comes to several times the budget the bodies
 * were being held to - so weighing only bodies bounds the wrong half of the
 * answer. What is left out is the same handful of bytes on every record there
 * is - an id, a project id, two timestamps - and the count ceiling bounds that.
 */
function weigh(record: OverlayRecord): number {
  return (
    Buffer.byteLength(record.body, "utf-8") +
    Buffer.byteLength(record.anchor.document ?? "", "utf-8") +
    Buffer.byteLength(record.anchor.element ?? "", "utf-8") +
    Buffer.byteLength(record.revision, "utf-8") +
    Buffer.byteLength(record.kind, "utf-8") +
    Buffer.byteLength(record.instance ?? "", "utf-8")
  );
}

/**
 * A page of a project's overlay, newest change first.
 *
 * Read a row at a time rather than all at once, which is what makes the byte
 * ceiling worth having: a query that handed back every matching row and left
 * the ceiling to be applied afterwards would have held them all first, which is
 * the thing being bounded.
 */
export function listOverlay(database: DatabaseSync, query: OverlayQuery): OverlayPage {
  const clauses = ["project_id = ?"];
  const values: (string | number)[] = [query.projectId];
  // `document` and `element` are compared with IS rather than =, because a
  // record about the project itself has no document and SQL's = never matches a
  // null. Asking for "the project-level records" is a real question and it must
  // not silently answer nothing.
  if (query.document !== undefined) {
    clauses.push("document IS ?");
    values.push(query.document);
  }
  if (query.element !== undefined) {
    clauses.push("element IS ?");
    values.push(query.element);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    values.push(query.kind);
  }
  if (query.revision !== undefined) {
    clauses.push("revision = ?");
    values.push(query.revision);
  }
  const cursor = parseCursor(query.before);
  if (cursor !== undefined) {
    clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  // One row past the page, which is how "is there more" is answered without
  // counting the table.
  values.push(query.limit + 1);

  const records: OverlayRecord[] = [];
  let bytes = 0;
  let more = false;
  for (const row of database
    .prepare(
      `${SELECT_RECORD} WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .iterate(...values)) {
    if (records.length === query.limit) {
      more = true;
      break;
    }
    const record = toRecord(row as Row);
    // The first record of a page goes on it whatever it weighs. A page that
    // could come back empty because one record is larger than the whole budget
    // would be a cursor that never moved, and a reader that could never get
    // past that record.
    if (records.length > 0 && bytes + weigh(record) > query.limitBytes) {
      more = true;
      break;
    }
    bytes += weigh(record);
    records.push(record);
  }

  const last = records.at(-1);
  return {
    records,
    ...(more && last !== undefined ? { cursor: `${last.updatedAt}:${last.id}` } : {}),
  };
}

/**
 * A cursor as this list writes one: a moment, a colon, and a row's id.
 *
 * The same shape the conversations next door use, so that a client reads every
 * cursor this server hands out the same way - as a string it was given and
 * passes back.
 */
function parseCursor(
  value: string | undefined,
): { readonly at: number; readonly id: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const at = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  // A cursor nobody can read is treated as no cursor rather than as a refusal:
  // it came from this server, so one that does not parse is a client that lost
  // its place, and the first page is where somebody who lost their place is.
  return Number.isInteger(at) && id !== "" ? { at, id } : undefined;
}

export function findOverlay(database: DatabaseSync, id: string): OverlayRecord | undefined {
  const row = database.prepare(`${SELECT_RECORD} WHERE id = ?`).get(id);
  return row === undefined ? undefined : toRecord(row as Row);
}

/* -------------------------------------------------------------- writing */

export interface OverlayWrite {
  readonly projectId: string;
  readonly revision: string;
  readonly anchor: TeamAnchor;
  readonly kind: string;
  readonly body: string;
  readonly authorId: string;
  readonly instance?: string;
  /** What the client called this write, so a repeat of it is not a second row. */
  readonly clientId?: string;
  readonly now: number;
}

/** A record, and whether this write had already happened. */
export interface OverlayWritten {
  readonly record: OverlayRecord;
  readonly repeated: boolean;
}

/**
 * Attach something, or answer with the row a repeated write already made.
 *
 * The idempotency is the same bargain the comment store strikes and it exists
 * for the same measured reason: a write travels over a socket that can drop
 * between the request and the answer, and a client that retries must not double
 * what it wrote. Same client id, same author - same row.
 */
export function putOverlay(database: DatabaseSync, input: OverlayWrite): OverlayWritten {
  // The stored client id carries the method, so an overlay put's key cannot be
  // matched by a write of some other method that was given the same client id.
  const clientKey =
    input.clientId === undefined ? null : `${TEAM_METHODS.overlayPut}:${input.clientId}`;
  if (input.clientId !== undefined) {
    const existing = database
      .prepare(`${SELECT_RECORD} WHERE author_id = ? AND client_id = ?`)
      .get(input.authorId, clientKey);
    if (existing !== undefined) {
      return { record: toRecord(existing as Row), repeated: true };
    }
  }

  // Counted after the repeat has been answered, so a retry of a write that
  // already landed is never the call refused - a client whose socket dropped
  // mid-answer must not be told the project is full because of its own row.
  // The count is a walk of one project's rows in overlay_by_project, which is
  // the same read `overlay.list` already makes to say how many there are.
  if (countOverlay(database, input.projectId) >= PROJECT_OVERLAY_LIMIT) {
    throw new TooManyOverlayRecordsError();
  }

  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO overlay (id, project_id, revision, document, element, kind, body,
         author_id, instance, created_at, updated_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.revision,
      input.anchor.document ?? null,
      input.anchor.element ?? null,
      input.kind,
      input.body,
      input.authorId,
      input.instance ?? null,
      input.now,
      input.now,
      clientKey,
    );
  return { record: require_(database, id), repeated: false };
}

/**
 * Replace what one record holds, and move it to the revision it now describes.
 *
 * The anchor's place cannot move: a record that changed which element it was
 * about would be a different record, and every reader holding it by anchor would
 * have to be told. What may move is the revision, because **that is what
 * following the head means** - a client that has looked and found the thing
 * still there says so by putting the record forward, and this is the write that
 * does it. Nothing here decides that on its own: this server cannot read the
 * document, so it cannot know.
 */
export function reviseOverlay(
  database: DatabaseSync,
  id: string,
  input: { readonly body: string; readonly revision: string; readonly now: number },
): OverlayRecord {
  database
    .prepare("UPDATE overlay SET body = ?, revision = ?, updated_at = ? WHERE id = ?")
    .run(input.body, input.revision, input.now, id);
  return require_(database, id);
}

/**
 * Take a record away, for good.
 *
 * A hard delete where a withdrawn comment keeps its row, and the difference is
 * not inconsistency: a conversation has a shape that a missing reply would
 * change the meaning of, and a record has none. Nothing reads a record's
 * neighbours, so nothing is owed a gap where one used to be.
 */
export function dropOverlay(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM overlay WHERE id = ?").run(id);
}

/**
 * How many records one project holds.
 *
 * Two callers: the count a list carries beside a narrowed read, and the ceiling
 * a put is admitted under. One query for both, so the number an operator is
 * shown and the number a refusal is decided by cannot come to differ.
 */
export function countOverlay(database: DatabaseSync, projectId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM overlay WHERE project_id = ?")
    .get(projectId);
  return row === undefined ? 0 : integerColumn(row as Row, "total");
}

function require_(database: DatabaseSync, id: string): OverlayRecord {
  const record = findOverlay(database, id);
  if (record === undefined) {
    // The row was written in this call. Anything else is the database having
    // lost it between two statements, which is not a case to paper over.
    throw new Error(`the overlay record ${id} was written and could not be read back`);
  }
  return record;
}
