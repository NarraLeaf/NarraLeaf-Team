/**
 * The service loreserver asks about a caller.
 *
 * loreserver does not decide who may touch a repository. It asks, over gRPC, at
 * the address in its `auth_url` — which is this — forwarding the caller's own
 * `authorization` header. What it does with the answer, measured against
 * loreserver 0.8.6, is narrower than the protocol suggests:
 *
 *   - It calls `CheckUserPermission` with one resource id, `urc-` followed by
 *     the repository id in lower-case hex.
 *   - It accepts the answer if and only if `allowed_resource_permission[0]`
 *     names that same id. The `permission` list is never read. An empty allow
 *     list is "No permissions for resource"; a different id is "Unexpected
 *     resource_id"; the client is told "not found" for either.
 *   - It calls `LookupUserPermissions` to find out which repositories to put in
 *     a listing.
 *   - It calls `RebacApi/CreateResource` after creating a repository, and
 *     `DeleteResource` after deleting one.
 *
 * So the allow list is the whole of the decision, and an id that is present is
 * an id the caller may open. Everything else in the reply is for the log and
 * for whoever reads this next.
 *
 * Every decision is written to the log with the caller, the resource and the
 * outcome, and kept in the database by src/identity/audit.ts. Nothing else in
 * the system records who reached what: loreserver logs that it asked, not what
 * it was told, and a refusal reaches the person as "not found".
 *
 * The resource in those lines is a string somebody else chose, and so is the
 * name a repository is reported under. Each goes through `forLog` as it comes
 * in, so that nothing a caller sends can write a line of this server's log or
 * move the cursor of the terminal it is being read in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DatabaseSync } from "node:sqlite";

import {
  decodeCheckUserPermissionRequest,
  decodeCreateResourceRequest,
  decodeDeleteResourceRequest,
  decodeExchangeExternalTokenForUserTokenRequest,
  decodeExchangeUserTokenForMultiresourceTokenRequest,
  decodeLookupUserPermissionsRequest,
  encodeCheckUserPermissionResponse,
  encodeExchangeExternalTokenForUserTokenResponse,
  encodeExchangeUserTokenForMultiresourceTokenResponse,
  encodeHealthCheckResponse,
  encodeLookupUserPermissionsResponse,
  EMPTY_MESSAGE,
  METHOD_CHECK_USER_PERMISSION,
  METHOD_CREATE_RESOURCE,
  METHOD_DELETE_RESOURCE,
  METHOD_EXCHANGE_EXTERNAL_TOKEN,
  METHOD_EXCHANGE_MULTIRESOURCE_TOKEN,
  METHOD_HEALTH_CHECK,
  METHOD_LOOKUP_USER_PERMISSIONS,
  type ResourcePermission,
} from "../grpc/messages.js";
import { GrpcServer, type GrpcCall, type GrpcMethod } from "../grpc/server.js";
import {
  GRPC_PERMISSION_DENIED,
  GRPC_UNAUTHENTICATED,
  GrpcStatusError,
} from "../grpc/status.js";
import {
  forLog,
  recordDecision,
  UNIDENTIFIED_ACCOUNT,
  type NewDecision,
  type RecordedDecision,
} from "../identity/audit.js";
import {
  bearerToken,
  describeRefusal,
  identifyToken,
  type CallerIdentification,
} from "../identity/bearer.js";
import type { IdentityConfig } from "../identity/config.js";
import type { KeyStore } from "../identity/keys.js";
import { storedTokenLifetimes, type TokenLifetimes } from "../identity/settings.js";
import { mintToken, type ResourceClaim } from "../identity/tokens.js";
import {
  createProject,
  findProject,
  forgetProject,
  listProjects,
  PROJECT_PERMISSIONS,
  projectIdFromResourceId,
  resourceIdOf,
} from "./registry.js";

/** Everything the service needs to answer a question. */
export interface AuthorizationContext {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /**
   * Token lifetimes named on the command line this Team server was started with.
   *
   * Absent is the ordinary case, and then the stored settings decide. What an
   * operator typed has to outrank them, or `up --token-lifetime` would stop
   * doing anything the moment somebody stored the setting it names.
   */
  readonly namedLifetimes?: Partial<TokenLifetimes>;
  /** Where one line per decision goes. */
  readonly log: (line: string) => void;
  /**
   * Somewhere to say that a decision was **refused**, for an operator watching.
   *
   * Beside {@link log} and shaped like it, because it is the same kind of thing:
   * a channel out of here to whatever this service was brought up beside,
   * absent in a build that has nothing to say it to. This one goes to the
   * sessions that are subscribed to `admin/refusals`; a build with no socket
   * has none, and leaves it unset.
   *
   * Refusals alone, and that is the design rather than a shortcut. A decision is
   * taken on every repository access — thousands in an afternoon of one team
   * working — so calling this on each of them would push more frames than the
   * rest of the protocol together, to tell a panel something it could only act
   * on by re-reading a page it already holds. A refusal is the rare outcome and
   * the one somebody wants put in front of them.
   */
  readonly refused?: (decision: RecordedDecision) => void;
  /**
   * Somewhere to say that a project is **no longer on this server**.
   *
   * Shaped like {@link refused} and for the same reason: forgetting a project
   * has consequences outside this file — the sessions holding a list that now
   * names something which is not there, and the reading this server kept of the
   * repository — and neither of those is a thing src/projects/ knows about. So
   * what happens here is the row going, and what happens to the rest of the
   * server is whatever this was wired to. Absent in a build with nothing to
   * tell, exactly as `refused` is, and then the row simply goes.
   *
   * The same disappearance travels the other way when a client asks for it, and
   * `projects.forget` in src/team/methods/projects.ts does it there. The two
   * paths have to leave this server in one state, because which of them a
   * project went by is not something anybody holding a list can see.
   */
  readonly forgotten?: (projectId: string) => void;
}

