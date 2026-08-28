/**
 * Threads and comments, over a session.
 *
 * The first product feature this protocol carries, and the one the shape of the
 * protocol was worked out against: it writes, it is anchored below the level of
 * a project, and everybody looking at the same project has to find out when
 * somebody else says something. Nothing before it did any of the three.
 *
 * **Who may do what, stated once.** Every account of this server reaches every
 * project on it, so listing, opening a thread, replying and resolving are open
 * to anybody signed in - that is the standing rule in src/projects/registry.ts
 * and nothing here narrows it. The one exception is not about projects at all:
 * **a comment may be edited or withdrawn only by the person who wrote it.** That
 * is authorship rather than authorisation. Putting words into somebody's mouth
 * is not a permission this server hands to anybody, an operator included, and a
 * conversation whose lines can be rewritten by whoever is reading is not a
 * conversation anybody can rely on.
 *
 * Every write takes a `clientId` and is safe to repeat with it. A session drops,
 * Studio reconnects, and the reply it never saw an answer for goes again: the
 * same id gives back the row that already exists rather than saying the same
 * thing twice. See src/comments/store.ts.
 */
import { findProjectById } from "../../projects/registry.js";
import {
  addComment,
  commentView,
  createThread,
  deleteComment,
  editComment,
  findComment,
  findThread,
  listThreads,
  nameResolver,
  setThreadStatus,
  threadComments,
  threadView,
  type CommentRecord,
} from "../../comments/store.js";
import {
  MethodError,
  boundedCount,
  flag,
  oneOf,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  ANCHOR_FIELD_LIMIT,
  COMMENT_BODY_LIMIT,
  SUGGESTION_LIMIT,
  TEAM_METHODS,
  projectThreadsTopic,
  type TeamAnchor,
  type TeamComment,
  type TeamThreadEvent,
  type TeamThreadKind,
  type TeamThreadStatus,
} from "../protocol.js";

/** The most an id may be, which is more than any id this server issues. */
const ID_LIMIT = 128;

/** The most a client id may be. Long enough for a UUID and a word, short of a payload. */
const CLIENT_ID_LIMIT = 128;

/** How many rows one page holds when nobody said. */
export const DEFAULT_PAGE = 50;

/**
 * The most one page may hold, so that a page is a bounded amount of work.
 *
 * One figure for both lists here. A page of threads and a page of one thread's
 * comments are read by the same panel and cost the same order of work to build,
 * and a second number would only be a second thing for a client to learn.
 */
export const MAXIMUM_PAGE = 200;

const THREAD_KINDS: readonly TeamThreadKind[] = ["comment", "suggestion"];
const THREAD_STATUSES: readonly TeamThreadStatus[] = ["open", "resolved"];

/** The project named by these parameters, or a refusal saying it is not here. */
function projectOf(params: Record<string, unknown>, context: MethodContext): string {
  const id = requiredText(params, "project", ID_LIMIT);
  if (findProjectById(context.options.database, id) === undefined) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return id;
}

/**
 * The anchor out of a call.
 *
 * Read as three strings and nothing more. This is the boundary the whole design
 * rests on: what a document path means, and whether an element id names
 * anything, are Studio's business. A check here would be this server learning
 * Studio's document format, and therefore having to be upgraded alongside it.
 */
function anchorOf(params: Record<string, unknown>): TeamAnchor {
  const raw = params["anchor"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MethodError("bad-params", "anchor has to be an object");
  }
  const anchor = raw as Record<string, unknown>;
  const document = optionalText(anchor, "document", ANCHOR_FIELD_LIMIT);
  const element = optionalText(anchor, "element", ANCHOR_FIELD_LIMIT);
  const revision = optionalText(anchor, "revision", ANCHOR_FIELD_LIMIT);
  return {
    ...(document === undefined ? {} : { document }),
    ...(element === undefined ? {} : { element }),
    ...(revision === undefined ? {} : { revision }),
  };
}

