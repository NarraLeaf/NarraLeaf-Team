/**
 * Who belongs to a project, and what that lets them do.
 *
 * Four roles, ordered: owner, editor, reviewer, viewer. Two questions are asked
 * of them, and they are different questions:
 *
 *   - **May this account open the repository?** Owners and editors. This is
 *     the answer loreserver is given. loreserver 0.8.6 was measured
 *     (docs/refactor-plan.zh.md, §10) to ignore whether a token says read or
 *     write: anybody it lets open a repository can push to it. So a role that
 *     may not write is a role that may not open the repository, and reviewers
 *     and viewers read a project through Team instead — the web console reads
 *     Team's own checkout, which needs nobody's repository access but Team's.
 *   - **May this account see the project at all?** Any role. This is what the
 *     protocol asks before it lists a project, hands over its threads, or lets
 *     somebody comment on it.
 *
 * An operator — an account in the admin group — is the owner of every project,
 * with or without a row, so that nobody can lock the administrators out of
 * what they administer.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, textColumn, type Row } from "../identity/database.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import { TEAM_PROJECT_ROLES, type TeamProjectRole } from "../team/protocol.js";

/** The roles, most able first: the protocol's own list, so the two cannot drift. */
export const PROJECT_ROLES = TEAM_PROJECT_ROLES;
export type ProjectRole = TeamProjectRole;

/** The roles that open the repository. */
const REPOSITORY_ROLES: ReadonlySet<ProjectRole> = new Set(["owner", "editor"]);

/** The role a member is given when none is named. */
export const DEFAULT_PROJECT_ROLE: ProjectRole = "editor";

/** Raised for a role that is not one of {@link PROJECT_ROLES}. */
export class UnknownRoleError extends Error {
  constructor(readonly role: string) {
    super(`"${role}" is not a project role; it is one of ${PROJECT_ROLES.join(", ")}`);
    this.name = "UnknownRoleError";
  }
}

/** Whether a string is a project role. */
export function isProjectRole(value: string): value is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(value);
}

/** Whether a role opens the repository. */
export function reachesRepository(role: ProjectRole | undefined): boolean {
  return role !== undefined && REPOSITORY_ROLES.has(role);
}

/** One member of one project. */
export interface ProjectMember {
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly addedBy: string | undefined;
  /** Milliseconds since the epoch. */
  readonly addedAt: number;
}

function toMember(row: Row): ProjectMember {
  const role = textColumn(row, "role");
  const addedBy = row.added_by;
  return {
    projectId: textColumn(row, "project_id"),
    userId: textColumn(row, "user_id"),
    // A role this build does not know reads as the least able one rather than
    // as an error: a row written by a newer Team must not hand anybody more.
    role: isProjectRole(role) ? role : "viewer",
    addedBy: typeof addedBy === "string" ? addedBy : undefined,
    addedAt: integerColumn(row, "added_at"),
  };
}

/** The role an account has in a project, or undefined if it has none. */
export function projectRole(
  database: DatabaseSync,
  projectId: string,
  user: UserRecord,
): ProjectRole | undefined {
  if (isOperator(user.groups)) {
    return "owner";
  }
  const row = database
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, user.id);
  if (row === undefined) {
    return undefined;
  }
  const role = textColumn(row as Row, "role");
  return isProjectRole(role) ? role : "viewer";
}

/** Whether an account may open a project's repository. */
export function mayOpenRepository(
  database: DatabaseSync,
  projectId: string,
  user: UserRecord,
): boolean {
  return reachesRepository(projectRole(database, projectId, user));
}

/** Whether an account may see a project at all. */
export function maySeeProject(database: DatabaseSync, projectId: string, user: UserRecord): boolean {
  return projectRole(database, projectId, user) !== undefined;
}

/**
 * The ids of the projects an account has any role in, or every project for an
 * operator. A set, for filtering a list the caller already has.
 */
