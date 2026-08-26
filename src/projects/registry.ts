/**
 * The projects Team knows about.
 *
 * A project is one loreserver repository. Team keeps the row that says who made
 * it; loreserver keeps the contents and asks Team, on every access, whether the
 * caller is an account of this server, which every project of it answers yes to.
 *
 * The two systems agree on an identifier and nothing else. loreserver's
 * repository id is sixteen bytes; it appears in a permission question as a
 * resource id, which is those bytes as lower-case hex with `urc-` in front. So
 * that is what is stored — the hex — and {@link resourceIdOf} is the only place
 * the prefix is written. A second identifier of Team's own would have to be
 * mapped back to this one at exactly the moment a wrong answer costs somebody
 * their access.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  integerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "../identity/database.js";

/**
 * What every account may do with every project on this server.
 *
 * There is one answer because there is one rule: an account of this server
 * reaches every project on it. The claim is filled in because loreserver's
 * data plane reads it, and because the audit line is more use with it than
 * without; the repository authorizer never looks at the verbs.
 */
export const PROJECT_PERMISSIONS: readonly string[] = ["read", "write"];

/** One project. */
export interface ProjectRecord {
  /** The repository id, sixteen bytes as thirty-two lower-case hex characters. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The account that created it, by user id. */
  readonly createdBy: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
}

/** What a resource id has in front of the repository id. */
export const RESOURCE_PREFIX = "urc-";

/** A repository id is sixteen bytes, written as hex. */
const REPOSITORY_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Whether a string could be a repository id.
 *
 * Exported because a client may now bring one of its own — a project that
 * already exists on somebody's disk is published under the id its repository
 * already has, rather than under one this server invents. Nothing downstream
 * re-checks the shape: the id becomes a primary key and half of a resource id,
 * and both of those compare character by character.
 *
 * Lower case only, exactly as {@link newProjectId} writes one. A caller holding
 * the other spelling folds it before asking, the way {@link
 * projectIdFromResourceId} does.
 */
export function isRepositoryId(value: string): boolean {
  return REPOSITORY_ID_PATTERN.test(value);
}

/**
 * A project name, as loreserver will accept it.
 *
 * loreserver has validation rules of its own and refuses a name that breaks
 * them, so this is not the only check; it is the one that happens before a
 * repository is created and a row is written.
 */
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Raised when a name cannot be a project name. */
export class InvalidProjectNameError extends Error {
  /**
   * The name that was refused.
   *
   * Kept beside the message rather than only inside it, as every error here
   * keeps its subject, so that something showing this to a person can write its
   * own sentence about it rather than repeat this one. It cannot be called
   * `name`: that is what an Error calls its class.
   */
  readonly projectName: string;

  constructor(projectName: string) {
    super(
      `"${projectName}" cannot be a project name. A project name is 1 to 64 characters of ` +
        "letters, digits, dot, dash and underscore, and starts with a letter or a digit.",
    );
    this.name = "InvalidProjectNameError";
    this.projectName = projectName;
  }
}

/** Raised when a project name is already in use. */
export class ProjectNameTakenError extends Error {
  constructor(readonly projectName: string) {
    super(`there is already a project called ${projectName}.`);
    this.name = "ProjectNameTakenError";
  }
}

/** Raised when nothing goes by a name or id a command was given. */
export class UnknownProjectError extends Error {
  constructor(readonly reference: string) {
    super(`there is no project called ${reference}.`);
    this.name = "UnknownProjectError";
  }
}

/** The resource id loreserver asks about for one project. */
export function resourceIdOf(projectId: string): string {
  return `${RESOURCE_PREFIX}${projectId}`;
}

/**
 * The project a resource id names, or undefined.
 *
 * Undefined for anything that is not shaped like one of Team's: a resource id
 * loreserver invented for something other than a repository, or a repository id
 * in some other spelling. Neither is a project here, and both have to answer
 * "no" rather than "not found by accident".
 */
