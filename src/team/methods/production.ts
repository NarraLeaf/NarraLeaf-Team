/**
 * Review requests, milestones and webhooks, over a session.
 *
 * What is stored and who may change it is decided in src/collab/; this file
 * reads parameters, asks, announces, notifies and tells the webhooks.
 */
import { ChatRefusal, deleteChat, listChat, sendChat } from "../../collab/chat.js";
import { mentionedAccounts, notify } from "../../collab/notifications.js";
import { recordActivity } from "../../collab/activity.js";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  MilestoneRefusal,
  milestoneView,
  updateMilestone,
} from "../../collab/milestones.js";
import { APPROVAL_STATUSES, ApprovalRefusal, approvalHistory, approvalView, listApprovals, setApproval } from "../../collab/approvals.js";
import { listLocks, lockAsset, LockRefusal, lockView, unlockAsset } from "../../collab/locks.js";
import { deleteFilter, FilterRefusal, listFilters, saveFilter } from "../../collab/filters.js";
import { createReview, findReview, listReviews, REVIEW_STATUSES, ReviewRefusal, reviewView, updateReview } from "../../collab/reviews.js";
import {
  createWebhook,
  deleteWebhook,
  deliverOne,
  emitWebhookEvent,
  findWebhook,
  findWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  redeliver,
  WEBHOOK_DELIVERIES_KEPT,
  webhookDeliveryView,
  WebhookRefusal,
  webhookView,
} from "../../collab/webhooks.js";
import { findUser, isOperator, type UserRecord } from "../../identity/users.js";
import { findProject } from "../../projects/registry.js";
import { projectRole } from "../../projects/members.js";
import {
  boundedCount,
  flag,
  MethodError,
  oneOf,
  optionalText,
  paramsObject,
  projectVisible,
  requiredInteger,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  accountNotificationsTopic,
  ANCHOR_FIELD_LIMIT,
  projectApprovalsTopic,
  projectChatTopic,
  projectLocksTopic,
  projectMilestonesTopic,
  projectReviewsTopic,
  TEAM_METHODS,
  TEAM_WEBHOOK_EVENTS,
  TEAM_WEBHOOK_FORMATS,
  type TeamApprovalsEvent,
  type TeamChatEvent,
  type TeamLocksEvent,
  type TeamMilestonesEvent,
  type TeamNotification,
  type TeamReviewsEvent,
  type TeamWebhookEvent,
} from "../protocol.js";

const ID_LIMIT = 128;
const USERNAME_LIMIT = 64;
const TITLE_LIMIT = 300;
const NOTE_LIMIT = 8 * 1024;
const NAME_LIMIT = 80;

function projectRef(context: MethodContext, reference: string): string {
  const project = findProject(context.options.database, reference);
  if (project === undefined || !projectVisible(context, project.id)) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return project.id;
}

function accountNamed(context: MethodContext, username: string): UserRecord {
  const user = findUser(context.options.database, username);
  if (user === undefined) throw new MethodError("not-found", `there is no account called ${username} on this server`);
  return user;
}

function refused(error: unknown): never {
  if (
    error instanceof ReviewRefusal ||
    error instanceof MilestoneRefusal ||
    error instanceof WebhookRefusal ||
    error instanceof ChatRefusal ||
    error instanceof ApprovalRefusal ||
    error instanceof LockRefusal ||
    error instanceof FilterRefusal
  ) {
    throw new MethodError(error.code, error.message);
  }
  throw error;
}

function tellAccounts(context: MethodContext, written: Map<string, TeamNotification>): void {
  for (const [accountId, notification] of written) {
    context.publish(accountNotificationsTopic(accountId), { kind: "notification", notification }, new Set([accountId]));
  }
}

/** A time in milliseconds, `null` to clear it, or absent. */
function optionalTime(read: Record<string, unknown>, key: string): number | null | undefined {
  const value = read[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MethodError("bad-params", `${key} has to be a time in milliseconds, or null`);
  }
  return value;
}

