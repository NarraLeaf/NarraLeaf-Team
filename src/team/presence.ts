/**
 * Who is here, and which rooms they are in.
 *
 * Two things live in this file and they are deliberately together: a client
 * instance is an installation of Studio that is connected right now, and a live
 * session is a room those instances join. Every question either one answers is
 * "at this instant" - what is connected, what is open, who is in it - and an
 * answer of that kind belongs in memory rather than in the database.
 *
 * **That is a decision, not an omission.** Persisting either would buy nothing
 * and cost a great deal. A table of instances is a list of installations that
 * connected once, which nothing reads, which grows for ever and which an
 * operator has to wonder about. A table of live sessions is worse: a room whose
 * members are all gone is not a room, so the rows would have to be swept, and a
 * sweep is a policy about how long a dead room counts as one. Meanwhile nothing
 * of value is at risk, because **a live session holds no content**. Whatever the
 * people in one produce is written through the overlay store or pushed to the
 * repository, and both of those are still there when this process is not.
 *
 * So this server restarting ends every room, drops every instance, and loses
 * nothing. Clients find out the same way they find out about everything else
 * here: their sockets closed, they reconnect, and they read again.
 *
 * The one rule that is easy to get wrong: **a connection closing is what removes
 * an instance**, not a client saying goodbye. A client that is told to say so
 * will one day be a client that crashed instead, and a room full of people who
 * are not there is worse than no room at all.
 */
import { randomInt, randomUUID } from "node:crypto";

import {
  projectClientsTopic,
  projectLiveTopic,
  liveTopic,
  type TeamClientInstance,
  type TeamLiveJoinRule,
  type TeamLiveMember,
  type TeamLiveSession,
} from "./protocol.js";

/**
 * The most live sessions one project may have open at once.
 *
 * A room is opened by a person pressing something, so this is not a rate limit -
 * it is a bound on what one project's `live.list` can grow to, so that a client
 * looping on `live.open` costs one project's list rather than this server's
 * memory.
 */
export const LIVE_SESSION_LIMIT = 32;

/** What a caller must say about itself before it counts as an instance. */
export interface InstanceAnnouncement {
  readonly id: string;
  readonly label: string;
  readonly agent: string;
  readonly project?: string;
  readonly revision?: string;
}

interface InstanceEntry {
  readonly connection: string;
  readonly instance: TeamClientInstance;
}

interface LiveEntry {
  readonly id: string;
  readonly project: string;
  /** Where the people in this room began, and see {@link TeamLiveSession} for why it must be said. */
  readonly revision: string;
  /** Which document they are all editing, and see {@link TeamLiveSession} for why that is not the same thing. */
  readonly story: string;
  readonly title?: string;
  readonly openedBy: string;
  readonly openedByInstance: string;
  readonly openedAt: number;
  /** Instance id to membership, in join order because a Map keeps insertion order. */
  readonly members: Map<string, TeamLiveMember>;
  /** How it may be joined. Changed by its opener; see {@link Presence.setRule}. */
  rule: TeamLiveJoinRule;
  /**
   * Who has asked to be let in and has not been answered, by instance id.
   *
   * ⚠ **Held here rather than timed out here.** Nothing on this server counts down:
   * a request that is never answered stays until its room ends or its asker's
   * connection does, and the window that asked is the one that decides how long it
   * is willing to wait. A timer here would be this server having an opinion about
   * how long a person takes to look at a notice.
   */
  readonly requests: Map<string, TeamLiveMember>;
  /**
   * The four digits somebody joins by, minted when the room opened.
   *
   * **Minted for every room and not only for the ones that need it**, because the
   * rule can be changed while the room is running and a code minted at that moment
   * would be a different code each time somebody flipped the switch. One room, one
   * code, for as long as the room lasts.
   *
   * ⚠ **Never in {@link view}.** It is answered to the window that opened the room
   * and to nobody else: the record goes out on the project's topic, and a code
   * everybody on the project is told is a code that has said nothing.
   */
  readonly code: string;
}

/** Raised where a caller asked for a room that is not there. */
export class NoSuchLiveSessionError extends Error {
  constructor() {
    super("there is no live session of that id on this server");
    this.name = "NoSuchLiveSessionError";
  }
}

/** Raised where a room is joined by asking and the caller tried to walk in. */
export class LiveJoinNeedsAskingError extends Error {
  constructor() {
    super("that live session is joined by asking whoever opened it");
    this.name = "LiveJoinNeedsAskingError";
  }
}

