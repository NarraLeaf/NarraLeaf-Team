/**
 * Every session that is open, and the one way anything reaches them.
 *
 * Publishing is a broadcast to whoever asked for a topic, and it is the only
 * thing in this process that writes to more than one connection. Keeping it
 * behind one object is what makes two properties true rather than hoped for:
 *
 *   - **A publisher does not know who is listening**, so the reader loop, a
 *     method handler and the CLI announce the same way and none of them can
 *     leak a session into somewhere it does not belong.
 *   - **Every topic has a sequence**, counted here, so that a client can tell
 *     whether it missed anything without this server keeping a log of what it
 *     sent.
 *
 * The sequences live in memory and start again at nought when `up` restarts.
 * That is not a gap: a client compares the number it is given when it
 * subscribes with the last one it saw, and **anything other than exactly that
 * number means read the collection again**. A restart therefore looks like a
 * missed event, which is what it is.
 *
 * Nothing here is persisted and nothing here is queued. A session that is not
 * connected at the moment something happens is told nothing, and finds out by
 * reading when it comes back. That is the whole of the delivery guarantee, and
 * it is deliberately the weakest one that is still correct: the alternative is a
 * durable outbox per client, which is a database this server would then have to
 * prune, back up and reason about.
 */

/** What the hub needs of a session, so that a test can be one in three lines. */
export interface HubSession {
  readonly id: string;
  /** Whether this session asked for that topic. */
  wants: (topic: string) => boolean;
  /** Hand one event over. Must not throw: a bad socket is one session's problem. */
  deliver: (topic: string, seq: number, payload: unknown) => void;
  /** End it, saying why. */
  end: (message: string) => void;
}

export class TeamHub {
  private readonly sessions = new Set<HubSession>();

  /** The last sequence published on each topic. Absent means nothing yet, which is nought. */
  private readonly sequences = new Map<string, number>();

  /** How many sessions are open, for an operator's line rather than for a decision. */
  get size(): number {
    return this.sessions.size;
  }

  add(session: HubSession): void {
    this.sessions.add(session);
  }

  remove(session: HubSession): void {
    this.sessions.delete(session);
  }

  /** Where a topic stands now, which is what a new subscription is told. */
  sequenceOf(topic: string): number {
    return this.sequences.get(topic) ?? 0;
  }

  /**
   * Forget a topic's sequence, because there is no longer a thing it addressed.
   *
   * Every topic ever published on leaves an entry here, and most of them are
   * addressed at something long-lived — this server, or a project. A live
   * session is not: it is opened by somebody pressing something, ends when they
   * go, and its id is never used again. Without this, a client opening and
   * closing rooms in a loop would grow this map for as long as the process ran,
   * at no cost to itself.
   *
   * Dropping a sequence is the same statement a restart makes: the number a
   * subscriber is given next will not be the one it last saw, so it reads the
   * collection again. For a room that has ended there is no collection and no
   * subscriber that could act on one, which is why this is safe to do here and
   * would not be for a project that is merely quiet.
   */
  forget(topic: string): void {
    this.sequences.delete(topic);
  }

  /**
   * Say that something happened, to whoever is listening.
   *
   * The sequence moves whether or not anybody is listening, so a client that
   * subscribes, disconnects for a minute and comes back is told a number that
   * differs from the one it had - which is exactly the signal it needs.
   */
  publish(topic: string, payload: unknown): void {
    const seq = this.sequenceOf(topic) + 1;
    this.sequences.set(topic, seq);
    for (const session of this.sessions) {
      if (!session.wants(topic)) {
        continue;
      }
      session.deliver(topic, seq, payload);
    }
  }

  /**
   * End every session, because this server is stopping.
   *
   * Iterated over a copy: ending a session removes it from the set, and a set
   * being written to while it is walked is how one of them gets missed.
   */
  closeAll(message: string): void {
    for (const session of [...this.sessions]) {
      session.end(message);
    }
    this.sessions.clear();
  }
}