function requireOperator(context: MethodContext): void {
  if (!isOperator(context.user.groups)) throw new MethodError("refused", "administering this server is for its operators");
}

export function productionMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.chatList,
      capability: "chat",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const before = read["cursor"];
        if (before !== undefined && (typeof before !== "number" || !Number.isInteger(before))) {
          throw new MethodError("bad-params", "cursor has to be the number a page answered with");
        }
        const limit = read["limit"];
        const count = typeof limit === "number" && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
        try {
          return listChat(context.options.database, context.user, projectId, { ...(before === undefined ? {} : { before: before as number }), limit: count });
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.chatSend,
      capability: "chat",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const body = read["body"];
        if (typeof body !== "string") throw new MethodError("bad-params", "a message has a body");
        let message;
        try {
          message = sendChat(context.options.database, context.user, projectId, body);
        } catch (error) {
          refused(error);
        }
        context.publish(projectChatTopic(projectId), { kind: "chat-message", message } satisfies TeamChatEvent);
        // Somebody named in a message hears about it, as in a comment.
        const named = mentionedAccounts(context.options.database, message.body).map((user) => user.id);
        if (named.length > 0) {
          tellAccounts(
            context,
            notify(context.options.database, named, {
              kind: "mention",
              projectId,
              ref: `chat:${message.id}`,
              actorId: context.user.id,
              summary: message.body,
            }),
          );
        }
        return { message };
      },
    },
    {
      name: TEAM_METHODS.chatDelete,
      capability: "chat",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = read["message"];
        if (typeof id !== "number" || !Number.isInteger(id)) throw new MethodError("bad-params", "message is a message's id");
        let record;
        try {
          record = deleteChat(context.options.database, context.user, id);
        } catch (error) {
          refused(error);
        }
        context.publish(projectChatTopic(record.projectId), { kind: "chat-deleted", id, project: record.projectId } satisfies TeamChatEvent);
        return {};
      },
    },
    {
      name: TEAM_METHODS.reviewsList,
      capability: "reviews",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const project = optionalText(read, "project", ID_LIMIT);
        const reviews = listReviews(context.options.database, context.user, {
          ...(project === undefined ? {} : { projectId: projectRef(context, project) }),
          includeClosed: flag(read, "includeClosed", false),
        });
        return { reviews: reviews.map((review) => reviewView(context.options.database, review)) };
      },
    },
    {
      name: TEAM_METHODS.reviewsCreate,
      capability: "reviews",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const reviewer = accountNamed(context, requiredText(read, "reviewer", USERNAME_LIMIT));
        const fromRevision = optionalText(read, "fromRevision", ANCHOR_FIELD_LIMIT);
        const note = optionalText(read, "note", NOTE_LIMIT);
        let review;
        try {
          review = createReview(context.options.database, context.user, {
            projectId,
            reviewerId: reviewer.id,
            ...(fromRevision === undefined ? {} : { fromRevision }),
            toRevision: requiredText(read, "toRevision", ANCHOR_FIELD_LIMIT),
            title: requiredText(read, "title", TITLE_LIMIT),
            ...(note === undefined ? {} : { note }),
          });
        } catch (error) {
          refused(error);
        }
        const view = reviewView(context.options.database, review);
        context.publish(projectReviewsTopic(projectId), { kind: "review-set", review: view } satisfies TeamReviewsEvent);
        tellAccounts(
          context,
          notify(context.options.database, [reviewer.id], {
            kind: "review-requested",
            projectId,
            ref: review.id,
            actorId: context.user.id,
            summary: review.title,
          }),
        );
        recordActivity(context.options.database, { accountId: context.user.id, projectId, kind: "review", ref: review.id, summary: review.title });
        emitWebhookEvent(context.options.database, {
          type: "review-requested",
          projectId,
          actor: context.account.username,
          ref: review.id,
          summary: `${context.account.username} asked ${reviewer.username} to review: ${review.title}`,
        });
        return { review: view };
      },
    },
    {
      name: TEAM_METHODS.reviewsUpdate,
      capability: "reviews",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = requiredText(read, "review", ID_LIMIT);
        const status = oneOf(read, "status", REVIEW_STATUSES);
        const verdictNote = optionalText(read, "verdictNote", NOTE_LIMIT);
        const previous = findReview(context.options.database, id);
        let review;
        try {
          review = updateReview(context.options.database, context.user, id, { status, ...(verdictNote === undefined ? {} : { verdictNote }) });
        } catch (error) {
          refused(error);
        }
        const view = reviewView(context.options.database, review);
        context.publish(projectReviewsTopic(review.projectId), { kind: "review-set", review: view } satisfies TeamReviewsEvent);
        const verdict = status === "approved" || status === "changes";
        if (verdict && previous?.status !== status && review.requesterId !== undefined) {
          tellAccounts(
            context,
            notify(context.options.database, [review.requesterId], {
              kind: "review-answered",
              projectId: review.projectId,
              ref: review.id,
              actorId: context.user.id,
              summary: `${status === "approved" ? "✓" : "✎"} ${review.title}`,
            }),
          );
          emitWebhookEvent(context.options.database, {
            type: "review-answered",
            projectId: review.projectId,
            actor: context.account.username,
            ref: review.id,
            summary: `${context.account.username} ${status === "approved" ? "approved" : "asked for changes to"}: ${review.title}`,
          });
        }
        return { review: view };
      },
    },
    {
      name: TEAM_METHODS.milestonesList,
      capability: "milestones",
      handle: (params: unknown, context: MethodContext) => {
        const projectId = projectRef(context, requiredText(paramsObject(params), "project", ID_LIMIT));
        try {
          return { milestones: listMilestones(context.options.database, context.user, projectId).map((m) => milestoneView(context.options.database, m)) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.milestonesCreate,
      capability: "milestones",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const note = optionalText(read, "note", NOTE_LIMIT);
        const dueAt = optionalTime(read, "dueAt");
        let milestone;
        try {
          milestone = createMilestone(context.options.database, context.user, {
            projectId,
            name: requiredText(read, "name", NAME_LIMIT),
            revision: requiredText(read, "revision", ANCHOR_FIELD_LIMIT),
            ...(note === undefined ? {} : { note }),
            ...(typeof dueAt === "number" ? { dueAt } : {}),
            gate: flag(read, "gate", false),
          });
        } catch (error) {
          refused(error);
        }
        const view = milestoneView(context.options.database, milestone);
        context.publish(projectMilestonesTopic(projectId), { kind: "milestone-set", milestone: view } satisfies TeamMilestonesEvent);
        recordActivity(context.options.database, { accountId: context.user.id, projectId, kind: "milestone", ref: milestone.revision, summary: milestone.name });
        emitWebhookEvent(context.options.database, {
          type: "milestone",
          projectId,
          actor: context.account.username,
          ref: milestone.revision,
          summary: `${context.account.username} marked ${milestone.revision.slice(0, 8)} as “${milestone.name}”`,
        });
        return { milestone: view };
      },
    },
    {
      name: TEAM_METHODS.milestonesDelete,
      capability: "milestones",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "milestone", ID_LIMIT);
        let removed;
        try {
          removed = deleteMilestone(context.options.database, context.user, id);
        } catch (error) {
          refused(error);
        }
        context.publish(projectMilestonesTopic(removed.projectId), { kind: "milestone-removed", milestone: removed.id } satisfies TeamMilestonesEvent);
        return {};
      },
    },
    {
      name: TEAM_METHODS.milestonesUpdate,
      capability: "milestones",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const id = requiredText(read, "milestone", ID_LIMIT);
        const input: { name?: string; revision?: string; note?: string | null; dueAt?: number | null; gate?: boolean } = {};
        if (read["name"] !== undefined) input.name = requiredText(read, "name", NAME_LIMIT);
        if (read["revision"] !== undefined) input.revision = requiredText(read, "revision", ANCHOR_FIELD_LIMIT);
        if (read["note"] !== undefined) input.note = read["note"] === null ? null : (optionalText(read, "note", NOTE_LIMIT) ?? null);
        const dueAt = optionalTime(read, "dueAt");
        if (dueAt !== undefined) input.dueAt = dueAt;
        if (read["gate"] !== undefined) input.gate = flag(read, "gate", false);
        let milestone;
        try {
          milestone = updateMilestone(context.options.database, context.user, id, input);
        } catch (error) {
          refused(error);
        }
        const view = milestoneView(context.options.database, milestone);
        context.publish(projectMilestonesTopic(milestone.projectId), { kind: "milestone-set", milestone: view } satisfies TeamMilestonesEvent);
        return { milestone: view };
      },
    },
    {
      name: TEAM_METHODS.approvalsList,
      capability: "approvals",
      handle: (params: unknown, context: MethodContext) => {
        const projectId = projectRef(context, requiredText(paramsObject(params), "project", ID_LIMIT));
        try {
          return { approvals: listApprovals(context.options.database, context.user, projectId).map((a) => approvalView(context.options.database, a)) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.approvalsHistory,
      capability: "approvals",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const target = requiredText(read, "target", ANCHOR_FIELD_LIMIT);
        try {
          return { changes: approvalHistory(context.options.database, context.user, projectId, target).map((a) => approvalView(context.options.database, a)) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.approvalsSet,
      capability: "approvals",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const note = optionalText(read, "note", NOTE_LIMIT);
        let approval;
        try {
          approval = setApproval(context.options.database, context.user, {
            projectId,
            target: requiredText(read, "target", ANCHOR_FIELD_LIMIT),
            status: oneOf(read, "status", APPROVAL_STATUSES),
            ...(note === undefined ? {} : { note }),
          });
        } catch (error) {
          refused(error);
        }
        const view = approvalView(context.options.database, approval);
        context.publish(projectApprovalsTopic(projectId), { kind: "approval-set", approval: view } satisfies TeamApprovalsEvent);
        if (approval.status === "approved" || approval.status === "changes") {
          recordActivity(context.options.database, {
            accountId: context.user.id,
            projectId,
            kind: approval.status === "approved" ? "approved" : "sent-back",
            ref: approval.target,
            summary: approval.note ?? approval.target,
          });
        }
        return { approval: view };
      },
    },
    {
      name: TEAM_METHODS.assetsLocks,
      capability: "locks",
      handle: (params: unknown, context: MethodContext) => {
        const projectId = projectRef(context, requiredText(paramsObject(params), "project", ID_LIMIT));
        try {
          return { locks: listLocks(context.options.database, context.user, projectId).map((lock) => lockView(context.options.database, lock)) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.assetsLock,
      capability: "locks",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const note = optionalText(read, "note", NAME_LIMIT * 2);
        const minutes = read["minutes"] === undefined ? undefined : requiredInteger(read, "minutes");
        let lock;
        try {
          lock = lockAsset(context.options.database, context.user, {
            projectId,
            assetId: requiredText(read, "asset", ANCHOR_FIELD_LIMIT),
            ...(minutes === undefined ? {} : { minutes }),
            ...(note === undefined ? {} : { note }),
          });
        } catch (error) {
          refused(error);
        }
        const view = lockView(context.options.database, lock);
        context.publish(projectLocksTopic(projectId), { kind: "lock-set", lock: view } satisfies TeamLocksEvent);
        return { lock: view };
      },
    },
    {
      name: TEAM_METHODS.assetsUnlock,
      capability: "locks",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const asset = requiredText(read, "asset", ANCHOR_FIELD_LIMIT);
        let gone;
        try {
          gone = unlockAsset(context.options.database, context.user, projectId, asset);
        } catch (error) {
          refused(error);
        }
        if (gone !== undefined) {
          context.publish(projectLocksTopic(projectId), { kind: "lock-released", project: projectId, asset } satisfies TeamLocksEvent);
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.filtersList,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const scope = optionalText(paramsObject(params), "scope", NAME_LIMIT);
        return { filters: listFilters(context.options.database, context.user, scope) };
      },
    },
    {
      name: TEAM_METHODS.filtersSave,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        try {
          return {
            filter: saveFilter(context.options.database, context.user, {
              scope: requiredText(read, "scope", NAME_LIMIT),
              name: requiredText(read, "name", NAME_LIMIT),
              query: requiredText(read, "query", NOTE_LIMIT),
            }),
          };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.filtersDelete,
      capability: "todos",
      handle: (params: unknown, context: MethodContext) => {
        try {
          deleteFilter(context.options.database, context.user, requiredText(paramsObject(params), "filter", ID_LIMIT));
        } catch (error) {
          refused(error);
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksList,
      capability: "webhooks",
      handle: (_params: unknown, context: MethodContext) => {
        requireOperator(context);
        return { webhooks: listWebhooks(context.options.database).map((hook) => webhookView(context.options.database, hook)) };
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksCreate,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        requireOperator(context);
        const read = paramsObject(params);
        const project = optionalText(read, "project", ID_LIMIT);
        const events = read["events"];
        if (!Array.isArray(events) || !events.every((e) => (TEAM_WEBHOOK_EVENTS as readonly unknown[]).includes(e))) {
          throw new MethodError("bad-params", `events has to be a list of: ${TEAM_WEBHOOK_EVENTS.join(", ")}`);
        }
        let hook;
        try {
          hook = createWebhook(context.options.database, context.user, {
            ...(project === undefined ? {} : { projectId: projectRef(context, project) }),
            url: requiredText(read, "url", 2048),
            format: read["format"] === undefined ? "json" : oneOf(read, "format", TEAM_WEBHOOK_FORMATS),
            events: events as TeamWebhookEvent[],
          });
        } catch (error) {
          refused(error);
        }
        // The secret is said once, here; nothing reads it back.
        return { webhook: webhookView(context.options.database, hook), secret: hook.secret };
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksDelete,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        requireOperator(context);
        deleteWebhook(context.options.database, requiredText(paramsObject(params), "webhook", ID_LIMIT));
        return {};
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksTest,
      capability: "webhooks",
      handle: async (params: unknown, context: MethodContext) => {
        requireOperator(context);
        const hook = findWebhook(context.options.database, requiredText(paramsObject(params), "webhook", ID_LIMIT));
        if (hook === undefined) throw new MethodError("not-found", "there is no webhook of that id");
        const projectId = hook.projectId ?? (context.options.database.prepare("SELECT id FROM projects LIMIT 1").get() as { id?: string } | undefined)?.id ?? "-";
        const status = await deliverOne(context.options.database, hook, {
          type: hook.events[0] ?? "commit",
          projectId,
          actor: context.account.username,
          summary: `test from ${context.account.username}`,
        });
        return { status, ...latestError(context, hook.id) };
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksDeliveries,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        requireOperator(context);
        const read = paramsObject(params);
        const hook = findWebhook(context.options.database, requiredText(read, "webhook", ID_LIMIT));
        if (hook === undefined) throw new MethodError("not-found", "there is no webhook of that id");
        return { deliveries: listWebhookDeliveries(context.options.database, hook.id, boundedCount(read, "limit", 50, WEBHOOK_DELIVERIES_KEPT)).map(webhookDeliveryView) };
      },
    },
    {
      name: TEAM_METHODS.adminWebhooksRedeliver,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        requireOperator(context);
        const again = redeliver(context.options.database, requiredInteger(paramsObject(params), "delivery"));
        if (again === undefined) throw new MethodError("not-found", "there is no delivery of that id");
        return { delivery: webhookDeliveryView(again) };
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksList,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        const projectId = ownedProject(context, paramsObject(params));
        return {
          webhooks: listWebhooks(context.options.database)
            .filter((hook) => hook.projectId === projectId)
            .map((hook) => webhookView(context.options.database, hook)),
        };
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksCreate,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = ownedProject(context, read);
        const events = read["events"];
        if (!Array.isArray(events) || !events.every((e) => (TEAM_WEBHOOK_EVENTS as readonly unknown[]).includes(e))) {
          throw new MethodError("bad-params", `events has to be a list of: ${TEAM_WEBHOOK_EVENTS.join(", ")}`);
        }
        let hook;
        try {
          hook = createWebhook(context.options.database, context.user, {
            projectId,
            url: requiredText(read, "url", 2048),
            format: read["format"] === undefined ? "json" : oneOf(read, "format", TEAM_WEBHOOK_FORMATS),
            events: events as TeamWebhookEvent[],
          });
        } catch (error) {
          refused(error);
        }
        return { webhook: webhookView(context.options.database, hook), secret: hook.secret };
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksDelete,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        const hook = ownedWebhook(context, paramsObject(params));
        deleteWebhook(context.options.database, hook.id);
        return {};
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksTest,
      capability: "webhooks",
      handle: async (params: unknown, context: MethodContext) => {
        const hook = ownedWebhook(context, paramsObject(params));
        const status = await deliverOne(context.options.database, hook, {
          type: hook.events[0] ?? "commit",
          projectId: hook.projectId ?? "-",
          actor: context.account.username,
          summary: `test from ${context.account.username}`,
        });
        return { status, ...latestError(context, hook.id) };
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksDeliveries,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const hook = ownedWebhook(context, read);
        return { deliveries: listWebhookDeliveries(context.options.database, hook.id, boundedCount(read, "limit", 50, WEBHOOK_DELIVERIES_KEPT)).map(webhookDeliveryView) };
      },
    },
    {
      name: TEAM_METHODS.projectsWebhooksRedeliver,
      capability: "webhooks",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const past = findWebhookDelivery(context.options.database, requiredInteger(read, "delivery"));
        if (past === undefined) throw new MethodError("not-found", "there is no delivery of that id");
        ownedWebhook(context, { webhook: past.webhookId });
        const again = redeliver(context.options.database, past.id);
        if (again === undefined) throw new MethodError("not-found", "there is no delivery of that id");
        return { delivery: webhookDeliveryView(again) };
      },
    },
  ];
}

/** Why the latest delivery of a webhook failed, where it did: what a test answers beside the status. */
function latestError(context: MethodContext, webhookId: string): { error?: string } {
  const error = listWebhookDeliveries(context.options.database, webhookId, 1)[0]?.error;
  return error === undefined ? {} : { error };
}

/**
 * The project a call names, where the caller owns it. A server operator counts as owning every
 * project, as everywhere else.
 */
function ownedProject(context: MethodContext, read: Record<string, unknown>): string {
  const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
  if (!isOperator(context.user.groups) && projectRole(context.options.database, projectId, context.user) !== "owner") {
    throw new MethodError("refused", "only this project's owners manage its webhooks");
  }
  return projectId;
}

/** One of a project's webhooks, where the caller owns the project. A server-wide one is the operators'. */
function ownedWebhook(context: MethodContext, read: Record<string, unknown>) {
  const hook = findWebhook(context.options.database, requiredText(read, "webhook", ID_LIMIT));
  if (hook === undefined || hook.projectId === undefined || !projectVisible(context, hook.projectId)) {
    throw new MethodError("not-found", "there is no webhook of that id");
  }
  if (!isOperator(context.user.groups) && projectRole(context.options.database, hook.projectId, context.user) !== "owner") {
    throw new MethodError("refused", "only this project's owners manage its webhooks");
  }
  return hook;
}
