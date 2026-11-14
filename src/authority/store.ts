/**
 * The project authority's durable half: the log of applied edits, and where
 * the last snapshot stands.
 *
 * The authority keeps a project's documents in memory and applies every edit
 * there. What makes that safe across a restart is this: each edit is written
 * here before the authority treats it as done, and a project is reopened by
 * reading the revision its last snapshot made and replaying every edit after
 * that snapshot's seq. Nothing an author was told had happened can be lost by
 * the process going away.
 *
 * `document` and `op` are Studio's JSON, stored as text and never read here.
 */
import type { DatabaseSync } from "node:sqlite";

/** One applied edit, as the log keeps it. */
export interface StoredEffect {
  readonly seq: number;
  readonly clientId: string;
  readonly accountId: string | null;
  readonly by: string;
  readonly document: unknown;
  readonly op: unknown;
  /** Translations and takes a paste derived, when it did. */
  readonly derived?: unknown;
  /**
   * The files it wrote. Kept so a server that reopens the project and does not apply the edit
   * again (a saved version already holds it) still knows which files it wrote, for offline
   * whole-file edits to collide with. Never sent to a Studio.
   */
  readonly touched?: readonly string[];
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/** Where a project's snapshots stand: everything up to `seq` is in `revision`. */
export interface SnapshotMark {
  readonly seq: number;
  readonly revision: string | null;
  readonly at: number;
}

export function appendEffect(database: DatabaseSync, projectId: string, effect: StoredEffect): void {
  database
    .prepare(
      `INSERT INTO doc_effects (project_id, seq, client_id, account_id, by_label, document, op, derived, touched, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      effect.seq,
      effect.clientId,
      effect.accountId,
      effect.by,
      JSON.stringify(effect.document),
      JSON.stringify(effect.op),
      effect.derived === undefined ? null : JSON.stringify(effect.derived),
      effect.touched === undefined || effect.touched.length === 0 ? null : JSON.stringify(effect.touched),
      effect.at,
    );
}

/**
 * Effects after `after`, oldest first, at most `limit` of them and stopping
 * before the page would pass `limitBytes` (one effect always fits, so a page
 * is never empty while there is more).
 */
export function effectsAfter(
  database: DatabaseSync,
  projectId: string,
  after: number,
  page: { readonly limit: number; readonly limitBytes?: number } = { limit: Number.MAX_SAFE_INTEGER },
): { effects: StoredEffect[]; more: boolean } {
  const rows = database
    .prepare(
      `SELECT seq, client_id, account_id, by_label, document, op, derived, touched, at FROM doc_effects
       WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(projectId, after, Math.min(page.limit, Number.MAX_SAFE_INTEGER - 1) + 1) as Array<{
    seq: number;
    client_id: string;
    account_id: string | null;
    by_label: string;
    document: string;
    op: string;
    derived: string | null;
    touched: string | null;
    at: number;
  }>;
  const effects: StoredEffect[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, page.limit)) {
    const size = row.document.length + row.op.length + (row.derived?.length ?? 0) + 256;
    if (page.limitBytes !== undefined && effects.length > 0 && bytes + size > page.limitBytes) {
      return { effects, more: true };
    }
    bytes += size;
    effects.push({
      seq: row.seq,
      clientId: row.client_id,
      accountId: row.account_id,
      by: row.by_label,
      document: JSON.parse(row.document) as unknown,
      op: JSON.parse(row.op) as unknown,
      ...(row.derived === null ? {} : { derived: JSON.parse(row.derived) as unknown }),
      ...(row.touched === null ? {} : { touched: JSON.parse(row.touched) as string[] }),
      at: row.at,
    });
  }
  return { effects, more: rows.length > page.limit };
}

/** The highest seq the log holds for a project, or zero. */
export function lastSeq(database: DatabaseSync, projectId: string): number {
  const row = database.prepare("SELECT MAX(seq) AS seq FROM doc_effects WHERE project_id = ?").get(projectId) as
    | { seq: number | null }
    | undefined;
  return row?.seq ?? 0;
}

export function snapshotMark(database: DatabaseSync, projectId: string): SnapshotMark | undefined {
  const row = database.prepare("SELECT seq, revision, at FROM doc_snapshots WHERE project_id = ?").get(projectId) as
    | { seq: number; revision: string | null; at: number }
    | undefined;
  return row === undefined ? undefined : { seq: row.seq, revision: row.revision, at: row.at };
}

export function markSnapshot(database: DatabaseSync, projectId: string, mark: SnapshotMark): void {
  database
    .prepare(
      `INSERT INTO doc_snapshots (project_id, seq, revision, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET seq = excluded.seq, revision = excluded.revision, at = excluded.at`,
    )
    .run(projectId, mark.seq, mark.revision, mark.at);
}

/**
 * Clear the log up to `throughSeq` for edits older than `before` (ms), never past what a saved version
 * holds - the caller passes at most the snapshot's seq. Answers the seq the log is now cleared to.
 */
export function pruneEffects(database: DatabaseSync, projectId: string, throughSeq: number, before: number): number {
  const row = database
    .prepare("SELECT MAX(seq) AS seq FROM doc_effects WHERE project_id = ? AND seq <= ? AND at < ?")
    .get(projectId, throughSeq, before) as { seq: number | null } | undefined;
  const through = row?.seq ?? 0;
  if (through <= prunedThrough(database, projectId)) {
    return prunedThrough(database, projectId);
  }
  database.prepare("DELETE FROM doc_effects WHERE project_id = ? AND seq <= ?").run(projectId, through);
  database.prepare("UPDATE doc_snapshots SET pruned_through = ? WHERE project_id = ?").run(through, projectId);
  return through;
}

/** The seq the log has been cleared to, or zero. */
export function prunedThrough(database: DatabaseSync, projectId: string): number {
  const row = database.prepare("SELECT pruned_through FROM doc_snapshots WHERE project_id = ?").get(projectId) as
    | { pruned_through: number }
    | undefined;
  return row?.pruned_through ?? 0;
}
