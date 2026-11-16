/**
 * Playable builds and the pictures put beside comments.
 *
 * Both are files kept under the storage root - builds/{project}/{id} and
 * attachments/{project}/{id}.{type} - with a row here saying what each is. The
 * server never opens a build: it is bytes somebody uploaded and somebody else
 * downloads. A picture is checked by its magic number and nothing more.
 *
 * Who may do what:
 *   - a build is uploaded and changed by an owner or an editor, and removed by
 *     an owner or whoever uploaded it;
 *   - a picture is put down by any member who may comment (everybody but a
 *     viewer), and taken away by whoever put it there or an owner.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { booleanColumn, inTransaction, integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { BUILD_LIMIT_MB, policyNumber, STORAGE_QUOTA_MB } from "../identity/policy.js";
import { findUserById, isOperator, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import type { TeamAttachment, TeamBuild } from "../team/protocol.js";

export class BuildRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export interface BuildRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly note: string | undefined;
  readonly revision: string | undefined;
  readonly platform: string | undefined;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedBy: string | undefined;
  readonly createdAt: number;
  readonly latest: boolean;
}

export interface AttachmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly type: "png" | "jpg" | "webp";
  readonly size: number;
  readonly uploadedBy: string | undefined;
  readonly createdAt: number;
}

function toBuild(row: Row): BuildRecord {
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    name: textColumn(row, "name"),
    note: optionalTextColumn(row, "note"),
    revision: optionalTextColumn(row, "revision"),
    platform: optionalTextColumn(row, "platform"),
    file: textColumn(row, "file"),
    size: integerColumn(row, "size"),
    sha256: textColumn(row, "sha256"),
    uploadedBy: optionalTextColumn(row, "uploaded_by"),
    createdAt: integerColumn(row, "created_at"),
    latest: booleanColumn(row, "latest"),
  };
}

function toAttachment(row: Row): AttachmentRecord {
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    type: textColumn(row, "type") as AttachmentRecord["type"],
    size: integerColumn(row, "size"),
    uploadedBy: optionalTextColumn(row, "uploaded_by"),
    createdAt: integerColumn(row, "created_at"),
  };
}

export function buildView(database: DatabaseSync, build: BuildRecord): TeamBuild {
  const uploader = build.uploadedBy === undefined ? undefined : findUserById(database, build.uploadedBy)?.username;
  return {
    id: build.id,
    project: build.projectId,
    name: build.name,
    ...(build.note === undefined ? {} : { note: build.note }),
    ...(build.revision === undefined ? {} : { revision: build.revision }),
    ...(build.platform === undefined ? {} : { platform: build.platform }),
    file: build.file,
    size: build.size,
    sha256: build.sha256,
    ...(uploader === undefined ? {} : { uploadedBy: uploader }),
    createdAt: build.createdAt,
    latest: build.latest,
  };
}

export function attachmentView(database: DatabaseSync, attachment: AttachmentRecord): TeamAttachment {
  const uploader = attachment.uploadedBy === undefined ? undefined : findUserById(database, attachment.uploadedBy)?.username;
  return {
    id: attachment.id,
    project: attachment.projectId,
    type: attachment.type,
    size: attachment.size,
    ...(uploader === undefined ? {} : { uploadedBy: uploader }),
    createdAt: attachment.createdAt,
  };
}

/** Where a project's builds are kept under the storage root. */
export function buildsDir(root: string, projectId: string): string {
  return join(root, "builds", projectId);
}

/** Where a project's pictures are kept under the storage root. */
export function attachmentsDir(root: string, projectId: string): string {
  return join(root, "attachments", projectId);
}

/** Whether this account may upload or change a project's builds. */
export function mayUploadBuild(database: DatabaseSync, projectId: string, user: UserRecord): boolean {
  const role = projectRole(database, projectId, user);
  return role === "owner" || role === "editor";
}

/** Whether this account may put a picture beside a comment in this project. */
export function mayAttach(database: DatabaseSync, projectId: string, user: UserRecord): boolean {
  const role = projectRole(database, projectId, user);
  return role !== undefined && role !== "viewer";
}

