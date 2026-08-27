/**
 * Whether this deployment is a collaboration server, and what follows from it
 * not being one.
 *
 * An operator can decide that their Team server holds projects and is
 * administered and is not a place people work together — see
 * `server.collaboration` in src/identity/settings.ts. The question that decides
 * what goes with it is whether the thing is a remote-collaboration service, and
 * three things answer yes, differing in kind — which is why all three are
 * decided here rather than each where it happens to be needed:
 *
 *   - **Five capabilities are not announced.** `comments`, `live`, `overlay`,
 *     `clients` and `blobs` are the coordination plane, and a deployment that is
 *     closed to collaboration does not have one. They are absent from the
 *     discovery document and from the `hello` frame, and every method under them
 *     refuses.
 *   - **The projects on this server are its operators' business.** The project
 *     list, one project, a project's history and the member list — and making a
 *     project or taking one off — are not capabilities of their own: they are
 *     methods under `session`, and a server answering the socket has `session` by
 *     definition. So this is a refusal per call rather than a capability that
 *     disappears, and the refusal says what happened, because the account it
 *     refuses has done nothing wrong and would otherwise read it as a server that
 *     is broken. The writes are in the list for a sharper reason than symmetry: a
 *     closed server that still let an ordinary account make a project on it would
 *     be accepting collaboration, and accepting a write whose result the same
 *     account then cannot see.
 *   - **The blob addresses are not served.** They are HTTP rather than a method,
 *     so no method table gates them and the capability going quiet would not stop
 *     them; {@link judgeBlobRoute} is how they are shut, and the note on it says
 *     why it reads the setting itself.
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
 *
 * `blobs` is in it although no method carries it: it names the addresses a live
 * session's files travel over, which are HTTP rather than calls. Leaving it out
 * would have announced a file transfer on a deployment that serves no live
 * session to transfer one for.
 */
export const COORDINATION_CAPABILITIES: readonly TeamCapability[] = [
  "comments",
  "clients",
  "live",
  "overlay",
  "blobs",
];

/**
 * The methods a closed deployment keeps for its operators.
 *
 * Named one at a time rather than derived from their capability, because they
 * have no capability of their own to be derived from: they are the `session`
 * methods, and `session` is the one capability that cannot be withdrawn.
 *
 * Reads and writes both. What is on this server, and what may be put on it or
 * taken off it, are the same question about the same thing, and a list holding
 * only the reads would leave an ordinary account able to make a project on a
 * server it cannot then list.
 */
const KEPT_FOR_OPERATORS: readonly string[] = [
  TEAM_METHODS.projectsList,
  TEAM_METHODS.projectsGet,
  TEAM_METHODS.projectsHistory,
  TEAM_METHODS.projectsCreate,
  TEAM_METHODS.projectsForget,
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
  if (KEPT_FOR_OPERATORS.includes(method.name) && !isOperator(user.groups)) {
    return {
      kind: "refused",
      detail:
        "this server is closed to collaboration, so what is on it is its operators' to read " +
        `and to change. Ask an operator to set ${COLLABORATION_KEY} to open if you are meant ` +
        "to be working here.",
    };
  }
  return { kind: "allowed" };
}

/**
 * Whether the addresses a live session's files travel over are served here.
 *
 * Asked as each blob request arrives, and asked of the setting rather than of
 * anything worked out earlier — which is the whole point of it being a second
 * gate rather than a consequence of the first two.
 *
 * The capability going quiet stops a client that checks before asking, and the
 * methods refusing stops a new transfer being agreed. Neither shuts this door.
 * An installation that announced itself while the deployment was still open
 * keeps its entry in presence until its socket closes — see
 * src/team/presence.ts — and src/web/blobs.ts admits a request from exactly such
 * an installation, so a transfer id agreed a minute before the switch would go
 * on being served afterwards by a server that had stopped announcing it could.
 * A switch that looks effective and is not is worse than no switch, so the route
 * reads the setting as it stands at the moment of the request, which is the one
 * thing that cannot be stale.
 *
 * Presence is deliberately not touched. Dropping announcements when a setting
 * changed would mean walking every open session, which is the invalidation this
 * design avoids, and it would say those installations had closed the project
 * when they had not.
 */
export function judgeBlobRoute(database: DatabaseSync): CollaborationVerdict {
  if (collaborationOpen(database)) {
    return { kind: "allowed" };
  }
  return {
    kind: "refused",
    detail:
      "this server is closed to collaboration, so it carries no files for a live session. " +
      `Its operators decide that with the ${COLLABORATION_KEY} setting.`,
  };
}
