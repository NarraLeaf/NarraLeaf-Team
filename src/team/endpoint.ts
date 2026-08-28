/**
 * Where a session begins: the `upgrade` half of the listener everything else is on.
 *
 * The discovery document, the Studio REST API and this are one port and one
 * certificate. That is not thrift, it is the trust story:
 * an operator compares a fingerprint once, and every conversation a Studio
 * installation has with this server arrives over the connection whose
 * certificate was compared. A second port would be a second such conversation,
 * and one nobody would have.
 *
 * ⚠ Measured rather than assumed: the listener is an HTTP/2 secure server with
 * `allowHTTP1`, and a connection whose ALPN settles on `http/1.1` does reach its
 * `upgrade` event. That is what makes the paragraph above true rather than a
 * plan.
 *
 * **A refusal here is an HTTP status, not a close code.** The socket is still
 * speaking HTTP when this decides, and a 401 with a sentence is something a
 * client can show a person. A 101 followed immediately by a close frame is a
 * client that connected and then did not, which is the hardest kind of failure
 * to report.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { bearerToken, describeRefusal, identifyToken } from "../identity/bearer.js";
import { storedServerName } from "../identity/settings.js";
import type { TeamService } from "./service.js";
import { TeamHub } from "./hub.js";
import {
  assertProtocolConsistency,
  methodTable,
  serverCapabilities,
  type TeamMethod,
} from "./methods.js";
import { adminMethods } from "./methods/admin.js";
import { clientMethods } from "./methods/clients.js";
import { commentMethods } from "./methods/comments.js";
import { liveMethods } from "./methods/live.js";
import { overlayMethods } from "./methods/overlay.js";
import { projectMethods } from "./methods/projects.js";
import { TeamPresence } from "./presence.js";
import {
  ANSWER_BYTES_LIMIT,
  TEAM_HEARTBEAT_MS,
  TEAM_SOCKET_PATH,
  type TeamCapability,
} from "./protocol.js";
import { TeamSession } from "./session.js";
import { completeUpgrade, isWebSocketUpgrade, refuseUpgrade } from "./websocket.js";

/**
 * The most one message may be.
 *
 * A suggestion is the largest thing a client sends, and this is comfortably
 * above it with room for the frame around it. Anything beyond is somebody using
 * a comment as a file store, and the answer is a close rather than a row.
 */
const MAXIMUM_MESSAGE_BYTES = 128 * 1024;

/**
 * The most one session may have waiting to go out to it.
 *
 * The ceiling above is about one message; this is about however many of them a
 * peer has stopped reading. A client that subscribes to a busy topic and then
 * does not drain its socket would otherwise have this server hold frames for it
 * for as long as the connection stayed open. Delivery here is weak on purpose,
 * so the answer is the one the protocol already gives for a subscriber that
 * cannot keep up: it is dropped, and it reconnects and reads the collection
 * again.
 *
 * Four times ANSWER_BYTES_LIMIT, which is the largest answer a method here
 * composes. It has to be at least one whole answer, or a session would be ended
 * for being sent one; the three above that are the frames that queue behind a
 * large answer while somebody on a slow link drains it. Derived rather than
 * chosen, so that raising what a page may weigh raises this with it instead of
 * quietly eating into the margin.
 *
 * What it bounds is frames piling up behind a peer that is not reading them, at
 * a figure a deployment can afford once per session rather than at whatever a
 * socket left open reaches.
 */
export const MAXIMUM_BUFFERED_BYTES = 4 * ANSWER_BYTES_LIMIT;

export interface TeamSocketOptions {
  /** The same service the REST API answers from: one database, one reader, one log. */
  readonly service: TeamService;
  /** This build's version, for the opening frame. */
  readonly version: string;
  /** What this server is called until somebody names it. */
  readonly host: string;
}

/**
 * The socket endpoint, and the handle to what is connected to it.
 *
 * The hub is returned rather than kept private because the things that publish
 * are outside this file: the project reader announces what it has read, and the
 * process announces that it is stopping.
 */
