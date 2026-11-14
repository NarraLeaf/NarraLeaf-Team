/**
 * Review requests, milestones and webhooks, over a session.
 *
 * What is stored and who may change it is decided in src/collab/; this file
 * reads parameters, asks, announces, notifies and tells the webhooks.
 */
import { notify } from "../../collab/notifications.js";
import { recordActivity } from "../../collab/activity.js";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  MilestoneRefusal,
  milestoneView,
} from "../../collab/milestones.js";
import { createReview, findReview, listReviews, REVIEW_STATUSES, ReviewRefusal, reviewView, updateReview } from "../../collab/reviews.js";
import {
  createWebhook,
  deleteWebhook,
  deliverOne,
  emitWebhookEvent,
  findWebhook,
  listWebhooks,
  WebhookRefusal,
  webhookView,
} from "../../collab/webhooks.js";
import { findUser, isOperator, type UserRecord } from "../../identity/users.js";
import { findProject } from "../../projects/registry.js";
import { projectRole } from "../../projects/members.js";
import {
  flag,
  MethodError,
  oneOf,
  optionalText,
  paramsObject,
  projectVisible,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  accountNotificationsTopic,
  ANCHOR_FIELD_LIMIT,
  projectMilestonesTopic,
  projectReviewsTopic,
  TEAM_METHODS,
  TEAM_WEBHOOK_EVENTS,
  TEAM_WEBHOOK_FORMATS,
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
  if (error instanceof ReviewRefusal || error instanceof MilestoneRefusal || error instanceof WebhookRefusal) {
    throw new MethodError(error.code, error.message);
  }
  throw error;
}

function tellAccounts(context: MethodContext, written: Map<string, TeamNotification>): void {
  for (const [accountId, notification] of written) {
    context.publish(accountNotificationsTopic(accountId), { kind: "notification", notification }, new Set([accountId]));
  }
}

function requireOperator(context: MethodContext): void {
  if (!isOperator(context.user.groups)) throw new MethodError("refused", "administering this server is for its operators");
}

export function productionMethods(): TeamMethod[] {
  return [
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
        let milestone;
        try {
          milestone = createMilestone(context.options.database, context.user, {
            projectId,
            name: requiredText(read, "name", NAME_LIMIT),
            revision: requiredText(read, "revision", ANCHOR_FIELD_LIMIT),
            ...(note === undefined ? {} : { note }),
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
        return { status };
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
        return { status };
      },
    },
  ];
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
