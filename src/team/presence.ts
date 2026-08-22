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
import { randomUUID } from "node:crypto";

import {
  projectClientsTopic,
  projectLiveTopic,
  liveTopic,
  type TeamClientInstance,
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
  readonly revision?: string;
  readonly title?: string;
  readonly openedBy: string;
  readonly openedByInstance: string;
  readonly openedAt: number;
  /** Instance id to membership, in join order because a Map keeps insertion order. */
  readonly members: Map<string, TeamLiveMember>;
}

/** Raised where a caller asked for a room that is not there. */
export class NoSuchLiveSessionError extends Error {
  constructor() {
    super("there is no live session of that id on this server");
    this.name = "NoSuchLiveSessionError";
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

  /** The rooms open on one project, oldest first. */
  live(project: string): TeamLiveSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.project === project)
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
    input: { project: string; revision?: string; title?: string },
  ): TeamLiveSession {
    const open = [...this.sessions.values()].filter((each) => each.project === input.project);
    if (open.length >= LIVE_SESSION_LIMIT) {
      throw new TooManyLiveSessionsError();
    }
    const now = Date.now();
    const session: LiveEntry = {
      id: randomUUID(),
      project: input.project,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.title === undefined ? {} : { title: input.title }),
      openedBy: instance.account,
      openedByInstance: instance.id,
      openedAt: now,
      members: new Map([[instance.id, memberOf(instance, now)]]),
    };
    this.sessions.set(session.id, session);
    const seen = view(session);
    this.publish(projectLiveTopic(session.project), { kind: "live-opened", session: seen });
    return seen;
  }

  /** Join one. Joining twice is the room one is already in, not a refusal. */
  join(instance: TeamClientInstance, id: string): TeamLiveSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new NoSuchLiveSessionError();
    }
    if (!session.members.has(instance.id)) {
      session.members.set(instance.id, memberOf(instance, Date.now()));
      this.announceChange(session);
    }
    return view(session);
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
    ...(session.revision === undefined ? {} : { revision: session.revision }),
    ...(session.title === undefined ? {} : { title: session.title }),
    openedBy: session.openedBy,
    openedByInstance: session.openedByInstance,
    openedAt: session.openedAt,
    members: [...session.members.values()],
  };
}
