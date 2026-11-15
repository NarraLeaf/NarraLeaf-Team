/**
 * Asking for access: a place in a project, more of one, or leave to make
 * projects.
 *
 * Somebody who cannot do what they came to do asks, and whoever decides it is
 * told. A project's place is decided by its owners (and the operators, who own
 * every project); leave to make projects by the operators alone. An answer is
 * kept beside the question, so the person who asked reads what happened and why.
 *
 * This module keeps the rows and checks a question is worth asking. Granting
 * what an approval grants is the method's, which changes a member or a group
 * the same way the members and admin methods do and announces it the same way.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { storedProjectCreators } from "../identity/settings.js";
import { findUserById, isOperator, isProjectCreator, type UserRecord } from "../identity/users.js";
import {
  PROJECT_AREAS,
  findProjectMember,
  isProjectArea,
  isProjectRole,
  maySeeProject,
  projectRole,
  type ProjectArea,
  type ProjectRole,
} from "../projects/members.js";
import { findProject } from "../projects/registry.js";
import {
  ACCESS_REQUEST_MESSAGE_LIMIT,
  type TeamAccessRequest,
  type TeamAccessRequestKind,
  type TeamAccessRequestStatus,
} from "../team/protocol.js";

export class AccessRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface AccessRecord {
  readonly id: number;
  readonly kind: TeamAccessRequestKind;
  readonly projectId: string | undefined;
  readonly userId: string;
  readonly role: ProjectRole | undefined;
  readonly areas: readonly ProjectArea[] | undefined;
  readonly template: string | undefined;
  readonly message: string | undefined;
  readonly status: TeamAccessRequestStatus;
  readonly at: number;
  readonly decidedBy: string | undefined;
  readonly decidedAt: number | undefined;
  readonly note: string | undefined;
  readonly grantedRole: ProjectRole | undefined;
  readonly grantedAreas: readonly ProjectArea[] | undefined;
}

const STATUSES: readonly TeamAccessRequestStatus[] = ["pending", "approved", "denied", "withdrawn"];

/** A stored list of areas: unknown names dropped, nothing readable meaning all. */
function readAreas(value: string | undefined): readonly ProjectArea[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? PROJECT_AREAS.filter((area) => parsed.includes(area)) : undefined;
  } catch {
    return undefined;
  }
}

/** A list of areas as stored: in order, and null when it is all of them. */
function writeAreas(areas: readonly ProjectArea[] | undefined): string | null {
  if (areas === undefined) return null;
  const list = PROJECT_AREAS.filter((area) => areas.includes(area));
  return list.length === PROJECT_AREAS.length ? null : JSON.stringify(list);
}

function readRole(value: string | undefined): ProjectRole | undefined {
  return value !== undefined && isProjectRole(value) ? value : undefined;
}

function toRecord(row: Row): AccessRecord {
  const status = textColumn(row, "status");
  const role = readRole(optionalTextColumn(row, "role"));
  const grantedRole = readRole(optionalTextColumn(row, "granted_role"));
  return {
    id: integerColumn(row, "id"),
    kind: textColumn(row, "kind") === "creator" ? "creator" : "project",
    projectId: optionalTextColumn(row, "project_id"),
    userId: textColumn(row, "user_id"),
    role,
    areas: role === "editor" ? readAreas(optionalTextColumn(row, "areas")) : undefined,
    template: optionalTextColumn(row, "template"),
    message: optionalTextColumn(row, "message"),
    status: (STATUSES as readonly string[]).includes(status) ? (status as TeamAccessRequestStatus) : "withdrawn",
    at: integerColumn(row, "at"),
    decidedBy: optionalTextColumn(row, "decided_by"),
    decidedAt: optionalIntegerColumn(row, "decided_at"),
    note: optionalTextColumn(row, "note"),
    grantedRole,
    grantedAreas: grantedRole === "editor" ? readAreas(optionalTextColumn(row, "granted_areas")) : undefined,
  };
}

/** A request as the wire carries it. */
export function accessView(database: DatabaseSync, record: AccessRecord): TeamAccessRequest {
  const requester = findUserById(database, record.userId);
  const project = record.projectId === undefined ? undefined : findProject(database, record.projectId);
  const decider = record.decidedBy === undefined ? undefined : findUserById(database, record.decidedBy);
  const current =
    record.projectId === undefined || requester === undefined ? undefined : projectRole(database, record.projectId, requester);
  return {
    id: record.id,
    kind: record.kind,
    ...(record.projectId === undefined ? {} : { project: record.projectId }),
    ...(project === undefined ? {} : { projectName: project.name }),
    requester: requester?.username ?? record.userId,
    ...(requester?.displayName ? { requesterName: requester.displayName } : {}),
    ...(record.role === undefined ? {} : { role: record.role }),
    ...(record.areas === undefined ? {} : { areas: record.areas }),
    ...(record.template === undefined ? {} : { template: record.template }),
    ...(current === undefined ? {} : { currentRole: current }),
    ...(record.message === undefined ? {} : { message: record.message }),
    status: record.status,
    at: record.at,
    ...(decider === undefined ? {} : { decidedBy: decider.username }),
    ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt }),
    ...(record.note === undefined ? {} : { note: record.note }),
    ...(record.grantedRole === undefined ? {} : { grantedRole: record.grantedRole }),
    ...(record.grantedAreas === undefined ? {} : { grantedAreas: record.grantedAreas }),
  };
}

