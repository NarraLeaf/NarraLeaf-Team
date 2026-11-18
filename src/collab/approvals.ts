/**
 * Approvals: where each scene and asset of a project stands — still a draft,
 * waiting on a reviewer, approved, or sent back with a reason. Team's own
 * record only (D1): approving a scene never touches the project's files, and
 * the target (`scene:{id}`, `asset:{id}`) is a string this server never reads.
 *
 * Editors move their work to draft or pending; reviewers and owners give the
 * verdict, and a verdict of `changes` carries its reason. Every move is kept.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import { TEAM_APPROVAL_STATUSES, type TeamApproval, type TeamApprovalStatus } from "../team/protocol.js";

export const APPROVAL_STATUSES: readonly TeamApprovalStatus[] = TEAM_APPROVAL_STATUSES;
const TARGET = /^(scene|asset):[^\s]{1,200}$/u;

export interface ApprovalRecord {
  readonly projectId: string;
  readonly target: string;
  readonly status: TeamApprovalStatus;
  readonly byId: string | undefined;
  readonly note: string | undefined;
  readonly at: number;
}

export class ApprovalRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

function toRecord(row: Row): ApprovalRecord {
  const status = textColumn(row, "status");
  return {
    projectId: textColumn(row, "project_id"),
    target: textColumn(row, "target"),
    // Unknown reads as a draft: a status a newer Team wrote approves nothing here.
    status: (APPROVAL_STATUSES as readonly string[]).includes(status) ? (status as TeamApprovalStatus) : "draft",
    byId: optionalTextColumn(row, "by_id"),
    note: optionalTextColumn(row, "note"),
    at: integerColumn(row, "at"),
  };
}

export function approvalView(database: DatabaseSync, approval: ApprovalRecord): TeamApproval {
  const by = approval.byId === undefined ? undefined : findUserById(database, approval.byId)?.username;
  return {
    project: approval.projectId,
    target: approval.target,
    status: approval.status,
    ...(by === undefined ? {} : { by }),
    ...(approval.note === undefined ? {} : { note: approval.note }),
    at: approval.at,
  };
}

export function isApprovalTarget(target: string): boolean {
  return TARGET.test(target);
}

export function listApprovals(database: DatabaseSync, viewer: UserRecord, projectId: string): ApprovalRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new ApprovalRefusal("not-found", "there is no project of that id on this server");
  return (database.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY at DESC LIMIT 5000").all(projectId) as Row[]).map(toRecord);
}

export function approvalHistory(database: DatabaseSync, viewer: UserRecord, projectId: string, target: string): ApprovalRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new ApprovalRefusal("not-found", "there is no project of that id on this server");
  return (
    database.prepare("SELECT * FROM approval_history WHERE project_id = ? AND target = ? ORDER BY id LIMIT 500").all(projectId, target) as Row[]
  ).map(toRecord);
}

/**
 * Move one target. Editors and owners may put it back to draft or ask for
 * review; reviewers and owners decide. Sending it back needs a reason.
 */
export function setApproval(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; target: string; status: TeamApprovalStatus; note?: string },
  now = Date.now(),
): ApprovalRecord {
  const role = projectRole(database, input.projectId, actor);
  if (role === undefined) throw new ApprovalRefusal("not-found", "there is no project of that id on this server");
  if (!isApprovalTarget(input.target)) throw new ApprovalRefusal("bad-params", "target has to be scene:{id} or asset:{id}");
  const verdict = input.status === "approved" || input.status === "changes";
  if (verdict ? role !== "owner" && role !== "reviewer" : role !== "owner" && role !== "editor") {
    throw new ApprovalRefusal(
      "refused",
      verdict ? "reviewers and owners approve or send back" : "editors and owners mark their work as a draft or ask for review",
    );
  }
  const note = input.note?.trim() || undefined;
  if (input.status === "changes" && note === undefined) {
    throw new ApprovalRefusal("bad-params", "sending it back needs a reason");
  }
  database
    .prepare(
      `INSERT INTO approvals (project_id, target, status, by_id, note, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, target) DO UPDATE SET status = excluded.status, by_id = excluded.by_id,
         note = excluded.note, at = excluded.at`,
    )
    .run(input.projectId, input.target, input.status, actor.id, note ?? null, now);
  database
    .prepare("INSERT INTO approval_history (project_id, target, status, by_id, note, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.projectId, input.target, input.status, actor.id, note ?? null, now);
  return toRecord(database.prepare("SELECT * FROM approvals WHERE project_id = ? AND target = ?").get(input.projectId, input.target) as Row);
}
