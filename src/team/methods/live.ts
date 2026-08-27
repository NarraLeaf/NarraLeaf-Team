/**
 * Rooms: opening one, joining one, and saying something in it.
 *
 * This is the half of the protocol that exists for something that has not been
 * built yet, and it is worth being plain about what it is and is not.
 *
 * **What it is.** A way for the people editing one project at one moment to find
 * each other, and a way for this server to carry what one of them says to
 * exactly the others. That is the piece a real-time feature cannot supply for
 * itself and cannot be added to later without changing how everything connects:
 * addressing, membership and a delivery path.
 *
 * **What it is not.** It is not a document, a model of edits, or an opinion
 * about conflicts. `live.say` takes a payload it never reads and hands it on
 * unchanged. When Studio grows an operation model, this file does not change.
 *
 * **Nothing said here is kept.** A message is delivered to whoever is subscribed
 * at that instant and forgotten; a client that was not connected missed it and
 * has nothing to re-read. That is deliberate and it is why the room may be
 * memory: everything that had to survive the room is written through
 * `overlay.put` or pushed to the repository. If a future feature needs an
 * ordered, replayable stream per document, **that is a change to the frames this
 * protocol is made of and the version number goes with it** - it is not
 * something to smuggle in by making this durable.
 */
import { findProjectById } from "../../projects/registry.js";
import {
  callingInstance,
  MethodError,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  NoSuchLiveSessionError,
  TooManyLiveSessionsError,
  WrongLiveCodeError,
  type TeamPresence,
} from "../presence.js";
import {
  ANCHOR_FIELD_LIMIT,
  INSTANCE_FIELD_LIMIT,
  LIVE_PAYLOAD_LIMIT,
  TEAM_METHODS,
  type TeamLiveJoinRule,
  type TeamLiveMessage,
} from "../protocol.js";

const ID_LIMIT = 128;

/** The project named by a call, checked, because a room hangs off a real one. */
function project(context: MethodContext, params: Record<string, unknown>): string {
  const id = requiredText(params, "project", ID_LIMIT);
  if (findProjectById(context.options.database, id) === undefined) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return id;
}

/**
 * The room a call names, insisting it is open.
 *
 * Read before the caller's own instance is resolved, because **the room is what
 * says which project this call is about** - and the project is what an instance
 * is found by. A client naming a room it is not in still gets an honest "there
 * is no such room" rather than a complaint about announcing.
 */
function room(presence: TeamPresence, id: string): { project: string } {
  const session = presence.liveSession(id);
  if (session === undefined) {
    throw new MethodError("not-found", "there is no live session of that id on this server");
  }
  return session;
}

/**
 * The room one code belongs to, insisting there is one.
 *
 * ⚠ **The same answer a code that is simply wrong gets**, and that is deliberate:
 * "there is no room with those digits" and "there is a room and this is not its
 * code" are the same sentence to whoever typed them, and telling the two apart
 * would turn ten thousand guesses into a map of which rooms exist.
 */
function byCode(presence: TeamPresence, code: string): string {
  const session = presence.liveByCode(code);
  if (session === undefined) {
    throw new MethodError("not-found", "there is no live session with that code on this server");
  }
  return session.id;
}

/**
 * The rule a call asked for, or undefined where it said nothing.
 *
 * A word out of a closed set rather than free text, checked here because a client
 * may say anything: a rule this server does not know would be stored and then
 * govern nothing, which is worse than a refusal in the one direction that matters.
 */
function joinRule(read: Record<string, unknown>): TeamLiveJoinRule | undefined {
  const rule = read["rule"];
  if (rule === undefined || rule === null) {
    return undefined;
  }
  if (rule !== "open" && rule !== "code") {
    throw new MethodError("bad-params", "a live session's rule is open or code");
  }
  return rule;
}

/** Turn the registry's own refusals into ones the protocol carries. */
function translate(error: unknown): never {
  if (error instanceof NoSuchLiveSessionError) {
    throw new MethodError("not-found", error.message);
  }
  if (error instanceof WrongLiveCodeError) {
    throw new MethodError("refused", error.message);
  }
  if (error instanceof TooManyLiveSessionsError) {
    throw new MethodError("refused", error.message);
  }
  throw error;
}

