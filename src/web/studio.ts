/**
 * The one thing a Studio installation asks for over HTTP, and what composes it.
 *
 * Studio is handed one address and nothing else. The discovery document turns
 * the address into a server; this turns a username and a password into the
 * token everything after it needs. Everything after it is the session — every
 * project a person reads, makes or forgets travels on the WebSocket, because a
 * read and the event that invalidates it have to arrive down one connection in
 * order.
 *
 * So there is exactly one route:
 *
 *     POST   /api/studio/v1/sign-in   a password, for a token
 *
 * It takes no bearer, because it is where a bearer comes from, and it is the
 * only thing here that has to work before a session exists. It is a second door
 * onto what `nlteam token mint` does at the server, for the same accounts and
 * with the same refusals: an operator who would otherwise mint a token and send
 * it through a chat window can hand over a username and a password instead.
 * What it mints is the same token, claim for claim — see {@link answerSignIn}.
 *
 * It is served on the same HTTP/1.1 listener as the discovery document and the
 * socket upgrade. One listener means one certificate, and therefore one decision
 * to trust — the reason set out in ./router.ts.
 *
 * What else is here
 * -----------------
 * The rest of this file is what a project and an account look like in an answer,
 * and what it is to make a project. They are here rather than beside the methods
 * that call them because they are the shared implementations: one builder for a
 * project body means a field cannot come to exist on one path and not another,
 * and one create means two callers cannot come to make a project differently.
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
import type { KeyStore } from "../identity/keys.js";
import { defaultPasswordHasher } from "../identity/passwords.js";
import { storedTokenLifetimes, type TokenLifetimes } from "../identity/settings.js";
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
  isOperator,
  SIGN_IN_REFUSED_MESSAGE,
} from "../identity/users.js";
import type { RevisionPage } from "../projects/read.js";
import {
  createProject,
  findProjectById,
  findProjectByClientId,
  forgetProject,
  InvalidProjectNameError,
  isRepositoryId,
  newProjectId,
  type ProjectRecord,
} from "../projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../projects/repository.js";
import { TEAM_METHODS, type TeamCapability } from "../team/protocol.js";
import type { ProjectFileView, RevisionView } from "../teamview.js";
import { originIsOurs, remoteAddressOf } from "./origin.js";

/** Where the route lives. Versioned, because a client older than the server is ordinary. */
const PREFIX = "/api/studio/v1";

/** Where a username and a password become a token. */
const SIGN_IN = `${PREFIX}/sign-in`;

/** How much of a request body is read before it is refused as nonsense. */
const MAXIMUM_BODY_BYTES = 4 * 1024;

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
   * history at all — see {@link serviceCapabilities}. Undefined from the call
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
  /**
   * Token lifetimes named on the command line this server was started with.
   *
   * Absent is the ordinary case, and then the stored settings decide. What an
   * operator typed has to outrank them, or `up --token-lifetime` would stop
   * doing anything the moment somebody stored the setting it names — the same
   * rule the authorization service is written to, so that a token minted here
   * and one minted there last the same time.
   */
  readonly namedLifetimes?: Partial<TokenLifetimes>;
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
}

/**
 * The capabilities that depend on what this build was handed.
 *
 * The other half of the vocabulary is derived from the method table, which says
 * what a session can be asked for — see src/team/methods.ts. These two are the
 * ones that table cannot say, because neither of them turns on whether a method
 * is registered:
 *
 * `password-sign-in` names the sign-in route, which is answered before a session
 * exists and so has no method to be derived from. It is unconditional: the route
 * needs nothing beyond the database and the keys, both of which every caller here
 * already has.
 *
 * `project-history` is about the reader rather than the method. `projects.history`
 * is always registered, but a build with no reader has no revisions to page and
 * answers an empty one — which a client cannot tell from a project nobody has ever
 * committed to. So the capability is present only where there is a reader that can
 * page a history, and a client that wants to offer a person a list of versions
 * checks it rather than inferring one from an empty page.
 *
 * Worked out from what this build was given rather than written down, so that the
 * discovery document cannot come to say something this server does not do.
 */
export function serviceCapabilities(options: StudioApiOptions): TeamCapability[] {
  const capabilities: TeamCapability[] = ["password-sign-in"];
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
 * `operator` is that label, and it is a label. It says this account may
 * administer this server. It is not a permission over any project: every
 * account of this server reaches every project on it.
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
 * The route here is reached over the network before any token has been
 * presented, so a handler whose promise rejects is an unhandled rejection —
 * which takes the whole server down rather than the one request. A body
 * abandoned halfway through is enough to make one. The same guard ./api.ts puts
 * in front of the operator's interface, for the same reason.
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
 * The settings to mint a token with, as they stand now.
 *
 * The base is what this server was brought up as. The stored lifetimes are read
 * on every mint, so shortening one reaches a running server without a restart;
 * what an operator named on the command line outranks a stored lifetime, or
 * `up --token-lifetime` would stop doing anything the moment somebody stored the
 * setting it names. This is the same order the authorization service mints by,
 * so a token handed out here and one handed out there last the same time.
 */
function mintingConfig(options: StudioApiOptions): IdentityConfig {
  return {
    ...options.config,
    ...storedTokenLifetimes(options.database),
    ...options.namedLifetimes,
  };
}

/**
 * Answer a request if it is one of ours, and say whether it was.
 *
 * Returns false for everything outside this API's prefix, so the router can go
 * on to whatever else it serves without this having to know what that is.
 *
 * Everything **inside** the prefix is answered here, including the addresses
 * there is nothing at, so that a mistyped API address is refused as one rather
 * than falling through to something that knows nothing about this API. That is
 * most of the prefix: everything a Studio installation asks a server for beyond
 * a token is a method on the session, so an address under here that is not the
 * sign-in route is one nothing has ever served.
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

  if (path === SIGN_IN) {
    if (request.method !== "POST") {
      onlyMethods(response, "POST", "POST");
      return true;
    }
    answering(options, response, answerSignIn(options, request, response));
    return true;
  }

  refuse(response, 404, "this server has nothing at that address.");
  return true;
}

/** Say which methods an address takes, in the header and in the sentence. */
function onlyMethods(response: ServerResponse, allow: string, spoken: string): void {
  response.writeHead(405, { allow, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `that address takes ${spoken}` }));
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

  const config = mintingConfig(options);
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
  options: StudioApiOptions,
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