/** Raised where a room may only be joined by its code and the caller gave none, or gave a wrong one. */
export class WrongLiveCodeError extends Error {
  constructor() {
    super("that live session is joined by its code, and this is not it");
    this.name = "WrongLiveCodeError";
  }
}

/** Raised where a project already holds as many rooms as it may. */
export class TooManyLiveSessionsError extends Error {
  constructor() {
    super("this project already has as many live sessions open as it may");
    this.name = "TooManyLiveSessionsError";
  }
}

/**
 * The most instances one link session may carry.
 *
 * ⚠ **More than one is the ordinary case, not a corner.** Studio holds one
 * socket per server and opens a window per project, so a person with two of this
 * server's projects open is one connection carrying two installations' worth of
 * presence. A model of one instance per connection would have those two windows
 * overwriting each other's entry, and the project field would flap between them.
 *
 * The bound is here so that a client looping on `clients.announce` with fresh
 * ids costs itself rather than this server.
 */
export const INSTANCES_PER_CONNECTION = 16;

/** Raised where one connection has announced as many instances as it may. */
export class TooManyInstancesError extends Error {
  constructor() {
    super("this session has announced as many installations as it may");
    this.name = "TooManyInstancesError";
  }
}

export class TeamPresence {
  /** Instance id to what it said and which connection carries it. */
  private readonly instances = new Map<string, InstanceEntry>();

  /** Connection id to every instance announced on it, so a close can find them all. */
  private readonly byConnection = new Map<string, Set<string>>();

  private readonly sessions = new Map<string, LiveEntry>();

  constructor(
    /**
     * How anything here reaches the people it concerns.
     *
     * Handed in rather than reached for, exactly as a method handler's is: this
     * file decides what changed, and the hub decides who hears about it.
     */
    private readonly publish: (topic: string, payload: unknown) => void,
  ) {}

  /* --------------------------------------------------------------- instances */

  /**
   * Record what one connection says it is, replacing whatever it said before.
   *
   * Announcing twice is ordinary rather than an error: an instance says so again
   * when the person opens a different project, and that is the whole of how this
   * server knows what anybody has open.
   *
   * **An id announced on a second connection moves to it.** The alternative is
   * two entries for one installation, one of which is a socket that is about to
   * be found dead. Whoever holds the id last holds it.
   */
  announce(
    connection: string,
    account: string,
    said: InstanceAnnouncement,
  ): TeamClientInstance {
    const previous = this.instances.get(said.id);
    const before = previous?.instance.project;

    // An id announced on a second connection moves to it. The alternative is two
    // entries for one installation, one of which is a socket about to be found
    // dead; whoever holds the id last holds it.
    if (previous !== undefined && previous.connection !== connection) {
      this.byConnection.get(previous.connection)?.delete(said.id);
    }
    const held = this.byConnection.get(connection) ?? new Set<string>();
    if (!held.has(said.id) && held.size >= INSTANCES_PER_CONNECTION) {
      throw new TooManyInstancesError();
    }

    const instance: TeamClientInstance = {
      id: said.id,
      account,
      label: said.label,
      agent: said.agent,
      ...(said.project === undefined ? {} : { project: said.project }),
      ...(said.revision === undefined ? {} : { revision: said.revision }),
      // Kept from the first announcement on this connection, so that changing
      // project does not read as somebody having just arrived.
      since: previous?.connection === connection ? previous.instance.since : Date.now(),
    };
    this.instances.set(said.id, { connection, instance });
    held.add(said.id);
    this.byConnection.set(connection, held);

    if (before !== undefined && before !== instance.project) {
      this.publish(projectClientsTopic(before), { kind: "client-gone", client: instance.id });
    }
    if (instance.project !== undefined) {
      this.publish(projectClientsTopic(instance.project), { kind: "client-here", client: instance });
    }
    return instance;
  }

  /**
   * The instance on one connection that has one project open.
   *
   * **This is how a call finds out which installation is making it**, and it is
   * resolved by project rather than named in the parameters on purpose: the
   * client composes an instance id out of its installation and the project, so
   * the caller would only be repeating something it already said. Every method
   * that needs an instance is already about one project - a room belongs to one,
   * a record is attached to one - so there is always something to resolve by.
   *
   * Undefined for a session that never announced, and for one whose windows are
   * all on other projects.
   */
  instanceOn(connection: string, project: string): TeamClientInstance | undefined {
    for (const id of this.byConnection.get(connection) ?? []) {
      const entry = this.instances.get(id);
      if (entry?.instance.project === project) {
        return entry.instance;
      }
    }
    return undefined;
  }

