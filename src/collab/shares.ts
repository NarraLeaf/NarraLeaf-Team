/**
 * Share links: a read-only look at a project for somebody with no account - a
 * proofreader, a voice actor, the person paying for it.
 *
 * A link is a random token. Only its SHA-256 is kept, so the table read on its
 * own opens nothing; the token is shown once, to the owner who made it, and
 * never again. A link is frozen at a revision (or follows `head`), may run out,
 * and may be taken back.
 *
 * What a link shows is a list of paths the console worked out when it was made
 * - a story's document and the registers it needs - because this server does not
 * read project files (docs/architecture.md, D2) and so cannot work out for
 * itself what "this story" is. No list is the whole project. A path ending in
 * `/` is everything under it.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { booleanColumn, integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, isOperator, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import { findProjectById } from "../projects/registry.js";
import { SHARE_LINK_MAX_DAYS, type TeamShareLink, type TeamShareView } from "../team/protocol.js";

const DAY = 24 * 60 * 60 * 1000;
/** The most paths one link lists. A story and its registers, not a mirror of the project. */
export const SHARE_PATHS_LIMIT = 2000;
const LABEL_LIMIT = 120;

export class ShareRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export interface ShareRecord {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly scope: string;
  readonly revision: string;
  readonly paths: readonly string[] | undefined;
  readonly allowComments: boolean;
  readonly expiresAt: number | undefined;
  readonly revokedAt: number | undefined;
  readonly createdBy: string | undefined;
  readonly createdAt: number;
  readonly lastUsedAt: number | undefined;
  readonly uses: number;
}

function toRecord(row: Row): ShareRecord {
  let paths: string[] | undefined;
  const stored = optionalTextColumn(row, "paths");
  if (stored !== undefined) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      paths = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      paths = [];
    }
  }
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    label: textColumn(row, "label"),
    scope: textColumn(row, "scope"),
    revision: textColumn(row, "revision"),
    paths,
    allowComments: booleanColumn(row, "allow_comments"),
    expiresAt: optionalIntegerColumn(row, "expires_at"),
    revokedAt: optionalIntegerColumn(row, "revoked_at"),
    createdBy: optionalTextColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
    lastUsedAt: optionalIntegerColumn(row, "last_used_at"),
    uses: integerColumn(row, "uses"),
  };
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function shareLinkView(database: DatabaseSync, share: ShareRecord): TeamShareLink {
  const creator = share.createdBy === undefined ? undefined : findUserById(database, share.createdBy)?.username;
  return {
    id: share.id,
    project: share.projectId,
    label: share.label,
    scope: share.scope,
    revision: share.revision,
    ...(share.paths === undefined ? {} : { paths: [...share.paths] }),
    allowComments: share.allowComments,
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
    ...(share.revokedAt === undefined ? {} : { revokedAt: share.revokedAt }),
    ...(creator === undefined ? {} : { createdBy: creator }),
    createdAt: share.createdAt,
    ...(share.lastUsedAt === undefined ? {} : { lastUsedAt: share.lastUsedAt }),
    uses: share.uses,
  };
}

/** What a guest is told about the link they opened. Nothing about who made it. */
export function shareGuestView(database: DatabaseSync, share: ShareRecord): TeamShareView {
  const project = findProjectById(database, share.projectId);
  return {
    project: share.projectId,
    projectName: project?.name ?? share.projectId,
    label: share.label,
    scope: share.scope,
    revision: share.revision,
    allowComments: share.allowComments,
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
  };
}

function mayManage(database: DatabaseSync, projectId: string, user: UserRecord): boolean {
  return projectRole(database, projectId, user) === "owner" || isOperator(user.groups);
}

