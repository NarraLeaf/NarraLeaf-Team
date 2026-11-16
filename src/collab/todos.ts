/**
 * To-dos: an owner's list, optionally assigned, optionally a project's.
 *
 * Visibility is the server's to enforce, not the page's to hide: a private
 * to-do is answered to its owner and nobody else — not to the assignee, which
 * is why a private to-do cannot have one — and a project to-do to the members
 * of its project. An anchor (`document` / `element` / `revision`) is carried
 * in the same terms a thread's is, and never parsed.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole, visibleProjectIds } from "../projects/members.js";
import type { TeamTodo, TeamTodoKind, TeamTodoStatus, TeamTodoVisibility } from "../team/protocol.js";

export const TODO_STATUSES: readonly TeamTodoStatus[] = ["open", "doing", "done"];
export const TODO_VISIBILITIES: readonly TeamTodoVisibility[] = ["private", "project"];
export const TODO_KINDS: readonly TeamTodoKind[] = ["task", "asset", "translation", "voice"];

/** One to-do as stored, with ids rather than usernames. */
export interface TodoRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly assigneeId: string | undefined;
  readonly projectId: string | undefined;
  readonly document: string | undefined;
  readonly element: string | undefined;
  readonly revision: string | undefined;
  readonly title: string;
  readonly body: string | undefined;
  readonly status: TeamTodoStatus;
  readonly visibility: TeamTodoVisibility;
  readonly dueAt: number | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly doneAt: number | undefined;
  /** The revision that finished it, where one did. */
  readonly doneRevision: string | undefined;
  readonly kind: TeamTodoKind;
  readonly locale: string | undefined;
  readonly asset: string | undefined;
  readonly labels: readonly string[];
  /** The milestone of its project it counts toward. */
  readonly milestoneId: string | undefined;
}

/** Why a to-do could not be written, in the caller's terms. */
export class TodoRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

function readLabels(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === "string") : [];
  } catch {
    return [];
  }
}

function writeLabels(labels: readonly string[] | undefined): string | null {
  return labels === undefined || labels.length === 0 ? null : JSON.stringify(labels);
}

function toRecord(row: Row): TodoRecord {
  const status = textColumn(row, "status");
  const visibility = textColumn(row, "visibility");
  return {
    id: textColumn(row, "id"),
    ownerId: textColumn(row, "owner_id"),
    assigneeId: optionalTextColumn(row, "assignee_id"),
    projectId: optionalTextColumn(row, "project_id"),
    document: optionalTextColumn(row, "document"),
    element: optionalTextColumn(row, "element"),
    revision: optionalTextColumn(row, "revision"),
    title: textColumn(row, "title"),
    body: optionalTextColumn(row, "body"),
    status: (TODO_STATUSES as readonly string[]).includes(status) ? (status as TeamTodoStatus) : "open",
    // Unknown reads as the narrower one: a row written by a newer Team must not show more.
    visibility: visibility === "project" ? "project" : "private",
    dueAt: optionalIntegerColumn(row, "due_at"),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
    doneAt: optionalIntegerColumn(row, "done_at"),
    doneRevision: optionalTextColumn(row, "done_revision"),
    // Unknown reads as a plain task: a kind written by a newer Team is still a to-do.
    kind: (TODO_KINDS as readonly string[]).includes(textColumn(row, "kind")) ? (textColumn(row, "kind") as TeamTodoKind) : "task",
    locale: optionalTextColumn(row, "locale"),
    asset: optionalTextColumn(row, "asset"),
    labels: readLabels(optionalTextColumn(row, "labels")),
    milestoneId: optionalTextColumn(row, "milestone_id"),
  };
}

export function findTodo(database: DatabaseSync, id: string): TodoRecord | undefined {
  const row = database.prepare("SELECT * FROM todos WHERE id = ?").get(id);
  return row === undefined ? undefined : toRecord(row as Row);
}

