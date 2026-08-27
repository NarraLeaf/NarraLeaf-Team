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
 *   - **May it still be told what it asked to be told?** A third question rather
 *     than a rephrasing of the second. A topic is judged once, when it is
 *     subscribed to, and an account demoted out of the operators goes on holding
 *     a perfectly good token - so the token check alone would leave it receiving
 *     the accounts, the settings and the keys until it happened to reconnect.
 *     See {@link TeamSession.withdrawManagement}.
 *
 * Everything a handler throws that is not a {@link MethodError} is answered as
 * `internal` **with its message left off the wire**. A fault's message is a
 * sentence about this server's insides, and the client's side of the protocol is
 * a code it can act on plus a line in the operator's log.
 */
import { describeRefusal, identifyToken } from "../identity/bearer.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import { judgeCollaboration } from "./collaboration.js";
import type { TeamService } from "./service.js";
import type { TeamHub, HubSession } from "./hub.js";
import { MethodError, type MethodContext, type TeamMethod } from "./methods.js";
import type { TeamPresence } from "./presence.js";
import {
  TEAM_HEARTBEAT_MS,
  TEAM_PROTOCOL_VERSION,
  type TeamAccount,
  type TeamByeFrame,
  type TeamCapability,
  type TeamClientFrame,
  type TeamErrorCode,
  type TeamServerFrame,
} from "./protocol.js";
import { isAdminTopic, judgeTopic, SUBSCRIPTION_LIMIT } from "./topics.js";
import { CLOSE, type WebSocketConnection } from "./websocket.js";

/**
 * How often a session that is saying nothing checks that the account behind it
 * may still be here, and may still be told what it asked to be told.
 *
 * **Thirty seconds is the whole of the window**, and it is worth saying in
 * words rather than leaving to be worked out from a number: a session that has
 * gone quiet goes on receiving what it subscribed to for at most one of these
 * after the account behind it stops being an operator. A session that is doing
 * anything at all has no window, because every call re-identifies its caller
 * and asks the same question on the way through.
 */
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
  readonly service: TeamService;
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
  /**
   * What this deployment announces, asked as this session opens.
   *
   * A function rather than a list, and the same function the discovery document
   * is written from, so that a client cannot be told one thing before it
   * connects and another after. It is asked here rather than when the process
   * started because part of the answer is a stored setting - see
   * ./collaboration.ts, which also says what happens to a session that was told
   * an answer which has since changed.
   */
  readonly capabilities: () => readonly TeamCapability[];
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

/**
 * The WebSocket close code a `bye` reason maps to.
 *
 * A close code is two bytes, and the wrong one is a lie a client acts on: closing
 * `1000` on a protocol violation reads as a clean goodbye, so a client author has
 * nothing to fix and reconnects into the same wall. So each reason a session ends
 * for carries the code that names it.
 *
 *  - A frame the protocol does not allow is `1002`, the code for a protocol
 *    error - the only reason this server sends a `bye{bad-params}`.
 *  - A token that will not do (`unauthenticated`) or a quota or in-flight cap
 *    reached (`refused`) is `1008`: the session broke a rule rather than
 *    finishing.
 *  - Anything else - the server shutting down, which sends `bye{unavailable}` -
 *    is `1000`, a clean end worth reconnecting into.
 *
 * A message over the ceiling is `1009`, but that never reaches here: the framing
 * layer closes it before a frame is ever handed up. See src/team/websocket.ts.
 */
function closeCodeFor(code: TeamErrorCode): number {
  switch (code) {
    case "bad-params":
      return CLOSE.protocolError;
    case "unauthenticated":
    case "refused":
      return CLOSE.policy;
    default:
      return CLOSE.normal;
  }
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
      capabilities: options.capabilities(),
      serverTime: Date.now(),
      heartbeatMs: TEAM_HEARTBEAT_MS,
    });

    this.revalidation = setInterval(() => {
      // The answer is thrown away: identifying is itself the check, it takes
      // back anything this session may no longer hold, and a refusal ends the
      // session from inside it. This timer is what covers a session that is
      // making no calls; one that is makes the same check on each of them.
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

    // Asked of every call, and asked here rather than inside each handler for
    // the reason the management family wraps its own: a gate one can forget to
    // write is a gate somebody eventually forgets. This is also the authority -
    // the capability list a session was told when it opened is advice, and a
    // client acting on a list that has since changed meets a refusal, which is
    // what a refusal is for. See ./collaboration.ts.
    const collaboration = judgeCollaboration(this.options.service.database, user, method);
    if (collaboration.kind === "refused") {
      this.fail(id, "refused", collaboration.detail);
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
    // The acknowledgement carries an empty object rather than null, so that
    // `result.value` is an object here as it is for every method.
    this.topics.delete(frame.topic);
    this.send({ t: "result", id, value: {} });
  }

  /**
   * Take back every management subscription from somebody who is no longer an
   * operator.
   *
   * A subscription outliving the person who could take it is the one thing
   * judging a topic when it is granted cannot prevent on its own: `judgeTopic`
   * runs as a client subscribes, the account is demoted afterwards, and the
   * token it holds is untouched by that - minted before, signed, unexpired, and
   * belonging to an account that is neither disabled nor revoked. Everything
   * else about the session is in perfect order.
   *
   * The session stays open and keeps everything else it asked for. A demotion is
   * no reason to disconnect somebody who is still an author on this server, and
   * ending the socket over it would look to them exactly like a server that had
   * fallen over.
   *
   * Each topic taken back is said on that topic, once, and to this session
   * alone: the hub is not asked to publish, because nothing has happened that
   * anybody else's subscription is about, and the sequence must not move for the
   * operators who are still listening. It goes out as an ordinary event so that
   * a client which has never heard of this kind does with it whatever it does
   * with any event kind it does not know, rather than meeting a frame it has no
   * name for.
   *
   * Nothing comparable happens to a subscription when a deployment is closed to
   * collaboration, and ./collaboration.ts says why the two cases are not alike.
   */
  private withdrawManagement(user: UserRecord): void {
    if (isOperator(user.groups)) {
      return;
    }
    for (const topic of [...this.topics]) {
      if (!isAdminTopic(topic)) {
        continue;
      }
      this.topics.delete(topic);
      this.send({
        t: "event",
        topic,
        seq: this.options.hub.sequenceOf(topic),
        payload: {
          kind: "subscription-withdrawn",
          topic,
          why: "this account is no longer an operator of this server",
        },
      });
    }
  }

  /**
   * Who is calling, now.
   *
   * Ends the session when the answer is nobody, and returns undefined so that
   * the caller stops. A refusal here is never per-call: the token that opened
   * this session is the only one it has, so a token that has stopped working has
   * stopped working for everything.
   *
   * Whoever it turns out to be is asked the second question on the way through,
   * because the answer is already in hand: a session that is making calls has no
   * reason to wait out a revalidation interval before losing what it may no
   * longer be told.
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
    this.withdrawManagement(identified.user);
    return identified.user;
  }

  private fail(id: number, code: TeamErrorCode, message: string): void {
    this.send({ t: "error", id, code, message });
  }

  /** Say why, then close with the code that reason maps to. */
  private bye(code: TeamByeFrame["code"], message: string): void {
    this.send({ t: "bye", code, message });
    this.options.connection.close(closeCodeFor(code), message);
    this.closed();
  }

  private send(frame: TeamServerFrame): void {
    this.options.connection.send(JSON.stringify(frame));
  }
}
