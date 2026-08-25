/**
 * The API a Studio installation talks to.
 *
 * Studio is handed one address and a token, and everything else has to be
 * behind them. The discovery document turns the address into a server; this
 * turns the token into a list of projects and a way to make another. Without
 * it an author has to be told a repository id by hand, which is the one thing
 * the address was supposed to replace.
 *
 * It is served on the same HTTP/1.1 listener as the discovery document, and
 * **before the switch that turns the web interface on**: the interface is a
 * page for an operator and is off by default, while this is how every Studio
 * installation finds its work. One listener also means one certificate, and
 * therefore one decision to trust — the reason set out in ./router.ts.
 *
 * Authentication is the token itself, presented as a bearer, and checked by
 * exactly what the authorization service checks it with. There is no session
 * and nothing to sign out of: the token is what a person was handed, and its
 * lifetime is the whole of how long this works. The one route that takes no
 * bearer is the one that hands a token out, and it takes a password instead.
 *
 * What it does not do is decide who may reach what. Every account of this
 * server reaches every project on it, so the list is the same list for
 * everybody — see src/projects/registry.ts. That is the whole of the
 * authorization here: none of the reads below filters, ranks or hides anything
 * by who asked.
 *
 * The routes
 * ----------
 *
 *     POST   /api/studio/v1/sign-in               a password, for a token
 *     GET    /api/studio/v1/projects              every project on this server
 *     POST   /api/studio/v1/projects              make another, or register one
 *     GET    /api/studio/v1/projects/:id          one of them, and what is in it
 *     DELETE /api/studio/v1/projects/:id          take it off this server's list
 *     GET    /api/studio/v1/projects/:id/history  a page of its revisions
 *     GET    /api/studio/v1/members               every account, as a name
 *
 * The first of those is the one route that takes no token, because it is where
 * a token comes from. It is a second door onto what `nlteam token mint` does at
 * the server, for the same accounts and with the same refusals: an operator who
 * would otherwise mint a token and send it through a chat window can hand over
 * a username and a password instead. What it mints is the same token, claim for
 * claim — see {@link answerSignIn}.
 *
 * The DELETE is the narrowest of them, and its wording is load-bearing: it takes
 * a project off this server's list and does not touch what the repository
 * holds. See {@link answerProjectForget}.
 *
 * What is absent and what is nought
 * ---------------------------------
 * Everything that comes out of a repository is optional, and a field Team has
 * not read is left out rather than sent as zero. A project cloned for the first
 * time may be minutes away from having a history to report, and a row saying
 * nought revisions is a row saying nobody has ever worked on it. Absent is the
 * only honest answer while the read is still running, and it is the same answer
 * a project written by a newer Studio gets — which is what keeps this server
 * from having to be upgraded in step with the one it serves.
 *
 * Nothing here starts a repository read or waits on one. Whatever the reader
 * has landed so far is what is served.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { audienceHosts, dataRemoteUrl, type IdentityConfig } from "../identity/config.js";
import { bearerToken, describeRefusal, identifyToken } from "../identity/bearer.js";
import type { KeyStore } from "../identity/keys.js";
import { defaultPasswordHasher } from "../identity/passwords.js";
import { storedTokenLifetimes } from "../identity/settings.js";
import {
  holdRefusedSignIn,
  sharedSignInLimiter,
  verifyingPassword,
  type SignInLimiter,
} from "../identity/signin.js";
import { mintToken } from "../identity/tokens.js";
import type { UserRecord } from "../identity/users.js";
import {
  authenticate,
  findUserById,
  listUsers,
  SIGN_IN_REFUSED_MESSAGE,
} from "../identity/users.js";
import type { RevisionPage } from "../projects/read.js";
import {
  createProject,
  findProject,
  findProjectById,
  forgetProject,
  isRepositoryId,
  listProjects,
  newProjectId,
  type ProjectRecord,
} from "../projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../projects/repository.js";
import type { TeamProjectsEvent } from "../team/protocol.js";
import { NOT_READ_YET } from "../tui/teamview.js";
import type { ProjectFileView, RevisionView } from "../tui/teamview.js";
import { isOperator } from "./api.js";
import { originIsOurs, remoteAddressOf } from "./origin.js";

/** Where the routes live. Versioned, because a client older than the server is ordinary. */
const PREFIX = "/api/studio/v1";

