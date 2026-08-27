/**
 * The `project` commands: make a repository, and see what this server holds.
 *
 * `project create` is the one that talks to loreserver; `project list` reads
 * rows in Team's database. There is nothing here about who may reach what,
 * because every account of this server reaches every project on it — see
 * ./projects/registry.ts.
 *
 * Both verbs have two paths and one output. Given `--root` they open the
 * database beside the server, which is what somebody logged into that machine
 * has and what still works when nothing is answering. Given `--server` they
 * call a method on a session, which is what everybody else has. **The methods
 * already exist**: these commands were wired to them rather than given routes
 * of their own, because a command line that grew a verb the protocol does not
 * have would be one Studio's management surface could never catch up with.
 */
import type { DatabaseSync } from "node:sqlite";

import { TEAM_METHODS } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readCreatedProject, readProjectList } from "./client/answers.js";
import { withSession } from "./client/server.js";
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

export interface ProjectCreateOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
  readonly name: string;
  readonly description: string | undefined;
}

export interface ProjectListOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
}

/** One row of the list, whichever path it was read by. */
interface ProjectRow {
  readonly name: string;
  readonly id: string;
  /** Who made it, or undefined for an account the server no longer has. */
  readonly madeBy: string | undefined;
}

/**
 * The list, or the sentence that stands in for an empty one.
 *
 * Written once and called from both paths, so that a person who administers one
 * server over ssh and another over the protocol is reading the same thing. An
 * account that no longer exists leaves the column blank rather than showing an
 * id: over the protocol there is no id to show, and a list that said different
 * things on the two paths would be worse than one that says less on both.
 */
function renderProjects(rows: readonly ProjectRow[], stdout: WriteText): void {
  if (rows.length === 0) {
    stdout("no projects yet. Make one with project create <name>.\n");
    return;
  }
  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const line = `${row.name.padEnd(width)}  ${row.id}  ${row.madeBy ?? ""}`;
    stdout(`${line.trimEnd()}\n`);
  }
}

/** A project that has just been made, whichever path made it. */
interface MadeProject {
  readonly name: string;
  readonly id: string;
  /** The account it belongs to, or undefined where the answer named none. */
  readonly owner: string | undefined;
  /**
   * The branch the repository was created with, where the path that made it knew.
   *
   * Only the local path does. It asks loreserver for the repository itself and
   * is told what loreserver named the first branch; `projects.create` answers
   * with the project, which is a record on this server and carries nothing about
   * the repository's branches. The line is therefore left out rather than filled
   * in with the name that is usually right — a default this program does not read
   * is a claim, and the one thing this command must not do is describe a
   * repository it did not look at.
   */
  readonly defaultBranch: string | undefined;
}

/**
 * What a project having been made looks like, written once for both paths.
 *
 * Same reasoning as {@link renderProjects}: an operator who makes one project
 * over ssh and the next over the protocol is reading one thing.
 */
function renderMadeProject(project: MadeProject, stdout: WriteText): void {
  stdout(`created ${project.name}\n`);
  stdout(`repository ${project.id}\n`);
  stdout(`${`owner ${project.owner ?? ""}`.trimEnd()}\n`);
  if (project.defaultBranch !== undefined) {
    stdout(`default branch ${project.defaultBranch}\n`);
  }
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

    renderMadeProject(
      {
        name: repository.name,
        id: repository.id,
        owner: owner.username,
        defaultBranch: repository.defaultBranchName,
      },
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Make a project on a server this account is signed in to.
 *
 * `projects.create` and not a method of the `admin` family, and that is not an
 * oversight: making a project is what every account of this server may do, and
 * it is the same call a Studio installation makes when somebody presses the
 * button. There is nothing here for an operator to be gated on.
 *
 * Which account it belongs to is settled by the session rather than named on
 * the line. Over the protocol the caller is the maker — there is no `--as` on
 * this path and the command line refuses one — because the alternative would be
 * a method that let anybody attribute work to somebody else. The local path has
 * `--as` for the opposite reason: whoever runs it holds the storage root and is
 * acting on behalf of a team rather than as one of them.
 */
export async function projectCreateOverProtocol(
  options: ProjectCreateOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const answer = await withSession(options.server, async (session) => {
      return await session.call(TEAM_METHODS.projectsCreate, {
        name: options.name,
        ...(options.description === undefined ? {} : { description: options.description }),
        // No `repositoryId`: that field is for an author publishing a repository
        // they already have on their own machine, which is Studio's path and not
        // a thing a command line has in front of it.
      });
    });
    const project = readCreatedProject(answer);
    renderMadeProject(
      {
        name: project.name,
        id: project.id,
        owner: project.createdBy,
        // Not carried by this answer; see the note on MadeProject.
        defaultBranch: undefined,
      },
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Every project, read out of the database beside the server. */
export async function projectList(
  options: ProjectListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    const names = new Map(listUsers(database).map((user) => [user.id, user.username]));
    renderProjects(
      listProjects(database).map((project) => ({
        name: project.name,
        id: project.id,
        // The username where there is one, and the id where the account has
        // gone: this side has an id to fall back on, and printing it is better
        // than printing nothing to somebody who can look it up.
        madeBy: names.get(project.createdBy) ?? project.createdBy,
      })),
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Every project, asked for over a session.
 *
 * The same question the other path asks a database, asked of the server that
 * owns it. Nothing here knows how a session is opened, what a token is or which
 * certificate authority it was verified against — that is all one call into
 * src/client/server.ts, which is the seam every administrative command is now
 * wired through. What comes back is checked rather than cast, in
 * src/client/answers.ts, for the reason set out at the top of that file.
 */
export async function projectListOverProtocol(
  options: ProjectListOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const answer = await withSession(options.server, async (session) => {
      return await session.call(TEAM_METHODS.projectsList);
    });
    const projects = readProjectList(answer);
    renderProjects(
      projects.map((project) => ({
        name: project.name,
        id: project.id,
        // Absent means the account that made it is gone. There is no id on this
        // side to fall back on, and inventing one would be a claim.
        madeBy: project.createdBy,
      })),
      stdout,
    );
    return 0;
  } catch (error) {
    // Every refusal that can arrive here — a token no longer good, a method this
    // build does not answer, a certificate that no longer chains — carries the
    // sentence somebody has to read. None of them is a stack trace.
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