/** Say what happened, to everybody watching that project's conversations. */
function announce(context: MethodContext, projectId: string, event: TeamThreadEvent): void {
  context.publish(projectThreadsTopic(projectId), event);
}

/** Announce a changed comment, and answer with it. */
function finishCommentUpdate(
  context: MethodContext,
  updated: CommentRecord,
): { comment: TeamComment } {
  const thread = findThread(context.options.database, updated.threadId);
  const comment = commentView(updated, nameResolver(context.options.database));
  if (thread !== undefined) {
    announce(context, thread.projectId, {
      kind: "comment-updated",
      thread: updated.threadId,
      comment,
    });
  }
  return { comment };
}

/**
 * The comment these parameters name, provided the caller wrote it.
 *
 * The two refusals are deliberately different. A comment that is not here is
 * `not-found`; one that is here and belongs to somebody else is `refused`. A
 * client showing an edit control on a comment it does not own has a bug, and
 * "no such comment" would send whoever is fixing it in the wrong direction.
 */
function ownComment(params: Record<string, unknown>, context: MethodContext): CommentRecord {
  const id = requiredText(params, "comment", ID_LIMIT);
  const comment = findComment(context.options.database, id);
  if (comment === undefined) {
    throw new MethodError("not-found", "there is no comment of that id on this server");
  }
  if (comment.authorId !== context.user.id) {
    throw new MethodError("refused", "a comment is edited by whoever wrote it");
  }
  return comment;
}