/** The one collection there is. */
const PROJECTS = `${PREFIX}/projects`;

/** Every account of this server, as names rather than as accounts. */
const MEMBERS = `${PREFIX}/members`;

/** Where a username and a password become a token. */
const SIGN_IN = `${PREFIX}/sign-in`;

/** What hangs off one project. */
const HISTORY = "history";

/** How much of a request body is read before it is refused as nonsense. */
const MAXIMUM_BODY_BYTES = 4 * 1024;

/** How many revisions a page of history holds when it is not asked for a number. */
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * The most revisions one page may hold.
 *
 * Each one costs a read of its metadata, so a page is a bounded amount of work
 * rather than however much a client asked for. Somebody wanting the whole of a
 * long history pages through it, which is what the cursor is for.
 */
const MAXIMUM_HISTORY_LIMIT = 100;

/**
 * What Team has read out of the repositories, and a way to read one page more.
 *
 * Deliberately optional, and deliberately only a lookup. Answering a request
 * must not start a repository read, wait for one, or be able to: a clone is the
 * slowest thing this server does, and a list of projects that stopped on a
 * loreserver which was not answering would be a list nobody could open Studio
 * without. Whatever has landed is served; the rest is absent.
 */
export interface StudioReadings {
  /** What Team last read about one project, or undefined if it has not. */
  get(projectId: string): { readonly history: RevisionView; readonly file: ProjectFileView } | undefined;
  /**
   * One page of a project's revisions, read on demand.
   *
   * Optional because it is what decides whether this build says it serves a
   * history at all — see {@link studioCapabilities}. Undefined from the call
   * means Team has no checkout of that project to read yet.
   */
  readonly revisions?: (
    projectId: string,
    page: { readonly limit: number; readonly before?: string },
  ) => Promise<RevisionPage | undefined>;
  /**
   * Drop what was read about one project, because it is no longer one.
   *
   * Called when a project is taken off this server, so that the reading does
   * not outlive the row. Optional for the same reason {@link revisions} is: a
   * build serving no reader has nothing to drop, and a stand-in for one in a
   * test need not grow a method to be handed to a route that has no reading to
   * forget anyway.
   */
  readonly forget?: (projectId: string) => void;
}

/** Everything this API needs that is not in the request. */
export interface StudioApiOptions {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /** The port loreserver serves gRPC on, for creating a repository. */
  readonly dataPort: number;
  /**
   * The fingerprint of this server's authority, absent until one exists.
   *
   * Written into a token handed out by the sign-in route, because that token
   * leaves this machine — the same reason `nlteam token mint` writes it. A
   * server with no certificates yet still signs in; its tokens simply carry no
   * fingerprint, and Studio falls back to asking a person for one.
   */
  readonly fingerprint?: string;
  /**
   * How often a password may be guessed at here.
   *
   * Absent means the one every door of this server shares, which is what a
   * running server wants: the rate somebody may guess at a password should not
   * depend on which door they knock on. A caller passes its own when it wants
   * one that no other caller has already spent.
   */
  readonly signIns?: SignInLimiter;
  /** What the repositories last said. Absent on a server that reads none. */
  readonly readings?: StudioReadings;
  /** Somewhere to say what happened, in the same place `up` says everything else. */
  readonly log?: (line: string) => void;
  /**
   * Tell every open session that the list of projects moved.
   *
   * Absent on a build with no socket, and on every test that does not care.
   * Called from the two routes that change what the list holds, rather than
   * from the registry, because the registry is also written by the CLI and by
   * loreserver adopting a repository - and an announcement is about a decision
   * somebody made, not about a row.
   */
  readonly announce?: (event: TeamProjectsEvent) => void;
}

/**
 * The names Studio matches literally to know what this server answers.
 *
 * Words rather than a version number, because they are added one at a time and
 * a client wants to know about each on its own.
 */
export type StudioCapability =
  | "projects"
  | "project-detail"
  | "members"
  | "project-history"
  | "password-sign-in";

