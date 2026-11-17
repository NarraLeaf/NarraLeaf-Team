/**
 * Profiles, activity, to-dos and notifications, over a session.
 *
 * What is stored, and who may see it, is decided in src/collab/; this file
 * reads parameters, asks, and announces. Every announcement is narrowed to
 * the accounts entitled to it: an account's own topics are only ever held by
 * that account (src/team/topics.ts), and a project's by its members.
 */
import { activityHeatmap, listActivity, recordActivity } from "../../collab/activity.js";
import { listNotifications, markRead, notify } from "../../collab/notifications.js";
import { emitWebhookEvent } from "../../collab/webhooks.js";
import {
  createTodo,
  deleteTodo,
  findTodo,
  listTodos,
  maySeeTodo,
  TODO_KINDS,
  TODO_PRIORITIES,
  TODO_STATUSES,
  TODO_VISIBILITIES,
  todoAccounts,
  TodoRefusal,
  todoView,
  updateTodo,
  type TodoInput,
  type TodoRecord,
} from "../../collab/todos.js";
import { accountPolicy, FIXED_BY_ADMIN } from "../../identity/accountPolicy.js";
import { findUser, findUserById, type UserRecord } from "../../identity/users.js";
import { profileBody } from "../../projects/answers.js";
import { findProject } from "../../projects/registry.js";
import {
  boundedCount,
  flag,
  MethodError,
  oneOf,
  optionalText,
  paramsObject,
  projectVisible,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  accountNotificationsTopic,
  accountTodosTopic,
  ANCHOR_FIELD_LIMIT,
  projectTodosTopic,
  TEAM_METHODS,
  TODO_LABEL_LENGTH,
  TODO_LABELS_LIMIT,
  type TeamNotification,
  type TeamTodoPriority,
  type TeamTodosEvent,
} from "../protocol.js";

const ID_LIMIT = 128;
const USERNAME_LIMIT = 64;
const TITLE_LIMIT = 300;
const BODY_LIMIT = 8 * 1024;
const BIO_LIMIT = 400;
const DISPLAY_NAME_LIMIT = 128;

/** A username, refused when nobody has it. */
function accountNamed(context: MethodContext, username: string): UserRecord {
  const user = findUser(context.options.database, username);
  if (user === undefined) {
    throw new MethodError("not-found", `there is no account called ${username} on this server`);
  }
  return user;
}

/** A project id or name the caller can see, or a not-found refusal. */
/** Whether a name is a time zone this runtime knows. */
function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function projectRef(context: MethodContext, reference: string): string {
  const project = findProject(context.options.database, reference);
  if (project === undefined || !projectVisible(context, project.id)) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return project.id;
}

function refused(error: unknown): never {
  if (error instanceof TodoRefusal) throw new MethodError(error.code, error.message);
  throw error;
}

/** Tell everybody entitled to it that a to-do changed, or went. */
export function announceTodo(context: MethodContext, todo: TodoRecord, event: TeamTodosEvent, previous?: TodoRecord): void {
  for (const accountId of new Set([...todoAccounts(todo), ...(previous === undefined ? [] : todoAccounts(previous))])) {
    const user = findUserById(context.options.database, accountId);
    // An assignee who can no longer see it hears that it went, not what it says now.
    const visible = user !== undefined && maySeeTodo(context.options.database, todo, user);
    context.publish(
      accountTodosTopic(accountId),
      visible || event.kind === "todo-removed" ? event : ({ kind: "todo-removed", todo: todo.id } satisfies TeamTodosEvent),
      new Set([accountId]),
    );
  }
  if (todo.projectId !== undefined && todo.visibility === "project") {
    context.publish(projectTodosTopic(todo.projectId), event);
  }
  // A to-do that stopped being the project's (made private, or moved) is gone from that list.
  if (previous?.projectId !== undefined && previous.visibility === "project" && (todo.visibility !== "project" || todo.projectId !== previous.projectId)) {
    context.publish(projectTodosTopic(previous.projectId), { kind: "todo-removed", todo: todo.id } satisfies TeamTodosEvent);
  }
}

function announceNotifications(context: MethodContext, written: Map<string, TeamNotification>): void {
  for (const [accountId, notification] of written) {
    context.publish(accountNotificationsTopic(accountId), { kind: "notification", notification }, new Set([accountId]));
  }
}

