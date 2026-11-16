/**
 * Where notifications go, what one watches, and reactions - over a session.
 *
 *  - `notifications.prefs` / `.set`: the switches (category × channel), the digest and the
 *    person's own Feishu or Slack address; `notifications.hook.test` posts a line to it and
 *    `notifications.digest.now` sends the digest at once.
 *  - `push.key` / `.subscribe` / `.unsubscribe` / `.test`: a browser asking to be pushed to.
 *  - `watches.list` / `.set`: following a project or a scene.
 *  - `reactions.list` / `.toggle`: an emoji on a comment or a chat message.
 *
 * Every answer is the caller's own: nobody reads or changes another account's settings here.
 */
import { postToHook, sendDigest } from "../../collab/digest.js";
import { PrefsRefusal, readPrefs, writePrefs, type PrefsChange } from "../../collab/prefs.js";
import { PushRefusal, pushToAccount, subscribe, unsubscribe, vapidKeys } from "../../collab/push.js";
import { isReaction, REACTION_TARGETS_LIMIT, reactionsOnMany, targetInProject, toggleReaction, type ReactionTarget } from "../../collab/reactions.js";
import { listWatches, setWatch, WatchRefusal } from "../../collab/watches.js";
import { WebhookRefusal } from "../../collab/webhooks.js";
import { findUserById } from "../../identity/users.js";
import { projectRole } from "../../projects/members.js";
import { findProject } from "../../projects/registry.js";
import { flag, MethodError, oneOf, optionalText, paramsObject, projectVisible, requiredText, type MethodContext, type TeamMethod } from "../methods.js";
import {
  projectChatTopic,
  projectThreadsTopic,
  TEAM_DIGEST_FREQUENCIES,
  TEAM_METHODS,
  TEAM_NOTIFICATION_CATEGORIES,
  TEAM_NOTIFICATION_CHANNELS,
  type TeamChatEvent,
  type TeamNotificationCategory,
  type TeamNotificationChannel,
  type TeamThreadEvent,
} from "../protocol.js";

const ID_LIMIT = 128;
const URL_LIMIT = 2048;
const KEY_LIMIT = 256;

function projectRef(context: MethodContext, reference: string): string {
  const project = findProject(context.options.database, reference);
  if (project === undefined || !projectVisible(context, project.id)) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return project.id;
}

function refused(error: unknown): never {
  if (error instanceof PushRefusal || error instanceof WatchRefusal || error instanceof PrefsRefusal || error instanceof WebhookRefusal) {
    throw new MethodError("bad-params", error.message);
  }
  throw error;
}

/** The switches a `notifications.prefs.set` names, checked. */
function switchesOf(value: unknown): NonNullable<PrefsChange["switches"]> {
  if (!Array.isArray(value) || value.length > TEAM_NOTIFICATION_CATEGORIES.length * TEAM_NOTIFICATION_CHANNELS.length) {
    throw new MethodError("bad-params", "switches has to be a list of { category, channel, enabled }");
  }
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new MethodError("bad-params", "a switch is { category, channel, enabled }");
    const read = entry as Record<string, unknown>;
    const category = read["category"];
    const channel = read["channel"];
    if (typeof category !== "string" || !(TEAM_NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
      throw new MethodError("bad-params", `category is one of ${TEAM_NOTIFICATION_CATEGORIES.join(", ")}`);
    }
    if (typeof channel !== "string" || !(TEAM_NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
      throw new MethodError("bad-params", `channel is one of ${TEAM_NOTIFICATION_CHANNELS.join(", ")}`);
    }
    if (typeof read["enabled"] !== "boolean") throw new MethodError("bad-params", "enabled is true or false");
    return { category: category as TeamNotificationCategory, channel: channel as TeamNotificationChannel, enabled: read["enabled"] };
  });
}

function currentUser(context: MethodContext) {
  return findUserById(context.options.database, context.user.id) ?? context.user;
}

/** Reacting is joining the conversation: a viewer reads and does not. */
function mayReact(context: MethodContext, projectId: string): void {
  if (projectRole(context.options.database, projectId, context.user) === "viewer") {
    throw new MethodError("refused", "a viewer of this project reads its conversations and does not react in them");
  }
}

