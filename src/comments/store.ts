/**
 * Conversations attached to places inside a project.
 *
 * This is the first thing this server stores that an author wrote. Everything
 * before it was an account or a fact about a repository, and both of those have
 * somewhere else they really live - a comment does not. It is server-side
 * content, it is not in the repository, and taking a project off this server
 * takes its conversations with it.
 *
 * **The anchor is opaque.** A thread names a document and, usually, something
 * inside that document. Both are strings Studio writes and Studio interprets;
 * this file stores them, indexes on them and compares them for equality. It does
 * not open the document, does not check the element exists, and does not refuse
 * a shape it has not seen. That is what lets Studio start anchoring comments to
 * a new kind of thing without a line changing here - see src/team/protocol.ts.
 *
 * Two rules that are not obvious and are worth stating once:
 *
 *  - **A withdrawn comment keeps its row.** The shape of a conversation is part
 *    of what the remaining comments mean, and a reply to nothing reads as a
 *    reply to whatever is now above it. So `deleted_at` is set and the body is
 *    emptied, rather than the row going away.
 *  - **A repeat is not a second row.** Every write takes a client id, and a
 *    write that arrives twice - the same client, the same id, over a socket that
 *    dropped between the request and the answer - returns the row it already
 *    made. That is the whole of what makes writing over a session safe to retry.
 *    The key is `(account, method, client id)`: the method is part of it so that
 *    one client id used for two different writes - opening a thread and replying
 *    to one - cannot be handed the wrong row.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  integerColumn,
  optionalIntegerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "../identity/database.js";
import { findUserById } from "../identity/users.js";
import { TEAM_METHODS } from "../team/protocol.js";
import type {
  TeamAnchor,
  TeamComment,
  TeamThread,
  TeamThreadKind,
  TeamThreadStatus,
} from "../team/protocol.js";

/** Every column of a thread, in one place so a reader and a writer cannot drift. */
const SELECT_THREAD = `SELECT id, project_id, document, element, revision, kind, status,
  created_by, created_at, updated_at, resolved_by, resolved_at FROM threads`;

const SELECT_COMMENT = `SELECT id, thread_id, author_id, body, suggestion, created_at,
  edited_at, deleted_at FROM comments`;

/** What a thread is, before its comments are counted. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly anchor: TeamAnchor;
  readonly kind: TeamThreadKind;
  readonly status: TeamThreadStatus;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedBy?: string;
  readonly resolvedAt?: number;
}

export interface CommentRecord {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly suggestion?: string;
  readonly createdAt: number;
  readonly editedAt?: number;
  readonly deletedAt?: number;
}

function toThread(row: Row): ThreadRecord {
  const document = optionalTextColumn(row, "document");
  const element = optionalTextColumn(row, "element");
  const revision = optionalTextColumn(row, "revision");
  const resolvedBy = optionalTextColumn(row, "resolved_by");
  const resolvedAt = optionalIntegerColumn(row, "resolved_at");
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    anchor: {
      ...(document === undefined ? {} : { document }),
      ...(element === undefined ? {} : { element }),
      ...(revision === undefined ? {} : { revision }),
    },
    kind: textColumn(row, "kind") as TeamThreadKind,
    status: textColumn(row, "status") as TeamThreadStatus,
    createdBy: textColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  };
}

function toComment(row: Row): CommentRecord {
  const suggestion = optionalTextColumn(row, "suggestion");
  const editedAt = optionalIntegerColumn(row, "edited_at");
  const deletedAt = optionalIntegerColumn(row, "deleted_at");
  return {
    id: textColumn(row, "id"),
    threadId: textColumn(row, "thread_id"),
    authorId: textColumn(row, "author_id"),
    body: textColumn(row, "body"),
    ...(suggestion === undefined ? {} : { suggestion }),
    createdAt: integerColumn(row, "created_at"),
    ...(editedAt === undefined ? {} : { editedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

/* -------------------------------------------------------------- writing */

export interface NewThread {
  readonly projectId: string;
  readonly anchor: TeamAnchor;
  readonly kind: TeamThreadKind;
  readonly createdBy: string;
  readonly body: string;
  readonly suggestion?: string;
  /** What the client called this write, so that a repeat of it is not a second thread. */
  readonly clientId?: string;
  readonly now: number;
}