export function findAccessRequest(database: DatabaseSync, id: number): AccessRecord | undefined {
  const row = database.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

const RANK: Readonly<Record<ProjectRole, number>> = { owner: 3, editor: 2, reviewer: 1, viewer: 0 };

/**
 * Whether a grant already includes another: a more able role does, and an
 * editor does another editor whose areas are all among its own.
 */
export function grantCovers(
  held: { role: ProjectRole; areas: readonly ProjectArea[] | undefined },
  asked: { role: ProjectRole; areas: readonly ProjectArea[] | undefined },
): boolean {
  if (RANK[held.role] !== RANK[asked.role]) return RANK[held.role] > RANK[asked.role];
  if (held.role !== "editor" || held.areas === undefined) return true;
  const wanted = asked.areas ?? PROJECT_AREAS;
  return wanted.every((area) => held.areas?.includes(area) === true);
}

/** Whether an account may decide a request: an owner of its project, or an operator. */
export function mayDecide(database: DatabaseSync, actor: UserRecord, record: AccessRecord): boolean {
  if (record.kind === "creator") return isOperator(actor.groups);
  return record.projectId !== undefined && projectRole(database, record.projectId, actor) === "owner";
}

/** Who decides a request, by account id: a project's owners and the operators, or the operators. */
export function deciderIds(database: DatabaseSync, record: AccessRecord): Set<string> {
  const rows =
    record.kind === "creator" || record.projectId === undefined
      ? database.prepare("SELECT user_id FROM user_groups WHERE group_name = 'admin'").all()
      : database
          .prepare(
            `SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner'
             UNION
             SELECT user_id FROM user_groups WHERE group_name = 'admin'`,
          )
          .all(record.projectId);
  return new Set(rows.map((row) => textColumn(row as Row, "user_id")));
}

/** The text of a message or note: trimmed, bounded, and absent when empty. */
export function boundedText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (Buffer.byteLength(text, "utf-8") > ACCESS_REQUEST_MESSAGE_LIMIT) {
    throw new AccessRefusal("bad-params", `a ${field} is at most ${ACCESS_REQUEST_MESSAGE_LIMIT} bytes`);
  }
  return text;
}

export type AccessAsk =
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly role: ProjectRole;
      readonly areas: readonly ProjectArea[] | undefined;
      readonly template?: string;
      readonly message?: string;
    }
  | { readonly kind: "creator"; readonly message?: string };

/**
 * Ask. Refused when there is nothing to ask for — the account already has it —
 * or nobody could grant it. A pending request for the same thing is replaced,
 * keeping one question per account and project in front of whoever decides.
 */