/**
 * The settings to mint with, carrying the two token lifetimes as they stand in
 * the database at this moment.
 *
 * Read per mint rather than kept from the start, so that shortening a lifetime
 * reaches a Team server that is already running instead of waiting for somebody to
 * restart it. It is one row fetched by primary key out of a local SQLite file,
 * beside the several queries each of these calls already makes.
 */
function mintingConfig(context: AuthorizationContext): IdentityConfig {
  return {
    ...context.config,
    ...storedTokenLifetimes(context.database),
    ...context.namedLifetimes,
  };
}

/** What a caller is called in the log when there is nobody to name. */
const UNIDENTIFIED = "an unidentified caller";

/**
 * What a decision is filed under when it is not about one project.
 *
 * Short nouns, because they sit in the same column as a project's name on a
 * screen that is often narrow.
 */
const SIGN_IN = "sign-in";
const LISTING = "listing";
const DATA_CONNECTION = "data connection";
const NOTHING = "nothing";

/**
 * Say what was decided, once, to every place it has to go.
 *
 * The log line and the record are written side by side rather than one derived
 * from the other: the line is a sentence for somebody watching a terminal, and
 * the record is five fields for somebody looking at a screen a week later.
 * Writing both at one call site is what stops either being forgotten; the two
 * calls that stay on `context.log` alone are the ones where Team decided
 * nothing, and each of them says so.
 *
 * A refusal goes to a third place, and only a refusal: it is pushed at whoever
 * is watching this server rather than left to be found by paging the log. The
 * reasoning for why an allowance is not is on {@link AuthorizationContext.refused}.
 */
function decided(context: AuthorizationContext, line: string, decision: NewDecision): void {
  context.log(line);
  const recorded = recordDecision(context.database, decision);
  if (!recorded.allowed) {
    context.refused?.(recorded);
  }
}

