/**
 * Project templates: who joins, which milestones are planned and which to-dos are waiting, kept
 * once and put into a new project — or an old one — in one go. "Short VN", "Localization round",
 * "Game jam". Nothing in a template touches a project's files: it only makes Team's own records.
 *
 * Whoever may make projects keeps templates (whoever made one, or an operator, changes it);
 * a project's owners apply one to it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUser, findUserById, isOperator, type UserRecord } from "../identity/users.js";
import { findProjectMember, listProjectMembers, maySeeProject, projectRole, setProjectMember } from "../projects/members.js";
import {
  teamPermissionTemplate,
  teamTemplateOf,
  TODO_LABEL_LENGTH,
  TODO_LABELS_LIMIT,
  type TeamProjectTemplate,
  type TeamTemplateBody,
  type TeamTodoKind,
} from "../team/protocol.js";
import { createMilestone, listMilestones, MilestoneRefusal, type MilestoneRecord } from "./milestones.js";
import { createTodo, listTodos, TODO_KINDS, TodoRefusal, type TodoRecord } from "./todos.js";

export const TEMPLATES_LIMIT = 200;
export const TEMPLATE_NAME_LIMIT = 100;
export const TEMPLATE_DESCRIPTION_LIMIT = 2000;
const MEMBERS_LIMIT = 200;
const MILESTONES_LIMIT = 100;
const TODOS_LIMIT = 500;
const TEXT_LIMIT = 300;
const BODY_LIMIT = 8 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export class TemplateRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

interface TemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly body: TeamTemplateBody;
  readonly createdBy: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toRecord(row: Row): TemplateRecord {
  let body: TeamTemplateBody = {};
  try {
    body = checkBody(JSON.parse(textColumn(row, "body")));
  } catch {
    // A body this build cannot read is an empty template rather than a broken list.
  }
  return {
    id: textColumn(row, "id"),
    name: textColumn(row, "name"),
    description: optionalTextColumn(row, "description"),
    body,
    createdBy: optionalTextColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

export function templateView(database: DatabaseSync, template: TemplateRecord): TeamProjectTemplate {
  const by = template.createdBy === undefined ? undefined : findUserById(database, template.createdBy)?.username;
  return {
    id: template.id,
    name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    body: template.body,
    ...(by === undefined ? {} : { createdBy: by }),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function text(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > limit) {
    throw new TemplateRefusal("bad-params", `${what} is text of 1 to ${limit} characters`);
  }
  return value.trim();
}

function optional(value: unknown, what: string, limit: number): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, what, limit);
}

function days(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650) {
    throw new TemplateRefusal("bad-params", "dueInDays is a whole number of days, 0 to 3650");
  }
  return value;
}

function list(value: unknown, what: string, limit: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) throw new TemplateRefusal("bad-params", `${what} is a list of at most ${limit}`);
  return value;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TemplateRefusal("bad-params", `${what} is an object`);
  return value as Record<string, unknown>;
}

/** A template body as given, checked and trimmed to what this build understands. */
export function checkBody(value: unknown): TeamTemplateBody {
  const read = object(value ?? {}, "body");
  const members = list(read["members"], "members", MEMBERS_LIMIT).map((raw) => {
    const member = object(raw, "a member");
    const template = text(member["template"], "a member's template", 32);
    if (teamPermissionTemplate(template) === undefined) throw new TemplateRefusal("bad-params", `“${template}” is not a permission template`);
    return { username: text(member["username"], "a member's username", 64), template } as NonNullable<TeamTemplateBody["members"]>[number];
  });
  const milestoneNames = new Set<string>();
  const milestones = list(read["milestones"], "milestones", MILESTONES_LIMIT).map((raw) => {
    const milestone = object(raw, "a milestone");
    const name = text(milestone["name"], "a milestone's name", TEXT_LIMIT);
    if (milestoneNames.has(name)) throw new TemplateRefusal("bad-params", `two milestones are called “${name}”`);
    milestoneNames.add(name);
    const note = optional(milestone["note"], "a milestone's note", BODY_LIMIT);
    const dueInDays = days(milestone["dueInDays"]);
    return { name, ...(note === undefined ? {} : { note }), ...(dueInDays === undefined ? {} : { dueInDays }) };
  });
  const todos = list(read["todos"], "todos", TODOS_LIMIT).map((raw) => {
    const todo = object(raw, "a to-do");
    const title = text(todo["title"], "a to-do's title", TEXT_LIMIT);
    const body = optional(todo["body"], "a to-do's body", BODY_LIMIT);
    const kindRaw = todo["kind"];
    if (kindRaw !== undefined && !(TODO_KINDS as readonly unknown[]).includes(kindRaw)) {
      throw new TemplateRefusal("bad-params", `a to-do's kind is one of ${TODO_KINDS.join(", ")}`);
    }
    const kind = kindRaw as TeamTodoKind | undefined;
    const locale = optional(todo["locale"], "a to-do's locale", 35);
    if ((kind === "translation" || kind === "voice") && locale === undefined) {
      throw new TemplateRefusal("bad-params", "a translation or voice to-do names its locale");
    }
    const labels = list(todo["labels"], "a to-do's labels", TODO_LABELS_LIMIT).map((label) => text(label, "a label", TODO_LABEL_LENGTH));
    const milestone = optional(todo["milestone"], "a to-do's milestone", TEXT_LIMIT);
    if (milestone !== undefined && !milestoneNames.has(milestone)) {
      throw new TemplateRefusal("bad-params", `a to-do counts toward “${milestone}”, which the template does not plan`);
    }
    const dueInDays = days(todo["dueInDays"]);
    return {
      title,
      ...(body === undefined ? {} : { body }),
      ...(kind === undefined || kind === "task" ? {} : { kind }),
      ...(locale === undefined ? {} : { locale }),
      ...(labels.length === 0 ? {} : { labels }),
      ...(milestone === undefined ? {} : { milestone }),
      ...(dueInDays === undefined ? {} : { dueInDays }),
    };
  });
  return {
    ...(members.length === 0 ? {} : { members }),
    ...(milestones.length === 0 ? {} : { milestones }),
    ...(todos.length === 0 ? {} : { todos }),
  };
}

