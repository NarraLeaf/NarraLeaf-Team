/**
 * How a project comes to exist on this server.
 *
 * One implementation, separate from whatever reports it, because the ordering in
 * it is what makes publishing work and a second copy of it would be a second set
 * of orderings to keep right.
 */
import { mintToken } from "../identity/tokens.js";
import type { UserRecord } from "../identity/users.js";
import { TEAM_METHODS } from "../team/protocol.js";
import { mintingConfig, type TeamService } from "../team/service.js";
import {
  createProject,
  findProjectById,
  findProjectByClientId,
  forgetProject,
  InvalidProjectNameError,
  isRepositoryId,
  newProjectId,
  type ProjectRecord,
} from "./registry.js";
import { loreserverUrl, repositoryCreate } from "./repository.js";

/**
 * The outcome of trying to make a project, apart from how the answer is carried.
 *
 * Every way a create can end, said once and separately from how it is reported,
 * so that how a project comes to exist is one piece of code rather than one per
 * caller. What a caller does with each outcome — which error code it raises,
 * what it announces and on which topic — is the caller's.
 */
export type ProjectCreation =
  | { readonly kind: "made"; readonly project: ProjectRecord; readonly adopted: boolean }
  /** A create that already happened, so this is the project it made, not a new one. */
  | { readonly kind: "repeat"; readonly project: ProjectRecord }
  | { readonly kind: "invalid-repository-id" }
  | { readonly kind: "repository-taken"; readonly repositoryId: string }
  /** The name is not one a project may carry. */
  | { readonly kind: "invalid-name"; readonly message: string }
  /** The name is already in use on this server. */
  | { readonly kind: "name-taken"; readonly message: string }
  /** loreserver would not make the repository; the row was rolled back. */
  | { readonly kind: "repository-refused"; readonly message: string };

/** What a create is asked for. */
export interface ProjectCreationRequest {
  readonly name: string;
  readonly description?: string;
  /** A repository the author already has, to adopt rather than create anew. */
  readonly repositoryId?: string;
  /** What the client called this write, so a repeat of it is not a second project. */
  readonly clientId?: string;
}

/**
 * The create key a repeatable create is scoped by.
 *
 * By method as well as the client's id, per the `(account, method, clientId)`
 * rule, so that one client id a caller reused across two different writes cannot
 * be handed the wrong row.
 */
function projectCreateKey(clientId: string): string {
  return `${TEAM_METHODS.projectsCreate}:${clientId}`;
}

/**
 * Make a project from nothing, or adopt one that already exists.
 *
 * The ordering here is what makes publishing work at all: the row is written
 * before loreserver is asked and removed again if it refuses, so that loreserver
 * announcing the new repository back to Team — while the create call is still
 * open — finds the row already there. A create carrying a repository id asks
 * loreserver for nothing: the repository exists on the author's disk under that
 * id, and what is missing is only the row.
 */
export async function makeOrAdoptProject(
  options: TeamService,
  user: UserRecord,
  request: ProjectCreationRequest,
): Promise<ProjectCreation> {
  // Folded, because hex is hex either way and everything downstream compares
  // this character by character: it becomes the primary key, and the second
  // half of the resource id loreserver asks permission questions about.
  const claimed = request.repositoryId?.toLowerCase();
  if (claimed !== undefined && !isRepositoryId(claimed)) {
    return { kind: "invalid-repository-id" };
  }

  // A create that already happened returns the row it made, before anything else
  // is decided: a client that never saw the answer is retrying, not colliding,
  // and a name or repository "already taken" by its own first attempt would be
  // the wrong thing to tell it.
  if (request.clientId !== undefined) {
    const already = findProjectByClientId(
      options.database,
      user.id,
      projectCreateKey(request.clientId),
    );
    if (already !== undefined) {
      return { kind: "repeat", project: already };
    }
  }

  // A repository id already registered is a collision rather than a silent
  // adoption: the author is publishing what they believe is a new project, and
  // the server already holding it means somebody has, which they have to know
  // before they push into it.
  if (claimed !== undefined && findProjectById(options.database, claimed) !== undefined) {
    return { kind: "repository-taken", repositoryId: claimed };
  }

  // The row is written before loreserver is asked, and removed again if it
  // refuses. See the note above on why that order matters.
  let project: ProjectRecord;
  try {
    project = createProject(options.database, {
      id: claimed ?? newProjectId(),
      name: request.name,
      description: request.description ?? "",
      createdBy: user.id,
      ...(request.clientId === undefined
        ? {}
        : { clientId: projectCreateKey(request.clientId) }),
    });
  } catch (error) {
    if (error instanceof InvalidProjectNameError) {
      return { kind: "invalid-name", message: error.message };
    }
    return {
      kind: "name-taken",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (claimed !== undefined) {
    // Adopted. This repository may have years of history, none of it read yet,
    // and loreserver is the wrong place to ask for one that already exists.
    return { kind: "made", project, adopted: true };
  }

  const config = mintingConfig(options);
  const minted = mintToken(user, options.keys.signingKey, config, { purpose: "repository" });
  try {
    await repositoryCreate({
      url: loreserverUrl(options.dataPort),
      token: minted.token,
      id: project.id,
      name: project.name,
      description: project.description,
    });
  } catch (error) {
    forgetProject(options.database, project.id);
    return {
      kind: "repository-refused",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { kind: "made", project, adopted: false };
}
