/**
 * A session, from the client's side.
 *
 * One connection, authenticated once, over which methods are called. It is the
 * same session a Studio installation opens, opened the same way and answered by
 * the same handlers — which is the point of it. **The command line must not grow
 * a verb the protocol does not have**, or Studio's own management surface could
 * never reach parity with it, so everything an administrator does from here has
 * to be a method on this.
 *
 * What arrives first is `hello`, and it is the whole of what this program knows
 * about what a server can do: the methods it answers and the capabilities it
 * serves, both derived on the server from what that build actually registered.
 * **A capability or a method name is how a client decides, never a probe.**
 * Calling something to find out whether it is there is how a client comes to
 * report "refused" for "this server is older than you are", and the two need
 * different sentences.
 *
 * Subscribing is not used yet. It is not designed out either: the frame this
 * sends is chosen per exchange and `subscribed` answers are routed by the same
 * id the results are, so the method that asks for a topic is a few lines rather
 * than a change of shape.
 */
import {
  TEAM_PROTOCOL_VERSION,
  TEAM_SOCKET_PATH,
  type TeamCapability,
  type TeamErrorCode,
  type TeamEventFrame,
  type TeamHelloFrame,
} from "@narraleaf/team-protocol";

import { CLOSE } from "../team/websocket.js";
import { openWebSocket, type ClientWebSocket } from "./websocket.js";

/**
 * The most one answer may be.
 *
 * Larger than the bound the server puts on what it will read, and deliberately:
 * that one is about how much memory one client may make a shared server hold,
 * and this one is about how much a server may make one command line hold. A list
 * of every project on a large deployment is bigger than anything a client sends.
 */
const MAXIMUM_MESSAGE_BYTES = 8 * 1024 * 1024;

/** How long the opening frame has to arrive before the server is called silent. */
const HELLO_TIMEOUT_MS = 30_000;

/**
 * How long one call waits.
 *
 * Every method on this server answers exactly once, so this fires only where
 * something has gone wrong that the socket itself has not noticed. It exists so
 * that a wedged server is a sentence and an exit code rather than a terminal
 * that never comes back.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * A refusal, as the protocol words one.
 *
 * The code is from the small shared vocabulary and the message is the server's
 * own sentence, in English, written for a log. It is printed as it arrived: a
 * client that rewords a refusal is a client whose output cannot be searched for
 * in the server's log.
 */
export class TeamCallError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamCallError";
  }
}

/** Raised when a server speaks a version of this protocol that this build does not. */
export class ProtocolVersionError extends Error {
  constructor(address: string, theirs: number) {
    super(
      theirs > TEAM_PROTOCOL_VERSION
        ? `${address} speaks version ${theirs} of the Team protocol and this nlteam speaks ` +
            `${TEAM_PROTOCOL_VERSION}. Update nlteam.`
        : `${address} speaks version ${theirs} of the Team protocol and this nlteam speaks ` +
            `${TEAM_PROTOCOL_VERSION}. Update the server.`,
    );
    this.name = "ProtocolVersionError";
  }
}

/** Raised when a method is asked for that the server did not say it answers. */
export class UnservedMethodError extends Error {
  constructor(address: string, method: string) {
    super(
      `${address} does not answer ${method}. It said so when the session opened, so this was ` +
        "not asked. The server may be older than this nlteam.",
    );
    this.name = "UnservedMethodError";
  }
}

/** Everything opening a session needs. */
export interface TeamSessionOptions {
  /** The address the authority was pinned for. */
  readonly address: string;
  /** That authority, as PEM. */
  readonly ca: string;
  /** The bearer this session is opened as. */
  readonly token: string;
  /**
   * Where an event on a subscribed topic goes.
   *
   * Nothing subscribes yet, so nothing arrives here yet. It is the seam rather
   * than a feature: the routing exists, and what is missing is a caller.
   */
  readonly onEvent?: (event: TeamEventFrame) => void;
}

/** What one exchange is waiting for. */
interface Waiting {
  readonly settle: (frame: Record<string, unknown>) => void;
  readonly fail: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** An open session. */
export class TeamSessionClient {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private ending: string | undefined;

  private constructor(
    private readonly socket: ClientWebSocket,
    private readonly options: TeamSessionOptions,
    /** The opening frame, which is the whole of what this knows about the server. */
    readonly hello: TeamHelloFrame,
  ) {}

  /** Whether this build of that server answers a method. */
  serves(method: string): boolean {
    return this.hello.methods.includes(method);
  }

  /** Whether that server serves a capability. */
  can(capability: TeamCapability): boolean {
    return this.hello.capabilities.includes(capability);
  }

