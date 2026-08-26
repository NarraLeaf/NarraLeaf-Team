/**
 * One Studio installation, connected.
 *
 * A session is the protocol's unit rather than a request: it is opened once with
 * a token, it says who it is, and after that either side speaks. What that buys
 * is the thing the REST API cannot do at any price - this server telling Studio
 * that something changed - and what it costs is that the two questions a request
 * answers once now have to be answered continuously:
 *
 *   - **Who is calling?** The caller is identified again for every single call,
 *     out of the token this session was opened with. Not once at the start. An
 *     account can be disabled or have its tokens revoked while a socket is open,
 *     and this server's whole claim about revocation is that it takes effect
 *     immediately rather than at expiry - see src/identity/bearer.ts. A session
 *     that identified its caller once at sign-in would be the one place that
 *     claim was untrue.
 *   - **Should this still be open?** Checked on a timer as well, because a
 *     session that makes no calls still receives events, and a disabled account
 *     that goes on being told what everybody is doing is the same hole with a
 *     longer lease.
 *
 * Everything a handler throws that is not a {@link MethodError} is answered as
 * `internal` **with its message left off the wire**. A fault's message is a
 * sentence about this server's insides, and the client's side of the protocol is
 * a code it can act on plus a line in the operator's log.
 */
import { describeRefusal, identifyToken } from "../identity/bearer.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import type { StudioApiOptions } from "../web/studio.js";
import type { TeamHub, HubSession } from "./hub.js";
import { MethodError, type MethodContext, type TeamMethod } from "./methods.js";
import type { TeamPresence } from "./presence.js";
import {
  TEAM_HEARTBEAT_MS,
  TEAM_PROTOCOL_VERSION,
  type TeamAccount,
  type TeamByeFrame,
  type TeamClientFrame,
  type TeamErrorCode,
  type TeamServerFrame,
} from "./protocol.js";
import { judgeTopic, SUBSCRIPTION_LIMIT } from "./topics.js";
import { CLOSE, type WebSocketConnection } from "./websocket.js";

/** How often a session checks that the account behind it may still be here. */
const REVALIDATE_MS = 30_000;

/**
 * The most calls one session may have in flight.
 *
 * Handlers are awaited, so a client that never reads its answers could otherwise
 * hold an unbounded number of them open. The limit is high enough that nothing
 * an interface does approaches it and low enough that one misbehaving client
 * costs one session.
 */
const IN_FLIGHT_LIMIT = 64;

export interface SessionOptions {
  readonly connection: WebSocketConnection;
  readonly hub: TeamHub;
  readonly service: StudioApiOptions;
  readonly methods: ReadonlyMap<string, TeamMethod>;
  /**
   * Who is connected and which live sessions are open.
   *
   * Shared by every session of this server, and this one's entry in it is
   * removed when the socket closes rather than when a client says goodbye - a
   * client that is told to say so is one that will one day crash instead, and a
   * room full of people who are not there is worse than no room.
   */
  readonly presence: TeamPresence;
  /** The token this session was opened with, kept so the caller can be identified again. */
  readonly token: string;
  /** Who it was when it opened, so the hello frame does not repeat the work. */
  readonly user: UserRecord;
  readonly serverName: string;
  readonly version: string;
}

/** The person behind a record, as the protocol carries them. */
export function accountOf(user: UserRecord): TeamAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    operator: isOperator(user.groups),
  };
}

export class TeamSession implements HubSession {
  readonly id: string;

  private readonly options: SessionOptions;
  private readonly topics = new Set<string>();
  private inFlight = 0;
  private revalidation: NodeJS.Timeout | undefined;
  private over = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.id = options.connection.id;

    options.hub.add(this);

    this.send({
      t: "hello",
      protocol: TEAM_PROTOCOL_VERSION,
      server: { name: options.serverName, version: options.version },
      session: this.id,
      account: accountOf(options.user),
      methods: [...options.methods.keys()],
      capabilities: options.hub.capabilities,
      serverTime: Date.now(),
      heartbeatMs: TEAM_HEARTBEAT_MS,
    });