export interface TeamSocket {
  readonly hub: TeamHub;
  /**
   * What this deployment announces, asked rather than settled.
   *
   * A function because part of the answer is a stored setting: a deployment
   * closed to collaboration announces no coordination plane, and an operator
   * closes one over ssh. Handed to whoever writes the discovery document and to
   * every session that opens, so both come from the same source and a client
   * cannot be told one thing before it connects and another after.
   */
  readonly capabilities: () => readonly TeamCapability[];
  /**
   * Who is connected and what each has open.
   *
   * Returned for the same reason the hub is: something outside this file needs
   * it. The blob addresses (src/web/blobs.ts) admit a request from an
   * installation this server currently knows to have that project open, and
   * that fact lives here rather than in the database.
   */
  readonly presence: TeamPresence;
  /**
   * Take one upgrade request, and say whether it was ours.
   *
   * False means the path was not this endpoint's, so whoever is listening may go
   * on to its own arms. Everything at this path is answered here, refusals
   * included.
   */
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

/** Every method this build serves. */
export function teamMethods(): readonly TeamMethod[] {
  return [
    ...projectMethods(),
    ...commentMethods(),
    ...clientMethods(),
    ...liveMethods(),
    ...overlayMethods(),
    ...adminMethods(),
  ];
}

export function createTeamSocket(options: TeamSocketOptions): TeamSocket {
  const methods = methodTable(teamMethods());
  // At startup, before a single call is answered: the registered handlers, the
  // declared method names and the published contract have to be one set. A build
  // where they differ would advertise what it cannot answer, so it refuses to
  // start rather than serve that.
  assertProtocolConsistency(methods);
  // The one answer the discovery document and the hello frame both carry,
  // worked out from what this build serves rather than written down twice - and
  // worked out afresh each time one of them is written, because part of it is a
  // stored setting. A list settled here would announce a coordination plane an
  // operator closed an hour ago until somebody restarted the process, which is
  // the same reason the server's own name is read per request.
  const capabilities = (): readonly TeamCapability[] =>
    serverCapabilities(methods, options.service);
  const hub = new TeamHub();
  // Given two of the hub's methods rather than the hub itself, because what
  // presence needs is a way to reach whoever is listening and a way to say that
  // a topic has stopped addressing anything. The one-way dependency is what
  // keeps a room from being able to end a session or count them.
  const presence = new TeamPresence(
    (topic, payload) => {
      hub.publish(topic, payload);
    },
    (topic) => {
      hub.forget(topic);
    },
  );

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const path = new URL(request.url ?? "/", "http://team.invalid").pathname;
    if (path !== TEAM_SOCKET_PATH) {
      return false;
    }
    if (!isWebSocketUpgrade(request)) {
      refuseUpgrade(socket, 400, "that is not a WebSocket handshake this server speaks");
      return true;
    }

    const header = request.headers["authorization"];
    const token = bearerToken(Array.isArray(header) ? header[0] : header);
    const identified = identifyToken(
      options.service.database,
      options.service.keys,
      options.service.config,
      token,
    );
    if (identified.kind === "refused") {
      refuseUpgrade(socket, 401, describeRefusal(identified.reason));
      return true;
    }

    // Read as the session opens rather than when this server started, for the
    // same reason the discovery document reads it per request: a name somebody
    // changes over ssh should reach the next connection, not the next restart.
    const serverName = storedServerName(options.service.database, options.host);

    let session: TeamSession | undefined;
    const connection = completeUpgrade(request, socket, head, {
      maximumMessageBytes: MAXIMUM_MESSAGE_BYTES,
      maximumBufferedBytes: MAXIMUM_BUFFERED_BYTES,
      heartbeatMs: TEAM_HEARTBEAT_MS,
      onMessage: (text) => {
        session?.receive(text);
      },
      onClose: () => {
        session?.closed();
      },
    });

    session = new TeamSession({
      connection,
      hub,
      service: options.service,
      methods,
      presence,
      token: token as string,
      user: identified.user,
      serverName,
      version: options.version,
      capabilities,
    });
    options.service.log?.(
      `team: ${identified.user.username} opened a session (${hub.size} open)`,
    );
    return true;
  };

  return { hub, capabilities, presence, handleUpgrade };
}