/** Whether a viewer may see a to-do at all. */
export function maySeeTodo(database: DatabaseSync, todo: TodoRecord, viewer: UserRecord): boolean {
  if (todo.ownerId === viewer.id) return true;
  if (todo.visibility === "private") return false;
  if (todo.assigneeId === viewer.id) return true;
  return todo.projectId !== undefined && maySeeProject(database, todo.projectId, viewer);
}

/**
 * The accounts whose own to-do topic a change is told on: the owner, and the
 * assignee of a project to-do. A project to-do is also told on the project's
 * topic, which only its members can hold.
 */
export function todoAccounts(todo: TodoRecord): Set<string> {
  const accounts = new Set([todo.ownerId]);
  if (todo.visibility === "project" && todo.assigneeId !== undefined) accounts.add(todo.assigneeId);
  return accounts;
}

export function todoView(database: DatabaseSync, todo: TodoRecord): TeamTodo {
  const owner = findUserById(database, todo.ownerId);
  const assignee = todo.assigneeId === undefined ? undefined : findUserById(database, todo.assigneeId);
  return {
    id: todo.id,
    owner: owner?.username ?? "?",
    ...(assignee === undefined ? {} : { assignee: assignee.username }),
    ...(todo.projectId === undefined ? {} : { project: todo.projectId }),
    ...(todo.document !== undefined && todo.element !== undefined
      ? { anchor: { document: todo.document, element: todo.element, ...(todo.revision === undefined ? {} : { revision: todo.revision }) } }
      : {}),
    title: todo.title,
    ...(todo.body === undefined ? {} : { body: todo.body }),
    status: todo.status,
    visibility: todo.visibility,
    ...(todo.dueAt === undefined ? {} : { dueAt: todo.dueAt }),
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    ...(todo.doneAt === undefined ? {} : { doneAt: todo.doneAt }),
    ...(todo.doneRevision === undefined ? {} : { doneRevision: todo.doneRevision }),
    kind: todo.kind,
    ...(todo.locale === undefined ? {} : { locale: todo.locale }),
    ...(todo.asset === undefined ? {} : { asset: todo.asset }),
    ...(todo.labels.length === 0 ? {} : { labels: todo.labels }),
    ...(todo.milestoneId === undefined ? {} : { milestone: todo.milestoneId }),
  };
}

export interface TodoInput {
  readonly title?: string;
  readonly body?: string | null;
  readonly projectId?: string | null;
  readonly assigneeId?: string | null;
  readonly visibility?: TeamTodoVisibility;
  readonly status?: TeamTodoStatus;
  readonly dueAt?: number | null;
  readonly anchor?: { document: string; element: string; revision?: string } | null;
  /** The revision that finishes it. Only with `status: "done"`, and only on a project's to-do. */
  readonly doneRevision?: string;
  readonly kind?: TeamTodoKind;
  readonly locale?: string | null;
  /** The asset that answered an asset request. */
  readonly asset?: string | null;
  readonly labels?: readonly string[];
  /** The milestone it counts toward, of the same project; `null` takes it off. */
  readonly milestoneId?: string | null;
}