/**
 * What every build of this file serves, whatever it was given.
 *
 * These are the routes {@link serveStudioApi} answers unconditionally, and this
 * is the list the discovery document is built from: a route that stops being
 * served has to be taken out of one place, not two. `password-sign-in` is among
 * them because the route below needs nothing beyond the database and the keys,
 * both of which every caller of this API already has.
 */
const ALWAYS_SERVED: readonly StudioCapability[] = [
  "projects",
  "project-detail",
  "members",
  "password-sign-in",
];

/**
 * What this build serves, worked out from what it was given.
 *
 * Read from the options rather than written down, so that the discovery
 * document cannot come to say something this file does not do. The history is
 * the one that is not unconditional: it is there only where there is something
 * to read a history out of.
 */
export function studioCapabilities(options: StudioApiOptions): StudioCapability[] {
  const capabilities: StudioCapability[] = [...ALWAYS_SERVED];
  if (options.readings?.revisions !== undefined) {
    capabilities.push("project-history");
  }
  return capabilities;
}

/** One project, as a Studio installation reads it. */
export interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who made it, by username; absent for an account that has been deleted. */
  readonly createdBy?: string;
  readonly createdAt: number;
  /**
   * The remote to clone, which is the address Studio would otherwise be told.
   *
   * **The project's name is on the end, and it has to be.** A client is given
   * `lore://host:port/<name>` and refuses one without the name — measured: the
   * clone page marks an origin-only address invalid and will not go on. What
   * the client stores afterwards is only the origin, which is why it is easy to
   * think the name is decoration.
   */
  readonly remote: string;
  /**
   * What the repository says about itself, absent until Team has read it.
   *
   * Absent rather than empty, and never zeroed. The first read of a project is
   * a clone and the slowest thing this server does, and a project that has been
   * worked on for months must not read as one nobody has touched while that
   * clone is still running.
   */
  readonly history?: RevisionView;
}

/**
 * One account, as a name beside a piece of work rather than as an account.
 *
 * What is here is what somebody needs in order to know whose revision they are
 * looking at. What is not here is an operator's business: when an account's
 * tokens were last refused, what groups it is in beyond the one label below,
 * and anything else the management plane keeps.
 *
 * `operator` is that label, and it is a label. It says this account may open
 * the operator's page and administer this server. It is not a permission over
 * any project: every account of this server reaches every project on it.
 */
export interface MemberBody {
  readonly username: string;
  readonly displayName: string;
  /**
   * The address, where the account has one.
   *
   * Included on purpose. It is already on every revision this person authored,
   * so within this server it is not a secret, and a member list that could not
   * be matched against a history would not be much of a member list. What is
   * done with it is Studio's decision, which is to show it to nobody by
   * default.
   */
  readonly email?: string;
  readonly operator: boolean;
  /**
   * Whether the account may still sign in.
   *
   * A disabled account is listed rather than dropped. Somebody who wrote half
   * of a project's history and then left is still the person that history
   * names, and a list they had fallen out of would leave those revisions signed
   * by a stranger.
   */
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  readonly createdAt: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * It is done, and there is nothing to say about it.
 *
 * No body at all rather than an empty object: 204 is the answer to a request
 * whose whole result is that it worked, and a client parsing one has nothing to
 * read out of it. Deliberately not {@link sendJson}, which would give it a
 * content length and a type for a body that is not there.
 */
function sendNothing(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

/**
 * Say no, in the shape everything else here answers in.
 *
 * One sentence and nothing else. A client that cannot act on the difference
 * between two refusals is a client that will print whichever it got, so the
 * sentence is the whole of the answer.
 */
function refuse(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

/**
 * Say that this one was not tried, and when the next one will be.
 *
 * `retry-after` as well as the sentence, because a client that reads it can
 * wait rather than keep asking, and one that does not has been told in words.
 */
function holdOff(response: ServerResponse, seconds: number): void {
  const body = JSON.stringify({
    error: `too many sign-ins from here have been refused; try again in ${seconds} seconds`,
  });
  response.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "retry-after": String(seconds),
  });
  response.end(body);
}

/**
 * Answer, and turn anything nobody planned for into one sentence.
 *
 * Every route here is reached over the network and one of them is reached
 * before any token has been presented, so a handler whose promise rejects is an
 * unhandled rejection — which takes the whole server down rather than the one
 * request. A body abandoned halfway through is enough to make one. The same
 * guard ./api.ts puts in front of the operator's interface, for the same
 * reason.
 */
function answering(
  options: StudioApiOptions,
  response: ServerResponse,
  work: Promise<void>,
): void {
  void work.catch((error: unknown) => {
    options.log?.(`studio: ${error instanceof Error ? error.message : String(error)}`);
    if (response.headersSent) {
      // Whatever was being written is finished with; the socket must not be
      // left open on a page waiting for the rest of an answer.
      response.end();
      return;
    }
    refuse(response, 500, "something went wrong answering that");
  });
}

export function projectBody(options: StudioApiOptions, project: ProjectRecord): ProjectBody {
  const { database, config } = options;
  const maker = findUserById(database, project.createdBy);
  // Whatever the reader has landed, and nothing is asked of it here. A project
  // it has not reached has no history, which is left out rather than filled in.
  const history = options.readings?.get(project.id)?.history;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    ...(maker === undefined ? {} : { createdBy: maker.username }),
    createdAt: project.createdAt,
    // Built from what this server was started with rather than stored, for the
    // same reason the discovery document is: the address a project is reached
    // at is a fact about the deployment, not about the project.
    remote: `${dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort)}/${project.name}`,
    ...(history === undefined ? {} : { history }),
  };
}