/**
 * The name a decision about `resourceId` is filed under.
 *
 * Resolved as the decision is made rather than as the log is read, so that the
 * record still says which project it was about after that project has been
 * deleted from this Team server. A resource Team knows nothing about keeps its resource
 * id, which is all there is to say about it.
 *
 * It costs one lookup by primary key in a local SQLite file, on a call that has
 * already verified an RSA signature.
 *
 * Whatever comes back is safe to write down. A project's name was checked
 * against the pattern in ./registry.ts before it could be stored, so escaping
 * it changes nothing; a resource id was checked against nothing at all, and it
 * is what this answers with whenever there is no project to name.
 */
function resourceName(context: AuthorizationContext, resourceId: string): string {
  const projectId = projectIdFromResourceId(resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);
  return forLog(project?.name ?? resourceId);
}

/**
 * What a refused check is filed under, for the whole call at once.
 *
 * A refusal has one reason and one subject: whoever presented the token. Which
 * resources the request happened to name changes nothing about it, so it is
 * recorded once rather than once per resource — the second, third and
 * sixty-fourth rows would be copies of the first, and this is the branch an
 * unidentified caller reaches, so the copies are what an unauthenticated
 * request can make this server write.
 *
 * loreserver asks about one resource, so that one is named and the record goes
 * on saying which project somebody was turned away from. A request naming
 * several is filed under how many, which is all a refusal has to say about
 * them.
 */
function refusedResource(
  context: AuthorizationContext,
  resourceIds: readonly string[],
): string {
  const only = resourceIds[0];
  if (only === undefined) {
    return NOTHING;
  }
  return resourceIds.length === 1 ? resourceName(context, only) : `${resourceIds.length} resources`;
}

/**
 * Identify whoever the question is about.
 *
 * Normally that is the bearer of the token loreserver forwarded. A request may
 * instead name a `target_user` holding a token of its own, and then the
 * question is about that person — answering about the bearer would be an answer
 * to a different question.
 *
 * A `kid` this process has not seen sends it back to the keys directory once. A
 * key can be rotated while Team is running, by `nlteam key rotate` in another
 * terminal, and the tokens signed by the new one are valid from the moment it
 * exists.
 */
async function identify(
  context: AuthorizationContext,
  call: GrpcCall,
  targetUserToken: string | undefined,
): Promise<CallerIdentification> {
  const token = targetUserToken ?? bearerToken(call.authorization);
  const identification = identifyToken(context.database, context.keys, context.config, token);
  if (identification.kind === "refused" && identification.reason === "unknown-key") {
    await context.keys.reload();
    return identifyToken(context.database, context.keys, context.config, token);
  }
  return identification;
}

