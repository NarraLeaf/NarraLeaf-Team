/**
 * Asking for access, and answering: the methods over src/collab/access.ts.
 *
 * Whoever decides is told by a notification, and every session concerned by an
 * `access-request` event on the projects topic, so a list on screen moves. An
 * approval grants exactly as the members and admin methods would — the same
 * write, the same recheck of open sessions, the same announcements — so a role
 * given by answering a request is no different from one given by hand.
 */
import {
  AccessRefusal,
  accessView,
  boundedText,
  createAccessRequest,
  deciderIds,
  discoverableProjects,
  findAccessRequest,
  listAccessRequests,
  mayDecide,
  requesterSees,
  settleAccessRequest,
  type AccessRecord,
} from "../../collab/access.js";
import { notify } from "../../collab/notifications.js";
import { adminUserBody } from "../../identity/answers.js";
import { findUserById, setProjectCreator } from "../../identity/users.js";
import { findProjectMember, setProjectMember } from "../../projects/members.js";
import { findProject } from "../../projects/registry.js";
import { projectMemberBody } from "../../projects/answers.js";
import { boundedCount, flag, MethodError, oneOf, optionalText, paramsObject, requiredText, type MethodContext, type TeamMethod } from "../methods.js";
import {
  accountNotificationsTopic,
  ACCESS_REQUEST_MESSAGE_LIMIT,
  TEAM_ACCESS_REQUEST_KINDS,
  TEAM_METHODS,
  TOPIC_ADMIN_USERS,
  TOPIC_PROJECTS,
  type TeamAccessRequest,
  type TeamNotification,
  type TeamProjectsEvent,
} from "../protocol.js";
import { announceMembers, grantParam, keepAnOwner } from "./projects.js";

const ID_LIMIT = 128;
const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 200;
/** The longest a message or a note may be as it arrives, before the store's own byte bound. */
const TEXT_LIMIT = ACCESS_REQUEST_MESSAGE_LIMIT;

function refused(error: unknown): never {
  if (error instanceof AccessRefusal) throw new MethodError(error.code, error.message);
  throw error;
}

function tellAccounts(context: MethodContext, written: Map<string, TeamNotification>): void {
  for (const [accountId, notification] of written) {
    context.publish(accountNotificationsTopic(accountId), { kind: "notification", notification }, new Set([accountId]));
  }
}

/** Tell whoever asked and whoever decides that a request moved. */
function announce(context: MethodContext, record: AccessRecord, request: TeamAccessRequest): void {
  const audience = deciderIds(context.options.database, record);
  audience.add(record.userId);
  context.publish(TOPIC_PROJECTS, { kind: "access-request", request } satisfies TeamProjectsEvent, audience);
}

/** A request the caller may see: its own, or one it decides. */
function visibleRequest(context: MethodContext, id: unknown): AccessRecord {
  if (typeof id !== "number" || !Number.isInteger(id)) throw new MethodError("bad-params", "id is a request's number");
  const record = findAccessRequest(context.options.database, id);
  if (record === undefined || (record.userId !== context.user.id && !mayDecide(context.options.database, context.user, record))) {
    throw new MethodError("not-found", "there is no access request of that id");
  }
  return record;
}

function summaryOf(request: TeamAccessRequest): string {
  const what = request.kind === "creator" ? "leave to make projects" : `${request.role ?? ""} in ${request.projectName ?? ""}`;
  return request.message === undefined ? what : `${what}: ${request.message}`;
}

