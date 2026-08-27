/**
 * What a server answers about itself, before anybody has an account on it.
 *
 * **One address is the whole of what an author is given.** `nlteam://host:port` names
 * this endpoint, and reading this document is what turns it into everything else: where
 * to sign in, whether signing in is required at all, and which data remote the projects
 * live on. Studio never asks a person for a `lore://` address and never shows one - that
 * is a detail of the storage this server happens to run, and naming it in an interface
 * would make it something people learn and type.
 *
 * It is served on the TLS listener the auth endpoint already uses, over HTTP/1.1 while
 * gRPC continues on h2. One listener, one certificate, and therefore one decision to
 * trust: the document that says where to sign in arrives over the same connection whose
 * certificate the author has been asked about, rather than over a second one nobody
 * looked at.
 *
 * Nothing here is secret. It is what the operator would otherwise have written in a chat
 * message, and every field of it is checkable against the token that arrives later.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { TEAM_PROTOCOL_VERSION } from "@narraleaf/team-protocol";

import { storedPublishLineage, storedServerName, type PublishLineageRule } from "./settings.js";

/** The path this document is served at, and the only path the HTTP/1.1 side answers. */
export const DISCOVERY_PATH = "/.well-known/nlteam";

/**
 * The shape of the document.
 *
 * `protocol` is a number rather than a range so that a client can say "this server speaks
 * something I do not" in one comparison. It changes only when a field an older client
 * relies on stops meaning what it meant, and it is the same number the opening `hello`
 * frame carries - both are {@link TEAM_PROTOCOL_VERSION}, so a client cannot be told one
 * thing here and another over the socket.
 */
export interface DiscoveryDocument {
  readonly protocol: number;
  /**
   * What this deployment calls itself, for a list of servers a person reads.
   *
   * The name an operator chose, and this server's own host until one of them
   * does. It is worked out as each request is answered — see
   * {@link discoveryDocument} — rather than settled when the process started,
   * because Studio shows it in place of `host:port` and a name that took a
   * restart to appear would be a name nobody dared change.
   */
  readonly name: string;
  readonly auth: {
    /**
     * Whether a token is needed to reach the projects.
     *
     * False for a server whose loreserver was configured without identity: it accepts
     * anyone who can reach it, and asking its authors for a token would be asking for
     * something nobody can issue.
     */
    readonly required: boolean;
    /** Where a token is presented, e.g. `https://team.example.lan:41402`. */
    readonly url: string;
  };
  readonly data: {
    /** The remote the repositories live on. Studio stores it and shows it to nobody. */
    readonly url: string;
  };
  /**
   * What this build of Team serves a Studio installation, by name.
   *
   * Additive, and it does not move `protocol`. An older client that has never
   * heard of this field ignores it and asks for what it has always asked for,
   * which is the behaviour wanted: `protocol` says what an old client can no
   * longer rely on, and nothing here takes anything away.
   *
   * A newer client matches these strings literally and asks for nothing it did
   * not find one for, so a capability added to a later Team is one Studio waits
   * to see rather than one it has to discover by getting a 404. The list is
   * built from what this build actually serves - the socket capabilities derived
   * from the registered methods, and the two the HTTP routes add - and it is the
   * same list the opening `hello` frame carries, so a client cannot be told one
   * thing here and another over the socket.
   */
  readonly capabilities: readonly string[];
  readonly authority: {
    /**
     * SHA-256 of the authority this endpoint's certificate chains to.
     *
     * Present so that a client which has already trusted this server can tell, before
     * anything else happens, that the machine answering is the one it trusted. It proves
     * nothing on its own - it arrives over the connection it describes - and the interface
     * treats it as a label rather than as evidence.
     */
    readonly sha256: string;
  };
  /** The server's own version, for a support conversation rather than for a decision. */
  readonly version: string;
  /**
   * What this deployment asks of the clients that use it.
   *
   * ⚠ **Stated, not enforced, and the distinction is the whole of why it is here
   * rather than checked on a call.** What these govern is what an author's own
   * machine does with its own repository - which nothing on this server can reach,
   * and which no request has to pass through. An operator sets them so that every
   * Studio on the deployment behaves one way; a Studio that ignored them would
   * only be misusing its own disk.
   *
   * Additive by design: a client that does not know a rule ignores it and behaves
   * as it did, so a rule added here is not a protocol change.
   */
  readonly policy: {
    /** What to do with a repository this server already holds. See `settings.ts`. */
    readonly publishLineage: PublishLineageRule;
  };
}

/**
 * Everything the document is composed from, as it stands when one is asked for.
 *
 * Everything here but the name is settled when `up` starts: the ports, the
 * fingerprint, the version, and what this build serves. The name is not, which
 * is the whole reason this is a source rather than a finished document — it is
 * a setting, and a setting somebody changes over ssh has to reach the next
 * request rather than the next restart.
 */
export interface DiscoverySource {
  /** Where the chosen name is read from, on each request. */
  readonly database: DatabaseSync;
  /** The host this server is reached at, which names it until somebody does. */
  readonly host: string;
  readonly auth: DiscoveryDocument["auth"];
  readonly data: DiscoveryDocument["data"];
  readonly capabilities: readonly string[];
  readonly authority: DiscoveryDocument["authority"];
  readonly version: string;
}

/** The document as it stands now, name and all. */
export function discoveryDocument(source: DiscoverySource): DiscoveryDocument {
  return {
    protocol: TEAM_PROTOCOL_VERSION,
    name: storedServerName(source.database, source.host),
    // Read as the answer is composed, for the name's reason: a rule changed over
    // ssh has to reach the next request rather than the next restart.
    policy: { publishLineage: storedPublishLineage(source.database) },
    auth: source.auth,
    data: source.data,
    capabilities: source.capabilities,
    authority: source.authority,
    version: source.version,
  };
}

/**
 * Answer the discovery request, and nothing else.
 *
 * Every other path is a 404 rather than a redirect or an index: this listener exists to
 * speak gRPC, and the few things it serves over HTTP/1.1 are named exceptions rather than
 * the start of a site.
 */
export function serveDiscovery(
  document: DiscoveryDocument,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const path = new URL(request.url ?? "/", "http://team.invalid").pathname;
  if (path !== DISCOVERY_PATH) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("method not allowed\n");
    return;
  }

  const body = `${JSON.stringify(document, null, 2)}\n`;
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Read once, at the moment somebody types an address. A cached copy would answer for
    // a deployment that has since moved its data port.
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}