/** A file name somebody sent, made safe to put in a header and short enough to show. */
export function cleanFileName(name: string | undefined, fallback: string): string {
  const cleaned = [...(name ?? "")]
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f && !`"\\/`.includes(char))
    .join("")
    .trim()
    .slice(0, 160);
  return cleaned === "" ? fallback : cleaned;
}

export function listBuilds(database: DatabaseSync, viewer: UserRecord, projectId: string): BuildRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new BuildRefusal("not-found", "there is no project of that id on this server");
  return (database.prepare("SELECT * FROM builds WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(toBuild);
}

export function findBuild(database: DatabaseSync, id: string): BuildRecord | undefined {
  const row = database.prepare("SELECT * FROM builds WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toBuild(row);
}

/** Record a build whose bytes are already at buildsDir(...)/id. The first of a project is the one to play. */
export function recordBuild(
  database: DatabaseSync,
  input: {
    id: string;
    projectId: string;
    name: string;
    note?: string;
    revision?: string;
    platform?: string;
    file: string;
    size: number;
    sha256: string;
    uploadedBy: string;
    latest?: boolean;
  },
  now = Date.now(),
): BuildRecord {
  return inTransaction(database, () => {
    const none = database.prepare("SELECT 1 FROM builds WHERE project_id = ? LIMIT 1").get(input.projectId) === undefined;
    const latest = input.latest === true || none;
    if (latest) database.prepare("UPDATE builds SET latest = 0 WHERE project_id = ?").run(input.projectId);
    database
      .prepare(
        `INSERT INTO builds (id, project_id, name, note, revision, platform, file, size, sha256, uploaded_by, created_at, latest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.name,
        input.note ?? null,
        input.revision ?? null,
        input.platform ?? null,
        input.file,
        input.size,
        input.sha256,
        input.uploadedBy,
        now,
        latest ? 1 : 0,
      );
    return findBuild(database, input.id)!;
  });
}

export interface BuildChange {
  readonly name?: string;
  readonly note?: string | null;
  readonly revision?: string | null;
  readonly platform?: string | null;
  readonly latest?: boolean;
}

/** Change what is said about a build. Answers it, and the build that stopped being the latest, if one did. */
export function updateBuild(
  database: DatabaseSync,
  actor: UserRecord,
  id: string,
  change: BuildChange,
): { build: BuildRecord; unset?: BuildRecord } {
  const build = findBuild(database, id);
  if (build === undefined || !maySeeProject(database, build.projectId, actor)) {
    throw new BuildRefusal("not-found", "there is no build of that id");
  }
  if (!mayUploadBuild(database, build.projectId, actor)) {
    throw new BuildRefusal("refused", "only owners and editors change a project's builds");
  }
  if (change.name !== undefined && change.name.trim() === "") throw new BuildRefusal("bad-params", "a build needs a name");
  return inTransaction(database, () => {
    let unset: BuildRecord | undefined;
    if (change.latest === true && !build.latest) {
      const row = database.prepare("SELECT * FROM builds WHERE project_id = ? AND latest = 1").get(build.projectId) as Row | undefined;
      unset = row === undefined ? undefined : toBuild(row);
      database.prepare("UPDATE builds SET latest = 0 WHERE project_id = ?").run(build.projectId);
    }
    database
      .prepare(
        `UPDATE builds SET name = ?, note = ?, revision = ?, platform = ?, latest = ? WHERE id = ?`,
      )
      .run(
        change.name?.trim() ?? build.name,
        change.note === undefined ? (build.note ?? null) : change.note?.trim() || null,
        change.revision === undefined ? (build.revision ?? null) : change.revision?.trim() || null,
        change.platform === undefined ? (build.platform ?? null) : change.platform?.trim() || null,
        change.latest === undefined ? (build.latest ? 1 : 0) : change.latest ? 1 : 0,
        id,
      );
    const after = findBuild(database, id)!;
    return unset === undefined ? { build: after } : { build: after, unset: findBuild(database, unset.id) ?? unset };
  });
}

/** Remove a build's row and its file. */
export async function deleteBuild(database: DatabaseSync, root: string, actor: UserRecord, id: string): Promise<BuildRecord> {
  const build = findBuild(database, id);
  if (build === undefined || !maySeeProject(database, build.projectId, actor)) {
    throw new BuildRefusal("not-found", "there is no build of that id");
  }
  const owner = projectRole(database, build.projectId, actor) === "owner" || isOperator(actor.groups);
  if (!owner && build.uploadedBy !== actor.id) {
    throw new BuildRefusal("refused", "an owner, or whoever uploaded it, removes a build");
  }
  database.prepare("DELETE FROM builds WHERE id = ?").run(id);
  await rm(join(buildsDir(root, build.projectId), build.id), { force: true });
  return build;
}

/** How many bytes a project's builds and pictures take, as the rows say. */
export function projectStorageBytes(database: DatabaseSync, projectId: string): number {
  const builds = database.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM builds WHERE project_id = ?").get(projectId) as Row;
  const pictures = database.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE project_id = ?").get(projectId) as Row;
  return integerColumn(builds, "total") + integerColumn(pictures, "total");
}

export function recordAttachment(
  database: DatabaseSync,
  input: { projectId: string; type: AttachmentRecord["type"]; size: number; uploadedBy: string },
  now = Date.now(),
): AttachmentRecord {
  const id = randomUUID();
  database
    .prepare("INSERT INTO attachments (id, project_id, type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.projectId, input.type, input.size, input.uploadedBy, now);
  return findAttachment(database, id)!;
}

export function findAttachment(database: DatabaseSync, id: string): AttachmentRecord | undefined {
  const row = database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toAttachment(row);
}

export async function deleteAttachment(database: DatabaseSync, root: string, actor: UserRecord, id: string): Promise<AttachmentRecord> {
  const attachment = findAttachment(database, id);
  if (attachment === undefined || !maySeeProject(database, attachment.projectId, actor)) {
    throw new BuildRefusal("not-found", "there is no picture of that id");
  }
  const owner = projectRole(database, attachment.projectId, actor) === "owner" || isOperator(actor.groups);
  if (!owner && attachment.uploadedBy !== actor.id) {
    throw new BuildRefusal("refused", "an owner, or whoever put it there, takes a picture away");
  }
  database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  await rm(join(attachmentsDir(root, attachment.projectId), `${attachment.id}.${attachment.type}`), { force: true });
  return attachment;
}

const MEGABYTE = 1024 * 1024;
/** The share of a quota past which a project is warned it is nearly full. */
export const STORAGE_WARN_AT = 0.9;

/** The largest build this server takes, as `storage.build_limit_mb` stands now. */
export function buildLimitBytes(database: DatabaseSync): number {
  return Math.max(1, policyNumber(database, BUILD_LIMIT_MB)) * MEGABYTE;
}

/** Each project's storage ceiling, or undefined when `storage.project_quota_mb` is 0 (none). */
export function projectQuotaBytes(database: DatabaseSync): number | undefined {
  const megabytes = policyNumber(database, STORAGE_QUOTA_MB);
  return megabytes > 0 ? megabytes * MEGABYTE : undefined;
}

export interface StorageView {
  readonly project: string;
  readonly usedBytes: number;
  readonly buildBytes: number;
  readonly attachmentBytes: number;
  readonly quotaBytes?: number;
  /** Past {@link STORAGE_WARN_AT} of the quota, or over it. */
  readonly nearlyFull: boolean;
  readonly full: boolean;
}

export function storageView(database: DatabaseSync, projectId: string): StorageView {
  const builds = database.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM builds WHERE project_id = ?").get(projectId) as Row;
  const pictures = database.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE project_id = ?").get(projectId) as Row;
  const buildBytes = integerColumn(builds, "total");
  const attachmentBytes = integerColumn(pictures, "total");
  const usedBytes = buildBytes + attachmentBytes;
  const quotaBytes = projectQuotaBytes(database);
  return {
    project: projectId,
    usedBytes,
    buildBytes,
    attachmentBytes,
    ...(quotaBytes === undefined ? {} : { quotaBytes }),
    nearlyFull: quotaBytes !== undefined && usedBytes >= quotaBytes * STORAGE_WARN_AT,
    full: quotaBytes !== undefined && usedBytes >= quotaBytes,
  };
}

/** How many more bytes this project may take, or Infinity with no quota. */
export function storageRoom(database: DatabaseSync, projectId: string): number {
  const quota = projectQuotaBytes(database);
  return quota === undefined ? Number.POSITIVE_INFINITY : Math.max(0, quota - projectStorageBytes(database, projectId));
}