/** `UrcAuthApi/CheckUserPermission`: which of these may the caller reach? */
async function checkUserPermission(
  context: AuthorizationContext,
  call: GrpcCall,
): Promise<Buffer> {
  const request = decodeCheckUserPermissionRequest(call.message);
  const caller = await identify(context, call, request.targetUser?.userToken);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    const asked = request.resourceIds[0];
    // One line for the call, including one that named no resource at all, so
    // that a refusal is never a gap in the log and never more than a line of it.
    decided(
      context,
      `auth: check ${UNIDENTIFIED} ${
        asked === undefined
          ? "for nothing"
          : request.resourceIds.length === 1
            ? forLog(asked)
            : `for ${request.resourceIds.length} resources`
      }: refused, ${because}`,
      {
        username: UNIDENTIFIED_ACCOUNT,
        resource: refusedResource(context, request.resourceIds),
        allowed: false,
        detail: because,
      },
    );
    // An empty allow list, not a gRPC failure. A refusal is an answer to the
    // question loreserver asked, and it turns into "not found" for the client
    // either way; failing the call would make an expired token look like a
    // broken authorization service.
    return encodeCheckUserPermissionResponse({ allowed: [], denied: [] });
  }

  const allowed: ResourcePermission[] = [];
  const denied: ResourcePermission[] = [];
  for (const resourceId of request.resourceIds) {
    // Two questions, and only two: is this a project this server holds, and is
    // the caller an account of this server. `identify` already answered the
    // second — a disabled account or a stale token never reaches here.
    const projectId = projectIdFromResourceId(resourceId);
    const project = projectId === undefined ? undefined : findProject(context.database, projectId);
    if (project === undefined) {
      denied.push({ resourceId, permission: [] });
      const why = "not a project on this server";
      decided(context, `auth: check ${caller.user.username} ${forLog(resourceId)}: denied, ${why}`, {
        username: caller.user.username,
        resource: resourceName(context, resourceId),
        allowed: false,
        detail: why,
      });
      continue;
    }
    // The id is echoed exactly as it was asked about, not rebuilt from the
    // project: loreserver compares the two strings, and a rebuilt one that
    // differed in any character would read as an answer about something else.
    allowed.push({ resourceId, permission: [...PROJECT_PERMISSIONS] });
    decided(context, `auth: check ${caller.user.username} ${forLog(resourceId)}: allowed`, {
      username: caller.user.username,
      resource: resourceName(context, resourceId),
      allowed: true,
      detail: "account of this server",
    });
  }

  return encodeCheckUserPermissionResponse({ allowed, denied });
}

/** `UrcAuthApi/LookupUserPermissions`: everything the caller may reach. */
async function lookupUserPermissions(
  context: AuthorizationContext,
  call: GrpcCall,
): Promise<Buffer> {
  const request = decodeLookupUserPermissionsRequest(call.message);
  const caller = await identify(context, call, undefined);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(context, `auth: lookup ${UNIDENTIFIED}: refused, ${because}`, {
      username: UNIDENTIFIED_ACCOUNT,
      resource: LISTING,
      allowed: false,
      detail: because,
    });
    return encodeLookupUserPermissionsResponse({ permissions: [] });
  }

  // The filter is honoured only when it names one resource outright. Team has
  // one kind of resource — a project — so a filter that is anything else, a
  // wildcard or a category name, would be a pattern language guessed at rather
  // than agreed, and guessing wrong here silently shortens somebody's listing.
  const only = projectIdFromResourceId(request.resourceFilter);
  const reachable = listProjects(context.database).filter(
    (project) => only === undefined || project.id === only,
  );

  decided(
    context,
    `auth: lookup ${caller.user.username}: ${reachable.length} project(s)${
      only === undefined ? "" : ` matching ${forLog(request.resourceFilter)}`
    }`,
    {
      username: caller.user.username,
      resource: LISTING,
      allowed: true,
      detail: `${reachable.length} project(s)`,
    },
  );

  // Every project in one reply. Paging exists in the protocol and is not used:
  // the page a caller would be asked to come back for is a handful of rows out
  // of one local database.
  return encodeLookupUserPermissionsResponse({
    permissions: reachable.map((project) => ({
      resourceId: resourceIdOf(project.id),
      permission: [...PROJECT_PERMISSIONS],
    })),
  });
}

/**
 * `UrcAuthApi/ExchangeExternalTokenForUserToken`: signing in.
 *
 * This is the one method a Studio installation calls before it can do anything
 * else, and the reason the TLS listener exists at all. What a client presents
 * is a token this Team server minted — `nlteam token mint`, which is what a person is
 * given after proving who they are with their password — and what it gets back
 * is a fresh one.
 *
 * Minting rather than echoing is the whole point of the exchange. The presented
 * token is proof of identity and nothing more; the token that comes back is
 * issued now, so it carries the account's `token_epoch` as it stands now, and
 * an account that has been disabled or had its access revoked in the meantime
 * gets nothing. Echoing would turn a token with a lifetime into one that
 * renews itself for ever.
 *
 * A refusal is a gRPC status, not a success carrying no token. A client reading
 * an empty `user_token` on an OK reply has no way to tell a refusal from a
 * server that has lost its keys.
 */