/** A thread and its opening comment, and whether they were already there. */
export interface ThreadCreation {
  readonly thread: ThreadRecord;
  readonly comment: CommentRecord;
  /** True when this write had already happened and this is the row it made. */
  readonly repeated: boolean;
}

/**
 * Open a thread, with the comment that starts it.
 *
 * The two rows are written together or not at all: a thread whose opening
 * comment failed to write is a conversation with nothing in it, and every reader
 * would have to have an opinion about that shape.
 */
export function createThread(database: DatabaseSync, input: NewThread): ThreadCreation {
  // The stored client id carries the method, so a create cannot collide with a
  // reply or an overlay put that was given the same client id. The opening
  // comment gets its own key under the same method, since it shares the comments
  // table with replies.
  const threadKey =
    input.clientId === undefined ? null : `${TEAM_METHODS.threadsCreate}:${input.clientId}`;
  const openingKey =
    input.clientId === undefined ? null : `${TEAM_METHODS.threadsCreate}:${input.clientId}:opening`;
  if (input.clientId !== undefined) {
    const existing = database
      .prepare(`${SELECT_THREAD} WHERE created_by = ? AND client_id = ?`)
      .get(input.createdBy, threadKey);
    if (existing !== undefined) {
      const thread = toThread(existing);
      const opening = openingComment(database, thread.id);
      if (opening !== undefined) {
        return { thread, comment: opening, repeated: true };
      }
    }
  }

  const threadId = randomUUID();
  const commentId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO threads (id, project_id, document, element, revision, kind, status,
           created_by, created_at, updated_at, client_id)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        input.projectId,
        input.anchor.document ?? null,
        input.anchor.element ?? null,
        input.anchor.revision ?? null,
        input.kind,
        input.createdBy,
        input.now,
        input.now,
        threadKey,
      );
    database
      .prepare(
        `INSERT INTO comments (id, thread_id, author_id, body, suggestion, created_at, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commentId,
        threadId,
        input.createdBy,
        input.body,
        input.suggestion ?? null,
        input.now,
        openingKey,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    thread: requireThread(database, threadId),
    comment: requireComment(database, commentId),
    repeated: false,
  };
}

export interface NewComment {
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly suggestion?: string;
  readonly clientId?: string;
  readonly now: number;
}

/** Add a comment, and say whether this write had already happened. */
export function addComment(
  database: DatabaseSync,
  input: NewComment,
): { readonly comment: CommentRecord; readonly repeated: boolean } {
  // The method is part of the key, so a reply's client id lives in its own
  // namespace, apart from a created thread's opening comment in the same table.
  const commentKey =
    input.clientId === undefined ? null : `${TEAM_METHODS.threadsReply}:${input.clientId}`;
  if (input.clientId !== undefined) {
    const existing = database
      .prepare(`${SELECT_COMMENT} WHERE author_id = ? AND client_id = ?`)
      .get(input.authorId, commentKey);
    if (existing !== undefined) {
      return { comment: toComment(existing), repeated: true };
    }
  }

  const id = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO comments (id, thread_id, author_id, body, suggestion, created_at, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.authorId,
        input.body,
        input.suggestion ?? null,
        input.now,
        commentKey,
      );
    touch(database, input.threadId, input.now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { comment: requireComment(database, id), repeated: false };
}

/**
 * Mark a thread resolved, or open it again.
 *
 * Anybody may. Resolving is a statement about the conversation rather than about
 * the work, and a thread that only its author could close is a thread that
 * outlives whoever left.
 */
export function setThreadStatus(
  database: DatabaseSync,
  threadId: string,
  resolved: boolean,
  by: string,
  now: number,
): ThreadRecord {
  database
    .prepare(
      `UPDATE threads SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(resolved ? "resolved" : "open", resolved ? by : null, resolved ? now : null, now, threadId);
  return requireThread(database, threadId);
}