export function accessMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.projectsDiscover,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const limit = boundedCount(paramsObject(params), "limit", 500, 1000);
        return {
          projects: discoverableProjects(context.options.database, context.user, limit).map((project) => ({
            id: project.id,
            name: project.name,
            ...(project.description === "" ? {} : { description: project.description }),
          })),
        };
      },
    },
    {
      name: TEAM_METHODS.accessRequestsList,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectRef = optionalText(read, "project", ID_LIMIT);
        const database = context.options.database;
        const project = projectRef === undefined ? undefined : findProject(database, projectRef);
        if (projectRef !== undefined && project === undefined) {
          throw new MethodError("not-found", "there is no project of that id on this server");
        }
        const lists = listAccessRequests(database, context.user, {
          all: flag(read, "all", false),
          ...(project === undefined ? {} : { project: project.id }),
          limit: boundedCount(read, "limit", DEFAULT_LIMIT, MAXIMUM_LIMIT),
        });
        return {
          mine: lists.mine.map((record) => accessView(database, record)),
          toDecide: lists.toDecide.map((record) => accessView(database, record)),
        };
      },
    },
    {
      name: TEAM_METHODS.accessRequestsCreate,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const kind = oneOf(read, "kind", TEAM_ACCESS_REQUEST_KINDS, "project");
        const message = optionalText(read, "message", TEXT_LIMIT);
        const database = context.options.database;
        let record: AccessRecord;
        try {
          if (kind === "creator") {
            record = createAccessRequest(database, context.user, { kind, ...(message === undefined ? {} : { message }) });
          } else {
            const projectId = requiredText(read, "project", ID_LIMIT);
            const grant = grantParam(read, "editor");
            record = createAccessRequest(database, context.user, {
              kind,
              projectId,
              role: grant.role,
              areas: grant.areas ?? undefined,
              ...(grant.template === undefined ? {} : { template: grant.template }),
              ...(message === undefined ? {} : { message }),
            });
          }
        } catch (error) {
          refused(error);
        }
        const request = accessView(database, record);
        announce(context, record, request);
        tellAccounts(
          context,
          notify(database, deciderIds(database, record), {
            kind: "access-requested",
            ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
            ref: `access:${record.id}`,
            actorId: context.user.id,
            summary: summaryOf(request),
          }),
        );
        return { request };
      },
    },
    {
      name: TEAM_METHODS.accessRequestsDecide,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const database = context.options.database;
        const record = visibleRequest(context, read["id"]);
        if (!mayDecide(database, context.user, record)) {
          throw new MethodError(
            "refused",
            record.kind === "creator" ? "only an operator decides who may make projects" : "only an owner of this project decides who joins it",
          );
        }
        if (record.status !== "pending") {
          throw new MethodError("conflict", `this request was already ${record.status}`);
        }
        const approve = read["approve"];
        if (typeof approve !== "boolean") throw new MethodError("bad-params", "approve has to be true or false");
        let note: string | undefined;
        try {
          note = boundedText(optionalText(read, "note", TEXT_LIMIT), "note");
        } catch (error) {
          refused(error);
        }
        const requester = findUserById(database, record.userId);
        if (requester === undefined) throw new MethodError("not-found", "the account that asked is gone");

        let settled: AccessRecord;
        if (!approve) {
          settled = settleAccessRequest(database, record, { status: "denied", by: context.user.id, ...(note === undefined ? {} : { note }) });
        } else if (record.kind === "creator") {
          const user = setProjectCreator(database, requester.username, true);
          context.publish(TOPIC_ADMIN_USERS, { kind: "user-creator-set", user: adminUserBody(user) });
          settled = settleAccessRequest(database, record, { status: "approved", by: context.user.id, ...(note === undefined ? {} : { note }) });
        } else {
          const project = record.projectId === undefined ? undefined : findProject(database, record.projectId);
          if (project === undefined || record.role === undefined) throw new MethodError("not-found", "the project asked about is gone");
          // What the owner grants: what was asked, unless they name something else.
          const changed = read["template"] !== undefined || read["role"] !== undefined || read["areas"] !== undefined;
          const grant = changed ? grantParam(read) : { role: record.role, areas: record.role === "editor" ? (record.areas ?? null) : undefined };
          if (grant.role !== "owner") keepAnOwner(context, project, requester);
          const member = setProjectMember(database, {
            projectId: project.id,
            userId: requester.id,
            role: grant.role,
            addedBy: context.user.id,
            ...(grant.areas === undefined ? {} : { areas: grant.areas }),
          });
          context.recheck?.(requester.id);
          const body = projectMemberBody(context.options, member);
          if (body !== undefined) announceMembers(context, project, { kind: "member-set", member: body }, requester);
          const held = findProjectMember(database, project.id, requester.id);
          settled = settleAccessRequest(database, record, {
            status: "approved",
            by: context.user.id,
            ...(note === undefined ? {} : { note }),
            grantedRole: member.role,
            grantedAreas: held?.areas,
          });
        }
        const request = accessView(database, settled);
        announce(context, settled, request);
        tellAccounts(
          context,
          notify(database, [settled.userId], {
            kind: "access-decided",
            // Named only to somebody who may read the project now: a denied
            // newcomer is told by the summary instead, and the notification
            // is not dropped for naming a project they cannot see.
            ...(settled.projectId !== undefined && requesterSees(database, settled) ? { projectId: settled.projectId } : {}),
            ref: `access:${settled.id}`,
            actorId: context.user.id,
            summary: `${settled.status}: ${summaryOf(request)}${note === undefined ? "" : ` — ${note}`}`,
          }),
        );
        return { request };
      },
    },
    {
      name: TEAM_METHODS.accessRequestsWithdraw,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const database = context.options.database;
        const record = visibleRequest(context, paramsObject(params)["id"]);
        if (record.userId !== context.user.id) throw new MethodError("refused", "only whoever asked may withdraw a request");
        if (record.status !== "pending") {
          return { request: accessView(database, record) };
        }
        const settled = settleAccessRequest(database, record, { status: "withdrawn" });
        const request = accessView(database, settled);
        announce(context, settled, request);
        return { request };
      },
    },
  ];
}
