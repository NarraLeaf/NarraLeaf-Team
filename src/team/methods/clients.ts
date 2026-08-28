/**
 * Saying which installation is on the other end, and asking who else is.
 *
 * A link session already knows **who** is calling - the token says so, and it is
 * re-read on every call. What it does not know is **which machine**, and one
 * person is routinely two: the desktop and the laptop, or two windows of one
 * build being driven side by side during an acceptance run. Everything that
 * follows in this protocol - a live session's membership, a broadcast reaching
 * the right sockets, a record saying what wrote it - needs the machine rather
 * than the person.
 *
 * So a client says so, once, as soon as its session opens, and again whenever
 * what it has open changes. The id is the client's own and it keeps it across
 * restarts; nothing here invents one, because an id this server made would be
 * new on every reconnect and would therefore identify a socket rather than an
 * installation.
 *
 * **Nothing announced here is stored.** See src/team/presence.ts for why.
 */
import { findProjectById } from "../../projects/registry.js";
import { InstanceTakenError, TooManyInstancesError } from "../presence.js";
import {
  MethodError,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  ANCHOR_FIELD_LIMIT,
  INSTANCE_FIELD_LIMIT,
  TEAM_METHODS,
} from "../protocol.js";

/** The most an id may be, which is more than any id this server issues. */
const ID_LIMIT = 128;

export function clientMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.clientsAnnounce,
      capability: "clients",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const project = optionalText(read, "project", ID_LIMIT);
        // A project named here is checked, where an anchor never is. The
        // difference is that this one is a key everybody else's subscription is
        // built on: an instance parked on a project id nobody has would be a
        // presence nothing could ever see, which reads to its owner as being
        // invisible rather than as having typed something wrong.
        if (project !== undefined && findProjectById(context.options.database, project) === undefined) {
          throw new MethodError("not-found", "there is no project of that id on this server");
        }
        // Bounded as an anchor field is, and for the same reason: it is a
        // revision as the client writes one, and this server never reads it.
        const revision = optionalText(read, "revision", ANCHOR_FIELD_LIMIT);
        try {
          return {
            client: context.presence.announce(context.connection.id, context.account.username, {
              id: requiredText(read, "instance", ID_LIMIT),
              label: requiredText(read, "label", INSTANCE_FIELD_LIMIT),
              agent: requiredText(read, "agent", INSTANCE_FIELD_LIMIT),
              ...(project === undefined ? {} : { project }),
              ...(revision === undefined ? {} : { revision }),
            }),
          };
        } catch (error) {
          if (error instanceof TooManyInstancesError) {
            throw new MethodError("refused", error.message);
          }
          if (error instanceof InstanceTakenError) {
            // A collision rather than a want of authority, which is what the
            // client can act on: an installation that has ended up sharing an
            // id - two copies of one Studio directory, most likely - announces
            // a fresh one and carries on, where a refusal would read as this
            // account not being allowed to say what machine it is on.
            throw new MethodError("conflict", error.message);
          }
          throw error;
        }
      },
    },
    {
      name: TEAM_METHODS.clientsWithdraw,
      capability: "clients",
      handle: (params: unknown, context: MethodContext) => {
        // Never refused, including for a project nothing was ever announced
        // about: the state the caller wanted is the state there is, which is the
        // rule leaving a room and dropping a subscription both follow.
        context.presence.withdraw(
          context.connection.id,
          requiredText(paramsObject(params), "project", ID_LIMIT),
        );
        // An object with nothing in it rather than null, so that a client reads
        // every method's answer the same way: `result.value` is always an
        // object, never a value it has to tell apart from a handler that built
        // no body at all.
        return {};
      },
    },
    {
      name: TEAM_METHODS.clientsList,
      capability: "clients",
      handle: (params: unknown, context: MethodContext) => {
        const project = optionalText(paramsObject(params), "project", ID_LIMIT);
        // Not checked here, unlike the announcement: asking about a project that
        // is not on this server is a question with an honest answer - nobody -
        // and a client polling one that was just taken off should be told that
        // rather than handed a refusal it has to interpret.
        return {
          clients: project === undefined
            ? context.presence.clients()
            : context.presence.clients(project),
        };
      },
    },
  ];
}