export function memberBody(user: UserRecord): MemberBody {
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    // The one group question this API asks, asked where the interface asks it,
    // so that the label and the door cannot come to disagree.
    operator: isOperator(user.groups),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
  };
}

/** Read a JSON body, or say what was wrong with it. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAXIMUM_BODY_BYTES) {
      return "that request body is larger than anything this API takes";
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    return "that request needs a JSON body";
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "that request body is not a JSON object";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "that request body is not JSON";
  }
}

function text(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Whoever presented the token, or undefined once the refusal has been sent.
 *
 * The same check the authorization service makes, so a token this API accepts
 * is one that reaches a repository and a token it refuses is one that would
 * have failed later anyway.
 */
function caller(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): UserRecord | undefined {
  const authorization = request.headers["authorization"];
  const token = bearerToken(Array.isArray(authorization) ? authorization[0] : authorization);
  const identified = identifyToken(options.database, options.keys, options.config, token);
  if (identified.kind === "refused") {
    refuse(response, 401, describeRefusal(identified.reason));
    return undefined;
  }
  return identified.user;
}

/**
 * Answer a request if it is one of ours, and say whether it was.
 *
 * Returns false for everything outside this API's prefix, so the router goes on
 * to the interface and the pages without this having to know they exist.
 *
 * Everything **inside** the prefix is answered here, including the addresses
 * there is nothing at. Falling through with one of those would hand it to the
 * arm that serves the operator's page, and on a server with that page switched
 * off the answer to a mistyped API address would be a sentence about a web
 * interface — which tells whoever typed it nothing about what they typed.
 */
export function serveStudioApi(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    return false;
  }

  if (path === PROJECTS) {
    if (request.method === "GET") {
      void answerProjectList(options, request, response);
      return true;
    }
    if (request.method === "POST") {
      answering(options, response, answerProjectCreate(options, request, response));
      return true;
    }
    onlyMethods(response, "GET, POST", "GET and POST");
    return true;
  }

  if (path === MEMBERS) {
    if (request.method !== "GET") {
      onlyMethods(response, "GET", "GET");
      return true;
    }
    answerMembers(options, request, response);
    return true;
  }

  if (path === SIGN_IN) {
    if (request.method !== "POST") {
      onlyMethods(response, "POST", "POST");
      return true;
    }
    answering(options, response, answerSignIn(options, request, response));
    return true;
  }

  const under = beneathProjects(path);
  if (under !== undefined) {
    if (under.rest === undefined) {
      if (request.method === "GET") {
        answerProject(options, request, response, under.reference);
        return true;
      }
      if (request.method === "DELETE") {
        answerProjectForget(options, request, response, under.reference);
        return true;
      }
      onlyMethods(response, "GET, DELETE", "GET and DELETE");
      return true;
    }
    if (under.rest === HISTORY) {
      if (request.method !== "GET") {
        onlyMethods(response, "GET", "GET");
        return true;
      }
      answering(
        options,
        response,
        answerProjectHistory(options, request, response, under.reference),
      );
      return true;
    }
  }

  refuse(response, 404, "this server has nothing at that address.");
  return true;
}