export function visibleProjectIds(database: DatabaseSync, user: UserRecord): Set<string> {
  const rows = isOperator(user.groups)
    ? database.prepare("SELECT id AS project_id FROM projects").all()
    : database.prepare("SELECT project_id FROM project_members WHERE user_id = ?").all(user.id);
  return new Set(rows.map((row) => textColumn(row as Row, "project_id")));
}

/** The ids of the projects whose repository an account may open. */
export function repositoryProjectIds(database: DatabaseSync, user: UserRecord): Set<string> {
  const rows = isOperator(user.groups)
    ? database.prepare("SELECT id AS project_id FROM projects").all()
    : database
        .prepare(
          "SELECT project_id FROM project_members WHERE user_id = ? AND role IN ('owner', 'editor')",
        )
        .all(user.id);
  return new Set(rows.map((row) => textColumn(row as Row, "project_id")));
}

/**
 * Every account an event about a project may be told to: its members, and the
 * operators, who own every project with or without a row. By user id, which is
 * what a session is keyed by.
 *
 * Read before a project goes rather than after, by a caller that needs it then:
 * the rows go with the project.
 */
export function projectAudience(database: DatabaseSync, projectId: string): Set<string> {
  const rows = database
    .prepare(
      `SELECT user_id FROM project_members WHERE project_id = ?
       UNION
       SELECT user_id FROM user_groups WHERE group_name = 'admin'`,
    )
    .all(projectId);
  return new Set(rows.map((row) => textColumn(row as Row, "user_id")));
}

/** How many accounts hold the owner role in a project by a row of their own. */
export function ownerCount(database: DatabaseSync, projectId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'owner'")
    .get(projectId);
  return integerColumn(row as Row, "count");
}

/** One account's own row in a project, if it has one. Operators without a row have none. */
export function findProjectMember(
  database: DatabaseSync,
  projectId: string,
  userId: string,
): ProjectMember | undefined {
  const row = database
    .prepare(
      `SELECT project_id, user_id, role, added_by, added_at FROM project_members
        WHERE project_id = ? AND user_id = ?`,
    )
    .get(projectId, userId);
  return row === undefined ? undefined : toMember(row as Row);
}

/** A project's members, owners first, then by when they were added. */
export function listProjectMembers(database: DatabaseSync, projectId: string): ProjectMember[] {
  return database
    .prepare(
      `SELECT project_id, user_id, role, added_by, added_at FROM project_members
        WHERE project_id = ?
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1
                           WHEN 'reviewer' THEN 2 ELSE 3 END, added_at, user_id`,
    )
    .all(projectId)
    .map((row) => toMember(row as Row));
}

/**
 * Give an account a role in a project, adding it if it is not a member and
 * changing its role if it is.
 */
export function setProjectMember(
  database: DatabaseSync,
  input: { projectId: string; userId: string; role: string; addedBy?: string },
): ProjectMember {
  if (!isProjectRole(input.role)) {
    throw new UnknownRoleError(input.role);
  }
  database
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`,
    )
    .run(input.projectId, input.userId, input.role, input.addedBy ?? null, Date.now());
  const member = findProjectMember(database, input.projectId, input.userId);
  if (member === undefined) {
    throw new Error(`the member row for ${input.userId} in ${input.projectId} was not written`);
  }
  return member;
}

/** Take an account out of a project. Answers whether it was a member. */
export function removeProjectMember(database: DatabaseSync, projectId: string, userId: string): boolean {
  const result = database
    .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .run(projectId, userId);
  return Number(result.changes) > 0;
}

/**
 * Make a new project's creator its owner, and every other account an editor.
 *
 * The second half keeps a new project as reachable as one made before roles
 * existed; an owner narrows it afterwards. A setting that makes new projects
 * start with their creator alone is planned beside the console.
 */
export function seedProjectMembers(database: DatabaseSync, projectId: string, createdBy: string): void {
  const now = Date.now();
  database
    .prepare(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by, added_at)
       SELECT ?, id, CASE WHEN id = ? THEN 'owner' ELSE 'editor' END, ?, ? FROM users`,
    )
    .run(projectId, createdBy, createdBy, now);
}
