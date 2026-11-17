/**
 * Asset locks: one person holds an asset of a project for a while — a
 * painter redoing a background — and an edit that touches it from anybody
 * else is refused until they let go or the time runs out. Whoever holds it, a
 * project owner, or an operator may let go; a lock past its time is gone.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, isOperator, type UserRecord } from "../identity/users.js";
import { mayEditArea, maySeeProject, projectRole } from "../projects/members.js";
import { ASSET_LOCK_DEFAULT_MINUTES, ASSET_LOCK_MAX_MINUTES, type TeamAssetLock } from "../team/protocol.js";

export interface LockRecord {
  readonly projectId: string;
  readonly assetId: string;
  readonly holderId: string;
  readonly note: string | undefined;
  readonly at: number;
  readonly expiresAt: number;
}

export class LockRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function toRecord(row: Row): LockRecord {
  return {
    projectId: textColumn(row, "project_id"),
    assetId: textColumn(row, "asset_id"),
    holderId: textColumn(row, "holder_id"),
    note: optionalTextColumn(row, "note"),
    at: integerColumn(row, "at"),
    expiresAt: integerColumn(row, "expires_at"),
  };
}

export function lockView(database: DatabaseSync, lock: LockRecord): TeamAssetLock {
  return {
    project: lock.projectId,
    asset: lock.assetId,
    holder: findUserById(database, lock.holderId)?.username ?? "?",
    ...(lock.note === undefined ? {} : { note: lock.note }),
    at: lock.at,
    expiresAt: lock.expiresAt,
  };
}

/** The locks of a project still in force. Those past their time are cleared on the way. */
export function activeLocks(database: DatabaseSync, projectId: string, now = Date.now()): LockRecord[] {
  database.prepare("DELETE FROM asset_locks WHERE project_id = ? AND expires_at <= ?").run(projectId, now);
  return (database.prepare("SELECT * FROM asset_locks WHERE project_id = ? ORDER BY at").all(projectId) as Row[]).map(toRecord);
}

export function listLocks(database: DatabaseSync, viewer: UserRecord, projectId: string, now = Date.now()): LockRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new LockRefusal("not-found", "there is no project of that id on this server");
  return activeLocks(database, projectId, now);
}

/** The first of these assets somebody other than `accountId` holds, if any. */
export function lockedAgainst(
  database: DatabaseSync,
  projectId: string,
  accountId: string,
  assetIds: readonly string[],
  now = Date.now(),
): LockRecord | undefined {
  if (assetIds.length === 0) return undefined;
  const statement = database.prepare("SELECT * FROM asset_locks WHERE project_id = ? AND asset_id = ? AND expires_at > ?");
  for (const assetId of assetIds) {
    const row = statement.get(projectId, assetId, now) as Row | undefined;
    if (row !== undefined && textColumn(row, "holder_id") !== accountId) return toRecord(row);
  }
  return undefined;
}

/** Hold an asset. Taking one's own lock again extends it; somebody else's is refused. */
export function lockAsset(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; assetId: string; minutes?: number; note?: string },
  now = Date.now(),
): LockRecord {
  if (projectRole(database, input.projectId, actor) === undefined) {
    throw new LockRefusal("not-found", "there is no project of that id on this server");
  }
  if (!mayEditArea(database, input.projectId, actor, "assets")) {
    throw new LockRefusal("refused", "only those who may change the assets hold one");
  }
  const minutes = input.minutes ?? ASSET_LOCK_DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > ASSET_LOCK_MAX_MINUTES) {
    throw new LockRefusal("bad-params", `minutes has to be between 1 and ${ASSET_LOCK_MAX_MINUTES}`);
  }
  const held = lockedAgainst(database, input.projectId, actor.id, [input.assetId], now);
  if (held !== undefined) {
    const holder = findUserById(database, held.holderId)?.username ?? "somebody";
    throw new LockRefusal("conflict", `${holder} holds that asset`);
  }
  database
    .prepare(
      `INSERT INTO asset_locks (project_id, asset_id, holder_id, note, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, asset_id) DO UPDATE SET holder_id = excluded.holder_id, note = excluded.note,
         at = excluded.at, expires_at = excluded.expires_at`,
    )
    .run(input.projectId, input.assetId, actor.id, input.note?.trim() || null, now, now + minutes * 60_000);
  return toRecord(
    database.prepare("SELECT * FROM asset_locks WHERE project_id = ? AND asset_id = ?").get(input.projectId, input.assetId) as Row,
  );
}

/** Let go of one. Answers the lock that was there, or undefined for none. */
export function unlockAsset(database: DatabaseSync, actor: UserRecord, projectId: string, assetId: string, now = Date.now()): LockRecord | undefined {
  if (projectRole(database, projectId, actor) === undefined) {
    throw new LockRefusal("not-found", "there is no project of that id on this server");
  }
  const current = activeLocks(database, projectId, now).find((lock) => lock.assetId === assetId);
  if (current === undefined) return undefined;
  if (current.holderId !== actor.id && projectRole(database, projectId, actor) !== "owner" && !isOperator(actor.groups)) {
    throw new LockRefusal("refused", "whoever holds it, an owner or an operator may let it go");
  }
  database.prepare("DELETE FROM asset_locks WHERE project_id = ? AND asset_id = ?").run(projectId, assetId);
  return current;
}
