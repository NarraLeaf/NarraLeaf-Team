/**
 * Whether this deployment is a collaboration server, and what follows from it
 * not being one.
 *
 * An operator can decide that their Team server holds projects and is
 * administered and is not a place people work together — see
 * `server.collaboration` in src/identity/settings.ts. Two things follow, and
 * they are different in kind, which is why both are decided here rather than
 * each where it happens to be needed:
 *
 *   - **Four capabilities are not announced.** `comments`, `live`, `overlay` and
 *     `clients` are the coordination plane, and a deployment that is closed to
 *     collaboration does not have one. They are absent from the discovery
 *     document and from the `hello` frame, and every method under them refuses.
 *   - **What is on this server is listed to its operators only.** The project
 *     list, one project, a project's history and the member list are not
 *     capabilities of their own — they are methods under `session`, and a server
 *     answering the socket has `session` by definition. So this is a refusal per
 *     call rather than a capability that disappears, and the refusal says what
 *     happened, because the account it refuses has done nothing wrong and would
 *     otherwise read it as a server that is broken.
 *
 * **The management family is untouched.** The point of the switch is to stop
 * this deployment being used for collaboration, not to stop it being
 * administered: an operator goes on reading the accounts, the settings, the
 * keys, the decisions and the status, and goes on being the one who can turn it
 * back on. That is also why the coordination refusal has no exception for them —
 * an operator has no use for `live.say`, and an exception would be a hole in a
 * switch whose whole purpose is that there is nothing to be found on the other
 * side of it.
 *
 * **A session already open was told a capability list that has since changed,
 * and that window stays.** The gate below is the authority and the capability
 * list is only advice, so the worst a stale list can do is lead a client to call
 * something and be refused — which is the ordinary shape of a refusal and the
 * one thing every client already handles. A new session is told the truth,
 * because the list is worked out when the `hello` frame is written. Nothing here
 * reaches into open sessions to take a capability back: there is no frame that
 * says so, inventing one would be a protocol change for a case a refusal already
 * covers, and a client that believed the old list would have been refused
 * anyway.
 *
 * **Subscriptions held under a capability that has just been turned off are left
 * alone**, and that is a decision rather than an oversight. src/team/session.ts
 * withdraws `admin/*` from a caller who stops being an operator, and it has to:
 * those topics carry what that person may no longer see, and the events go on
 * being published to whoever is left. Here neither is true. A project's threads,
 * overlay, clients and live topics carry nothing an account of this server may
 * not see — every account reaches every project, which is the whole of the
 * authorization model — and with the methods refused there is nothing left to
 * publish on them anyway, so the subscription goes quiet by itself rather than
 * by being taken away. Withdrawing them would mean walking every open session
 * whenever a setting changed, which is the invalidation this design exists to
 * avoid.
 */
import type { DatabaseSync } from "node:sqlite";

import { COLLABORATION_KEY, storedCollaboration } from "../identity/settings.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import { TEAM_METHODS, type TeamCapability } from "./protocol.js";

/**
 * The capabilities a deployment closed to collaboration does not have.
 *
 * One list, read both by what is announced and by what is refused, so that a
 * capability cannot be left out of the discovery document while its methods go
 * on answering, or the other way about.
 */
export const COORDINATION_CAPABILITIES: readonly TeamCapability[] = [
  "comments",
  "clients",
  "live",
  "overlay",
];

/**
 * The methods that say what is on this server.
 *
 * Reads rather than writes, and named one at a time rather than derived from
 * their capability, because they have no capability of their own to be derived
 * from: they are the `session` methods, and `session` is the one capability that
 * cannot be withdrawn.
 */
const LISTING_METHODS: readonly string[] = [
  TEAM_METHODS.projectsList,
  TEAM_METHODS.projectsGet,
  TEAM_METHODS.projectsHistory,
  TEAM_METHODS.membersList,
];

/** What a call turned out to be, in the shape a topic's verdict already takes. */
export type CollaborationVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly detail: string };

/** Whether this deployment is a collaboration server, as it stands now. */
export function collaborationOpen(database: DatabaseSync): boolean {
  return storedCollaboration(database) === "open";
}

/**
 * Everything this deployment would announce, less what a closed one does not
 * have.
 *
 * Given the whole set and answering with it, rather than being asked about one
 * capability at a time, so that the caller cannot filter half a list.
 */
export function withoutCoordination(
  capabilities: Iterable<TeamCapability>,
): Set<TeamCapability> {
  const kept = new Set(capabilities);
  for (const capability of COORDINATION_CAPABILITIES) {
    kept.delete(capability);
  }
  return kept;
}

/**
 * Whether this call may be answered at all on this deployment.
 *
 * Asked of every call, after the caller has been identified and before the
 * handler is reached — see src/team/session.ts. Reading the setting is a row
 * from a database this process already holds open, which is what makes asking
 * each time affordable and what keeps the answer current: a deployment closed
 * over ssh a second ago refuses the next call rather than the next restart.
 *
 * A refusal names the setting. The person reading it is either an operator, who
 * can act on it directly, or an author, who now knows what to ask for instead of
 * filing a bug against a server that looks broken.
 */
export function judgeCollaboration(
  database: DatabaseSync,
  user: UserRecord,
  method: { readonly name: string; readonly capability: TeamCapability },
): CollaborationVerdict {
  if (collaborationOpen(database)) {
    return { kind: "allowed" };
  }
  if (COORDINATION_CAPABILITIES.includes(method.capability)) {
    return {
      kind: "refused",
      detail:
        `this server is closed to collaboration, so ${method.name} is not served here. Its ` +
        `operators decide that with the ${COLLABORATION_KEY} setting.`,
    };
  }
  if (LISTING_METHODS.includes(method.name) && !isOperator(user.groups)) {
    return {
      kind: "refused",
      detail:
        "this server is closed to collaboration, so only its operators may read what is on " +
        `it. Ask an operator to set ${COLLABORATION_KEY} to open if you are meant to be ` +
        "working here.",
    };
  }
  return { kind: "allowed" };
}