/**
 * Take a path apart into the project it names and whatever hangs off it.
 *
 * Undefined for anything that is not under the collection, so the router goes
 * on to the pages rather than this claiming an address it has no answer for.
 * The separator is a real one: the URL parser leaves an escaped slash escaped,
 * so a project reference cannot be made to look like two segments.
 */
function beneathProjects(path: string): { reference: string; rest?: string } | undefined {
  if (!path.startsWith(`${PROJECTS}/`)) {
    return undefined;
  }
  const [first, second, ...more] = path.slice(PROJECTS.length + 1).split("/");
  if (first === undefined || first === "" || more.length > 0) {
    return undefined;
  }
  const reference = decodeSegment(first);
  if (reference === undefined) {
    return undefined;
  }
  return second === undefined || second === "" ? { reference } : { reference, rest: second };
}

/** One path segment as it was written, or undefined if it was written wrongly. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Say which methods an address takes, in the header and in the sentence. */
function onlyMethods(response: ServerResponse, allow: string, spoken: string): void {
  response.writeHead(405, { allow, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `that address takes ${spoken}` }));
}

function answerProjectList(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const projects = listProjects(options.database).map((project) =>
    projectBody(options, project),
  );
  options.log?.(`studio: ${user.username} listed ${projects.length} project(s)`);
  sendJson(response, 200, { projects });
}

/**
 * One project, and what is in it.
 *
 * The project is the same body a row of the list is, history and all, so
 * nothing here is a second account of what a project is. What this adds is the
 * project file — the title, the stage, how many scenes and assets — which is
 * read out of the repository and is therefore the part that may be absent.
 *
 * A file Team could not make sense of is `readable: false` and a sentence
 * saying why, never a refusal. Most often it was written by a newer Studio,
 * and the project around it is still true.
 */
function answerProject(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  reference: string,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  // By id or by name, because both are things a client has in front of it: the
  // id every row carries, and the name the remote address ends with.
  const project = findProject(options.database, reference);
  if (project === undefined) {
    refuse(response, 404, `there is no project called ${reference}.`);
    return;
  }
  const read = options.readings?.get(project.id) ?? NOT_READ_YET;
  options.log?.(`studio: ${user.username} opened ${project.name} (${project.id})`);
  sendJson(response, 200, { project: projectBody(options, project), file: read.file });
}

/**
 * `DELETE /api/studio/v1/projects/:id`: take a project off this server's list.
 *
 * 204 and no body when it is gone, 404 when there was nothing by that name or
 * id, 401 without a token this server signed.
 *
 * What it removes and what it does not
 * ------------------------------------
 * It removes the row: this server stops listing the project, stops reading its
 * repository on the interval, and stops answering permission questions about
 * it — a resource nothing here has a project for is not one of ours, which is
 * what src/projects/service.ts already answers.
 *
 * **It does not delete anything the repository holds.** loreserver keeps the
 * store, the branches and every revision in them, exactly as they were. This
 * is the same act as {@link forgetProject}, which is why it is that function
 * and not a new one: Team's row and the repository's contents are two things,
 * and only the first of them is this server's to remove. An author whose
 * project was taken off a server by mistake publishes it again, under the id
 * their repository has always carried, and gets their history back with it.
 *
 * That asymmetry is deliberate and is not an oversight to be tidied up later.
 * loreserver has a verb that would destroy the store; it is not called from
 * anywhere in Team, and nothing about an operator clearing a stray row off a
 * list is a reason to reach for it.
 *
 * Who may
 * -------
 * Any account that can present a token this server signed, which is the same
 * rule every other project route here is written to: an account of this server
 * reaches every project on it. No group is consulted — not `operator`, which
 * is a label about the management page, and not the account that created the
 * project, which is a name shown beside it rather than a claim over it.
 *
 * Why the reading is dropped
 * --------------------------
 * The reader keeps what it last read under the repository id, and the id is
 * the one thing a re-registration keeps. Left behind, it would answer for the
 * next registration of that repository with a history read before it was
 * removed — including, in the case this exists for, a reading of nothing at
 * all taken while a stray empty project sat on the list.
 */
