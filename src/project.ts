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
import { countUsers, listUsers, requireUser, type UserRecord } from "./identity/users.js";
import { makeOrAdoptProject } from "./projects/create.js";
import { listProjects } from "./projects/registry.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * loreserver's refusal, with a line about `--repository` where it earns one.
 *
 * A repository that is already in the store is the one refusal a create can get
 * that somebody can do something about, and it is the ordinary shape of taking
 * a project back: the row went, the repository stayed, and asking for a new one
 * under the same name meets the one that is there. loreserver says so and names
 * the id, in its own words, and has no reason to know that this server has an
 * option for exactly this.
 *
 * The id is left in loreserver's sentence to be read rather than pulled out of
 * it and rebuilt here. What is quoted is another program's message, and a
 * reader of it that took it apart would go wrong the day it is reworded — into
 * a sentence naming the wrong id, which is worse than one naming none.
 */
export function withTheWayOut(message: string): string {
  if (!message.includes("ALREADY_EXISTS")) {
    return message;
  }
  return (
    `${message}\n` +
    "That repository is in this server's store already. If it is one this server has " +
    "forgotten, record it again with --repository and the id named above."
  );
}

export interface ProjectCreateOptions {
  readonly root: string;
  readonly name: string;
  readonly description: string | undefined;
  /** The account the project is created for and belongs to. */
  readonly as: string | undefined;
  /**
   * A repository that already exists, to record rather than create.
   *
   * Absent is the ordinary case and means a repository is asked for. Present, it
   * is the id of one already in this server's store — most often one that was
   * taken off the list, since taking a project off leaves the repository and
   * every revision in it exactly where they were.
   */
  readonly repositoryId: string | undefined;
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
  /** A repository that already exists, carried as `projects.create`'s `repositoryId`. */
  readonly repositoryId: string | undefined;
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
   * Whether the repository was already there, rather than asked for.
   *
   * Said rather than left to be worked out from the missing branch line: a
   * repository with years of history in it and a repository created a moment ago
   * are different things to be holding, and the person who ran the command
   * should not have to infer which one they now have.
   */
  readonly adopted: boolean;
  /**
   * The branch the repository was created with, where the path that made it knew.
   *
   * Only the local path making a new repository does. It asks loreserver for the
   * repository itself and is told what loreserver named the first branch;
   * `projects.create` answers with the project, which is a record on this server
   * and carries nothing about the repository's branches, and an adoption asks
   * loreserver nothing at all. The line is therefore left out rather than filled
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
 *
 * An adoption gets a different first word and a sentence of its own, because
 * "created" would be false: nothing was created, an existing repository was
 * recorded. The sentence says what was not done as well as what was — loreserver
 * was not asked for anything — since the whole risk with this option is somebody
 * believing a fresh repository is waiting for them.
 */
function renderMadeProject(project: MadeProject, stdout: WriteText): void {
  stdout(`${project.adopted ? "adopted" : "created"} ${project.name}\n`);
  stdout(`repository ${project.id}\n`);
  stdout(`${`owner ${project.owner ?? ""}`.trimEnd()}\n`);
  if (project.defaultBranch !== undefined) {
    stdout(`default branch ${project.defaultBranch}\n`);
  }
  if (project.adopted) {
    stdout(
      "The repository already existed and was recorded as it stands, with every revision " +
        "in it; loreserver was asked for nothing.\n",
    );
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
 * Create a repository on loreserver and record the project it belongs to, or
 * record one that already exists.
 *
 * The ordering that makes this work — the row written before loreserver is asked
 * and removed again if it refuses — is not here. It is in
 * ./projects/create.ts, which is what `projects.create` calls too, because two
 * orderings of the same three steps would be two to keep right and only one of
 * them is exercised by a Studio installation. What is left here is a storage
 * root's half of the arrangements: which account this is for, the settings the
 * token is minted from, and a sentence for each way it can end.
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
    // Opened here rather than inside the create, because this is the half that
    // knows where a storage root keeps them. The token minted from them is
    // minted without a password, unlike `token mint`: whoever runs this already
    // has the storage root and could sign anything they liked with the key in
    // it, so a prompt would be a formality rather than a check.
    const keys = await KeyStore.open(layout.keysDir);

    const outcome = await makeOrAdoptProject(
      // Four fields and not a service, because this is a command line and not a
      // running server — see ProjectCreationSource on why the parameter is
      // narrowed to what the function reads rather than widened to what this
      // path would have to invent.
      { database, keys, config, dataPort: options.dataPort },
      owner,
      {
        name: options.name,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }),
      },
    );

    switch (outcome.kind) {
      case "invalid-repository-id":
        // Worded as `projects.create` words it, and a test drives both paths
        // with the same bad id and compares them: what a command prints must
        // not depend on which plane it took.
        throw new Error("a repository id is thirty-two hexadecimal characters");
      case "repository-taken":
        throw new Error(
          `the repository ${outcome.repositoryId} is already a project on this server`,
        );
      case "invalid-name":
      case "name-taken":
        // Worded by the registry, which is what refused, and carried through
        // unedited for the same reason a server's refusal is.
        throw new Error(outcome.message);
      case "repository-refused":
        // loreserver's own sentence, and the row it was about is already gone.
        // It is the other server that said no, so it says so in its own words
        // rather than being reported as a fault of this one — with one sentence
        // added where what it said is that the repository is already there.
        // That is the one refusal here with a way out, and loreserver has no
        // reason to know what this server's way out is called.
        throw new Error(withTheWayOut(outcome.message));
      case "made":
      case "repeat":
        renderMadeProject(
          {
            name: outcome.project.name,
            id: outcome.project.id,
            owner: owner.username,
            // A repeat cannot arrive here: it is what a create labelled with a
            // client id answers when that create already happened, and nothing
            // on the command line labels one. It is rendered beside the other
            // because the row it names is the project either way, and whether
            // loreserver was asked for it follows from the option that was given.
            adopted:
              outcome.kind === "made" ? outcome.adopted : options.repositoryId !== undefined,
            defaultBranch: outcome.kind === "made" ? outcome.defaultBranch : undefined,
          },
          stdout,
        );
        return 0;
    }
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
 *
 * `--repository` is on both paths, because `repositoryId` was on this method
 * before the command line had an option for it. Nothing was added to the
 * protocol to reach it, which is the rule this file was written to.
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
        ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }),
      });
    });
    const project = readCreatedProject(answer);
    renderMadeProject(
      {
        name: project.name,
        id: project.id,
        owner: project.createdBy,
        // Read off what was asked for rather than out of the answer, which
        // carries the project and nothing about how it came to be. It is the
        // same fact: a create naming a repository adopts, one naming none asks
        // loreserver, and a repository already registered comes back as a
        // refusal rather than as a project. Nothing here sends a client id, so
        // there is no third outcome to confuse it with.
        adopted: options.repositoryId !== undefined,
        // Not carried by this answer; see the note on MadeProject.
        defaultBranch: undefined,
      },
      stdout,
    );
    return 0;
  } catch (error) {
    // Through the same reader as the local path's refusals, because the sentence
    // it adds is about this command rather than about which plane carried it:
    // the server passes loreserver's words through unedited, so what arrives
    // here is the string the other path had in its hand.
    stderr(`nlteam: ${withTheWayOut(describeError(error))}\n`);
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
