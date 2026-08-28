/**
 * What a session may be asked to do, as one table.
 *
 * A method is a name, a capability it belongs to, and a function of the
 * parameters and who is calling. Nothing else: no route, no status code, no
 * header. That is the point of the table, and it is why adding a verb to this
 * protocol costs a file here and a caller in Studio.
 *
 * The capability a method belongs to is what the discovery document announces,
 * and it is worked out from this table rather than written beside it - see
 * {@link capabilitiesOf}. A build that cannot serve something leaves the module
 * out, and both the method and the capability disappear together. A capability
 * that is announced while its method is missing is the one failure mode a client
 * cannot recover from, because checking before asking is the whole of what a
 * capability is for.
 */
import type { UserRecord } from "../identity/users.js";
import { collaborationOpen, withoutCoordination } from "./collaboration.js";
import { serviceCapabilities, type TeamService } from "./service.js";
import type { TeamPresence } from "./presence.js";
import { CONTRACT, TEAM_METHODS } from "./protocol.js";
import type { TeamAccount, TeamCapability, TeamClientInstance, TeamErrorCode } from "./protocol.js";

/**
 * A refusal a method raises, and the one thing a handler ever throws on purpose.
 *
 * Anything else that comes out of a handler is a fault rather than an answer,
 * and is reported as `internal` with its message kept off the wire - see
 * src/team/session.ts. So the distinction here is not tidiness: it is which
 * failures a client is told the truth about.
 */
export class MethodError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MethodError";
  }
}

/** Everything a handler is given. */
export interface MethodContext {
  /** The service this session belongs to: the database, the keys, the reader. */
  readonly options: TeamService;
  /** Who is calling, freshly identified for this call rather than at sign-in. */
  readonly user: UserRecord;
  /** The same person, in the shape the protocol carries. */
  readonly account: TeamAccount;
  /**
   * Tell everybody listening to a topic that something happened.
   *
   * Handed to the handler rather than reached for, so that a method cannot
   * publish to a server other than its own and so that a test can watch what a
   * handler announces without a socket.
   */
  readonly publish: (topic: string, payload: unknown) => void;
  /**
   * The link session this call arrived on, by id.
   *
   * Here because a handful of methods are about the caller's own connection
   * rather than about a row: saying which installation is on the other end, and
   * everything that follows from it. See {@link callingInstance}.
   */
  readonly connection: { readonly id: string };
  /** Who is connected and which live sessions are open. See src/team/presence.ts. */
  readonly presence: TeamPresence;
}

/**
 * Which installation is calling about one project, refusing if it never said.
 *
 * Resolved by project rather than named in the parameters: one link session
 * carries an instance per window, a window is a project, and the client composes
 * its instance ids out of exactly that - so naming one would be the caller
 * repeating itself. Every method that needs an instance is about a project
 * already, which is what makes this always answerable.
 *
 * Announcing is one call and a client makes it as soon as it opens a project, so
 * a caller reaching one of these without having announced skipped a step rather
 * than being old - an older client has no idea these methods exist. The refusal
 * names the remedy.
 */
export function callingInstance(context: MethodContext, project: string): TeamClientInstance {
  const instance = context.presence.instanceOn(context.connection.id, project);
  if (instance === undefined) {
    throw new MethodError(
      "refused",
      "this session has not said which installation has that project open; call clients.announce first",
    );
  }
  return instance;
}

/** One thing a session can be asked for. */
export interface TeamMethod {
  readonly name: string;
  /** Which capability this method is announced under. */
  readonly capability: TeamCapability;
  readonly handle: (params: unknown, context: MethodContext) => Promise<unknown> | unknown;
}

/**
 * The methods, by name, with a duplicate treated as a mistake rather than a
 * later definition winning.
 */
export function methodTable(methods: readonly TeamMethod[]): ReadonlyMap<string, TeamMethod> {
  const table = new Map<string, TeamMethod>();
  for (const method of methods) {
    if (table.has(method.name)) {
      throw new Error(`two methods are both called ${method.name}`);
    }
    table.set(method.name, method);
  }
  return table;
}

/**
 * What a table of methods amounts to, as capability names.
 *
 * `session` is always among them: a server answering this at all is a server
 * that has the socket, and a client with no way to say so would have to open one
 * to find out.
 */
export function capabilitiesOf(table: ReadonlyMap<string, TeamMethod>): TeamCapability[] {
  const capabilities = new Set<TeamCapability>(["session"]);
  for (const method of table.values()) {
    capabilities.add(method.capability);
  }
  return [...capabilities];
}