export function findTemplate(database: DatabaseSync, id: string): TemplateRecord | undefined {
  const row = database.prepare("SELECT * FROM project_templates WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listTemplates(database: DatabaseSync): TemplateRecord[] {
  return (database.prepare("SELECT * FROM project_templates ORDER BY name COLLATE NOCASE LIMIT ?").all(TEMPLATES_LIMIT) as Row[]).map(toRecord);
}

/** What a project holds now, as a template body: its members, its milestones, its open project to-dos. */
export function bodyFromProject(database: DatabaseSync, actor: UserRecord, projectId: string, now = Date.now()): TeamTemplateBody {
  if (!maySeeProject(database, projectId, actor)) throw new TemplateRefusal("not-found", "there is no project of that id on this server");
  if (projectRole(database, projectId, actor) !== "owner") throw new TemplateRefusal("refused", "a project's owners make a template from it");
  const members = listProjectMembers(database, projectId).flatMap((member) => {
    const user = findUserById(database, member.userId);
    const template = teamTemplateOf(member.role, member.areas);
    return user === undefined || template === undefined || user.id === actor.id ? [] : [{ username: user.username, template: template.id }];
  });
  const milestones: MilestoneRecord[] = listMilestones(database, actor, projectId).slice(0, MILESTONES_LIMIT).reverse();
  const names = new Map(milestones.map((milestone) => [milestone.id, milestone.name]));
  const ahead = (due: number | undefined) => (due === undefined || due <= now ? undefined : Math.ceil((due - now) / DAY));
  const todos: TodoRecord[] = listTodos(database, actor, { projectId, includeDone: false })
    .filter((todo) => todo.visibility === "project")
    .slice(0, TODOS_LIMIT);
  return checkBody({
    members: members.slice(0, MEMBERS_LIMIT),
    milestones: milestones.map((milestone) => ({
      name: milestone.name,
      ...(milestone.note === undefined ? {} : { note: milestone.note }),
      ...(ahead(milestone.dueAt) === undefined ? {} : { dueInDays: ahead(milestone.dueAt) }),
    })),
    todos: todos.map((todo) => {
      const milestone = todo.milestoneId === undefined ? undefined : names.get(todo.milestoneId);
      return {
        title: todo.title,
        ...(todo.body === undefined ? {} : { body: todo.body.slice(0, BODY_LIMIT) }),
        kind: todo.kind,
        ...(todo.locale === undefined ? {} : { locale: todo.locale }),
        ...(todo.labels.length === 0 ? {} : { labels: todo.labels }),
        ...(milestone === undefined ? {} : { milestone }),
        ...(ahead(todo.dueAt) === undefined ? {} : { dueInDays: ahead(todo.dueAt) }),
      };
    }),
  });
}

/** Keep a template: a new one, or a change to the one named by `id` by whoever made it or an operator. */
export function saveTemplate(
  database: DatabaseSync,
  actor: UserRecord,
  input: { id?: string; name: string; description?: string | null; body: TeamTemplateBody },
  now = Date.now(),
): TemplateRecord {
  const name = text(input.name, "name", TEMPLATE_NAME_LIMIT);
  const clash = database.prepare("SELECT id FROM project_templates WHERE name = ?").get(name) as Row | undefined;
  if (input.id === undefined) {
    if (clash !== undefined) throw new TemplateRefusal("conflict", "there is already a template of that name");
    const count = database.prepare("SELECT COUNT(*) AS n FROM project_templates").get() as Row;
    if (integerColumn(count, "n") >= TEMPLATES_LIMIT) throw new TemplateRefusal("refused", `this server keeps at most ${TEMPLATES_LIMIT} templates`);
    const id = randomUUID();
    database
      .prepare("INSERT INTO project_templates (id, name, description, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, input.description ?? null, JSON.stringify(input.body), actor.id, now, now);
    return findTemplate(database, id) as TemplateRecord;
  }
  const current = findTemplate(database, input.id);
  if (current === undefined) throw new TemplateRefusal("not-found", "there is no template of that id");
  if (current.createdBy !== actor.id && !isOperator(actor.groups)) throw new TemplateRefusal("refused", "whoever made a template, or an operator, changes it");
  if (clash !== undefined && textColumn(clash, "id") !== current.id) throw new TemplateRefusal("conflict", "there is already a template of that name");
  database
    .prepare("UPDATE project_templates SET name = ?, description = ?, body = ?, updated_at = ? WHERE id = ?")
    .run(name, input.description === undefined ? (current.description ?? null) : input.description, JSON.stringify(input.body), now, current.id);
  return findTemplate(database, current.id) as TemplateRecord;
}

export function deleteTemplate(database: DatabaseSync, actor: UserRecord, id: string): void {
  const current = findTemplate(database, id);
  if (current === undefined) throw new TemplateRefusal("not-found", "there is no template of that id");
  if (current.createdBy !== actor.id && !isOperator(actor.groups)) throw new TemplateRefusal("refused", "whoever made a template, or an operator, takes it away");
  database.prepare("DELETE FROM project_templates WHERE id = ?").run(id);
}

/** What applying a template did: the members it added, the milestones and to-dos it made, and what it passed over. */
export interface TemplateApplied {
  readonly members: string[];
  readonly milestones: MilestoneRecord[];
  readonly todos: TodoRecord[];
  readonly skipped: string[];
}

/**
 * Put a template into a project. Members named get the template's place (an owner stays one); an account that does
 * not exist, or a milestone whose name is taken, is passed over and named in `skipped`.
 */
export function applyTemplate(database: DatabaseSync, actor: UserRecord, templateId: string, projectId: string, now = Date.now()): TemplateApplied {
  const template = findTemplate(database, templateId);
  if (template === undefined) throw new TemplateRefusal("not-found", "there is no template of that id");
  if (!maySeeProject(database, projectId, actor)) throw new TemplateRefusal("not-found", "there is no project of that id on this server");
  if (projectRole(database, projectId, actor) !== "owner") throw new TemplateRefusal("refused", "a project's owners apply a template to it");
  const applied: TemplateApplied = { members: [], milestones: [], todos: [], skipped: [] };
  for (const member of template.body.members ?? []) {
    const user = findUser(database, member.username);
    const grant = teamPermissionTemplate(member.template);
    if (user === undefined || grant === undefined) {
      applied.skipped.push(`@${member.username}`);
      continue;
    }
    // An owner stays one, and the person applying it keeps their own place.
    if (user.id === actor.id || findProjectMember(database, projectId, user.id)?.role === "owner") {
      applied.skipped.push(`@${member.username}`);
      continue;
    }
    setProjectMember(database, { projectId, userId: user.id, role: grant.role, addedBy: actor.id, areas: grant.areas ?? null });
    applied.members.push(user.username);
  }
  const milestoneIds = new Map<string, string>();
  for (const milestone of template.body.milestones ?? []) {
    try {
      const made = createMilestone(
        database,
        actor,
        {
          projectId,
          name: milestone.name,
          revision: "",
          ...(milestone.note === undefined ? {} : { note: milestone.note }),
          ...(milestone.dueInDays === undefined ? {} : { dueAt: now + milestone.dueInDays * DAY }),
        },
        now,
      );
      milestoneIds.set(made.name, made.id);
      applied.milestones.push(made);
    } catch (error) {
      if (!(error instanceof MilestoneRefusal) || error.code !== "conflict") throw error;
      const existing = database.prepare("SELECT id FROM milestones WHERE project_id = ? AND name = ?").get(projectId, milestone.name) as Row | undefined;
      if (existing !== undefined) milestoneIds.set(milestone.name, textColumn(existing, "id"));
      applied.skipped.push(milestone.name);
    }
  }
  for (const todo of template.body.todos ?? []) {
    try {
      applied.todos.push(
        createTodo(
          database,
          actor,
          {
            title: todo.title,
            ...(todo.body === undefined ? {} : { body: todo.body }),
            projectId,
            visibility: "project",
            kind: todo.kind ?? "task",
            ...(todo.locale === undefined ? {} : { locale: todo.locale }),
            ...(todo.labels === undefined ? {} : { labels: todo.labels }),
            ...(todo.milestone !== undefined && milestoneIds.has(todo.milestone) ? { milestoneId: milestoneIds.get(todo.milestone) as string } : {}),
            ...(todo.dueInDays === undefined ? {} : { dueAt: now + todo.dueInDays * DAY }),
          },
          now,
        ),
      );
    } catch (error) {
      if (!(error instanceof TodoRefusal)) throw error;
      applied.skipped.push(todo.title);
    }
  }
  return applied;
}
