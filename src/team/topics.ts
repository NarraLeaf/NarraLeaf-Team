/**
 * What a session may ask to be told about.
 *
 * A topic is a string a client sends and this server matches. Two things have to
 * be decided about one before it becomes a subscription, and they are different
 * questions that are easy to run together:
 *
 *   - **Is it a topic at all?** A name nobody publishes on is a subscription
 *     that would never fire, and a client holding one would wait forever for an
 *     event rather than being told it asked for something that does not exist.
 *   - **May this caller have it?** For anything about a project the answer is
 *     yes for every account of this server, because that is the whole of the
 *     authorization model: every account reaches every project - see
 *     src/projects/registry.ts. The `admin/*` topics are the exception, and the
 *     reason this question is asked at all: they carry the accounts, the
 *     settings, the keys and the refusals, and they are an operator's business.
 *
 * A topic that names a project checks the project exists. Not for secrecy - the
 * list is the same list for everybody - but because a subscription to a project
 * that was taken off this server is a client waiting on something that will not
 * happen, and saying so is cheaper than never answering.
 */
import type { DatabaseSync } from "node:sqlite";

import { findProjectById } from "../projects/registry.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import type { TeamPresence } from "./presence.js";
import {
  TOPIC_ADMIN_KEYS,
  TOPIC_ADMIN_REFUSALS,
  TOPIC_ADMIN_SETTINGS,
  TOPIC_ADMIN_USERS,
  TOPIC_PROJECTS,
} from "./protocol.js";

/** What a topic turned out to be. */
export type TopicVerdict =
  | { readonly kind: "allowed" }
  /** There is no such topic on this server. */
  | { readonly kind: "unknown"; readonly detail: string }
  /** There is, and this caller may not have it. */
  | { readonly kind: "refused"; readonly detail: string };

/** How many topics one session may hold at once. */
export const SUBSCRIPTION_LIMIT = 64;

/** The prefix a per-project topic starts with. */
const PROJECT_PREFIX = "project:";

/** What may hang off one project, after the id. */
const PROJECT_SUFFIXES: readonly string[] = ["", "/threads", "/overlay", "/clients", "/live"];

/** The prefix a live session's own topic starts with. */
const LIVE_PREFIX = "live:";

/** The prefix every topic about this server itself starts with. */
export const ADMIN_PREFIX = "admin/";

/** Every topic under that prefix, which is the whole set an operator may hold. */
const ADMIN_TOPICS: readonly string[] = [
  TOPIC_ADMIN_USERS,
  TOPIC_ADMIN_SETTINGS,
  TOPIC_ADMIN_KEYS,
  TOPIC_ADMIN_REFUSALS,
];

/** Whether `topic` is one of this server's own, whoever is asking for it. */
export function isAdminTopic(topic: string): boolean {
  return topic.startsWith(ADMIN_PREFIX);
}

/**
 * Whether this session may subscribe to `topic`.
 *
 * The caller is read for the `admin/*` topics and for nothing else, which is
 * the shape of the authorization model rather than an accident of what has been
 * written so far.
 */
export function judgeTopic(
  database: DatabaseSync,
  user: UserRecord,
  topic: string,
  presence?: TeamPresence,
): TopicVerdict {
  if (topic === TOPIC_PROJECTS) {
    return { kind: "allowed" };
  }

  if (isAdminTopic(topic)) {
    // Existence before permission, deliberately in that order. A name under
    // this prefix that nothing publishes on is a mistake in a client whoever
    // holds the socket, and saying "you may not" to somebody asking for a topic
    // that does not exist would send them looking for a role rather than for
    // their typo. There is nothing secret here that the capability list does
    // not already say: it announces to every session that this server can be
    // administered, and refuses everybody who is not an operator.
    if (!ADMIN_TOPICS.includes(topic)) {
      return { kind: "unknown", detail: `${topic} is not something this server publishes` };
    }
    if (!isOperator(user.groups)) {
      return { kind: "refused", detail: "what this server is doing is for its operators" };
    }
    return { kind: "allowed" };
  }

  if (topic.startsWith(LIVE_PREFIX)) {
    // Existence, not membership. Subscribing is hearing and joining is being
    // counted, and they are different acts: a client subscribes so that the
    // events it is about to be sent are not missed between joining and the
    // subscription landing, which would be a race it could not win the other way
    // round. Speaking is where membership is checked - see methods/live.ts.
    //
    // A build with no live sessions has no presence to ask, and a topic naming
    // one is then a topic nobody publishes on.
    const id = topic.slice(LIVE_PREFIX.length);
    if (presence?.liveSession(id) === undefined) {
      return { kind: "unknown", detail: "there is no live session of that id on this server" };
    }
    return { kind: "allowed" };
  }

  if (topic.startsWith(PROJECT_PREFIX)) {
    const rest = topic.slice(PROJECT_PREFIX.length);
    // Split at the first separator rather than the last: a project id never
    // contains one, and reading it from the right would let a topic invent an
    // id out of a suffix nobody serves.
    const separator = rest.indexOf("/");
    const projectId = separator === -1 ? rest : rest.slice(0, separator);
    const suffix = separator === -1 ? "" : rest.slice(separator);
    if (!PROJECT_SUFFIXES.includes(suffix)) {
      return { kind: "unknown", detail: `${topic} is not something this server publishes` };
    }
    if (findProjectById(database, projectId) === undefined) {
      return { kind: "unknown", detail: "there is no project of that id on this server" };
    }
    return { kind: "allowed" };
  }

  return { kind: "unknown", detail: `${topic} is not something this server publishes` };
}