function answerProjectForget(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  reference: string,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  // By id or by name, as the read of one project is, because a client holding
  // a stray row has both and neither is more correct than the other.
  const project = findProject(options.database, reference);
  if (project === undefined) {
    // The same sentence a read of a project that is not here answers with. A
    // second delete of the same project lands here, which is the right answer
    // to it: there is nothing by that name on this server.
    refuse(response, 404, `there is no project called ${reference}.`);
    return;
  }
  forgetProject(options.database, project.id);
  options.readings?.forget?.(project.id);
  // The name is read out of the row before it goes, because this is the one
  // line here whose subject does not exist by the time anybody reads it.
  options.log?.(`studio: ${user.username} forgot ${project.name} (${project.id})`);
  // Its conversations went with the row, by the foreign key migration 8 wrote.
  // Anybody holding that project's threads topic is told the project is gone
  // rather than told nothing and left listening to something that cannot speak.
  options.announce?.({ kind: "project-forgotten", project: project.id });
  sendNothing(response);
}

/**
 * A username and a password, for the token everything else here takes.
 *
 * The token is the one `nlteam token mint` prints, and it has to be: Studio
 * compares a token's audience against the address it dialled and refuses one
 * that differs, and it reads the authority's fingerprint out of the claims to
 * know which machine it has been asked to trust. So the claims are not composed
 * here — {@link mintToken} writes them, from the stored lifetimes and the same
 * account record, exactly as the command does.
 *
 * Every refusal is the same refusal
 * ---------------------------------
 * One status and one sentence for an account that is not there, a password that
 * is wrong, an account that has been disabled and an account that belongs to a
 * machine. Whoever is at the other end learns nothing about which accounts
 * exist on this server, which is the same rule `nlteam token mint` and the
 * operator's sign-in are written to.
 *
 * A service account is refused for a different reason and answered the same
 * way: it is an account no person signs in to, and a password prompt that
 * accepted one would be an interactive door onto a machine's credentials.
 *
 * Nothing about the body is logged, ever. A refusal may name the username that
 * was tried, because an operator reading the log needs to know what is being
 * guessed at; the password does not appear in any line here, or in any error
 * this can raise.
 *
 * What it costs to knock
 * ----------------------
 * A password check is the most expensive thing this server does for somebody
 * who has presented nothing, and an unknown username costs the same as a known
 * one because it is hashed against a decoy. So the door is guarded before the
 * check rather than after it: a request from a page of another site is refused
 * on its `origin`, and a name that has been refused often enough from one place
 * is answered without its password being looked at.
 */