function exchangeExternalToken(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeExchangeExternalTokenForUserTokenRequest(call.message);
  // The token is taken from the request, not from the `authorization` header:
  // a client signing in has nothing to put in that header yet, and the field is
  // where its library puts what it was given. `token_type` is passed through by
  // the client and read by nobody; Team knows only one kind of token.
  const presented = request.externalToken === "" ? undefined : request.externalToken;
  const caller = identifyToken(context.database, context.keys, context.config, presented);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(context, `auth: exchange ${UNIDENTIFIED}: refused, ${because}`, {
      username: UNIDENTIFIED_ACCOUNT,
      resource: SIGN_IN,
      allowed: false,
      detail: because,
    });
    // One status and one sentence for every refusal, unlike the permission
    // calls: this is the sign-in path, and the caller is whoever reached the
    // endpoint. Saying which check failed would say whether an account exists.
    throw new GrpcStatusError(
      GRPC_UNAUTHENTICATED,
      "the token presented for exchange was not accepted",
    );
  }

  // Every project this account may reach, named in the token.
  //
  // A client opens its data connection and authorizes it with this token,
  // before it has asked for anything narrower — and loreserver refuses a token
  // that reaches `StorageAuthorizeTask` with no `resources` claim, having
  // decoded it perfectly well. A sign-in token with no resources therefore
  // signs in, resolves a repository, and then cannot read a byte of it.
  const reachable = listProjects(context.database).map((project) => ({
    resource_id: resourceIdOf(project.id),
    permission: [...PROJECT_PERMISSIONS],
  }));

  // The sign-in lifetime, which is the long one. This token comes back here to
  // be exchanged and is asked about again on every repository access, so
  // revoking an account's tokens refuses it without waiting for it to expire.
  const minted = mintToken(caller.user, context.keys.signingKey, mintingConfig(context), {
    purpose: "sign-in",
    resources: reachable,
  });
  decided(
    context,
    `auth: exchange ${caller.user.username}: issued a token for ${reachable.length} ` +
      `project(s) until ${new Date(minted.claims.exp * 1000).toISOString()}`,
    {
      username: caller.user.username,
      resource: SIGN_IN,
      allowed: true,
      detail: `a token for ${reachable.length} project(s)`,
    },
  );

  return encodeExchangeExternalTokenForUserTokenResponse({
    userToken: {
      userToken: minted.token,
      expiresAt: minted.claims.exp,
      // The account's id, which is also the token's `sub`. A client requires a
      // caller's configured identity to equal this, so it is what a Studio
      // installation has to be told about itself.
      userId: caller.user.id,
      userName: caller.user.displayName,
    },
  });
}

/**
 * `UrcAuthApi/ExchangeUserTokenForMultiresourceToken`: a token for the data
 * connection.
 *
 * Signing in is not enough to open a repository. Before a client touches a
 * repository's data it exchanges the user token it holds for one scoped to the
 * resources it is about to use, and it presents that token on the QUIC storage
 * connection rather than the one it signed in with. Without this method the
 * sequence gets remarkably far and then stops: the client signs in, resolves
 * the repository over gRPC — which Team allows, and logs as allowed — and then
 * fails with "Not connected to remote: Not authorized to access repository",
 * while loreserver records `MissingToken` against a `StorageAuthorizeTask`.
 * Nothing in either message says a method is missing.
 *
 * Team answers by checking every resource the client named and minting a fresh
 * token, because a token minted now carries the account's state now. The scope
 * is not written into the token: loreserver goes on asking
 * {@link checkUserPermission} about every access, so a token that named
 * resources it should not would still be refused at the point of use. What this
 * call adds is that a caller with no grant is stopped here, before any data
 * connection is opened at all.
 */
