/**
 * Watching: being told when something one cares about changes.
 *
 * A person watches a whole project (scope `''`) or one scene in it (scope `scene:{id}`). They hear
 * - as a `watch` notification - when:
 *
 *  - a version of the project is saved or restored: everyone watching the project, and everyone
 *    watching a scene edited since the last version;
 *  - a commit lands in the project's repository: everyone watching the project.
 *
 * Edits are not announced one by one - a scene is written a keystroke at a time. An edit only
 * marks its scenes touched (`watch_touched`), and only scenes somebody watches; the next version
 * says who to tell and clears the marks.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, textColumn, type Row } from "../identity/database.js";
import type { TeamWatch } from "../team/protocol.js";
import { announceWritten, notify } from "./notifications.js";

/** Scopes per project a person may watch, so the list stays something one can read. */
export const WATCHES_PER_PROJECT = 100;

export class WatchRefusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** `''` for the project, `scene:{id}` for a scene; anything else is refused. */
export function checkScope(scope: string): string {
  if (scope === "") return scope;
  if (/^scene:[A-Za-z0-9_.:-]{1,128}$/.test(scope)) return scope;
  throw new WatchRefusal("a watch is on the project, or on one scene as scene:{id}");
}

function toWatch(row: Row): TeamWatch {
  const scope = textColumn(row, "scope");
  return { project: textColumn(row, "project_id"), ...(scope === "" ? {} : { scope }), createdAt: integerColumn(row, "created_at") };
}

/** One person's watches, in one project or every one. */
export function listWatches(database: DatabaseSync, accountId: string, projectId?: string): TeamWatch[] {
  const rows =
    projectId === undefined
      ? database.prepare("SELECT * FROM watches WHERE account_id = ? ORDER BY project_id, scope").all(accountId)
      : database.prepare("SELECT * FROM watches WHERE account_id = ? AND project_id = ? ORDER BY scope").all(accountId, projectId);
  return (rows as Row[]).map(toWatch);
}

/** Start or stop watching. Answers whether anything changed. */
export function setWatch(database: DatabaseSync, accountId: string, projectId: string, scope: string, on: boolean, now = Date.now()): boolean {
  checkScope(scope);
  if (!on) {
    return Number(database.prepare("DELETE FROM watches WHERE account_id = ? AND project_id = ? AND scope = ?").run(accountId, projectId, scope).changes) > 0;
  }
  const count = integerColumn(
    database.prepare("SELECT COUNT(*) AS n FROM watches WHERE account_id = ? AND project_id = ?").get(accountId, projectId) as Row,
    "n",
  );
  if (count >= WATCHES_PER_PROJECT) throw new WatchRefusal(`one person watches at most ${WATCHES_PER_PROJECT} things in a project`);
  return (
    Number(
      database
        .prepare("INSERT INTO watches (account_id, project_id, scope, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(accountId, projectId, scope, now).changes,
    ) > 0
  );
}

/** Mark scenes an edit wrote, for the scenes somebody watches. Cheap when nobody does. */
export function touchScenes(database: DatabaseSync, projectId: string, sceneIds: readonly string[], accountId: string, now = Date.now()): void {
  for (const sceneId of new Set(sceneIds)) {
    const scope = `scene:${sceneId}`;
    const watched = database.prepare("SELECT 1 FROM watches WHERE project_id = ? AND scope = ? LIMIT 1").get(projectId, scope);
    if (watched === undefined) continue;
    database
      .prepare(
        `INSERT INTO watch_touched (project_id, scope, account_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, scope) DO UPDATE SET account_id = excluded.account_id, at = excluded.at`,
      )
      .run(projectId, scope, accountId, now);
  }
}

/** Who watches the project as a whole. */
function projectWatchers(database: DatabaseSync, projectId: string): string[] {
  return (database.prepare("SELECT account_id FROM watches WHERE project_id = ? AND scope = ''").all(projectId) as Row[]).map((row) =>
    textColumn(row, "account_id"),
  );
}

/** Who watches a scene that was touched since the last version. */
function touchedSceneWatchers(database: DatabaseSync, projectId: string): string[] {
  return (
    database
      .prepare(
        `SELECT DISTINCT w.account_id FROM watches w JOIN watch_touched t ON t.project_id = w.project_id AND t.scope = w.scope
         WHERE w.project_id = ?`,
      )
      .all(projectId) as Row[]
  ).map((row) => textColumn(row, "account_id"));
}

export interface WatchEvent {
  readonly projectId: string;
  readonly kind: "version" | "commit";
  /** The account that did it, never told about their own act; absent for a commit by a git name. */
  readonly actorId?: string;
  /** The revision. */
  readonly ref: string;
  readonly summary: string;
}

/**
 * Tell the watchers. A version also tells those watching a scene edited since the last one, and
 * clears the marks. Announced through the server's announcer: this can run with no request to
 * answer, from a refresh.
 */
export function notifyWatchers(database: DatabaseSync, event: WatchEvent, now = Date.now()): number {
  const recipients = new Set(projectWatchers(database, event.projectId));
  if (event.kind === "version") {
    for (const accountId of touchedSceneWatchers(database, event.projectId)) recipients.add(accountId);
    database.prepare("DELETE FROM watch_touched WHERE project_id = ?").run(event.projectId);
  }
  if (recipients.size === 0) return 0;
  const written = notify(
    database,
    recipients,
    { kind: "watch", projectId: event.projectId, ref: event.ref, summary: event.summary, ...(event.actorId === undefined ? {} : { actorId: event.actorId }) },
    now,
  );
  announceWritten(written);
  return written.size;
}