/** Check that a to-do's shape holds together, for the caller making it so. */
function checkShape(
  database: DatabaseSync,
  actor: UserRecord,
  shape: {
    projectId: string | undefined;
    assigneeId: string | undefined;
    visibility: TeamTodoVisibility;
    anchored: boolean;
    kind: TeamTodoKind;
    locale: string | undefined;
    milestoneId?: string | undefined;
  },
): void {
  if (shape.projectId !== undefined && !maySeeProject(database, shape.projectId, actor)) {
    throw new TodoRefusal("not-found", "there is no project of that id on this server");
  }
  if (shape.visibility === "project" && shape.projectId === undefined) {
    throw new TodoRefusal("bad-params", "a to-do shown to a project has to be in one");
  }
  if (shape.kind !== "task" && shape.projectId === undefined) {
    throw new TodoRefusal("bad-params", "an asset, translation or voice to-do belongs to a project");
  }
  if ((shape.kind === "translation" || shape.kind === "voice") && shape.locale === undefined) {
    throw new TodoRefusal("bad-params", "a translation or voice to-do names its locale");
  }
  if (shape.milestoneId !== undefined) {
    const milestone = database.prepare("SELECT project_id FROM milestones WHERE id = ?").get(shape.milestoneId) as Row | undefined;
    if (milestone === undefined || shape.projectId === undefined || textColumn(milestone, "project_id") !== shape.projectId) {
      throw new TodoRefusal("bad-params", "a to-do counts toward a milestone of its own project");
    }
  }
  if (shape.anchored && shape.projectId === undefined) {
    throw new TodoRefusal("bad-params", "an anchored to-do has to be in the project it points into");
  }
  if (shape.assigneeId !== undefined && shape.assigneeId !== actor.id) {
    if (shape.visibility === "private") {
      throw new TodoRefusal("bad-params", "a private to-do cannot be given to somebody else; show it to the project first");
    }
    const assignee = findUserById(database, shape.assigneeId);
    if (assignee === undefined || shape.projectId === undefined || !maySeeProject(database, shape.projectId, assignee)) {
      throw new TodoRefusal("bad-params", "that account is not a member of the project");
    }
  }
}

export function createTodo(database: DatabaseSync, actor: UserRecord, input: TodoInput & { title: string }, now = Date.now()): TodoRecord {
  const projectId = input.projectId ?? undefined;
  const assigneeId = input.assigneeId ?? undefined;
  const visibility = input.visibility ?? "private";
  const anchor = input.anchor ?? undefined;
  if (input.doneRevision !== undefined) {
    throw new TodoRefusal("bad-params", "a to-do is finished by a revision after it is made, with todos.update");
  }
  const kind = input.kind ?? "task";
  const locale = input.locale ?? undefined;
  const milestoneId = input.milestoneId ?? undefined;
  checkShape(database, actor, { projectId, assigneeId, visibility, anchored: anchor !== undefined, kind, locale, milestoneId });
  const status = input.status ?? "open";
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO todos (id, owner_id, assignee_id, project_id, document, element, revision, title, body, status,
                          visibility, due_at, created_at, updated_at, done_at, kind, locale, asset, labels, milestone_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      actor.id,
      assigneeId ?? null,
      projectId ?? null,
      anchor?.document ?? null,
      anchor?.element ?? null,
      anchor?.revision ?? null,
      input.title,
      input.body ?? null,
      status,
      visibility,
      input.dueAt ?? null,
      now,
      now,
      status === "done" ? now : null,
      kind,
      locale ?? null,
      input.asset ?? null,
      writeLabels(input.labels),
      milestoneId ?? null,
    );
  return findTodo(database, id) as TodoRecord;
}

/**
 * Change a to-do. Its owner may change anything; its assignee may move its
 * status and nothing else; a project owner may tidy a project to-do as its
 * owner could. Anybody else is refused.
 */