function exchangeMultiresourceToken(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeExchangeUserTokenForMultiresourceTokenRequest(call.message);
  const caller = identifyToken(
    context.database,
    context.keys,
    context.config,
    bearerToken(call.authorization),
  );

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(
      context,
      `auth: multiresource ${UNIDENTIFIED} for ${request.resourceIds.length} resource(s): ` +
        `refused, ${because}`,
      {
        username: UNIDENTIFIED_ACCOUNT,
        resource: DATA_CONNECTION,
        allowed: false,
        detail: because,
      },
    );
    throw new GrpcStatusError(
      GRPC_UNAUTHENTICATED,
      "the token presented for exchange was not accepted",
    );
  }

  // Every resource, not merely one of them: the token being asked for covers
  // all of them at once, and handing one out for a set that includes something
  // the caller may not have would be handing out the wrong thing.
  const granted: ResourceClaim[] = [];
  for (const resourceId of request.resourceIds) {
    const projectId = projectIdFromResourceId(resourceId);
    const project = projectId === undefined ? undefined : findProject(context.database, projectId);
    if (project === undefined) {
      const why = "not a project on this server";
      decided(
        context,
        `auth: multiresource ${caller.user.username} ${forLog(resourceId)}: denied, ${why}`,
        {
          username: caller.user.username,
          resource: resourceName(context, resourceId),
          allowed: false,
          detail: why,
        },
      );
      // PERMISSION_DENIED rather than an empty answer: the caller is identified,
      // and the question was whether this account may have this project. A
      // reply carrying no token would reach the person as a client that could
      // not find its own credentials.
      throw new GrpcStatusError(
        GRPC_PERMISSION_DENIED,
        "one of the resources asked for is not a project on this server",
      );
    }
    // The id is echoed exactly as it was asked about, for the reason
    // checkUserPermission echoes it: the comparison downstream is on the string.
    granted.push({ resource_id: resourceId, permission: [...PROJECT_PERMISSIONS] });
    decided(
      context,
      `auth: multiresource ${caller.user.username} ${forLog(resourceId)}: allowed`,
      {
        username: caller.user.username,
        resource: resourceName(context, resourceId),
        allowed: true,
        detail: "account of this server",
      },
    );
  }

  // The resources are named in the token itself. This is what makes it a
  // multiresource token rather than another user token, and it is what the
  // storage connection reads.
  // The repository lifetime, which is the short one, and this is the call that
  // makes the pair worth having. What is minted here is presented on the data
  // connection, to loreserver's data plane, and Team is not necessarily asked
  // about it again — so the expiry is the only thing that ends it.
  const minted = mintToken(caller.user, context.keys.signingKey, mintingConfig(context), {
    purpose: "repository",
    resources: granted,
  });
  return encodeExchangeUserTokenForMultiresourceTokenResponse({
    token: {
      userToken: minted.token,
      expiresAt: minted.claims.exp,
      userId: caller.user.id,
      userName: caller.user.displayName,
    },
  });
}

/**
 * `RebacApi/CreateResource`: loreserver saying a repository now exists.
 *
 * Usually this is a second telling of something Team caused: `nlteam project
 * create` recorded the project and then asked for the repository, so the row is
 * already there and there is nothing to do but say so.
 *
 * A repository Team has never heard of is a different matter, and it used to be
 * let be — which left it unreachable for ever. Nothing on this server reaches a
 * repository that is not one of its projects, so a repository with no row is
 * one nobody can open, including whoever just made it. loreserver forwards the
 * caller's own `authorization` header on this call, so there is somebody to
 * record it against, and it is recorded.
 *
 * The call is answered with OK whatever happens here. The repository exists by
 * the time this arrives; failing the call would report a creation that did
 * happen as one that failed, and would still leave the row unwritten.
 */