/** The parts of a to-do the parameters name, `null` meaning "clear it". */
/** Labels as given, trimmed, without repeats; at most {@link TODO_LABELS_LIMIT} short ones. */
function todoLabels(value: unknown): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) {
    throw new MethodError("bad-params", "labels has to be a list of words");
  }
  const labels = [...new Set((value as string[]).map((label) => label.trim()).filter((label) => label !== ""))];
  if (labels.length > TODO_LABELS_LIMIT || labels.some((label) => label.length > TODO_LABEL_LENGTH)) {
    throw new MethodError("bad-params", `a to-do carries at most ${TODO_LABELS_LIMIT} labels of ${TODO_LABEL_LENGTH} characters`);
  }
  return labels;
}

function todoInput(context: MethodContext, read: Record<string, unknown>): TodoInput {
  const input: { -readonly [K in keyof TodoInput]: TodoInput[K] } = {};
  if (read["title"] !== undefined) input.title = requiredText(read, "title", TITLE_LIMIT);
  if (read["body"] !== undefined) input.body = optionalText(read, "body", BODY_LIMIT) ?? null;
  if (read["project"] !== undefined) input.projectId = read["project"] === null ? null : projectRef(context, requiredText(read, "project", ID_LIMIT));
  if (read["assignee"] !== undefined) {
    input.assigneeId = read["assignee"] === null ? null : accountNamed(context, requiredText(read, "assignee", USERNAME_LIMIT)).id;
  }
  if (read["visibility"] !== undefined) input.visibility = oneOf(read, "visibility", TODO_VISIBILITIES);
  if (read["status"] !== undefined) input.status = oneOf(read, "status", TODO_STATUSES);
  if (read["dueAt"] !== undefined) {
    const due = read["dueAt"];
    if (due !== null && (typeof due !== "number" || !Number.isFinite(due))) {
      throw new MethodError("bad-params", "dueAt has to be a time in milliseconds, or null");
    }
    input.dueAt = due as number | null;
  }
  if (read["doneRevision"] !== undefined) input.doneRevision = requiredText(read, "doneRevision", ANCHOR_FIELD_LIMIT);
  if (read["kind"] !== undefined) input.kind = oneOf(read, "kind", TODO_KINDS);
  if (read["locale"] !== undefined) input.locale = read["locale"] === null ? null : requiredText(read, "locale", 35);
  if (read["asset"] !== undefined) input.asset = read["asset"] === null ? null : requiredText(read, "asset", ANCHOR_FIELD_LIMIT);
  if (read["labels"] !== undefined) input.labels = todoLabels(read["labels"]);
  if (read["milestone"] !== undefined) input.milestoneId = read["milestone"] === null ? null : requiredText(read, "milestone", ID_LIMIT);
  if (read["priority"] !== undefined) {
    const priority = read["priority"];
    if (!(TODO_PRIORITIES as readonly unknown[]).includes(priority)) {
      throw new MethodError("bad-params", "priority has to be 0, 1, 2 or 3");
    }
    input.priority = priority as TeamTodoPriority;
  }
  if (read["anchor"] !== undefined) {
    if (read["anchor"] === null) {
      input.anchor = null;
    } else {
      const anchor = paramsObject(read["anchor"]);
      const revision = optionalText(anchor, "revision", ANCHOR_FIELD_LIMIT);
      input.anchor = {
        document: requiredText(anchor, "document", ANCHOR_FIELD_LIMIT),
        element: requiredText(anchor, "element", ANCHOR_FIELD_LIMIT),
        ...(revision === undefined ? {} : { revision }),
      };
    }
  }
  return input;
}