export function listShares(database: DatabaseSync, viewer: UserRecord, projectId: string): ShareRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new ShareRefusal("not-found", "there is no project of that id on this server");
  if (!mayManage(database, projectId, viewer)) throw new ShareRefusal("refused", "only a project's owners see its share links");
  return (database.prepare("SELECT * FROM share_links WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(toRecord);
}

/** A path a link may list: relative, no `..`, no NUL, not absurdly long. */
function cleanPath(path: string): string | undefined {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (trimmed === "" || trimmed.length > 512 || trimmed.includes("\0")) return undefined;
  if (trimmed.split("/").some((part) => part === ".." || part === ".")) return undefined;
  return trimmed;
}

export function createShare(
  database: DatabaseSync,
  actor: UserRecord,
  input: {
    projectId: string;
    label?: string;
    scope?: string;
    revision?: string;
    paths?: readonly string[];
    allowComments?: boolean;
    days?: number;
  },
  now = Date.now(),
): { share: ShareRecord; token: string } {
  if (!maySeeProject(database, input.projectId, actor)) throw new ShareRefusal("not-found", "there is no project of that id on this server");
  if (!mayManage(database, input.projectId, actor)) throw new ShareRefusal("refused", "only a project's owners make share links");
  const revision = input.revision ?? "head";
  if (revision !== "head" && !/^[A-Za-z0-9]{8,128}$/.test(revision)) throw new ShareRefusal("bad-params", "that is not a revision id");
  let paths: string[] | undefined;
  if (input.paths !== undefined) {
    if (input.paths.length === 0) throw new ShareRefusal("bad-params", "a share link has to show something");
    if (input.paths.length > SHARE_PATHS_LIMIT) throw new ShareRefusal("bad-params", "that is more files than one link shows");
    paths = [];
    for (const raw of input.paths) {
      const path = cleanPath(raw);
      if (path === undefined) throw new ShareRefusal("bad-params", `${raw} is not a path in a project`);
      if (!paths.includes(path)) paths.push(path);
    }
  }
  if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > SHARE_LINK_MAX_DAYS)) {
    throw new ShareRefusal("bad-params", `a link runs for between 1 and ${SHARE_LINK_MAX_DAYS} days`);
  }
  const label = (input.label ?? "").trim().slice(0, LABEL_LIMIT);
  const scope = (input.scope ?? (paths === undefined ? "project" : "story")).trim().slice(0, 256) || "project";
  const token = randomBytes(24).toString("base64url");
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO share_links (id, project_id, token_hash, label, scope, revision, paths, allow_comments, expires_at,
         revoked_at, created_by, created_at, last_used_at, uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0)`,
    )
    .run(
      id,
      input.projectId,
      hashShareToken(token),
      label === "" ? "共享链接" : label,
      scope,
      revision,
      paths === undefined ? null : JSON.stringify(paths),
      input.allowComments === true ? 1 : 0,
      input.days === undefined ? null : now + input.days * DAY,
      actor.id,
      now,
    );
  return { share: findShare(database, id)!, token };
}

export function findShare(database: DatabaseSync, id: string): ShareRecord | undefined {
  const row = database.prepare("SELECT * FROM share_links WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function revokeShare(database: DatabaseSync, actor: UserRecord, id: string, now = Date.now()): ShareRecord {
  const share = findShare(database, id);
  if (share === undefined || !maySeeProject(database, share.projectId, actor)) throw new ShareRefusal("not-found", "there is no share link of that id");
  if (!mayManage(database, share.projectId, actor)) throw new ShareRefusal("refused", "only a project's owners take a share link back");
  if (share.revokedAt === undefined) database.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ?").run(now, id);
  return findShare(database, id)!;
}

/** The link a token opens, if it still opens one: not taken back, not run out, its project still here. */
export function shareByToken(database: DatabaseSync, token: string, now = Date.now()): ShareRecord | undefined {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
  const row = database.prepare("SELECT * FROM share_links WHERE token_hash = ?").get(hashShareToken(token)) as Row | undefined;
  if (row === undefined) return undefined;
  const share = toRecord(row);
  if (share.revokedAt !== undefined) return undefined;
  if (share.expiresAt !== undefined && share.expiresAt <= now) return undefined;
  if (findProjectById(database, share.projectId) === undefined) return undefined;
  return share;
}

/** Count one use of a link. */
export function touchShare(database: DatabaseSync, id: string, now = Date.now()): void {
  database.prepare("UPDATE share_links SET uses = uses + 1, last_used_at = ? WHERE id = ?").run(now, id);
}

/** Whether a link shows this path. */
export function shareShows(share: ShareRecord, path: string): boolean {
  if (share.paths === undefined) return true;
  return share.paths.some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed));
}