export function notifyMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.notificationsPrefs,
      capability: "notifications",
      handle: (_params: unknown, context: MethodContext) => ({ prefs: readPrefs(context.options.database, currentUser(context)) }),
    },
    {
      name: TEAM_METHODS.notificationsPrefsSet,
      capability: "notifications",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const hookRaw = read["hook"];
        if (hookRaw !== undefined && hookRaw !== null && (typeof hookRaw !== "string" || hookRaw.length > URL_LIMIT)) {
          throw new MethodError("bad-params", "hook is an address, or null to take it away");
        }
        const change: PrefsChange = {
          ...(read["switches"] === undefined ? {} : { switches: switchesOf(read["switches"]) }),
          ...(read["digest"] === undefined ? {} : { digest: oneOf(read, "digest", TEAM_DIGEST_FREQUENCIES) }),
          ...(hookRaw === undefined ? {} : { hook: hookRaw === null || hookRaw.trim() === "" ? null : hookRaw.trim() }),
        };
        try {
          writePrefs(context.options.database, context.user.id, change);
        } catch (error) {
          refused(error);
        }
        return { prefs: readPrefs(context.options.database, currentUser(context)) };
      },
    },
    {
      name: TEAM_METHODS.notificationsHookTest,
      capability: "digests",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const prefs = readPrefs(context.options.database, currentUser(context));
        const url = optionalText(read, "url", URL_LIMIT) ?? prefs.hook;
        if (url === undefined) throw new MethodError("bad-params", "set an address first, or name one to try");
        const answer = await postToHook(context.options.database, url, `NarraLeaf Team：@${context.user.username} 的通知地址可以用了。`);
        if (answer.error !== undefined) throw new MethodError("unavailable", answer.error);
        return { status: answer.status };
      },
    },
    {
      name: TEAM_METHODS.notificationsDigestNow,
      capability: "digests",
      handle: async (params: unknown, context: MethodContext) => {
        // Everything unread from the last day or week, whether or not a digest is due.
        const read = paramsObject(params);
        const since = Date.now() - (read["period"] === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000;
        const outcome = await sendDigest(context.options.database, currentUser(context), Date.now(), since);
        return outcome;
      },
    },
    {
      name: TEAM_METHODS.pushKey,
      capability: "push",
      handle: (_params: unknown, context: MethodContext) => ({ key: vapidKeys(context.options.database).publicKey }),
    },
    {
      name: TEAM_METHODS.pushSubscribe,
      capability: "push",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const endpoint = requiredText(read, "endpoint", URL_LIMIT);
        const p256dh = requiredText(read, "p256dh", KEY_LIMIT);
        const auth = requiredText(read, "auth", KEY_LIMIT);
        try {
          await subscribe(context.options.database, context.user.id, { endpoint, p256dh, auth });
        } catch (error) {
          refused(error);
        }
        return { prefs: readPrefs(context.options.database, currentUser(context)) };
      },
    },
    {
      name: TEAM_METHODS.pushUnsubscribe,
      capability: "push",
      handle: (params: unknown, context: MethodContext) => {
        const endpoint = requiredText(paramsObject(params), "endpoint", URL_LIMIT);
        const removed = unsubscribe(context.options.database, context.user.id, endpoint);
        return { removed, prefs: readPrefs(context.options.database, currentUser(context)) };
      },
    },
    {
      name: TEAM_METHODS.pushTest,
      capability: "push",
      handle: async (_params: unknown, context: MethodContext) => {
        const reached = await pushToAccount(context.options.database, context.user.id, {
          kind: "test",
          title: "NarraLeaf Team",
          summary: "推送通知可以用了。 Push notifications work.",
          url: "/console/settings/notifications",
        });
        return { reached };
      },
    },
    {
      name: TEAM_METHODS.watchesList,
      capability: "watches",
      handle: (params: unknown, context: MethodContext) => {
        const project = optionalText(paramsObject(params), "project", ID_LIMIT);
        const projectId = project === undefined ? undefined : projectRef(context, project);
        const watches = listWatches(context.options.database, context.user.id, projectId).filter((watch) => projectVisible(context, watch.project));
        return { watches };
      },
    },
    {
      name: TEAM_METHODS.watchesSet,
      capability: "watches",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const scope = optionalText(read, "scope", ID_LIMIT + 6) ?? "";
        const on = flag(read, "watching", true);
        try {
          setWatch(context.options.database, context.user.id, projectId, scope, on);
        } catch (error) {
          refused(error);
        }
        return { watches: listWatches(context.options.database, context.user.id, projectId) };
      },
    },
    {
      name: TEAM_METHODS.reactionsList,
      capability: "reactions",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const kind = oneOf<ReactionTarget>(read, "kind", ["comment", "chat"]);
        const raw = read["targets"];
        if (!Array.isArray(raw) || raw.length > REACTION_TARGETS_LIMIT || raw.some((target) => typeof target !== "string" && typeof target !== "number")) {
          throw new MethodError("bad-params", `targets has to be a list of at most ${REACTION_TARGETS_LIMIT} ids`);
        }
        const targets = (raw as (string | number)[])
          .map(String)
          .filter((target) => target.length <= ID_LIMIT && targetInProject(context.options.database, projectId, kind, target));
        return { reactions: reactionsOnMany(context.options.database, kind, targets) };
      },
    },
    {
      name: TEAM_METHODS.reactionsToggle,
      capability: "reactions",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const kind = oneOf<ReactionTarget>(read, "kind", ["comment", "chat"]);
        const rawTarget = read["target"];
        const target = typeof rawTarget === "number" ? String(rawTarget) : requiredText(read, "target", ID_LIMIT);
        const emoji = requiredText(read, "emoji", 16);
        if (!isReaction(emoji)) throw new MethodError("bad-params", "that is not one of the reactions this server keeps");
        mayReact(context, projectId);
        if (!targetInProject(context.options.database, projectId, kind, target)) {
          throw new MethodError("not-found", kind === "comment" ? "there is no such comment in that project" : "there is no such message in that project");
        }
        const reaction = toggleReaction(context.options.database, projectId, kind, target, context.user.id, emoji);
        if (kind === "comment") {
          context.publish(projectThreadsTopic(projectId), { kind: "reaction", reaction } satisfies TeamThreadEvent);
        } else {
          context.publish(projectChatTopic(projectId), { kind: "reaction", project: projectId, reaction } satisfies TeamChatEvent);
        }
        return { reaction };
      },
    },
  ];
}