  /**
   * Call one method and hand back what it answered.
   *
   * A method the opening frame did not list is refused here rather than sent, so
   * that "this server is older than you are" is never reported as "refused" —
   * see the note at the top of this file.
   */
  async call(method: string, params?: unknown): Promise<unknown> {
    if (!this.serves(method)) {
      throw new UnservedMethodError(this.options.address, method);
    }
    const answer = await this.exchange("call", method, {
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (answer["t"] === "error") {
      throw new TeamCallError(
        answer["code"] as TeamErrorCode,
        typeof answer["message"] === "string"
          ? answer["message"]
          : `${method} was refused and said nothing about why`,
      );
    }
    return answer["value"];
  }

  /** Close the session tidily. */
  close(): void {
    this.socket.close(CLOSE.normal, "done");
  }

  /** Send one frame that will be answered, and wait for the answer. */
  private exchange(
    kind: "call" | "subscribe" | "unsubscribe",
    what: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.ending !== undefined) {
      return Promise.reject(new Error(this.ending));
    }
    const id = this.next++;
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        fail(
          new Error(
            `${this.options.address} did not answer ${what} within ` +
              `${Math.round(CALL_TIMEOUT_MS / 1000)} seconds`,
          ),
        );
      }, CALL_TIMEOUT_MS);
      this.waiting.set(id, { settle, fail, timer });
      this.socket.send(JSON.stringify({ t: kind, id, ...extra }));
    });
  }

  /** One frame off the wire. */
  private receive(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return;
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      // A server that sends something other than JSON on this protocol is one
      // there is nothing useful to say to. The socket's own close path reports
      // it when the conversation stops making progress.
      return;
    }

    if (frame["t"] === "event") {
      this.options.onEvent?.(frame as unknown as TeamEventFrame);
      return;
    }
    if (frame["t"] === "bye") {
      // Said as a message rather than left to the close code, so that a token
      // that expired reads differently from a server that is shutting down.
      const message = typeof frame["message"] === "string" ? frame["message"] : "the session ended";
      this.abandon(message);
      return;
    }
    const id = frame["id"];
    if (typeof id !== "number") {
      return;
    }
    const waiting = this.waiting.get(id);
    if (waiting === undefined) {
      return;
    }
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.settle(frame);
  }

  /** Nothing more will be answered: fail whatever is still waiting, once. */
  private abandon(reason: string): void {
    this.ending ??= reason;
    for (const [id, waiting] of [...this.waiting]) {
      this.waiting.delete(id);
      clearTimeout(waiting.timer);
      waiting.fail(new Error(reason));
    }
  }

  /**
   * Open a session, and return once the server has said who this is talking to.
   *
   * The opening frame is waited for rather than assumed, because everything
   * decided afterwards is decided out of it.
   */
  static async open(options: TeamSessionOptions): Promise<TeamSessionClient> {
    let client: TeamSessionClient | undefined;
    let hello: TeamHelloFrame | undefined;
    let deliverHello: (() => void) | undefined;
    let refuseHello: ((error: Error) => void) | undefined;

    const socket = await openWebSocket({
      address: options.address,
      ca: options.ca,
      path: TEAM_SOCKET_PATH,
      token: options.token,
      maximumMessageBytes: MAXIMUM_MESSAGE_BYTES,
      onMessage: (text) => {
        if (hello === undefined) {
          const parsed: unknown = JSON.parse(text);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as Record<string, unknown>)["t"] === "hello"
          ) {
            hello = parsed as unknown as TeamHelloFrame;
            deliverHello?.();
            return;
          }
        }
        client?.receive(text);
      },
      onClose: (reason) => {
        refuseHello?.(new Error(`${options.address} closed the session: ${reason}`));
        client?.abandon(`${options.address} closed the session: ${reason}`);
      },
    });

    try {
      await new Promise<void>((settle, fail) => {
        if (hello !== undefined) {
          settle();
          return;
        }
        const timer = setTimeout(() => {
          fail(
            new Error(
              `${options.address} opened a session and said nothing within ` +
                `${Math.round(HELLO_TIMEOUT_MS / 1000)} seconds`,
            ),
          );
        }, HELLO_TIMEOUT_MS);
        deliverHello = () => {
          clearTimeout(timer);
          settle();
        };
        refuseHello = (error) => {
          clearTimeout(timer);
          fail(error);
        };
      });
    } catch (error) {
      socket.close(CLOSE.goingAway, "no hello");
      throw error;
    }

    const opening = hello as TeamHelloFrame;
    if (opening.protocol !== TEAM_PROTOCOL_VERSION) {
      socket.close(CLOSE.protocolError, "protocol version");
      throw new ProtocolVersionError(options.address, opening.protocol);
    }

    client = new TeamSessionClient(socket, options, opening);
    return client;
  }
}
