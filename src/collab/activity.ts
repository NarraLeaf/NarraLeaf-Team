/**
 * What happened: the rows behind a timeline and a contribution graph.
 *
 * Written as things happen — a thread opened, a comment, a to-do finished —
 * and, for commits, by the refresh pass when it sees revisions it has not
 * recorded (src/projects/refresh.ts). Read with the caller's visibility: a row
 * about a project is shown to the project's members, and a private row to its
 * own account only.
 *
 * A commit's author is a string the pushing client wrote; loreserver does not
 * check it (docs/refactor-plan.zh.md §10). It is matched to an account by
 * username, address or display name where one matches, and the row keeps the
 * string either way, so a match is a convenience and never proof.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, type Row } from "../identity/database.js";
import { eachUser, findUserById, type UserRecord } from "../identity/users.js";
import { visibleProjectIds } from "../projects/members.js";
import type { TeamActivity, TeamActivityDay, TeamActivityKind } from "../team/protocol.js";

/** The longest summary kept: a line, not a document. */
const SUMMARY_LIMIT = 200;

export interface NewActivity {
  readonly accountId?: string;
  readonly actorLabel?: string;
  readonly projectId?: string;
  readonly kind: TeamActivityKind;
  readonly ref?: string;
  readonly summary?: string;
  readonly private?: boolean;
  readonly at?: number;
}

function clip(text: string | undefined): string | null {
  if (text === undefined) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? null : line.slice(0, SUMMARY_LIMIT);
}

export function recordActivity(database: DatabaseSync, entry: NewActivity): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO activity (account_id, actor_label, project_id, kind, ref, summary, private, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.accountId ?? null,
      entry.actorLabel ?? null,
      entry.projectId ?? null,
      entry.kind,
      entry.ref ?? null,
      clip(entry.summary),
      entry.private === true ? 1 : 0,
      entry.at ?? Date.now(),
    );
}

/**
 * The account a commit author string names, if one does.
 *
 * Studio writes `Name <address>`, a bare name, or a username. Tried in that
 * order of confidence: an exact address, an exact username, an exact display
 * name. Two accounts with one display name match neither.
 */
export function accountForAuthor(database: DatabaseSync, author: string | undefined): UserRecord | undefined {
  if (author === undefined || author.trim() === "") return undefined;
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(author.trim());
  const name = (match?.[1] ?? author).trim().toLowerCase();
  const address = match?.[2]?.trim().toLowerCase();
  const users = [...eachUser(database)];
  if (address !== undefined) {
    const byAddress = users.find((user) => user.email?.toLowerCase() === address);
    if (byAddress !== undefined) return byAddress;
  }
  const byUsername = users.find((user) => user.username === name);
  if (byUsername !== undefined) return byUsername;
  const byName = users.filter((user) => user.displayName.trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0] : undefined;
}

/** Record commits Team has read, once each. */
export function recordCommits(
  database: DatabaseSync,
  projectId: string,
  revisions: readonly { readonly id: string; readonly at?: number; readonly by?: string; readonly message?: string }[],
): number {
  let added = 0;
  for (const revision of revisions) {
    const account = accountForAuthor(database, revision.by);
    const result = database
      .prepare(
        `INSERT OR IGNORE INTO activity (account_id, actor_label, project_id, kind, ref, summary, private, at)
         VALUES (?, ?, ?, 'commit', ?, ?, 0, ?)`,
      )
      .run(account?.id ?? null, revision.by ?? null, projectId, revision.id, clip(revision.message), revision.at ?? Date.now());
    added += Number(result.changes);
  }
  return added;
}

/** Whether Team has recorded any commit for a project yet. */
export function knowsCommitsOf(database: DatabaseSync, projectId: string): boolean {
  return database.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'commit' LIMIT 1").get(projectId) !== undefined;
}

/** Whether one revision is already recorded. */
export function knowsCommit(database: DatabaseSync, projectId: string, revision: string): boolean {
  return (
    database.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'commit' AND ref = ?").get(projectId, revision) !==
    undefined
  );
}

/** The visibility clause and its parameters, for one caller. */
function visibleTo(database: DatabaseSync, viewer: UserRecord): { clause: string; params: string[] } {
  const projects = [...visibleProjectIds(database, viewer)];
  const placeholders = projects.map(() => "?").join(", ");
  return {
    clause:
      `((project_id IS NULL OR project_id IN (${placeholders || "NULL"})) ` +
      "AND (private = 0 OR account_id = ?))",
    params: [...projects, viewer.id],
  };
}

function toActivity(database: DatabaseSync, row: Row): TeamActivity {
  const accountId = optionalTextColumn(row, "account_id");
  const account = accountId === undefined ? undefined : findUserById(database, accountId);
  const project = optionalTextColumn(row, "project_id");
  const ref = optionalTextColumn(row, "ref");
  const summary = optionalTextColumn(row, "summary");
  return {
    id: integerColumn(row, "id"),
    kind: (optionalTextColumn(row, "kind") ?? "comment") as TeamActivityKind,
    ...(project === undefined ? {} : { project }),
    ...(ref === undefined ? {} : { ref }),
    ...(summary === undefined ? {} : { summary }),
    ...(account === undefined ? {} : { account: account.username }),
    actor: account?.displayName || account?.username || optionalTextColumn(row, "actor_label") || "?",
    at: integerColumn(row, "at"),
  };
}

/** A page of activity the viewer may see, for one account or one project or both, newest first. */
export function listActivity(
  database: DatabaseSync,
  viewer: UserRecord,
  query: { accountId?: string; projectId?: string; before?: number; limit: number },
): { activity: TeamActivity[]; cursor?: number } {
  const visible = visibleTo(database, viewer);
  const where = [visible.clause];
  const params: (string | number)[] = [...visible.params];
  if (query.accountId !== undefined) {
    where.push("account_id = ?");
    params.push(query.accountId);
  }
  if (query.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(query.projectId);
  }
  if (query.before !== undefined) {
    where.push("id < ?");
    params.push(query.before);
  }
  const rows = database
    .prepare(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...params, query.limit + 1) as Row[];
  const page = rows.slice(0, query.limit).map((row) => toActivity(database, row));
  const last = page.at(-1);
  return rows.length > query.limit && last !== undefined ? { activity: page, cursor: last.id } : { activity: page };
}

/**
 * How many things one account did each day, as the viewer may see them, in the
 * viewer's time zone (`tzOffsetMinutes`, as `Date#getTimezoneOffset` gives it:
 * minutes to add to local time to reach UTC).
 */
export function activityHeatmap(
  database: DatabaseSync,
  viewer: UserRecord,
  query: { accountId: string; tzOffsetMinutes: number; days: number; now?: number },
): TeamActivityDay[] {
  const visible = visibleTo(database, viewer);
  const since = (query.now ?? Date.now()) - query.days * 86_400_000;
  const shift = -query.tzOffsetMinutes * 60_000;
  const rows = database
    .prepare(
      `SELECT date((at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS count FROM activity
        WHERE ${visible.clause} AND account_id = ? AND at >= ?
        GROUP BY day ORDER BY day`,
    )
    .all(shift, ...visible.params, query.accountId, since) as Row[];
  return rows.map((row) => ({ day: String(row["day"]), count: integerColumn(row, "count") }));
}