/**
 * Everything this deployment announces, as one derived list.
 *
 * The discovery document and the opening `hello` frame both carry this, so a
 * client is told the same thing before and after it connects. It is two halves
 * worked out from what the build actually does: the capabilities this table
 * implies, and the ones that turn on what the build was handed rather than on
 * which methods it registered - see {@link serviceCapabilities}. Neither half is
 * written down a second time, so a module left out of the build takes its
 * capability with it.
 *
 * **Then the deployment's own answer is subtracted**, which is why this is
 * called each time a document is written or a session opened rather than once
 * when the process started: a server closed to collaboration announces no
 * coordination plane, and that is a stored setting somebody changes over ssh -
 * see ./collaboration.ts. Reading it is a row from a database this process
 * already holds open, so working the list out afresh costs a query and needs no
 * cache anybody has to remember to invalidate.
 */
export function serverCapabilities(
  table: ReadonlyMap<string, TeamMethod>,
  service: TeamService,
): TeamCapability[] {
  const capabilities = new Set<TeamCapability>(capabilitiesOf(table));
  for (const capability of serviceCapabilities(service)) {
    capabilities.add(capability);
  }
  return [
    ...(collaborationOpen(service.database) ? capabilities : withoutCoordination(capabilities)),
  ];
}

/**
 * Refuse to serve a protocol that does not agree with itself.
 *
 * Called when the server starts, before it answers anything. Three lists have to
 * be the same set: the handlers actually registered, the method names the
 * contract declares, and the methods the published contract carries. A build
 * where they differ would advertise a method it cannot answer, or answer one it
 * did not advertise, and a client that read the list and then called what it
 * found would be refused - the one failure checking before asking exists to
 * prevent. Better to fail loudly at startup than to serve the lie.
 *
 * The capability each method is announced under is checked against the contract's
 * vocabulary too, for the same reason: a word in the discovery document that no
 * client has a definition for is a word that helps nobody.
 */
export function assertProtocolConsistency(table: ReadonlyMap<string, TeamMethod>): void {
  const registered = [...table.keys()].sort();
  const declared = [...Object.values(TEAM_METHODS)].sort();
  const published = [...CONTRACT.methods].sort();
  const differ = (left: readonly string[], right: readonly string[]): boolean =>
    left.length !== right.length || left.some((name, index) => name !== right[index]);
  if (differ(registered, declared) || differ(registered, published)) {
    throw new Error(
      "the Team protocol does not agree with itself: the registered handlers, the declared " +
        "method names and the published contract are not the same set.\n" +
        `  registered: ${registered.join(", ")}\n` +
        `  declared:   ${declared.join(", ")}\n` +
        `  contract:   ${published.join(", ")}`,
    );
  }
  for (const capability of capabilitiesOf(table)) {
    if (!CONTRACT.capabilities.includes(capability)) {
      throw new Error(`the capability ${capability} is served but the contract does not name it`);
    }
  }
}

/* ------------------------------------------------ reading what arrived */

/**
 * The parameters as an object, refusing anything else.
 *
 * Absent parameters are an empty object rather than a refusal: a method that
 * takes nothing should be callable without a body, and every reader below
 * refuses a missing field on its own terms anyway.
 */
export function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) {
    return {};
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new MethodError("bad-params", "the parameters are not an object");
  }
  return params as Record<string, unknown>;
}

/** A string that is there and is not blank. */
export function requiredText(
  params: Record<string, unknown>,
  name: string,
  limit: number,
): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new MethodError("bad-params", `${name} has to be a non-empty string`);
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf-8") > limit) {
    throw new MethodError("bad-params", `${name} is longer than this server stores`);
  }
  return trimmed;
}

/** A string, or nothing, refusing anything that is neither. */
export function optionalText(
  params: Record<string, unknown>,
  name: string,
  limit: number,
  /**
   * What to say instead of this reader's own sentence about the length.
   *
   * Most fields are bounded so that a frame stays a frame, and "longer than this
   * server stores" is the whole of what there is to say about one. A few are
   * bounded because of what they go on to do, and for those the same input
   * reaching the same server by the other road prints a sentence a person can
   * act on — so one rule refusing in two places must not be two sentences.
   */
  because?: string,
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MethodError("bad-params", `${name} has to be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (Buffer.byteLength(trimmed, "utf-8") > limit) {
    throw new MethodError("bad-params", because ?? `${name} is longer than this server stores`);
  }
  return trimmed;
}

/** One of a short list of words, which is how every enumerated field arrives. */
export function oneOf<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = params[name];
  if (value === undefined || value === null) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new MethodError("bad-params", `${name} has to be one of ${allowed.join(", ")}`);
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new MethodError("bad-params", `${name} has to be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** A whole number within bounds, with a default for the request that gave none. */
export function boundedCount(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = params[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MethodError("bad-params", `${name} has to be a whole number of at least one`);
  }
  return Math.min(value, maximum);
}

/** A yes or a no, with a default. */
export function flag(params: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = params[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new MethodError("bad-params", `${name} has to be true or false`);
  }
  return value;
}