export function createAccessRequest(database: DatabaseSync, user: UserRecord, ask: AccessAsk, now = Date.now()): AccessRecord {
  const message = boundedText(ask.message, "message");
  let projectId: string | null = null;
  let role: ProjectRole | null = null;
  let areas: string | null = null;
  let template: string | null = null;
  if (ask.kind === "project") {
    const project = findProject(database, ask.projectId);
    if (project === undefined) throw new AccessRefusal("not-found", "there is no project of that id on this server");
    projectId = project.id;
    const held = projectRole(database, project.id, user);
    if (held === "owner") throw new AccessRefusal("conflict", "you already own this project and may do everything in it");
    if (ask.role === "editor" && ask.areas !== undefined && ask.areas.length === 0) {
      throw new AccessRefusal("bad-params", "an editor is asked for with at least one area");
    }
    if (ask.areas !== undefined && !ask.areas.every(isProjectArea)) {
      throw new AccessRefusal("bad-params", "areas is a list of story, characters, assets, ui, localization and config");
    }
    const wanted = ask.role === "editor" ? ask.areas : undefined;
    if (held !== undefined) {
      const areasHeld = held === "editor" ? findProjectMember(database, project.id, user.id)?.areas : undefined;
      if (grantCovers({ role: held, areas: areasHeld }, { role: ask.role, areas: wanted })) {
        throw new AccessRefusal("conflict", "you already have that in this project");
      }
    }
    role = ask.role;
    areas = writeAreas(wanted);
    template = ask.template ?? null;
  } else {
    const rule = storedProjectCreators(database);
    if (rule === "everyone" || isProjectCreator(user.groups)) {
      throw new AccessRefusal("conflict", "you may already make projects on this server");
    }
    if (rule === "admins") {
      throw new AccessRefusal("refused", "only the operators make projects on this server, and nobody is let in beside them");
    }
  }
  const existing = database
    .prepare(
      `SELECT id FROM access_requests
        WHERE user_id = ? AND kind = ? AND COALESCE(project_id, '') = ? AND status = 'pending'`,
    )
    .get(user.id, ask.kind, projectId ?? "") as Row | undefined;
  let id: number;
  if (existing !== undefined) {
    id = integerColumn(existing, "id");
    database
      .prepare("UPDATE access_requests SET role = ?, areas = ?, template = ?, message = ?, at = ? WHERE id = ?")
      .run(role, areas, template, message ?? null, now, id);
  } else {
    const result = database
      .prepare(
        `INSERT INTO access_requests (kind, project_id, user_id, role, areas, template, message, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(ask.kind, projectId, user.id, role, areas, template, message ?? null, now);
    id = Number(result.lastInsertRowid);
  }
  const record = findAccessRequest(database, id);
  if (record === undefined) throw new Error(`access request ${id} was not written`);
  return record;
}

/** Write an answer on a pending request. The grant itself is the caller's to apply first. */
export function settleAccessRequest(
  database: DatabaseSync,
  record: AccessRecord,
  answer: {
    status: "approved" | "denied" | "withdrawn";
    by?: string;
    note?: string;
    grantedRole?: ProjectRole;
    grantedAreas?: readonly ProjectArea[] | undefined;
  },
  now = Date.now(),
): AccessRecord {
  database
    .prepare(
      `UPDATE access_requests SET status = ?, decided_by = ?, decided_at = ?, note = ?, granted_role = ?, granted_areas = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(
      answer.status,
      answer.by ?? null,
      now,
      answer.note ?? null,
      answer.grantedRole ?? null,
      answer.grantedRole === "editor" ? writeAreas(answer.grantedAreas) : null,
      record.id,
    );
  const settled = findAccessRequest(database, record.id);
  if (settled === undefined) throw new Error(`access request ${record.id} went while it was answered`);
  return settled;
}

/**
 * The caller's own requests, newest first, and those it decides on: every
 * request for a project it owns and, for an operator, every request at all.
 */
export function listAccessRequests(
  database: DatabaseSync,
  viewer: UserRecord,
  options: { all: boolean; project?: string; limit: number },
): { mine: AccessRecord[]; toDecide: AccessRecord[] } {
  const status = options.all ? "" : "AND status = 'pending'";
  const project = options.project === undefined ? "" : "AND project_id = ?";
  const projectArgs = options.project === undefined ? [] : [options.project];
  const mine = (
    database
      .prepare(`SELECT * FROM access_requests WHERE user_id = ? ${status} ${project} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(viewer.id, ...projectArgs, options.limit) as Row[]
  ).map(toRecord);
  const toDecide = (
    isOperator(viewer.groups)
      ? database
          .prepare(`SELECT * FROM access_requests WHERE user_id <> ? ${status} ${project} ORDER BY at DESC, id DESC LIMIT ?`)
          .all(viewer.id, ...projectArgs, options.limit)
      : database
          .prepare(
            `SELECT * FROM access_requests
              WHERE kind = 'project' AND user_id <> ? ${status} ${project}
                AND project_id IN (SELECT project_id FROM project_members WHERE user_id = ? AND role = 'owner')
              ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(viewer.id, ...projectArgs, viewer.id, options.limit)
  ).map((row) => toRecord(row as Row));
  return { mine, toDecide };
}

/** The projects an account has no role in, by name: what it may ask to join. */
export function discoverableProjects(
  database: DatabaseSync,
  viewer: UserRecord,
  limit: number,
): { id: string; name: string; description: string }[] {
  if (isOperator(viewer.groups)) return [];
  return (
    database
      .prepare(
        `SELECT id, name, description FROM projects
          WHERE id NOT IN (SELECT project_id FROM project_members WHERE user_id = ?)
          ORDER BY name LIMIT ?`,
      )
      .all(viewer.id, limit) as Row[]
  ).map((row) => ({ id: textColumn(row, "id"), name: textColumn(row, "name"), description: textColumn(row, "description") }));
}

/** Whether the requester may read a project now, which says whether to name it in a notification. */
export function requesterSees(database: DatabaseSync, record: AccessRecord): boolean {
  const user = findUserById(database, record.userId);
  return user !== undefined && record.projectId !== undefined && maySeeProject(database, record.projectId, user);
}