export function updateTodo(database: DatabaseSync, actor: UserRecord, id: string, input: TodoInput, now = Date.now()): TodoRecord {
  const current = findTodo(database, id);
  if (current === undefined || !maySeeTodo(database, current, actor)) {
    throw new TodoRefusal("not-found", "there is no to-do of that id");
  }
  const owns =
    current.ownerId === actor.id ||
    (current.visibility === "project" && current.projectId !== undefined && projectRole(database, current.projectId, actor) === "owner");
  // Finishing it in a commit is still only moving its status, so an assignee may say which.
  const onlyStatus = Object.keys(input).every((key) => key === "status" || key === "doneRevision" || key === "asset");
  if (!owns && !(current.assigneeId === actor.id && onlyStatus)) {
    throw new TodoRefusal("refused", "only its owner may change this to-do; its assignee may change its status");
  }
  const next = {
    projectId: input.projectId === undefined ? current.projectId : (input.projectId ?? undefined),
    assigneeId: input.assigneeId === undefined ? current.assigneeId : (input.assigneeId ?? undefined),
    visibility: input.visibility ?? current.visibility,
    anchor:
      input.anchor === undefined
        ? current.document !== undefined && current.element !== undefined
          ? { document: current.document, element: current.element, ...(current.revision === undefined ? {} : { revision: current.revision }) }
          : undefined
        : (input.anchor ?? undefined),
  };
  const kind = input.kind ?? current.kind;
  const locale = input.locale === undefined ? current.locale : (input.locale ?? undefined);
  // A to-do moved to another project leaves its milestone behind.
  const milestoneId =
    input.milestoneId === undefined ? (next.projectId === current.projectId ? current.milestoneId : undefined) : (input.milestoneId ?? undefined);
  checkShape(database, actor, { ...next, anchored: next.anchor !== undefined, kind, locale, milestoneId });
  const status = input.status ?? current.status;
  const doneAt = status === "done" ? (current.doneAt ?? now) : null;
  if (input.doneRevision !== undefined && (input.status !== "done" || next.projectId === undefined)) {
    throw new TodoRefusal("bad-params", "doneRevision goes with status done, on a project's to-do");
  }
  // Kept while it stays done; a to-do opened again was not finished by anything.
  const doneRevision = status === "done" ? (input.doneRevision ?? current.doneRevision) : undefined;
  database
    .prepare(
      `UPDATE todos SET assignee_id = ?, project_id = ?, document = ?, element = ?, revision = ?, title = ?, body = ?,
                        status = ?, visibility = ?, due_at = ?, updated_at = ?, done_at = ?, done_revision = ?,
                        kind = ?, locale = ?, asset = ?, labels = ?, milestone_id = ? WHERE id = ?`,
    )
    .run(
      next.assigneeId ?? null,
      next.projectId ?? null,
      next.anchor?.document ?? null,
      next.anchor?.element ?? null,
      next.anchor?.revision ?? null,
      input.title ?? current.title,
      input.body === undefined ? (current.body ?? null) : input.body,
      status,
      next.visibility,
      input.dueAt === undefined ? (current.dueAt ?? null) : input.dueAt,
      now,
      doneAt,
      doneRevision ?? null,
      kind,
      locale ?? null,
      input.asset === undefined ? (current.asset ?? null) : input.asset,
      input.labels === undefined ? writeLabels(current.labels) : writeLabels(input.labels),
      milestoneId ?? null,
      id,
    );
  return findTodo(database, id) as TodoRecord;
}

export function deleteTodo(database: DatabaseSync, actor: UserRecord, id: string): TodoRecord | undefined {
  const current = findTodo(database, id);
  if (current === undefined || !maySeeTodo(database, current, actor)) return undefined;
  if (current.ownerId !== actor.id) {
    throw new TodoRefusal("refused", "only its owner may delete this to-do");
  }
  database.prepare("DELETE FROM todos WHERE id = ?").run(id);
  return current;
}

/** The to-dos a viewer may see: their own (owned or assigned), or one project's. */
export function listTodos(
  database: DatabaseSync,
  viewer: UserRecord,
  query: { projectId?: string; includeDone: boolean },
): TodoRecord[] {
  const done = query.includeDone ? "" : " AND status != 'done'";
  if (query.projectId !== undefined) {
    if (!maySeeProject(database, query.projectId, viewer)) return [];
    return (
      database
        .prepare(
          `SELECT * FROM todos WHERE project_id = ? AND (visibility = 'project' OR owner_id = ?)${done}
            ORDER BY status = 'done', COALESCE(due_at, 9e15), updated_at DESC LIMIT 1000`,
        )
        .all(query.projectId, viewer.id) as Row[]
    ).map(toRecord);
  }
  const visible = visibleProjectIds(database, viewer);
  return (
    database
      .prepare(
        `SELECT * FROM todos WHERE (owner_id = ? OR (assignee_id = ? AND visibility = 'project'))${done}
          ORDER BY status = 'done', COALESCE(due_at, 9e15), updated_at DESC LIMIT 1000`,
      )
      .all(viewer.id, viewer.id) as Row[]
  )
    .map(toRecord)
    .filter((todo) => todo.ownerId === viewer.id || todo.projectId === undefined || visible.has(todo.projectId));
}
