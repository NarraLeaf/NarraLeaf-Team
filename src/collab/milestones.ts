/**
 * Milestones: a name on one revision of a project — "Demo 1", "Steam Next
 * Fest" — that the console can be read at. Unique per project; the revision is
 * a string this server never reads.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import type { TeamMilestone } from "../team/protocol.js";

export interface MilestoneRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly revision: string;
  readonly note: string | undefined;
  readonly createdBy: string | undefined;
  readonly createdAt: number;
}

export class MilestoneRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function toRecord(row: Row): MilestoneRecord {
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    name: textColumn(row, "name"),
    revision: textColumn(row, "revision"),
    note: optionalTextColumn(row, "note"),
    createdBy: optionalTextColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
  };
}

export function milestoneView(database: DatabaseSync, milestone: MilestoneRecord): TeamMilestone {
  const by = milestone.createdBy === undefined ? undefined : findUserById(database, milestone.createdBy)?.username;
  return {
    id: milestone.id,
    project: milestone.projectId,
    name: milestone.name,
    revision: milestone.revision,
    ...(milestone.note === undefined ? {} : { note: milestone.note }),
    ...(by === undefined ? {} : { createdBy: by }),
    createdAt: milestone.createdAt,
  };
}

export function findMilestone(database: DatabaseSync, id: string): MilestoneRecord | undefined {
  const row = database.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listMilestones(database: DatabaseSync, viewer: UserRecord, projectId: string): MilestoneRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new MilestoneRefusal("not-found", "there is no project of that id on this server");
  return (database.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at DESC LIMIT 500").all(projectId) as Row[]).map(toRecord);
}

/** Owners and editors name revisions: they are the ones who make them. */
export function createMilestone(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; name: string; revision: string; note?: string },
  now = Date.now(),
): MilestoneRecord {
  const role = projectRole(database, input.projectId, actor);
  if (role === undefined) throw new MilestoneRefusal("not-found", "there is no project of that id on this server");
  if (role !== "owner" && role !== "editor") throw new MilestoneRefusal("refused", "owners and editors name revisions");
  const taken = database.prepare("SELECT 1 FROM milestones WHERE project_id = ? AND name = ?").get(input.projectId, input.name);
  if (taken !== undefined) throw new MilestoneRefusal("conflict", "this project already has a milestone of that name");
  const id = randomUUID();
  database
    .prepare("INSERT INTO milestones (id, project_id, name, revision, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.projectId, input.name, input.revision, input.note ?? null, actor.id, now);
  return findMilestone(database, id) as MilestoneRecord;
}

/** Whoever named it, or an owner of the project, may take the name off. */
export function deleteMilestone(database: DatabaseSync, actor: UserRecord, id: string): MilestoneRecord {
  const current = findMilestone(database, id);
  if (current === undefined || !maySeeProject(database, current.projectId, actor)) {
    throw new MilestoneRefusal("not-found", "there is no milestone of that id");
  }
  if (current.createdBy !== actor.id && projectRole(database, current.projectId, actor) !== "owner") {
    throw new MilestoneRefusal("refused", "whoever named it, or an owner, may take it off");
  }
  database.prepare("DELETE FROM milestones WHERE id = ?").run(id);
  return current;
}