    this.revalidation = setInterval(() => {
      // The answer is thrown away: identifying is itself the check, and a
      // refusal ends the session from inside it.
      this.identify();
    }, REVALIDATE_MS);
    // The same reasoning as the heartbeat in ./websocket.ts: an open session is
    // not a reason for this process to stay up.
    this.revalidation.unref?.();
  }

  /* ------------------------------------------------------- what the hub uses */

  wants(topic: string): boolean {
    return this.topics.has(topic);
  }

  deliver(topic: string, seq: number, payload: unknown): void {
    this.send({ t: "event", topic, seq, payload });
  }

  end(message: string): void {
    this.bye("unavailable", message);
  }

  /* ------------------------------------------------------- what arrives */

  /**
   * One message from the client.
   *
   * Anything that is not a frame this speaks ends the session rather than being
   * ignored. A client sending nonsense is a client that has misunderstood the
   * protocol, and going on would mean it never finds out.
   */
  receive(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.bye("bad-params", "that was not JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.bye("bad-params", "a frame has to be an object");
      return;
    }
    const frame = parsed as Partial<TeamClientFrame> & { t?: unknown; id?: unknown };
    if (typeof frame.id !== "number" || !Number.isInteger(frame.id)) {
      this.bye("bad-params", "a frame has to carry a whole-number id");
      return;
    }

    switch (frame.t) {
      case "call":
        this.answer(frame.id, frame as { method?: unknown; params?: unknown });
        return;
      case "subscribe":
        this.subscribe(frame.id, frame as { topic?: unknown });
        return;
      case "unsubscribe":
        this.unsubscribe(frame.id, frame as { topic?: unknown });
        return;
      default:
        this.bye("bad-params", `there is no frame of kind ${String(frame.t)}`);
    }
  }

  /** Called once, whatever ended the connection. */
  closed(): void {
    if (this.over) {
      return;
    }
    this.over = true;
    if (this.revalidation !== undefined) {
      clearInterval(this.revalidation);
      this.revalidation = undefined;
    }
    this.topics.clear();
    this.options.hub.remove(this);
    // Whatever this connection said it was goes with it, and so does its place
    // in every live session. This is the only path that removes an instance:
    // see the note on SessionOptions.presence.
    this.options.presence.dropConnection(this.id);
  }

  /* ------------------------------------------------------------- internals */

  private answer(id: number, frame: { method?: unknown; params?: unknown }): void {
    if (typeof frame.method !== "string") {
      this.fail(id, "bad-params", "a call has to name a method");
      return;
    }
    const method = this.options.methods.get(frame.method);
    if (method === undefined) {
      this.fail(id, "unknown-method", `this server has no method called ${frame.method}`);
      return;
    }
    if (this.inFlight >= IN_FLIGHT_LIMIT) {
      this.bye("refused", "too many calls are waiting on this session");
      return;
    }

    const user = this.identify();
    if (user === undefined) {
      return;
    }

    const context: MethodContext = {
      options: this.options.service,
      user,
      account: accountOf(user),
      publish: (topic, payload) => {
        this.options.hub.publish(topic, payload);
      },
      connection: { id: this.id },
      presence: this.options.presence,
    };

    this.inFlight += 1;
    void (async () => {
      try {
        const value = await method.handle(frame.params, context);
        this.send({ t: "result", id, value });
      } catch (error) {
        if (error instanceof MethodError) {
          this.fail(id, error.code, error.message);
          return;
        }
        // Kept off the wire on purpose. What the client is owed is a code; what
        // this sentence describes is somewhere inside this process.
        this.options.service.log?.(
          `team: ${frame.method as string} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.fail(id, "internal", "something went wrong answering that");
      } finally {
        this.inFlight -= 1;
      }
    })();
  }

  private subscribe(id: number, frame: { topic?: unknown }): void {
    if (typeof frame.topic !== "string" || frame.topic === "") {
      this.fail(id, "bad-params", "a subscription has to name a topic");
      return;
    }
    const user = this.identify();
    if (user === undefined) {
      return;
    }
    if (this.topics.has(frame.topic)) {
      // Already held. Answered rather than refused, and with the sequence as it
      // stands, because a client that re-subscribes after a reconnect it did
      // not notice is asking a reasonable question.
      this.send({
        t: "subscribed",
        id,
        topic: frame.topic,
        seq: this.options.hub.sequenceOf(frame.topic),
      });
      return;
    }
    if (this.topics.size >= SUBSCRIPTION_LIMIT) {
      this.fail(id, "refused", "this session already holds as many topics as it may");
      return;
    }

    const verdict = judgeTopic(
      this.options.service.database,
      user,
      frame.topic,
      this.options.presence,
    );
    if (verdict.kind === "unknown") {
      this.fail(id, "not-found", verdict.detail);
      return;
    }
    if (verdict.kind === "refused") {
      this.fail(id, "refused", verdict.detail);
      return;
    }

    this.topics.add(frame.topic);
    this.send({
      t: "subscribed",
      id,
      topic: frame.topic,
      seq: this.options.hub.sequenceOf(frame.topic),
    });
  }

  private unsubscribe(id: number, frame: { topic?: unknown }): void {
    if (typeof frame.topic !== "string") {
      this.fail(id, "bad-params", "an unsubscribe has to name a topic");
      return;
    }
    // Dropping one that was never held is a success. There is nothing for the
    // client to do differently, and the state it wanted is the state it has.
    this.topics.delete(frame.topic);
    this.send({ t: "result", id, value: null });
  }

  /**
   * Who is calling, now.
   *
   * Ends the session when the answer is nobody, and returns undefined so that
   * the caller stops. A refusal here is never per-call: the token that opened
   * this session is the only one it has, so a token that has stopped working has
   * stopped working for everything.
   */
  private identify(): UserRecord | undefined {
    const identified = identifyToken(
      this.options.service.database,
      this.options.service.keys,
      this.options.service.config,
      this.options.token,
    );
    if (identified.kind === "refused") {
      this.bye("unauthenticated", describeRefusal(identified.reason));
      return undefined;
    }
    return identified.user;
  }

  private fail(id: number, code: TeamErrorCode, message: string): void {
    this.send({ t: "error", id, code, message });
  }

  /** Say why, then close. */
  private bye(code: TeamByeFrame["code"], message: string): void {
    this.send({ t: "bye", code, message });
    this.options.connection.close(
      code === "unauthenticated" ? CLOSE.policy : CLOSE.normal,
      message,
    );
    this.closed();
  }

  private send(frame: TeamServerFrame): void {
    this.options.connection.send(JSON.stringify(frame));
  }
}