async function answerSignIn(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!originIsOurs(request)) {
    // The token this answers with goes in the body rather than in a cookie, so
    // a page elsewhere gains nothing by making the request. What it would gain
    // is the ability to spend this server's password checking through the
    // browser of anybody who visits it.
    refuse(response, 403, "that request came from somewhere else");
    return;
  }

  const body = await readJson(request);
  if (typeof body === "string") {
    // What was wrong with the request, which is not a statement about any
    // account: a body too long or not JSON is answered before a password is
    // read out of it.
    refuse(response, 400, body);
    return;
  }
  const username = text(body, "username");
  const password = typeof body["password"] === "string" ? body["password"] : undefined;
  if (username === undefined || password === undefined) {
    refuse(response, 400, "a sign-in takes a username and a password");
    return;
  }

  const limiter = options.signIns ?? sharedSignInLimiter();
  const address = remoteAddressOf(request);
  const wait = limiter.waitFor(username, address);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    options.log?.(`studio: sign-in for ${JSON.stringify(username)} held off for ${seconds}s`);
    // A different sentence from the refusal below, and it may be: what it says
    // is how often this caller has been wrong, which they already know, and
    // nothing about whether the account they named is one this server has.
    holdOff(response, seconds);
    return;
  }

  const result = await verifyingPassword(() =>
    authenticate(options.database, defaultPasswordHasher(), username, password),
  );
  if (result.kind === "refused" || result.user.isServiceAccount) {
    if (result.kind === "refused") {
      limiter.refused(username, address);
    } else {
      // The password was right; the account is simply not one a person signs
      // in to. Counting it would hold that against whoever typed it.
      limiter.accepted(username, address);
    }
    await holdRefusedSignIn();
    options.log?.(`studio: sign-in refused for ${JSON.stringify(username)}`);
    refuse(response, 401, SIGN_IN_REFUSED_MESSAGE);
    return;
  }
  limiter.accepted(username, address);

  const config = { ...options.config, ...storedTokenLifetimes(options.database) };
  const minted = mintToken(result.user, options.keys.signingKey, config, {
    purpose: "sign-in",
    ...(options.fingerprint === undefined ? {} : { authorityFingerprint: options.fingerprint }),
  });

  options.log?.(`studio: ${result.user.username} signed in`);
  sendJson(response, 200, {
    token: minted.token,
    // The account as the person who just signed in is entitled to see it, which
    // is their own row and nothing about anybody else's. What groups they are
    // in is not here: it decides nothing about the projects this API serves,
    // and Studio has no screen that would be different for an operator.
    account: {
      username: result.user.username,
      displayName: result.user.displayName,
      ...(result.user.email === undefined ? {} : { email: result.user.email }),
    },
  });
}

/**
 * Every account of this server, so that a name on a revision is a person.
 *
 * Every account, including the disabled ones. This is not a list of who may do
 * something — everybody may, which is the rule the rest of this server is built
 * on — it is the list a history is read against, and somebody who left is still
 * the author of what they wrote.
 */
function answerMembers(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const members = listUsers(options.database).map((account) => memberBody(account));
  options.log?.(`studio: ${user.username} listed ${members.length} member(s)`);
  sendJson(response, 200, { members });
}

/**
 * A page of one project's revisions.
 *
 * Read when it is asked for and never on the interval that refreshes the rest:
 * a history is read by one person looking at one project, and reading every
 * page of every project once a minute would be work nobody asked for.
 *
 * A project Team has no checkout of yet answers with `revisions` absent, for
 * the same reason a row of the list has no history: an empty page reads as a
 * project with no revisions, which is a different and untrue thing.
 */
async function answerProjectHistory(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  reference: string,
): Promise<void> {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const project = findProject(options.database, reference);
  if (project === undefined) {
    refuse(response, 404, `there is no project called ${reference}.`);
    return;
  }
  const readings = options.readings;
  if (readings?.revisions === undefined) {
    // A build serving no history says so in its capabilities, so a client that
    // read them does not ask. One that asked anyway is answered the same way a
    // project nobody has read is: absent, rather than a refusal it can do
    // nothing about.
    sendJson(response, 200, { more: false });
    return;
  }

  const query = new URL(request.url ?? "/", "http://team.invalid").searchParams;
  const limit = pageLimit(query.get("limit"));
  const before = query.get("before") ?? undefined;

  // Called on the reader rather than through a reference lifted off it. The
  // reader is a class, its `revisions` keeps a set of the projects a read is
  // inside of, and a copy of the method called on its own has no `this` to
  // find that set on — which every stand-in for it in a test does have, being
  // an object literal, so this answered in the suite and threw on every server.
  const page = await readings.revisions(project.id, {
    limit,
    ...(before === undefined || before === "" ? {} : { before }),
  });
  if (page === undefined) {
    sendJson(response, 200, { more: false });
    return;
  }
  options.log?.(
    `studio: ${user.username} read ${page.revisions.length} revision(s) of ${project.name}`,
  );
  sendJson(response, 200, { revisions: page.revisions, more: page.more });
}

/**
 * How many revisions to read, from what was asked for.
 *
 * Anything that is not a number this can act on becomes the default rather
 * than a refusal: a client that sent nonsense wanted a page of history, and a
 * page of history is a better answer than a sentence about its query string.
 */