export function commentMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.threadsList,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectOf(read, context);
        const document = optionalText(read, "document", ANCHOR_FIELD_LIMIT);
        const element = optionalText(read, "element", ANCHOR_FIELD_LIMIT);
        const before = optionalText(read, "before", ID_LIMIT);
        const said = read["status"];
        const page = listThreads(context.options.database, {
          projectId,
          ...(document === undefined ? {} : { document }),
          ...(element === undefined ? {} : { element }),
          ...(said === undefined || said === null
            ? {}
            : { status: oneOf(read, "status", THREAD_STATUSES) }),
          limit: boundedCount(read, "limit", DEFAULT_PAGE, MAXIMUM_PAGE),
          ...(before === undefined ? {} : { before }),
        });
        // One resolver for the whole page, so a list naming the same three people
        // fifty times reads three rows rather than fifty.
        const nameOf = nameResolver(context.options.database);
        return {
          threads: page.threads.map((thread) =>
            threadView(context.options.database, thread, nameOf),
          ),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      },
    },
    {
      name: TEAM_METHODS.threadsGet,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const threadId = requiredText(read, "thread", ID_LIMIT);
        const thread = findThread(context.options.database, threadId);
        if (thread === undefined) {
          throw new MethodError("not-found", "there is no thread of that id on this server");
        }
        const after = optionalText(read, "after", ID_LIMIT);
        // Paged, the way the threads above are paged and with the same numbers.
        //
        // A thread is a conversation somebody is reading rather than a log, and
        // for a thread people wrote that argues for answering it whole. It is
        // not a bound, though: nothing stops an account writing a hundred
        // thousand comments on one thread and then asking for it, and every
        // body may be COMMENT_BODY_LIMIT. Of the two ways to bound it, a
        // ceiling with a field saying the answer was cut leaves the far end of
        // the conversation unreachable - and read oldest first, the far end is
        // the newest replies, which is the part somebody came for. So a page
        // and a cursor. `thread.comments` still says how many there are in all,
        // so a reader knows what it is a page of.
        const page = threadComments(context.options.database, threadId, {
          limit: boundedCount(read, "limit", DEFAULT_PAGE, MAXIMUM_PAGE),
          ...(after === undefined ? {} : { after }),
        });
        const nameOf = nameResolver(context.options.database);
        return {
          thread: threadView(context.options.database, thread, nameOf),
          comments: page.comments.map((comment) => commentView(comment, nameOf)),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      },
    },
    {
      name: TEAM_METHODS.threadsCreate,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectOf(read, context);
        const kind = oneOf(read, "kind", THREAD_KINDS, "comment");
        const suggestion = optionalText(read, "suggestion", SUGGESTION_LIMIT);
        if (kind === "suggestion" && suggestion === undefined) {
          throw new MethodError("bad-params", "a suggestion has to carry what it suggests");
        }
        const clientId = optionalText(read, "clientId", CLIENT_ID_LIMIT);
        const created = createThread(context.options.database, {
          projectId,
          anchor: anchorOf(read),
          kind,
          createdBy: context.user.id,
          body: requiredText(read, "body", COMMENT_BODY_LIMIT),
          ...(suggestion === undefined ? {} : { suggestion }),
          ...(clientId === undefined ? {} : { clientId }),
          now: Date.now(),
        });
        const thread = threadView(context.options.database, created.thread);
        // A repeat announces nothing. The event went out when the write really
        // happened, and a second one would have every other client redraw a
        // thread that did not change.
        if (!created.repeated) {
          announce(context, projectId, { kind: "thread-created", thread });
        }
        return { thread, comment: commentView(created.comment, nameResolver(context.options.database)) };
      },
    },
    {
      name: TEAM_METHODS.threadsReply,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const threadId = requiredText(read, "thread", ID_LIMIT);
        const thread = findThread(context.options.database, threadId);
        if (thread === undefined) {
          throw new MethodError("not-found", "there is no thread of that id on this server");
        }
        const suggestion = optionalText(read, "suggestion", SUGGESTION_LIMIT);
        const clientId = optionalText(read, "clientId", CLIENT_ID_LIMIT);
        const added = addComment(context.options.database, {
          threadId,
          authorId: context.user.id,
          body: requiredText(read, "body", COMMENT_BODY_LIMIT),
          ...(suggestion === undefined ? {} : { suggestion }),
          ...(clientId === undefined ? {} : { clientId }),
          now: Date.now(),
        });
        const comment = commentView(added.comment, nameResolver(context.options.database));
        if (!added.repeated) {
          announce(context, thread.projectId, {
            kind: "comment-created",
            thread: threadId,
            comment,
          });
        }
        return { comment };
      },
    },
    {
      name: TEAM_METHODS.threadsResolve,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const threadId = requiredText(read, "thread", ID_LIMIT);
        const current = findThread(context.options.database, threadId);
        if (current === undefined) {
          throw new MethodError("not-found", "there is no thread of that id on this server");
        }
        const resolved = flag(read, "resolved", true);
        // A naturally idempotent write: asking for the state a thread is already
        // in changes nothing, so it must not touch the row or announce a change
        // nobody made. A client that redraws on every event would otherwise
        // redraw for a resolve that moved nothing.
        if (resolved === (current.status === "resolved")) {
          return { thread: threadView(context.options.database, current) };
        }
        const thread = setThreadStatus(
          context.options.database,
          threadId,
          resolved,
          context.user.id,
          Date.now(),
        );
        const view = threadView(context.options.database, thread);
        announce(context, thread.projectId, { kind: "thread-updated", thread: view });
        return { thread: view };
      },
    },
    {
      name: TEAM_METHODS.commentsEdit,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const comment = ownComment(read, context);
        if (comment.deletedAt !== undefined) {
          throw new MethodError("conflict", "that comment has been withdrawn");
        }
        return finishCommentUpdate(
          context,
          editComment(
            context.options.database,
            comment.id,
            requiredText(read, "body", COMMENT_BODY_LIMIT),
            optionalText(read, "suggestion", SUGGESTION_LIMIT),
            Date.now(),
          ),
        );
      },
    },
    {
      name: TEAM_METHODS.commentsDelete,
      capability: "comments",
      handle: (params: unknown, context: MethodContext) => {
        const comment = ownComment(paramsObject(params), context);
        return finishCommentUpdate(
          context,
          deleteComment(context.options.database, comment.id, Date.now()),
        );
      },
    },
  ];
}