/** Change the wording of a comment that is already there. */
export function editComment(
  database: DatabaseSync,
  commentId: string,
  body: string,
  suggestion: string | undefined,
  now: number,
): CommentRecord {
  const comment = requireComment(database, commentId);
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("UPDATE comments SET body = ?, suggestion = ?, edited_at = ? WHERE id = ?")
      .run(body, suggestion ?? null, now, commentId);
    touch(database, comment.threadId, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return requireComment(database, commentId);
}

/**
 * Withdraw a comment.
 *
 * The body goes and the row stays, for the reason at the top of this file. A
 * second withdrawal is not an error: the state somebody asked for is the state
 * that is already there.
 */
export function deleteComment(
  database: DatabaseSync,
  commentId: string,
  now: number,
): CommentRecord {
  const comment = requireComment(database, commentId);
  if (comment.deletedAt !== undefined) {
    return comment;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("UPDATE comments SET body = '', suggestion = NULL, deleted_at = ? WHERE id = ?")
      .run(now, commentId);
    touch(database, comment.threadId, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return requireComment(database, commentId);
}

/** Say that something in this thread changed, so a list ordered by activity is right. */
function touch(database: DatabaseSync, threadId: string, now: number): void {
  database.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
}

/* -------------------------------------------------------------- reading */

export function findThread(database: DatabaseSync, id: string): ThreadRecord | undefined {
  const row = database.prepare(`${SELECT_THREAD} WHERE id = ?`).get(id);
  return row === undefined ? undefined : toThread(row);
}

export function findComment(database: DatabaseSync, id: string): CommentRecord | undefined {
  const row = database.prepare(`${SELECT_COMMENT} WHERE id = ?`).get(id);
  return row === undefined ? undefined : toComment(row);
}

/** Raised where a row was written a moment ago and has to be there. */
class MissingRowError extends Error {}

function requireThread(database: DatabaseSync, id: string): ThreadRecord {
  const thread = findThread(database, id);
  if (thread === undefined) {
    throw new MissingRowError(`thread ${id} was written and is not there`);
  }
  return thread;
}

function requireComment(database: DatabaseSync, id: string): CommentRecord {
  const comment = findComment(database, id);
  if (comment === undefined) {
    throw new MissingRowError(`comment ${id} was written and is not there`);
  }
  return comment;
}

/**
 * What one comment adds to an answer, in UTF-8 bytes.
 *
 * The two fields a client wrote, and nothing else. What is left over - an id, a
 * thread id, three timestamps - is the same handful of bytes on every comment
 * there is, and the count ceiling beside the byte one is what bounds that.
 */
function weighComment(comment: CommentRecord): number {
  return (
    Buffer.byteLength(comment.body, "utf-8") +
    (comment.suggestion === undefined ? 0 : Buffer.byteLength(comment.suggestion, "utf-8"))
  );
}

/**
 * What one thread adds to an answer, in UTF-8 bytes.
 *
 * A thread on a list is not the row: it carries the comment that opened it, and
 * that comment is nearly all of its weight - a body and, on a suggestion, up to
 * SUGGESTION_LIMIT beside it. The anchor is counted too, because three fields of
 * ANCHOR_FIELD_LIMIT each on however many rows a count ceiling allows is larger
 * than the bodies it was sitting beside.
 */
function weighThread(thread: ThreadRecord, opening: CommentRecord | undefined): number {
  const anchor = thread.anchor;
  return (
    Buffer.byteLength(anchor.document ?? "", "utf-8") +
    Buffer.byteLength(anchor.element ?? "", "utf-8") +
    Buffer.byteLength(anchor.revision ?? "", "utf-8") +
    (opening === undefined ? 0 : weighComment(opening))
  );
}

export interface CommentQuery {
  readonly limit: number;
  /**
   * The most the comments on one page may weigh.
   *
   * A second ceiling because the first one is not a bound on memory: a body may
   * be COMMENT_BODY_LIMIT and a suggestion beside it SUGGESTION_LIMIT, so a page
   * of the maximum count could be a hundred times the size of a page of
   * ordinary replies. Whichever of the two is reached first ends the page.
   */
  readonly limitBytes: number;
  /**
   * Where the previous page ended, as `<createdAt>:<id>`.
   *
   * Forwards, where a thread cursor goes back, because a conversation is read
   * in the order it was said. Two parts for the reason a thread cursor has two:
   * a reply can be written in the same millisecond as the one before it, and a
   * cursor that was only a time would either repeat one or skip one.
   */
  readonly after?: string;
}

export interface CommentPage {
  readonly comments: CommentRecord[];
  /** Where to carry on from, absent when the conversation ends here. */
  readonly cursor?: string;
}

/**
 * A page of one thread's comments, oldest first, withdrawn ones in their place.
 *
 * Read a row at a time rather than all at once, which is what makes the byte
 * ceiling worth having: a query that handed back every matching row and left the
 * ceiling to be applied afterwards would have held them all first, which is the
 * thing being bounded. One row past the page is read either way, which is how
 * "is there more" is answered without counting the table.
 */
export function threadComments(
  database: DatabaseSync,
  threadId: string,
  query: CommentQuery,
): CommentPage {
  const conditions: string[] = ["thread_id = ?"];
  const values: (string | number)[] = [threadId];
  const cursor = parseCursor(query.after);
  if (cursor !== undefined) {
    conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  values.push(query.limit + 1);

  const comments: CommentRecord[] = [];
  let bytes = 0;
  let more = false;
  for (const row of database
    .prepare(`${SELECT_COMMENT} WHERE ${conditions.join(" AND ")} ORDER BY created_at, id LIMIT ?`)
    .iterate(...values)) {
    if (comments.length === query.limit) {
      more = true;
      break;
    }
    const comment = toComment(row as Row);
    // The first comment of a page goes on it whatever it weighs, or a
    // conversation holding one reply larger than the budget would be a cursor
    // that never moved and a reader who could never read past it.
    if (comments.length > 0 && bytes + weighComment(comment) > query.limitBytes) {
      more = true;
      break;
    }
    bytes += weighComment(comment);
    comments.push(comment);
  }

  const last = comments.at(-1);
  return {
    comments,
    ...(more && last !== undefined ? { cursor: `${last.createdAt}:${last.id}` } : {}),
  };
}

function openingComment(database: DatabaseSync, threadId: string): CommentRecord | undefined {
  const row = database
    .prepare(`${SELECT_COMMENT} WHERE thread_id = ? ORDER BY created_at, id LIMIT 1`)
    .get(threadId);
  return row === undefined ? undefined : toComment(row);
}

export interface ThreadQuery {
  readonly projectId: string;
  /** Narrow to one document, and optionally to one thing inside it. */
  readonly document?: string;
  readonly element?: string;
  readonly status?: TeamThreadStatus;
  readonly limit: number;
  /**
   * The most the threads on one page may weigh.
   *
   * The count above bounds how many threads a page holds and says nothing about
   * how large each is. A thread on a list carries the comment that opened it,
   * and that comment may be COMMENT_BODY_LIMIT with SUGGESTION_LIMIT beside it,
   * so the count alone asks this server to compose an answer of well over ten
   * megabytes - the largest single answer any method here could produce.
   * Whichever of the two ceilings is reached first ends the page.
   */
  readonly limitBytes: number;
  /**
   * Where the previous page ended, as `<updatedAt>:<id>`.
   *
   * The id is in it because two threads can be touched in the same millisecond,
   * and a cursor that was only a time would either repeat one of them or skip
   * one. Opaque to the client, which passes back whatever it was given.
   */
  readonly before?: string;
}

/**
 * One thread on a page, with the comment that opened it already read.
 *
 * The opening comment is carried rather than looked up again because weighing a
 * thread means reading it: the byte ceiling is mostly a ceiling on opening
 * comments, so the page cannot decide where to stop without them. Handing it on
 * keeps the whole list to one read of each rather than a second one when the
 * answer is composed.
 */
export interface ThreadRow {
  readonly thread: ThreadRecord;
  /**
   * Absent only for a thread whose comments are all gone, which the writes here
   * never produce - a thread and its opening comment are written together.
   */
  readonly opening?: CommentRecord;
}

export interface ThreadPage {
  readonly threads: ThreadRow[];
  /** Where to carry on from, absent when this is the end. */
  readonly cursor?: string;
}

/**
 * A page of a project's threads, by what changed last.
 *
 * Newest activity first, because a panel showing conversations is showing what
 * is live rather than what is oldest.
 *
 * Read a row at a time rather than all at once, which is what makes the byte
 * ceiling worth having: a query that handed back every matching row and left the
 * ceiling to be applied afterwards would have held them all first - and read an
 * opening comment for each - which is the thing being bounded. One row past the
 * page is read either way, which is how "is there more" is answered without
 * counting the table.
 */
export function listThreads(database: DatabaseSync, query: ThreadQuery): ThreadPage {
  const conditions: string[] = ["project_id = ?"];
  const values: (string | number)[] = [query.projectId];

  if (query.document !== undefined) {
    conditions.push("document = ?");
    values.push(query.document);
  }
  if (query.element !== undefined) {
    conditions.push("element = ?");
    values.push(query.element);
  }
  if (query.status !== undefined) {
    conditions.push("status = ?");
    values.push(query.status);
  }
  const cursor = parseCursor(query.before);
  if (cursor !== undefined) {
    conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  values.push(query.limit + 1);

  const threads: ThreadRow[] = [];
  let bytes = 0;
  let more = false;
  for (const row of database
    .prepare(
      `${SELECT_THREAD} WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .iterate(...values)) {
    if (threads.length === query.limit) {
      more = true;
      break;
    }
    const thread = toThread(row as Row);
    const opening = openingComment(database, thread.id);
    // The first thread of a page goes on it whatever it weighs. A page that
    // could come back empty because one thread's suggestion was larger than the
    // whole budget would be a cursor that never moved, and a project whose
    // conversations nobody could read past it.
    if (threads.length > 0 && bytes + weighThread(thread, opening) > query.limitBytes) {
      more = true;
      break;
    }
    bytes += weighThread(thread, opening);
    threads.push({ thread, ...(opening === undefined ? {} : { opening }) });
  }

  const last = threads.at(-1)?.thread;
  return {
    threads,
    ...(more && last !== undefined ? { cursor: `${last.updatedAt}:${last.id}` } : {}),
  };
}

/**
 * A cursor as both lists here write one: a moment, a colon, and a row's id.
 *
 * One reader for both, because a client is handed cursors from two methods of
 * the same family and passes back whatever it was given; two spellings would be
 * two chances for one of them to stop round-tripping.
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

/** How many comments a thread holds, withdrawn ones included. */
export function countComments(database: DatabaseSync, threadId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM comments WHERE thread_id = ?")
    .get(threadId);
  return row === undefined ? 0 : integerColumn(row, "total");
}

/**
 * A project's conversations go when the project does, and nothing here does it.
 *
 * `threads.project_id` is a foreign key with `ON DELETE CASCADE` and the
 * database is opened with `PRAGMA foreign_keys = ON`, so forgetting a project
 * takes its threads and their comments with it in the same statement. Written
 * down because the absence of a function is not evidence of a decision, and the
 * next person looking for one should find this rather than write it.
 */

/* ------------------------------------------------------- what the wire sees */

/**
 * A username for an account id, remembered for as long as one answer is built.
 *
 * A page of threads names the same few people over and over, and every one of them would
 * otherwise be a row read. Per call rather than kept: an account renamed while a server
 * runs must not go on being called what it was.
 */
export function nameResolver(database: DatabaseSync): (userId: string) => string | undefined {
  const known = new Map<string, string | undefined>();
  return (userId) => {
    if (!known.has(userId)) {
      known.set(userId, findUserById(database, userId)?.username);
    }
    return known.get(userId);
  };
}

export function commentView(
  record: CommentRecord,
  nameOf: (userId: string) => string | undefined,
): TeamComment {
  const author = nameOf(record.authorId);
  return {
    id: record.id,
    thread: record.threadId,
    ...(author === undefined ? {} : { author }),
    body: record.body,
    ...(record.suggestion === undefined ? {} : { suggestion: record.suggestion }),
    createdAt: record.createdAt,
    ...(record.editedAt === undefined ? {} : { editedAt: record.editedAt }),
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
  };
}

/**
 * One thread as the protocol carries it, with its count and its opening comment.
 *
 * The opening comment is taken as an argument where the caller has it - a page
 * of threads has read one for every row in order to weigh it - and looked up
 * where it does not. Passing it on rather than reading it twice is what keeps a
 * list of two hundred threads to two hundred reads.
 */
export function threadView(
  database: DatabaseSync,
  record: ThreadRecord,
  nameOf: (userId: string) => string | undefined = nameResolver(database),
  known?: CommentRecord,
): TeamThread {
  const opening = known ?? openingComment(database, record.id);
  const createdBy = nameOf(record.createdBy);
  const resolvedBy = record.resolvedBy === undefined ? undefined : nameOf(record.resolvedBy);
  return {
    id: record.id,
    project: record.projectId,
    anchor: record.anchor,
    kind: record.kind,
    status: record.status,
    ...(createdBy === undefined ? {} : { createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    comments: countComments(database, record.id),
    ...(opening === undefined ? {} : { opening: commentView(opening, nameOf) }),
  };
}
