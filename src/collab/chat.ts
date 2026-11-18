/**
 * A project's channel: what its members write to each other, kept in order.
 *
 * The other half of talking in a project. A live session's chat (src/team/
 * methods/live.ts) reaches only whoever is in the room and is forgotten; this
 * is written down, read back a page at a time, and seen by every member - the
 * place to say something to the team rather than to whoever is online.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import { CHAT_BODY_LIMIT, type TeamChatMessage } from "../team/protocol.js";

export class ChatRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

interface ChatRecord {
  readonly id: number;
  readonly projectId: string;
  readonly authorId: string | undefined;
  readonly body: string;
  readonly at: number;
  readonly deletedAt: number | undefined;
}

function toRecord(row: Row): ChatRecord {
  return {
    id: integerColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    authorId: optionalTextColumn(row, "author_id"),
    body: textColumn(row, "body"),
    at: integerColumn(row, "at"),
    deletedAt: optionalIntegerColumn(row, "deleted_at"),
  };
}

export function chatView(database: DatabaseSync, record: ChatRecord): TeamChatMessage {
  const author = record.authorId === undefined ? undefined : findUserById(database, record.authorId)?.username;
  return {
    id: record.id,
    project: record.projectId,
    ...(author === undefined ? {} : { author }),
    body: record.deletedAt === undefined ? record.body : "",
    at: record.at,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
  };
}

/** A page of a project's channel, newest first, before `before` when given. */
export function listChat(
  database: DatabaseSync,
  viewer: UserRecord,
  projectId: string,
  options: { before?: number; limit: number },
): { messages: TeamChatMessage[]; cursor?: number } {
  if (!maySeeProject(database, projectId, viewer)) throw new ChatRefusal("not-found", "there is no project of that id on this server");
  const rows = (
    options.before === undefined
      ? database.prepare("SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, options.limit + 1)
      : database.prepare("SELECT * FROM chat_messages WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(projectId, options.before, options.limit + 1)
  ) as Row[];
  const records = rows.slice(0, options.limit).map(toRecord);
  const last = records[records.length - 1];
  return {
    messages: records.map((record) => chatView(database, record)),
    ...(rows.length > options.limit && last !== undefined ? { cursor: last.id } : {}),
  };
}

/** Write a message. A viewer reads the project and does not write in it, as with comments. */
export function sendChat(database: DatabaseSync, author: UserRecord, projectId: string, body: string, now = Date.now()): TeamChatMessage {
  const role = projectRole(database, projectId, author);
  if (role === undefined) throw new ChatRefusal("not-found", "there is no project of that id on this server");
  if (role === "viewer") throw new ChatRefusal("refused", "a viewer reads this project and does not write in its channel");
  const text = body.trim();
  if (text === "") throw new ChatRefusal("bad-params", "a message has something in it");
  if (Buffer.byteLength(text, "utf-8") > CHAT_BODY_LIMIT) throw new ChatRefusal("bad-params", `a message is at most ${CHAT_BODY_LIMIT} bytes`);
  const result = database
    .prepare("INSERT INTO chat_messages (project_id, author_id, body, at, deleted_at) VALUES (?, ?, ?, ?, NULL)")
    .run(projectId, author.id, text, now);
  const row = database.prepare("SELECT * FROM chat_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as Row;
  return chatView(database, toRecord(row));
}

/** Take back one's own message. The row stays, emptied, so replies still read in order. */
export function deleteChat(database: DatabaseSync, actor: UserRecord, id: number, now = Date.now()): ChatRecord {
  const row = database.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as Row | undefined;
  const record = row === undefined ? undefined : toRecord(row);
  if (record === undefined || !maySeeProject(database, record.projectId, actor)) {
    throw new ChatRefusal("not-found", "there is no message of that id");
  }
  if (record.authorId !== actor.id) throw new ChatRefusal("refused", "only whoever wrote a message may take it back");
  database.prepare("UPDATE chat_messages SET deleted_at = ?, body = '' WHERE id = ?").run(now, id);
  return { ...record, deletedAt: now, body: "" };
}