  /** Everything announced on one connection, for a log line rather than a decision. */
  instancesOf(connection: string): TeamClientInstance[] {
    const held = this.byConnection.get(connection);
    if (held === undefined) {
      return [];
    }
    return [...held]
      .map((id) => this.instances.get(id)?.instance)
      .filter((instance): instance is TeamClientInstance => instance !== undefined);
  }

  /**
   * Take back what one connection said about one project, because that window closed.
   *
   * Needed because a socket outlives a window: Studio holds one connection per
   * server and a window per project, so closing a project leaves the connection
   * open and would leave a presence behind claiming somebody still has that
   * project open. This is the only way an instance goes without its socket
   * going, and it is safe to be wrong about - a client that never calls it loses
   * nothing except a stale row that its next disconnect clears.
   */
  withdraw(connection: string, project: string): void {
    const instance = this.instanceOn(connection, project);
    if (instance === undefined) {
      return;
    }
    this.byConnection.get(connection)?.delete(instance.id);
    this.retire(instance.id);
  }

  /** Everything connected, or everything with one project open. */
  clients(project?: string): TeamClientInstance[] {
    const all = [...this.instances.values()].map((entry) => entry.instance);
    return project === undefined ? all : all.filter((each) => each.project === project);
  }

  /**
   * One connection has gone, so whatever was on it has gone.
   *
   * Everything this instance was in is left, which may close rooms, and every
   * project it was on is told. Safe to call for a connection that never
   * announced anything, which is every connection from a Studio too old to.
   */
  dropConnection(connection: string): void {
    const held = this.byConnection.get(connection);
    this.byConnection.delete(connection);
    for (const id of held ?? []) {
      const entry = this.instances.get(id);
      // Only where this connection is still the one holding it: an instance that
      // moved to a newer socket must not be swept by the older one closing.
      if (entry === undefined || entry.connection !== connection) {
        continue;
      }
      this.retire(id);
    }
  }

  /** Take one instance out of everything, telling whoever was watching. */
  private retire(id: string): void {
    const entry = this.instances.get(id);
    if (entry === undefined) {
      return;
    }
    this.instances.delete(id);
    for (const session of [...this.sessions.values()]) {
      // A request outlives nothing: the window that made it has gone, so there is
      // nobody left for a yes to admit. Dropped without a word, because the only
      // thing that could hear one is the connection that just closed.
      session.requests.delete(id);
      if (session.members.has(id)) {
        this.part(session, id);
      }
    }
    const project = entry.instance.project;
    if (project !== undefined) {
      this.publish(projectClientsTopic(project), { kind: "client-gone", client: id });
    }
  }

  /* ----------------------------------------------------------------- rooms */

