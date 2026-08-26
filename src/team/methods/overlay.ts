/**
 * Attaching things to a project without changing what the project is.
 *
 * The request this answers is a specific one: a client wants to keep something
 * beside a place in a project **at a version**, and it must not end up in the
 * version history. A review mark on a story row, a translator's flag, a note
 * from a playtest. None of those are edits; all of them are about an edit.
 *
 * Three properties are worth reading before changing anything here.
 *
 * **The repository is never touched.** Nothing in this file writes to Lore,
 * reaches loreserver, or produces a revision. A collaborator who syncs sees
 * exactly what they would have seen. That is the whole point, and it is the
 * property to check first if any of this ever grows a second implementation.
 *
 * **A record names the revision it was written against, and the head is a
 * separate answer.** `overlay.list` hands back both: every record with the
 * revision it describes, and what this server last read the project's tip to be.
 * It does not mark anything stale, because it cannot: whether the story row a
 * note is about survived the next revision is a question about a document, and
 * this server has not got one. The client compares, and the client decides. What
 * it does when they differ - ignore it, grey it out, or look and move the record
 * forward with `overlay.put` - is Studio's business.
 *
 * ⚠ **The head may be absent, and absent is not "no revisions".** This server
 * reads repositories on a loop; a project it has not reached yet has no reading
 * at all. A client that treated a missing head as "the project is empty" would
 * mark every record stale a minute after a restart.
 *
 * **`kind` and `body` are opaque.** Grouped and filtered by; never interpreted.
 * Same bargain as an anchor, so that a Studio which starts attaching a new sort
 * of thing needs no server upgrade.
 */
import {
  countOverlay,
  dropOverlay,
  findOverlay,
  listOverlay,
  putOverlay,
  reviseOverlay,
  type OverlayRecord,
} from "../../overlay/store.js";
import { findUserById } from "../../identity/users.js";
import { findProjectById } from "../../projects/registry.js";
import {
  boundedCount,
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
  OVERLAY_BODY_LIMIT,
  projectOverlayTopic,
  TEAM_METHODS,
  type TeamOverlayEvent,
  type TeamOverlayRecord,
} from "../protocol.js";

const ID_LIMIT = 128;

/** How many records one read returns without being asked for more. */
const DEFAULT_LIMIT = 500;

/**
 * The most one read may return.
 *
 * High, because the ordinary read is "everything attached to this project" and a
 * window that had to page would be a window that could not draw a count. A
 * project beyond this is one where somebody is using overlay as a database, and
 * the honest answer is the newest thousand.
 */
const MAXIMUM_LIMIT = 2000;