export function projectIdFromResourceId(resourceId: string): string | undefined {
  // Case is folded because hex is hex either way. What is not folded is the
  // string that goes back in the answer: that is echoed exactly as it arrived,
  // because loreserver compares it character by character with what it asked.
  if (!resourceId.toLowerCase().startsWith(RESOURCE_PREFIX)) {
    return undefined;
  }
  const id = resourceId.slice(RESOURCE_PREFIX.length).toLowerCase();
  return REPOSITORY_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Generate a repository id.
 *
 * A random UUID with its dashes removed: sixteen bytes, generated by the
 * caller, which is what loreserver's create call expects so that a retry of the
 * same call is the same repository rather than a second one.
 */
export function newProjectId(): string {
  return randomUUID().replaceAll("-", "");
}

function toProject(row: Row): ProjectRecord {
  return {
    id: textColumn(row, "id"),
    name: textColumn(row, "name"),
    description: textColumn(row, "description"),
    createdBy: textColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
  };
}

const SELECT_PROJECT = "SELECT id, name, description, created_by, created_at FROM projects";

/** What a new project is made from. */
export interface NewProject {
  /** The repository id, from {@link newProjectId}. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** The account that made it. */
  readonly createdBy: string;
  /**
   * The key a repeatable create is scoped by, stored verbatim, or absent.
   *
   * How a create sent twice over a dropped session becomes one project rather
   * than two: the caller looks this up first with {@link findProjectByClientId}
   * and, finding the row it already made, hands it back. Absent on every row
   * written any other way. The caller scopes it — by method, per the
   * `(account, method, clientId)` rule — so this column holds whatever it
   * composed rather than a raw client id.
   */
  readonly clientId?: string;
}

/**
 * Record a project.
 *
 * `created_by` is who made it, and that is the whole of what it is: it is
 * shown, and it is not consulted when somebody asks to open the repository.
 * Every account of this server reaches every project on it.
 */
export function createProject(database: DatabaseSync, input: NewProject): ProjectRecord {
  if (!PROJECT_NAME_PATTERN.test(input.name)) {
    throw new InvalidProjectNameError(input.name);
  }
  const now = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projects (id, name, description, created_by, created_at, client_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.description ?? "", input.createdBy, now, input.clientId ?? null);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    // SQLite reports the collision as a constraint failure naming the column.
    // Turning it into a sentence here keeps the caller from having to read
    // SQLite's wording to tell a taken name from a broken database.
    if (error instanceof Error && error.message.includes("projects.name")) {
      throw new ProjectNameTakenError(input.name);
    }
    throw error;
  }

  return requireProject(database, input.id);
}

/** Every project, in name order. */
export function listProjects(database: DatabaseSync): ProjectRecord[] {
  return database
    .prepare(`${SELECT_PROJECT} ORDER BY name`)
    .all()
    .map((row) => toProject(row));
}

/**
 * The project with this id or this name, or undefined.
 *
 * One lookup takes either, because both are things an operator has in front of
 * them: the name they chose, and the id every log line and error message shows.
 */
export function findProject(
  database: DatabaseSync,
  reference: string,
): ProjectRecord | undefined {
  const row = database
    .prepare(`${SELECT_PROJECT} WHERE id = ? OR name = ?`)
    .get(reference.toLowerCase(), reference);
  return row === undefined ? undefined : toProject(row);
}

/**
 * The project registered under one repository id, or undefined.
 *
 * Deliberately not {@link findProject}: that one takes a name as well, and a
 * name can be a repository id — a repository this server adopts under a name
 * already taken is named after its own id (see ./service.ts). So the question
 * "is this repository already registered" has to be asked of the id column
 * alone, or a second project's name answers it.
 */
export function findProjectById(
  database: DatabaseSync,
  projectId: string,
): ProjectRecord | undefined {
  const row = database.prepare(`${SELECT_PROJECT} WHERE id = ?`).get(projectId);
  return row === undefined ? undefined : toProject(row);
}

/**
 * The project one account made under a given create key, or undefined.
 *
 * How a repeated create is recognised: the caller composes the key it scoped
 * the write by — by account and method — and asks whether a project already
 * carries it. Scoped to the maker as well as the key, so that two accounts that
 * happened to choose the same client id are never handed each other's project.
 */
export function findProjectByClientId(
  database: DatabaseSync,
  createdBy: string,
  clientId: string,
): ProjectRecord | undefined {
  const row = database
    .prepare(`${SELECT_PROJECT} WHERE created_by = ? AND client_id = ?`)
    .get(createdBy, clientId);
  return row === undefined ? undefined : toProject(row);
}

/** The project with this id or name, or a failure naming it. */
export function requireProject(database: DatabaseSync, reference: string): ProjectRecord {
  const project = findProject(database, reference);
  if (project === undefined) {
    throw new UnknownProjectError(reference);
  }
  return project;
}

/**
 * Forget a project.
 *
 * Nothing is deleted from loreserver here. This is what happens when loreserver
 * says a repository is gone, not a way of making one go.
 */
export function forgetProject(database: DatabaseSync, projectId: string): boolean {
  const project = findProject(database, projectId);
  if (project === undefined) {
    return false;
  }
  database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return true;
}
