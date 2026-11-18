/**
 * The history versions the project authority wrote, and who each one is down to.
 *
 * Every version is a revision the server commits under one account - the one it reads the
 * repository as - so the revision's author names that account whoever did the work. What a
 * timeline, a contribution graph or a history list needs is kept here instead: who saved it (for a
 * version saved by hand), whether the server saved it on its own, and whose edits it holds.
 */
import type { DatabaseSync } from "node:sqlite";

import { findUserById } from "../identity/users.js";
import type { TeamDocVersion, TeamVersionRole } from "../team/protocol.js";

/** The line every snapshot's message ends with; a version saved by hand has its name above it. */
const SNAPSHOT_TRAILER = /(?:^|\n\n)Team snapshot at seq \d+\s*$/;

/** Whether a revision message is one the authority wrote. */
export function isSnapshotMessage(message: string | undefined): boolean {
  return message !== undefined && SNAPSHOT_TRAILER.test(message);
}

export interface NewVersion {
  readonly projectId: string;
  readonly revision: string;
  readonly seq: number;
  /** The seq of the version before it: the edits after it and up to `seq` are this one's. */
  readonly fromSeq: number;
  readonly label?: string;
  readonly savedBy?: string;
  readonly auto: boolean;
  readonly at: number;
}

/** Write down a version, working out whose edits it holds from the log. */
export function recordVersion(database: DatabaseSync, version: NewVersion): void {
  const rows = database
    .prepare(
      `SELECT DISTINCT account_id FROM doc_effects
        WHERE project_id = ? AND seq > ? AND seq <= ? AND account_id IS NOT NULL`,
    )
    .all(version.projectId, version.fromSeq, version.seq) as Array<{ account_id: string }>;
  const participants = rows.map((row) => row.account_id);
  if (version.savedBy !== undefined && !participants.includes(version.savedBy) && version.label?.startsWith("Restored ")) {
    participants.push(version.savedBy);
  }
  database
    .prepare(
      `INSERT OR REPLACE INTO doc_versions (project_id, revision, seq, from_seq, label, saved_by, auto, participants, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      version.projectId,
      version.revision,
      version.seq,
      version.fromSeq,
      version.label ?? null,
      version.savedBy ?? null,
      version.auto ? 1 : 0,
      JSON.stringify(participants),
      version.at,
    );
}

/** Whether a revision is one of the project's versions. */
export function isVersion(database: DatabaseSync, projectId: string, revision: string): boolean {
  return database.prepare("SELECT 1 FROM doc_versions WHERE project_id = ? AND revision = ?").get(projectId, revision) !== undefined;
}

function username(database: DatabaseSync, id: string | null): string | undefined {
  if (id === null) return undefined;
  return findUserById(database, id)?.username;
}

/** What is known about each of these revisions that is a version, by revision. */
export function versionsOf(database: DatabaseSync, projectId: string, revisions: readonly string[]): Map<string, TeamDocVersion> {
  const out = new Map<string, TeamDocVersion>();
  if (revisions.length === 0) return out;
  const rows = database
    .prepare(
      `SELECT revision, seq, label, saved_by, auto, participants FROM doc_versions
        WHERE project_id = ? AND revision IN (${revisions.map(() => "?").join(", ")})`,
    )
    .all(projectId, ...revisions) as Array<{
    revision: string;
    seq: number;
    label: string | null;
    saved_by: string | null;
    auto: number;
    participants: string;
  }>;
  for (const row of rows) {
    let ids: unknown = [];
    try {
      ids = JSON.parse(row.participants);
    } catch {
      ids = [];
    }
    const names = (Array.isArray(ids) ? ids : [])
      .map((id) => (typeof id === "string" ? username(database, id) : undefined))
      .filter((name): name is string => name !== undefined);
    const savedBy = username(database, row.saved_by);
    out.set(row.revision, {
      ...(row.label === null ? {} : { label: row.label }),
      auto: row.auto === 1,
      ...(savedBy === undefined ? {} : { savedBy }),
      participants: names,
      seq: row.seq,
    });
  }
  return out;
}

/** Who may save a version of a project, and restore one. */
export function versionRoles(database: DatabaseSync, projectId: string): { save: TeamVersionRole; restore: TeamVersionRole } {
  const row = database.prepare("SELECT save_role, restore_role FROM projects WHERE id = ?").get(projectId) as
    | { save_role: string; restore_role: string }
    | undefined;
  const role = (value: string | undefined): TeamVersionRole => (value === "owner" ? "owner" : "editor");
  return { save: role(row?.save_role), restore: role(row?.restore_role) };
}

export function setVersionRoles(
  database: DatabaseSync,
  projectId: string,
  roles: { save?: TeamVersionRole; restore?: TeamVersionRole },
): void {
  if (roles.save !== undefined) database.prepare("UPDATE projects SET save_role = ? WHERE id = ?").run(roles.save, projectId);
  if (roles.restore !== undefined) database.prepare("UPDATE projects SET restore_role = ? WHERE id = ?").run(roles.restore, projectId);
}
