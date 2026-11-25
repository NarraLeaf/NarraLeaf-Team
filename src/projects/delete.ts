/**
 * Deleting a project for good, repository and all.
 *
 * Taking a project off the list (`projects.forget`) leaves its repository in
 * loreserver's store, every revision in it and its name with it, so that it can
 * be recorded again. This is the other thing: loreserver deletes the
 * repository, its branches and its history, and the name is free for a new
 * project. Nothing brings it back but a backup.
 *
 * Two things can be deleted:
 *
 *  - **A project on the list.** loreserver is asked to delete its repository,
 *    with a token minted for the person deleting it, and asks this server
 *    whether they may exactly as it does for any repository call. Once the
 *    repository has gone, loreserver says so over `RebacApi/DeleteResource`
 *    (./service.ts), which takes the row away and tells everybody holding the
 *    list. A repository that is already gone takes only the row.
 *
 *  - **A leftover**: the repository of a project taken off the list earlier.
 *    This server has no row for it, so loreserver would be told it is nobody's
 *    and refuse; the row is written back for the length of the call, the
 *    repository is looked up by id to check that it carries the name the caller
 *    gave, and only then deleted. A repository by another name, or none, takes
 *    the row away again and deletes nothing. The id is what loreserver named
 *    when a create met the name (see `heldBy`), so the name is the check that
 *    it was read right.
 *
 * Who may do which is the caller's to decide; src/team/methods/projects.ts does.
 */
import { rm } from "node:fs/promises";

import { GrpcCallError } from "../grpc/client.js";
import { GRPC_NOT_FOUND } from "../grpc/status.js";
import { mintToken } from "../identity/tokens.js";
import type { UserRecord } from "../identity/users.js";
import { mintingConfig, type TeamService } from "../team/service.js";
import { authorityWorkingCopyPath, projectCheckoutPath, readyMarkerPath } from "./cache.js";
import {
  createProject,
  findProject,
  findProjectById,
  forgetProject,
  isRepositoryId,
  type ProjectRecord,
} from "./registry.js";
import { loreserverUrl, repositoryDelete, repositoryGet } from "./repository.js";

/** What the caller named: a project by name, or a repository by id and the name it should carry. */
export interface DeletionRequest {
  readonly name: string;
  readonly repositoryId?: string;
}

/** What a request turned out to name. */
export type DeletionTarget =
  | { readonly kind: "project"; readonly project: ProjectRecord }
  | { readonly kind: "leftover"; readonly repositoryId: string; readonly name: string };

/** Why nothing was deleted, before loreserver was asked anything. */
export type DeletionMiss =
  | { readonly kind: "invalid-repository-id" }
  /** No project by that name, and no repository id to look further with. */
  | { readonly kind: "not-found" }
  /** The project with that repository id is called something else. */
  | { readonly kind: "name-mismatch"; readonly actual: string }
  /** A project on the list carries the name, under another repository. */
  | { readonly kind: "name-taken"; readonly project: ProjectRecord };

/**
 * Which project or leftover a request names, read from this server's rows alone.
 *
 * The name has to match exactly, and is required even beside an id: it is what
 * the person typed to confirm, so a request that names one thing and confirms
 * another deletes neither.
 */
export function deletionTarget(
  database: TeamService["database"],
  request: DeletionRequest,
): DeletionTarget | DeletionMiss {
  if (request.repositoryId === undefined) {
    const project = findProject(database, request.name);
    return project !== undefined && project.name === request.name ? { kind: "project", project } : { kind: "not-found" };
  }
  const id = request.repositoryId.toLowerCase();
  if (!isRepositoryId(id)) {
    return { kind: "invalid-repository-id" };
  }
  const listed = findProjectById(database, id);
  if (listed !== undefined) {
    return listed.name === request.name ? { kind: "project", project: listed } : { kind: "name-mismatch", actual: listed.name };
  }
  const named = findProject(database, request.name);
  if (named !== undefined && named.name === request.name) {
    return { kind: "name-taken", project: named };
  }
  return { kind: "leftover", repositoryId: id, name: request.name };
}