  /**
   * The rooms open on one project, oldest first, as one instance may see them.
   *
   * ⚠ **A `code` room is not in the list for anybody who is not in it**, and that
   * is the whole of what "not discoverable" means here - the filter is on this
   * server rather than in whatever draws the list, because a list drawn from an
   * answer that carried the room is a list one client build chooses not to show.
   * It stays in the list for its own members: a window that reloads finds the room
   * it is still in by asking for this, and a member hidden from its own room would
   * be a member who cannot resume.
   */
  live(project: string, forInstance?: string): TeamLiveSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.project === project)
      .filter((session) => session.rule !== "code"
        || (forInstance !== undefined && session.members.has(forInstance)))
      .map((session) => view(session));
  }

  /** One room, or undefined. */
  liveSession(id: string): TeamLiveSession | undefined {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : view(session);
  }

  /** Whether one instance is in one room, which is what says it may speak in it. */
  isMember(id: string, instance: string): boolean {
    return this.sessions.get(id)?.members.has(instance) === true;
  }

  /**
   * Open a room, with its opener already in it.
   *
   * A room with nobody in it would be closed the moment it was made - the last
   * one out closes it - so the opener joins as part of opening rather than in a
   * second call somebody could forget.
   */
  open(
    instance: TeamClientInstance,
    input: {
      project: string;
      revision: string;
      story: string;
      title?: string;
      rule?: TeamLiveJoinRule;
    },
  ): { session: TeamLiveSession; code: string } {
    const open = [...this.sessions.values()].filter((each) => each.project === input.project);
    if (open.length >= LIVE_SESSION_LIMIT) {
      throw new TooManyLiveSessionsError();
    }
    const now = Date.now();
    const session: LiveEntry = {
      id: randomUUID(),
      project: input.project,
      revision: input.revision,
      story: input.story,
      ...(input.title === undefined ? {} : { title: input.title }),
      openedBy: instance.account,
      openedByInstance: instance.id,
      openedAt: now,
      members: new Map([[instance.id, memberOf(instance, now)]]),
      rule: input.rule ?? "open",
      code: this.mintCode(),
      requests: new Map(),
    };
    this.sessions.set(session.id, session);
    const seen = view(session);
    this.publish(projectLiveTopic(session.project), { kind: "live-opened", session: seen });
    // The code goes back to the opener and travels no further. Everything else
    // about the room is public to the project; this is the one thing that is not.
    return { session: seen, code: session.code };
  }

  /**
   * Four digits no other room on this server is using.
   *
   * **Unique rather than merely random**, because a code is an address: somebody
   * types four digits without knowing whose room they are looking for, and two
   * rooms answering to one number is a question this server cannot answer. Ten
   * thousand against a server's worth of rooms leaves the retry loop finishing on
   * its first pass in every deployment anybody runs.
   *
   * ⚠ **Not a secret, and deliberately short enough to read aloud.** Ten thousand
   * values is a number an account on this server could work through, and that is
   * the accepted shape rather than an oversight: every account here already
   * reaches every project, so what the code buys is not keeping people out - it is
   * letting somebody in without having to know whose room it is or find it in a
   * list. Making it longer, hashing it or expiring it would cost exactly that and
   * buy nothing this server's own permissions do not already decide.
   */
  private mintCode(): string {
    const taken = new Set([...this.sessions.values()].map((session) => session.code));
    if (taken.size >= 10_000) {
      throw new TooManyLiveSessionsError();
    }
    for (;;) {
      const code = String(randomInt(0, 10_000)).padStart(4, "0");
      if (!taken.has(code)) {
        return code;
      }
    }
  }

  /**
   * Change how a running room may be joined, which its opener may do and nobody else.
   *
   * ⚠ **The code does not change with it.** One room, one code: a host who flips to
   * `code` and back has not invalidated what they read out to somebody a minute ago,
   * and a host who wanted a new one wanted a new room.
   */
  setRule(instanceId: string, id: string, rule: TeamLiveJoinRule): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (session.openedByInstance !== instanceId) {
      return false;
    }
    if (session.rule !== rule) {
      session.rule = rule;
      this.announceChange(session);
    }
    return true;
  }

  /**
   * The room one code belongs to, or undefined.
   *
   * Server-wide rather than per project, because that is what a code is for:
   * somebody types four digits without knowing whose room they are looking for, or
   * even which project it is about. See {@link Presence.mintCode} for why that is
   * safe to answer and what it is not.
   */
  liveByCode(code: string): TeamLiveSession | undefined {
    const session = [...this.sessions.values()].find((each) => each.code === code);
    return session === undefined ? undefined : view(session);
  }

  /**
   * Join one. Joining twice is the room one is already in, not a refusal.
   *
   * ⚠ **A `code` room is joined by its code and by nothing else**, including by a
   * caller who has its id. Hiding it from the list is what stops it being stumbled
   * upon; this is what stops the id being enough, and without it the rule would be
   * a rule about listings rather than about joining.
   *
   * A member is let back in whatever the rule says: it is in the room already, and
   * refusing it would be refusing a window that reloaded.
   */
  join(instance: TeamClientInstance, id: string, code?: string): TeamLiveSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (!session.members.has(instance.id)) {
      if (session.rule === "code" && code !== session.code) {
        throw new WrongLiveCodeError();
      }
      if (session.rule === "request") {
        // Listed, and still not walk-in-able. Without this the rule would be a
        // decoration on a room anybody could join by pressing the same button.
        throw new LiveJoinNeedsAskingError();
      }
    }
    if (!session.members.has(instance.id)) {
      session.members.set(instance.id, memberOf(instance, Date.now()));
      this.announceChange(session);
    }
    return view(session);
  }

  /**
   * Ask to be let into a room that is joined by asking.
   *
   * Answers what the asker is already able to see - the room - rather than a
   * receipt: what they are waiting for is a change to the roster, and the only
   * thing that can tell them it happened is the roster.
   *
   * Asking twice is the request that is already outstanding, for the reason
   * joining twice is the room one is already in. Asking about a room one is
   * already in is nothing at all.
   */
  request(instance: TeamClientInstance, id: string): TeamLiveSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (!session.members.has(instance.id) && !session.requests.has(instance.id)) {
      const member = memberOf(instance, Date.now());
      session.requests.set(instance.id, member);
      // On the project's topic, where the person who asked is listening: they are
      // not in the room, so the room's own topic would reach the host and nobody
      // else. See `TeamLiveEvent`.
      this.publish(projectLiveTopic(session.project), {
        kind: "live-requested",
        session: session.id,
        member,
      });
    }
    return view(session);
  }

  /**
   * Say yes or no to somebody who asked, which the room's opener may do and nobody else.
   *
   * ⚠ **Yes has no event of its own.** Admitting somebody is a change to the
   * roster, and a change to the roster is already announced - so whoever asked
   * learns they are in by finding themselves in it, which is the same thing every
   * other member learns from. Only a no needs saying, because nothing else about
   * the room changes when the answer is no.
   */
  answer(
    openerInstanceId: string,
    id: string,
    instanceId: string,
    admit: boolean,
  ): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (session.openedByInstance !== openerInstanceId) {
      return false;
    }
    const asked = session.requests.get(instanceId);
    if (asked === undefined) {
      // Nobody by that name is waiting: answered already, gone, or never asked.
      // The state the caller wanted is the state there is.
      return true;
    }
    session.requests.delete(instanceId);
    if (admit) {
      session.members.set(instanceId, { ...asked, joinedAt: Date.now() });
      this.announceChange(session);
      return true;
    }
    this.publish(projectLiveTopic(session.project), {
      kind: "live-refused",
      session: session.id,
      instance: instanceId,
    });
    return true;
  }

  /**
   * Leave one. Leaving one nobody is in is a success, for the reason
   * unsubscribing from a topic nobody holds is: the state that was wanted is the
   * state there is.
   */
  leave(instanceId: string, id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return;
    }
    this.part(session, instanceId);
  }

  /**
   * Close one outright, which its opener may do and nobody else.
   *
   * The one act here that is about authorship rather than authorization: a room
   * belongs to whoever opened it, and pulling everybody else out of one is not
   * something a passer-by does. Everything else on this server is open to every
   * account of it (see src/projects/registry.ts), and this is not an exception to
   * that so much as a different question.
   */
  close(instanceId: string, id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (session.openedByInstance !== instanceId) {
      return false;
    }
    this.end(session);
    return true;
  }

  /** Relay one thing said in a room to everybody subscribed to it. */
  say(session: string, payload: unknown): void {
    this.publish(liveTopic(session), payload);
  }

  /**
   * Take one member out, ending the room if that was the last of them - or if it
   * was the one that opened it.
   *
   * **The opener leaving ends the room even with others still in it.** A room is
   * a place for the instances editing one project to reach each other, and the
   * one that opened it is the one holding the copy the others are following. With
   * it gone the rest would be talking to nobody in particular: still delivered
   * to, still able to speak, and with nothing on the other end that can act on
   * any of it. Ending the room says so at once instead of leaving people to work
   * it out from the silence.
   *
   * Every way an instance can go leads here - `leave`, a window withdrawing, a
   * socket closing - so this is the only place that has to know it.
   */
  private part(session: LiveEntry, instanceId: string): void {
    if (!session.members.delete(instanceId)) {
      return;
    }
    if (session.members.size === 0 || session.openedByInstance === instanceId) {
      this.end(session);
      return;
    }
    this.announceChange(session);
  }

  private end(session: LiveEntry): void {
    this.sessions.delete(session.id);
    this.publish(projectLiveTopic(session.project), { kind: "live-closed", session: session.id });
  }

  private announceChange(session: LiveEntry): void {
    this.publish(projectLiveTopic(session.project), {
      kind: "live-changed",
      session: view(session),
    });
  }
}

function memberOf(instance: TeamClientInstance, at: number): TeamLiveMember {
  return {
    instance: instance.id,
    account: instance.account,
    label: instance.label,
    joinedAt: at,
  };
}

function view(session: LiveEntry): TeamLiveSession {
  return {
    id: session.id,
    project: session.project,
    revision: session.revision,
    story: session.story,
    ...(session.title === undefined ? {} : { title: session.title }),
    openedBy: session.openedBy,
    openedByInstance: session.openedByInstance,
    openedAt: session.openedAt,
    members: [...session.members.values()],
    rule: session.rule,
    // ⚠ And never `code`. This value is published on the project's topic, which
    // everybody on the project is watching - see `LiveEntry.code`.
  };
}