function pageLimit(asked: string | null): number {
  const wanted = Number(asked);
  if (asked === null || asked === "" || !Number.isInteger(wanted) || wanted < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(wanted, MAXIMUM_HISTORY_LIMIT);
}

/**
 * `POST /api/studio/v1/projects`: make a project, or register one that exists.
 *
 * ```
 * {"name": "...", "description": "...", "repositoryId": "..."}
 * ```
 *
 * Two acts behind one address, and `repositoryId` is what says which.
 *
 * **Without it**, this makes a project from nothing: an id is generated here
 * and loreserver is asked for the repository to go with it. That is the whole
 * of what this route used to do, and it is unchanged.
 *
 * **With it**, the repository already exists — on the author's own disk, under
 * an id it has carried since the day they enabled version control — and what is
 * missing is the row saying it belongs on this server. So the row is written
 * and loreserver is not asked for anything: it is the client that will push,
 * and asking for a repository under the same id would either be refused or
 * would make a second one under a name the author had already claimed.
 *
 * The ordering note below is why publishing works at all. loreserver announces
 * a repository to Team as it is created, and Team answers for one only when it
 * has the row — so the row has to be there before the client's push, which is
 * to say before this answers. It is, and nothing between here and the push can
 * reorder them.
 *
 * A repository id already registered is a 409 rather than a silent adoption:
 * the author is publishing what they believe is a new project, and the server
 * already holding it means somebody has published it, which they have to know
 * before they push into it.
 */
async function answerProjectCreate(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const body = await readJson(request);
  if (typeof body === "string") {
    refuse(response, 400, body);
    return;
  }
  const name = text(body, "name");
  if (name === undefined) {
    refuse(response, 400, "a project needs a name");
    return;
  }
  const description = text(body, "description") ?? "";

  // Folded, because hex is hex either way and everything downstream compares
  // this character by character: it becomes the primary key, and the second
  // half of the resource id loreserver asks permission questions about.
  const claimed = text(body, "repositoryId")?.toLowerCase();
  if (claimed !== undefined && !isRepositoryId(claimed)) {
    refuse(response, 400, "a repository id is thirty-two hexadecimal characters");
    return;
  }
  if (claimed !== undefined && findProjectById(options.database, claimed) !== undefined) {
    refuse(response, 409, `the repository ${claimed} is already a project on this server.`);
    return;
  }

  // The row is written before loreserver is asked, and removed again if it
  // refuses. That order matters: loreserver announces the new repository back
  // to Team while the create call is still open, and a server that had not
  // recorded the project yet would have nothing to say about it.
  let project: ProjectRecord;
  try {
    project = createProject(options.database, {
      id: claimed ?? newProjectId(),
      name,
      description,
      createdBy: user.id,
    });
  } catch (error) {
    refuse(response, 409, error instanceof Error ? error.message : String(error));
    return;
  }

  if (claimed !== undefined) {
    options.log?.(`studio: ${user.username} registered ${project.name} (${project.id})`);
    options.announce?.({ kind: "project-created", project: project.id });
    // No history, and for a different reason from the one below: this
    // repository may have years of it, and none of it has arrived yet. Absent
    // is what says the reader has not been round; a nought would say the
    // author had published an empty project.
    sendJson(response, 201, { project: projectBody(options, project) });
    return;
  }

  const config = { ...options.config, ...storedTokenLifetimes(options.database) };
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
    options.log?.(
      `studio: ${user.username} could not create ${name}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    // 502 rather than 500: Team did its part, and the thing that refused is the
    // other server. A client that says so is one whose operator looks in the
    // right log.
    refuse(response, 502, error instanceof Error ? error.message : String(error));
    return;
  }

  options.log?.(`studio: ${user.username} created ${project.name} (${project.id})`);
  options.announce?.({ kind: "project-created", project: project.id });
  // No history on it, and that is right: the repository was made a moment ago
  // and nothing has been read out of it. Absent says so; nought would say
  // somebody had already emptied it.
  sendJson(response, 201, { project: projectBody(options, project) });
}
