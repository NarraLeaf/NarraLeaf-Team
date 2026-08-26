/**
 * The `project` commands: make a repository, and see what this server holds.
 *
 * `project create` is the one that talks to loreserver; `project list` reads
 * rows in Team's database. There is nothing here about who may reach what,
 * because every account of this server reaches every project on it — see
 * ./projects/registry.ts.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteText } from "./cli.js";
import { identityConfig, type IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { storedIdentity, storedTokenLifetimes } from "./identity/settings.js";
import { mintToken } from "./identity/tokens.js";
import { countUsers, listUsers, requireUser, type UserRecord } from "./identity/users.js";
import { loreserverUrl, repositoryCreate } from "./projects/repository.js";
import {
  createProject,
  forgetProject,
  listProjects,
  newProjectId,
} from "./projects/registry.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectCreateOptions {
  readonly root: string;
  readonly name: string;
  readonly description: string | undefined;
  /** The account the project is created for and belongs to. */
  readonly as: string | undefined;
  /** The port loreserver serves gRPC on. */
  readonly dataPort: number;
  readonly overrides: Partial<IdentityConfig>;
}

export interface ProjectListOptions {
  readonly root: string;
}

/**
 * The account a command is acting for.
 *
 * A Team server with one account has no ambiguity to resolve, and naming yourself on
 * every command would be ceremony. With two, there is no such thing as the
 * obvious one, so the command says so rather than choosing.
 */
function resolveOperator(database: DatabaseSync, username: string | undefined): UserRecord {
  if (username !== undefined) {
    return requireUser(database, username);
  }
  const accounts = countUsers(database);
  if (accounts === 0) {
    throw new Error(
      "this server has no accounts yet. Make the first one with: nlteam init <username>",
    );
  }
  const only = listUsers(database)[0];
  if (accounts > 1 || only === undefined) {
    throw new Error(
      "there is more than one account here, so name the one this is for with --as <username>",
    );
  }
  return only;
}

/**
 * Create a repository on loreserver and record the project it belongs to.
 *
 * The row is written first and removed again if loreserver refuses. That order
 * matters: loreserver announces the new repository back to Team while the create
 * call is still open, and a Team server that had not recorded the project yet would
 * have nothing to say about it.
 */
export async function projectCreate(
  options: ProjectCreateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    // Defaults, then what this server was brought up as and has stored, then
    // what the command line or the environment named. The stored identity is
    // where the data port and the host names come from, so the token this hands
    // to loreserver names the same audience the running server mints — while a
    // flag still overrides it for the run.
    const config = identityConfig({
      ...storedIdentity(database),
      ...storedTokenLifetimes(database),
      ...options.overrides,
    });
    const owner = resolveOperator(database, options.as);
    const keys = await KeyStore.open(layout.keysDir);
    // Minted without a password, unlike `token mint`. Whoever runs this already
    // has the storage root and could sign anything they liked with the key in
    // it; a prompt here would be a formality, not a check.
    //
    // The repository lifetime and not the sign-in one: this token is handed
    // straight to loreserver for a single create call and then dropped, and a
    // token that outlives its one use by a month is one to be found later.
    const minted = mintToken(owner, keys.signingKey, config, { purpose: "repository" });

    const id = newProjectId();
    const project = createProject(database, {
      id,
      name: options.name,
      ...(options.description === undefined ? {} : { description: options.description }),
      createdBy: owner.id,
    });

    let repository;
    try {
      repository = await repositoryCreate({
        url: loreserverUrl(options.dataPort),
        token: minted.token,
        id: project.id,
        name: project.name,
        description: project.description,
      });
    } catch (error) {
      forgetProject(database, project.id);
      throw error;
    }

    stdout(`created ${repository.name}\n`);
    stdout(`repository ${repository.id}\n`);
    stdout(`owner ${owner.username}\n`);
    stdout(`default branch ${repository.defaultBranchName}\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Every project, or every project one person can reach. */
export async function projectList(
  options: ProjectListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    const projects = listProjects(database);
    if (projects.length === 0) {
      stdout("no projects yet. Make one with project create <name>.\n");
      return 0;
    }
    const names = new Map(listUsers(database).map((user) => [user.id, user.username]));
    const width = Math.max(...projects.map((project) => project.name.length));
    for (const project of projects) {
      const madeBy = names.get(project.createdBy) ?? project.createdBy;
      stdout(`${project.name.padEnd(width)}  ${project.id}  ${madeBy}
`);
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