async function createResource(
  context: AuthorizationContext,
  call: GrpcCall,
): Promise<Buffer> {
  const request = decodeCreateResourceRequest(call.message);
  const projectId = projectIdFromResourceId(request.resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);
  // Both of these are whatever loreserver was told by whoever asked it for the
  // repository, so both are rendered once here and used from there.
  const about = `auth: create resource ${forLog(request.resourceId)} ` +
    `"${forLog(request.resourceName)}"`;

  if (project !== undefined) {
    context.log(`${about}: the project ${project.name}`);
    return EMPTY_MESSAGE;
  }
  if (projectId === undefined) {
    context.log(`${about}: not a resource id this server can read`);
    return EMPTY_MESSAGE;
  }

  const caller = await identify(context, call, undefined);
  if (caller.kind !== "identified") {
    context.log(`${about}: not recorded, ${describeRefusal(caller.reason)}`);
    return EMPTY_MESSAGE;
  }

  try {
    const recorded = createProject(context.database, {
      id: projectId,
      name: availableProjectName(context, request.resourceName, projectId),
      createdBy: caller.user.id,
    });
    context.log(`${about}: recorded as ${recorded.name}, made by ${caller.user.username}`);
  } catch (error) {
    // Said rather than thrown. A repository that exists and has no row is worth
    // a person looking at, and the line is the only place they would see it.
    //
    // The sentence is escaped as the name is: a name this server would not
    // accept is refused by quoting it, so what comes back here carries the text
    // that arrived.
    context.log(
      `${about}: not recorded, ` +
        `${forLog(error instanceof Error ? error.message : String(error))}`,
    );
  }
  return EMPTY_MESSAGE;
}

/**
 * A name for a repository Team is adopting, which this server does not already
 * hold and which its own rules accept.
 *
 * The name loreserver reports is the one somebody chose, so it is tried first.
 * A name already taken here, or one this server would not accept, falls back to
 * the repository id — which is unique, is what every log line shows anyway, and
 * is honest about being a name nobody chose.
 */
function availableProjectName(
  context: AuthorizationContext,
  reported: string,
  projectId: string,
): string {
  const trimmed = reported.trim();
  if (trimmed !== "" && findProject(context.database, trimmed) === undefined) {
    return trimmed;
  }
  return projectId;
}

/**
 * `RebacApi/DeleteResource`: loreserver saying a repository is gone.
 *
 * One thing decides it: whether there is an account behind the call. An
 * identified caller forgets the project, and an unidentified one does not.
 * There is no narrower question to ask, because every account of this server
 * reaches every project on it — `projects.forget` says the same in as many
 * words and has no role check either — so asking who made the project, or
 * whether they still have it, would be inventing an authority this server does
 * not have anywhere else.
 *
 * What identification buys is that the row only ever goes on somebody's behalf.
 * Of the two ways to be wrong, the stale row is the safer: a project this
 * server holds a row for and loreserver has no repository for denies nobody
 * anything and is one command to take off, while a row dropped on a call from
 * nobody at all would take away everybody's access to a repository that may
 * still be there.
 *
 * A project that goes this way is as gone as one somebody forgot over the
 * protocol, so the same two things follow it: the disappearance is said out
 * loud through {@link AuthorizationContext.forgotten}, and the reading this
 * server held of the repository goes with it. Neither is reached for from
 * here — see that callback for why.
 *
 * Either way the call is answered with OK. The repository is already gone by
 * the time this arrives, and failing the call would only make loreserver report
 * a delete that did happen as a delete that failed.
 */