export function liveMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.liveList,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const id = project(context, paramsObject(params));
        // Asked on behalf of this window, because what it may see depends on which
        // rooms it is in: a `code` room is not listed to anybody else. `undefined`
        // for a connection that never announced, which sees only the open ones -
        // it is in nothing, so there is nothing it is being kept out of.
        const instance = context.presence.instanceOn(context.connection.id, id);
        return { sessions: context.presence.live(id, instance?.id) };
      },
    },
    {
      name: TEAM_METHODS.liveOpen,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = project(context, read);
        const instance = callingInstance(context, id);
        // The one thing a room may not be opened without. The people in one
        // apply each other's operations to a document, which means nothing
        // unless they all began from the same document, and this is what names
        // that starting point. Opened without it, the room's members would have
        // no way of telling whether their texts agreed, and every operation
        // after the first would land somewhere slightly different - silently,
        // since nothing in this protocol compares them. Still unread here: it is
        // carried so that the clients can compare it, as `title` is carried so
        // that a person can read it.
        const revision = requiredText(read, "revision", ANCHOR_FIELD_LIMIT);
        // The other thing a room may not be opened without, and required for a
        // reason of its own rather than as a second copy of the one above: the
        // revision says which text the members started from, this says which
        // document of it they are editing. Left out, a joiner has nothing to go
        // on but its own copy - so it can only ever follow a document it
        // already has, and two people can agree about the version while
        // applying each other's operations to different files. Unread here, as
        // everything anchor-shaped on this server is.
        const story = requiredText(read, "story", ANCHOR_FIELD_LIMIT);
        const title = optionalText(read, "title", INSTANCE_FIELD_LIMIT);
        // How people get in, defaulting to the way every room worked before there
        // was a choice - so a client that says nothing opens the room it always did.
        const rule = joinRule(read);
        try {
          // ⚠ The code is answered HERE and nowhere else. It is not on the room
          // record, because that record goes out on the project's topic to
          // everybody watching the project.
          const opened = context.presence.open(instance, {
            project: id,
            revision,
            story,
            ...(title === undefined ? {} : { title }),
            ...(rule === undefined ? {} : { rule }),
          });
          return { session: opened.session, code: opened.code };
        } catch (error) {
          translate(error);
        }
      },
    },
    {
      name: TEAM_METHODS.liveJoin,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        // Two ways to say which room, because a code exists to be used by somebody
        // who has neither the id nor the project: they were read four digits. The
        // id remains the ordinary way in for a room anybody can see.
        const code = optionalText(read, "code", ID_LIMIT);
        const id = code === undefined
          ? requiredText(read, "session", ID_LIMIT)
          : byCode(context.presence, code);
        const instance = callingInstance(context, room(context.presence, id).project);
        try {
          return { session: context.presence.join(instance, id, code) };
        } catch (error) {
          translate(error);
        }
      },
    },
    {
      name: TEAM_METHODS.liveRule,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = requiredText(read, "session", ID_LIMIT);
        const rule = joinRule(read);
        if (rule === undefined) {
          throw new MethodError("bad-params", "live.rule needs a rule of open or code");
        }
        const instance = callingInstance(context, room(context.presence, id).project);
        let changed: boolean;
        try {
          changed = context.presence.setRule(instance.id, id, rule);
        } catch (error) {
          translate(error);
        }
        if (!changed) {
          // The same answer closing somebody else's room gets, and for the same
          // reason: a room belongs to whoever opened it, and how people get into
          // it is not something a passer-by decides.
          throw new MethodError("refused", "only the window that opened a live session may change how it is joined");
        }
        // Nothing about the room that the caller did not already have. What
        // changed is public on the project's topic; the code is not, and is not
        // re-issued - one room, one code.
        return { rule };
      },
    },
    {
      name: TEAM_METHODS.liveLeave,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        // Never refused, including for a room that is not there and for a session
        // that never announced. The state the caller wanted is the state there
        // is, which is the rule unsubscribing from an unheld topic follows.
        const id = requiredText(paramsObject(params), "session", ID_LIMIT);
        const session = context.presence.liveSession(id);
        if (session === undefined) {
          return {};
        }
        const instance = context.presence.instanceOn(context.connection.id, session.project);
        if (instance !== undefined) {
          context.presence.leave(instance.id, id);
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.liveClose,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "session", ID_LIMIT);
        const instance = callingInstance(context, room(context.presence, id).project);
        let closed: boolean;
        try {
          closed = context.presence.close(instance.id, id);
        } catch (error) {
          translate(error);
        }
        if (!closed) {
          throw new MethodError("refused", "only the installation that opened a live session may close it");
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.liveSay,
      capability: "live",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = requiredText(read, "session", ID_LIMIT);
        const instance = callingInstance(context, room(context.presence, id).project);
        // Membership rather than mere subscription, and the two really differ: a
        // client may subscribe to a room's topic to watch it, and speaking in
        // one is something only the people in it do.
        if (!context.presence.isMember(id, instance.id)) {
          throw new MethodError("refused", "this installation is not in that live session");
        }
        const message: TeamLiveMessage = {
          session: id,
          from: instance.id,
          account: instance.account,
          at: Date.now(),
          payload: payloadOf(read),
        };
        // Sent to everybody subscribed, the speaker included. A client cannot
        // otherwise tell the round trip it made from one it did not, and every
        // real-time protocol that leaves the sender out grows a second path to
        // put them back in.
        context.presence.say(id, message);
        return {};
      },
    },
  ];
}

/**
 * The thing being said, bounded and otherwise untouched.
 *
 * Measured against its JSON rather than against a shape, because there is no
 * shape: this is Studio talking to Studio. The bound is about how much one
 * client may make this server relay to every other, and a client with a document
 * to send has `overlay.put` and the repository.
 */
function payloadOf(params: Record<string, unknown>): unknown {
  const payload = params["payload"];
  if (payload === undefined) {
    throw new MethodError("bad-params", "payload has to be there, even if it is null");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(payload) ?? "null";
  } catch {
    // A cycle, or something JSON cannot hold. It arrived as JSON, so this is
    // close to impossible; refusing beats relaying something that cannot be
    // written back out to the people listening.
    throw new MethodError("bad-params", "payload is not something this server can carry");
  }
  if (Buffer.byteLength(encoded, "utf-8") > LIVE_PAYLOAD_LIMIT) {
    throw new MethodError("bad-params", "payload is larger than this server will relay");
  }
  return payload;
}