export function collabMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.accountProfileGet,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const username = optionalText(paramsObject(params), "username", USERNAME_LIMIT);
        const user = username === undefined ? context.user : accountNamed(context, username);
        const online = context.online?.(user.id);
        return { profile: { ...profileBody(user), ...(online === undefined ? {} : { online }) } };
      },
    },
    {
      name: TEAM_METHODS.accountProfileUpdate,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const displayName = read["displayName"] === undefined ? undefined : requiredText(read, "displayName", DISPLAY_NAME_LIMIT);
        const bio = read["bio"] === undefined ? undefined : (optionalText(read, "bio", BIO_LIMIT) ?? "");
        const timezone = read["timezone"] === undefined ? undefined : (optionalText(read, "timezone", 64) ?? "");
        if (timezone !== undefined && timezone !== "" && !isTimeZone(timezone)) {
          throw new MethodError("bad-params", "timezone has to be an IANA time zone such as Asia/Shanghai");
        }
        const database = context.options.database;
        const fixed = accountPolicy(database, context.user.id).policy;
        const now = findUserById(database, context.user.id) ?? context.user;
        // A fixed field the page sends back unchanged is fine: the settings page saves all three at once.
        if (
          (fixed.displayName !== undefined && displayName !== undefined && displayName !== now.displayName) ||
          (fixed.bio !== undefined && bio !== undefined && bio !== (now.bio ?? "")) ||
          (fixed.timezone !== undefined && timezone !== undefined && timezone !== (now.timezone ?? ""))
        ) {
          throw new MethodError("refused", FIXED_BY_ADMIN);
        }
        if (timezone !== undefined) database.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(timezone === "" ? null : timezone, context.user.id);
        if (displayName !== undefined) database.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, context.user.id);
        if (bio !== undefined) database.prepare("UPDATE users SET bio = ? WHERE id = ?").run(bio === "" ? null : bio, context.user.id);
        return { profile: profileBody(findUserById(database, context.user.id) ?? context.user) };
      },
    },
    {
      name: TEAM_METHODS.activityList,
      capability: "activity",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const username = optionalText(read, "account", USERNAME_LIMIT);
        const project = optionalText(read, "project", ID_LIMIT);
        const before = read["cursor"];
        if (before !== undefined && (typeof before !== "number" || !Number.isInteger(before))) {
          throw new MethodError("bad-params", "cursor has to be the number a page answered with");
        }
        return listActivity(context.options.database, context.user, {
          ...(username === undefined ? {} : { accountId: accountNamed(context, username).id }),
          ...(project === undefined ? {} : { projectId: projectRef(context, project) }),
          ...(before === undefined ? {} : { before: before as number }),
          limit: boundedCount(read, "limit", 50, 200),
        });
      },
    },
    {
      name: TEAM_METHODS.activityHeatmap,
      capability: "activity",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const username = optionalText(read, "account", USERNAME_LIMIT);
        const offset = read["tzOffsetMinutes"] ?? 0;
        if (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > 16 * 60) {
          throw new MethodError("bad-params", "tzOffsetMinutes has to be whole minutes, as Date#getTimezoneOffset gives");
        }
        return {
          days: activityHeatmap(context.options.database, context.user, {
            accountId: (username === undefined ? context.user : accountNamed(context, username)).id,
            tzOffsetMinutes: offset,
            days: boundedCount(read, "days", 371, 371),
          }),
        };
      },
    },
    {
      name: TEAM_METHODS.todosList,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const project = optionalText(read, "project", ID_LIMIT);
        const todos = listTodos(context.options.database, context.user, {
          ...(project === undefined ? {} : { projectId: projectRef(context, project) }),
          includeDone: flag(read, "includeDone", false),
        });
        return { todos: todos.map((todo) => todoView(context.options.database, todo)) };
      },
    },
    {
      name: TEAM_METHODS.todosCreate,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const input = todoInput(context, read);
        const title = requiredText(read, "title", TITLE_LIMIT);
        let todo: TodoRecord;
        try {
          todo = createTodo(context.options.database, context.user, { ...input, title });
        } catch (error) {
          refused(error);
        }
        const view = todoView(context.options.database, todo);
        announceTodo(context, todo, { kind: "todo-set", todo: view });
        recordActivity(context.options.database, {
          accountId: context.user.id,
          ...(todo.projectId === undefined ? {} : { projectId: todo.projectId }),
          kind: "todo-created",
          ref: todo.id,
          summary: todo.title,
          private: todo.visibility === "private",
        });
        if (todo.assigneeId !== undefined) {
          if (todo.projectId !== undefined && todo.visibility === "project") {
            emitWebhookEvent(context.options.database, {
              type: "todo-assigned",
              projectId: todo.projectId,
              actor: context.account.username,
              ref: todo.id,
              summary: `${context.account.username} gave ${findUserById(context.options.database, todo.assigneeId)?.username ?? "?"}: ${todo.title}`,
            });
          }
          announceNotifications(
            context,
            notify(context.options.database, [todo.assigneeId], {
              kind: "assigned",
              ...(todo.projectId === undefined ? {} : { projectId: todo.projectId }),
              ref: todo.id,
              actorId: context.user.id,
              summary: todo.title,
            }),
          );
        }
        return { todo: view };
      },
    },
    {
      name: TEAM_METHODS.todosUpdate,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = requiredText(read, "todo", ID_LIMIT);
        const { todo: _ignored, ...fields } = read;
        void _ignored;
        const input = todoInput(context, fields);
        const previous = findTodo(context.options.database, id);
        let todo: TodoRecord;
        try {
          todo = updateTodo(context.options.database, context.user, id, input);
        } catch (error) {
          refused(error);
        }
        const view = todoView(context.options.database, todo);
        announceTodo(context, todo, { kind: "todo-set", todo: view }, previous);
        if (previous !== undefined && previous.status !== "done" && todo.status === "done") {
          if (todo.projectId !== undefined && todo.visibility === "project") {
            emitWebhookEvent(context.options.database, {
              type: "todo-done",
              projectId: todo.projectId,
              actor: context.account.username,
              ref: todo.id,
              summary: `${context.account.username} finished: ${todo.title}`,
            });
          }
          recordActivity(context.options.database, {
            accountId: context.user.id,
            ...(todo.projectId === undefined ? {} : { projectId: todo.projectId }),
            kind: "todo-done",
            ref: todo.id,
            summary: todo.title,
            private: todo.visibility === "private",
          });
        }
        if (todo.assigneeId !== undefined && todo.assigneeId !== previous?.assigneeId) {
          if (todo.projectId !== undefined && todo.visibility === "project") {
            emitWebhookEvent(context.options.database, {
              type: "todo-assigned",
              projectId: todo.projectId,
              actor: context.account.username,
              ref: todo.id,
              summary: `${context.account.username} gave ${findUserById(context.options.database, todo.assigneeId)?.username ?? "?"}: ${todo.title}`,
            });
          }
          announceNotifications(
            context,
            notify(context.options.database, [todo.assigneeId], {
              kind: "assigned",
              ...(todo.projectId === undefined ? {} : { projectId: todo.projectId }),
              ref: todo.id,
              actorId: context.user.id,
              summary: todo.title,
            }),
          );
        }
        return { todo: view };
      },
    },
    {
      name: TEAM_METHODS.todosDelete,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "todo", ID_LIMIT);
        let gone: TodoRecord | undefined;
        try {
          gone = deleteTodo(context.options.database, context.user, id);
        } catch (error) {
          refused(error);
        }
        if (gone !== undefined) announceTodo(context, gone, { kind: "todo-removed", todo: gone.id });
        return {};
      },
    },
    {
      name: TEAM_METHODS.notificationsList,
      capability: "notifications",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const before = read["cursor"];
        if (before !== undefined && (typeof before !== "number" || !Number.isInteger(before))) {
          throw new MethodError("bad-params", "cursor has to be the number a page answered with");
        }
        return listNotifications(context.options.database, context.user.id, {
          unreadOnly: flag(read, "unreadOnly", false),
          ...(before === undefined ? {} : { before: before as number }),
          limit: boundedCount(read, "limit", 50, 200),
        });
      },
    },
    {
      name: TEAM_METHODS.notificationsRead,
      capability: "notifications",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        let ids: number[] | "all";
        if (read["all"] === true) {
          ids = "all";
        } else {
          const raw = read["ids"];
          if (!Array.isArray(raw) || raw.length > 500 || !raw.every((id) => typeof id === "number" && Number.isInteger(id))) {
            throw new MethodError("bad-params", "ids has to be a list of notification ids, or all: true");
          }
          ids = raw as number[];
        }
        const changed = markRead(context.options.database, context.user.id, ids);
        if (changed > 0) {
          context.publish(accountNotificationsTopic(context.user.id), { kind: "notifications-read", ids }, new Set([context.user.id]));
        }
        return {};
      },
    },
  ];
}