async function deleteResource(context: AuthorizationContext, call: GrpcCall): Promise<Buffer> {
  const request = decodeDeleteResourceRequest(call.message);
  const projectId = projectIdFromResourceId(request.resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);
  const caller = await identify(context, call, undefined);
  const who = caller.kind === "identified" ? caller.user.username : UNIDENTIFIED;
  // The id as it arrived, and the only part of this line that did.
  const asked = forLog(request.resourceId);

  if (project === undefined) {
    context.log(`auth: delete resource ${who} ${asked}: no project of this Team server`);
    return EMPTY_MESSAGE;
  }
  if (caller.kind !== "identified") {
    const why = describeRefusal(caller.reason);
    decided(context, `auth: delete resource ${who} ${asked}: kept, ${why}`, {
      username: UNIDENTIFIED_ACCOUNT,
      resource: project.name,
      allowed: false,
      detail: `kept, ${why}`,
    });
    return EMPTY_MESSAGE;
  }

  forgetProject(context.database, project.id);
  // Recorded after the project row is gone, and holding the name rather than a
  // reference to it: this is the one decision whose subject no longer exists by
  // the time anybody reads about it.
  decided(
    context,
    `auth: delete resource ${who} ${asked}: forgot the project ${project.name}`,
    {
      username: who,
      resource: project.name,
      allowed: true,
      detail: "forgot the project",
    },
  );
  // Last, so that nothing hears about a project going before it has gone.
  context.forgotten?.(project.id);
  return EMPTY_MESSAGE;
}

/**
 * The methods this service answers, by path.
 *
 * Everything else in `UrcAuthApi` — sessions, API keys, user metadata — is
 * absent on purpose, and the server answers `UNIMPLEMENTED` for it. An empty
 * reply would be indistinguishable from a real answer meaning "no permissions",
 * and a caller would act on it.
 *
 * The same methods are served on both listeners. loreserver reaches the
 * plaintext one over the loopback and a client reaches the TLS one; neither is
 * given anything the other is not, because the decision every method makes is
 * about the token presented, not about where the connection came from.
 */
export function authorizationMethods(
  context: AuthorizationContext,
): Readonly<Record<string, GrpcMethod>> {
  return {
    [METHOD_CHECK_USER_PERMISSION]: (call) => checkUserPermission(context, call),
    [METHOD_LOOKUP_USER_PERMISSIONS]: (call) => lookupUserPermissions(context, call),
    [METHOD_EXCHANGE_EXTERNAL_TOKEN]: (call) => exchangeExternalToken(context, call),
    [METHOD_EXCHANGE_MULTIRESOURCE_TOKEN]: (call) => exchangeMultiresourceToken(context, call),
    [METHOD_CREATE_RESOURCE]: (call) => createResource(context, call),
    [METHOD_DELETE_RESOURCE]: (call) => deleteResource(context, call),
    // Answered because it is part of the service loreserver was pointed at, and
    // a health check that fails is a service that looks down.
    [METHOD_HEALTH_CHECK]: () => encodeHealthCheckResponse("SERVING"),
  };
}

/** What the service needs beyond its context. */
export interface AuthorizationServiceOptions extends AuthorizationContext {
  readonly port: number;
  /** Interface to listen on; the loopback by default. */
  readonly host?: string;
  /** True to listen on every interface rather than the loopback. */
  readonly anyInterface?: boolean;
  /** The certificate and key for a TLS listener; absent for a plaintext one. */
  readonly tls?: { readonly cert: string; readonly key: string };
  /** Answer HTTP/1.1 on this listener too - the discovery document, and only it. */
  readonly http1?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Take an HTTP/1.1 upgrade on this listener - the Team protocol's socket. */
  readonly upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The option that moves this listener, for the message if it cannot start. */
  readonly portOption?: string;
  /** Called for a failure that belongs to no call. */
  readonly onError?: (error: Error) => void;
}

/** Start the authorization service. */
export async function startAuthorizationService(
  options: AuthorizationServiceOptions,
): Promise<GrpcServer> {
  return await GrpcServer.start({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.anyInterface === undefined ? {} : { anyInterface: options.anyInterface }),
    methods: authorizationMethods(options),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.http1 === undefined ? {} : { http1: options.http1 }),
    ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
    ...(options.portOption === undefined ? {} : { portOption: options.portOption }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