/** How a deletion ended, once loreserver was involved. */
export type Deletion =
  | {
      readonly kind: "deleted";
      readonly repositoryId: string;
      readonly name: string;
      /**
       * Whether the row was still here once loreserver answered, and so was
       * taken away by this call rather than by loreserver's `DeleteResource`.
       * Only then is it the caller's to announce: the other path announced it.
       */
      readonly forgotHere: boolean;
      /** There was no repository left to delete; only the row went. */
      readonly alreadyGone: boolean;
    }
  /** A leftover id that names no repository. Nothing was deleted. */
  | { readonly kind: "no-repository" }
  /** A leftover id whose repository carries another name. Nothing was deleted. */
  | { readonly kind: "name-mismatch"; readonly actual: string }
  /** loreserver would not; the message is its own. Nothing was deleted. */
  | { readonly kind: "repository-refused"; readonly message: string };

/** What deleting needs: what making a project needs, and the root the caches are under. */
export type DeletionSource = Pick<
  TeamService,
  "database" | "keys" | "config" | "namedLifetimes" | "dataPort" | "root" | "authorities"
>;

function notFound(error: unknown): boolean {
  return error instanceof GrpcCallError && error.status === GRPC_NOT_FOUND;
}

function described(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Team's own copies of the project, which nothing reads once it has gone.
 *
 * Both checkouts are clones this server made and would make again; with the
 * repository deleted there is nothing to make them from, and a project made
 * later has another id, so they would only take up space. Best effort: a copy
 * that will not go is space, not a fault.
 */
async function dropCopies(source: DeletionSource, repositoryId: string): Promise<void> {
  source.authorities?.forget(repositoryId);
  await Promise.all(
    [projectCheckoutPath(source.root, repositoryId), readyMarkerPath(source.root, repositoryId), authorityWorkingCopyPath(source.root, repositoryId)].map((path) =>
      rm(path, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

/** Delete what {@link deletionTarget} found, for `user`. */
export async function deleteForever(source: DeletionSource, user: UserRecord, target: DeletionTarget): Promise<Deletion> {
  const url = loreserverUrl(source.dataPort);
  // The repository lifetime: handed to loreserver for these calls and dropped.
  const token = mintToken(user, source.keys.signingKey, mintingConfig(source), { purpose: "repository" }).token;
  const repositoryId = target.kind === "project" ? target.project.id : target.repositoryId;
  const name = target.kind === "project" ? target.project.name : target.name;

  if (target.kind === "leftover") {
    // Written back so that loreserver's question about it has an answer; taken
    // away again on every path that deletes nothing.
    createProject(source.database, { id: repositoryId, name, description: "", createdBy: user.id });
    let found;
    try {
      found = await repositoryGet({ url, token, query: { kind: "id", id: repositoryId } });
    } catch (error) {
      forgetProject(source.database, repositoryId);
      return notFound(error) ? { kind: "no-repository" } : { kind: "repository-refused", message: described(error) };
    }
    if (found.name !== name) {
      forgetProject(source.database, repositoryId);
      return { kind: "name-mismatch", actual: found.name };
    }
  }

  let alreadyGone = false;
  try {
    await repositoryDelete({ url, token, id: repositoryId });
  } catch (error) {
    if (!notFound(error)) {
      if (target.kind === "leftover") forgetProject(source.database, repositoryId);
      return { kind: "repository-refused", message: described(error) };
    }
    // A row with no repository behind it: what is left to delete is the row.
    alreadyGone = true;
  }

  const forgotHere = forgetProject(source.database, repositoryId);
  await dropCopies(source, repositoryId);
  return { kind: "deleted", repositoryId, name, forgotHere, alreadyGone };
}