export function overlayMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.overlayList,
      capability: "overlay",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = requireProject(context, read);
        const document = optionalText(read, "document", ANCHOR_FIELD_LIMIT);
        const element = optionalText(read, "element", ANCHOR_FIELD_LIMIT);
        const kind = optionalText(read, "kind", INSTANCE_FIELD_LIMIT);
        const revision = optionalText(read, "revision", ANCHOR_FIELD_LIMIT);
        const records = listOverlay(context.options.database, {
          projectId,
          ...(document === undefined ? {} : { document }),
          ...(element === undefined ? {} : { element }),
          ...(kind === undefined ? {} : { kind }),
          ...(revision === undefined ? {} : { revision }),
          limit: boundedCount(read, "limit", DEFAULT_LIMIT, MAXIMUM_LIMIT),
        });
        const head = context.options.readings?.get(projectId)?.history.head;
        return {
          ...(head === undefined ? {} : { head }),
          /** Everything this project holds, so a count can be drawn beside a narrowed read. */
          total: countOverlay(context.options.database, projectId),
          records: records.map((record) => body(context, record)),
        };
      },
    },
    {
      name: TEAM_METHODS.overlayPut,
      capability: "overlay",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const anchor = paramsObject(read["anchor"]);
        const revision = requiredText(anchor, "revision", ANCHOR_FIELD_LIMIT);
        const text = requiredText(read, "body", OVERLAY_BODY_LIMIT);
        const existing = optionalText(read, "id", ID_LIMIT);

        // Replacing something already attached. Kept in this method rather than
        // in one of its own because a client putting a record forward onto a new
        // head is doing the same act as writing one: it has looked, the thing is
        // still there, and this is what it says.
        if (existing !== undefined) {
          const record = findOverlay(context.options.database, existing);
          if (record === undefined) {
            throw new MethodError("not-found", "there is no overlay record of that id");
          }
          // Authorship, not authorization. Every account of this server reaches
          // every project (see src/projects/registry.ts); what nobody does is
          // rewrite somebody else's record and leave their name on it.
          if (record.authorId !== context.user.id) {
            throw new MethodError("refused", "only the account that wrote a record may replace it");
          }
          const revised = reviseOverlay(context.options.database, existing, {
            body: text,
            revision,
            now: Date.now(),
          });
          const view = body(context, revised);
          announce(context, revised.projectId, { kind: "overlay-put", record: view });
          return { record: view };
        }

        const projectId = requireProject(context, read);
        const document = optionalText(anchor, "document", ANCHOR_FIELD_LIMIT);
        const element = optionalText(anchor, "element", ANCHOR_FIELD_LIMIT);
        // Absent rather than refused for a session that never announced itself:
        // an instance is useful to record and it is not a permission. Refusing
        // here would make `overlay` depend on `clients`, and a build serving one
        // without the other is a build this table has no opinion about.
        const instance = context.presence.instanceOn(context.connection.id, projectId)?.id;
        const clientId = optionalText(read, "clientId", ID_LIMIT);
        const written = putOverlay(context.options.database, {
          projectId,
          revision,
          anchor: {
            ...(document === undefined ? {} : { document }),
            ...(element === undefined ? {} : { element }),
            revision,
          },
          kind: requiredText(read, "kind", INSTANCE_FIELD_LIMIT),
          body: text,
          authorId: context.user.id,
          ...(instance === undefined ? {} : { instance }),
          ...(clientId === undefined ? {} : { clientId }),
          now: Date.now(),
        });
        const view = body(context, written.record);
        // A repeat announces nothing. The event went out when the write really
        // happened, and a second one would have every reader re-read for a
        // change that did not occur.
        if (!written.repeated) {
          announce(context, projectId, { kind: "overlay-put", record: view });
        }
        return { record: view, repeated: written.repeated };
      },
    },
    {
      name: TEAM_METHODS.overlayDrop,
      capability: "overlay",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "id", ID_LIMIT);
        const record = findOverlay(context.options.database, id);
        if (record === undefined) {
          // Dropping something that is not there is a success: what the caller
          // wanted is what there is. An empty object rather than a refusal, so
          // that a retry after a socket dropped mid-answer is quiet and every
          // method's answer is read the same way.
          return {};
        }
        if (record.authorId !== context.user.id) {
          throw new MethodError("refused", "only the account that wrote a record may take it off");
        }
        dropOverlay(context.options.database, id);
        announce(context, record.projectId, {
          kind: "overlay-dropped",
          record: id,
          anchor: record.anchor,
        });
        return {};
      },
    },
  ];
}

function requireProject(context: MethodContext, params: Record<string, unknown>): string {
  const id = requiredText(params, "project", ID_LIMIT);
  if (findProjectById(context.options.database, id) === undefined) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return id;
}

/**
 * A stored row as the protocol carries it: an author id becomes a username.
 *
 * Absent for an account this server no longer has, for the reason a thread's is:
 * a record outlives whoever wrote it, and one claiming an author it cannot name
 * would be worse than one claiming none.
 */
function body(context: MethodContext, record: OverlayRecord): TeamOverlayRecord {
  const author = findUserById(context.options.database, record.authorId);
  return {
    id: record.id,
    project: record.projectId,
    anchor: { ...record.anchor, revision: record.revision },
    kind: record.kind,
    body: record.body,
    ...(author === undefined ? {} : { author: author.username }),
    ...(record.instance === undefined ? {} : { instance: record.instance }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function announce(context: MethodContext, projectId: string, event: TeamOverlayEvent): void {
  context.publish(projectOverlayTopic(projectId), event);
}
