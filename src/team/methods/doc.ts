/**
 * A team project's documents, with this server as their authority.
 *
 * Opening a team project in Studio is following its `doc` topic: there is no
 * room to open, no host, and nothing that ends when the last person leaves.
 * Every edit is an intent sent here (`doc.intent`), applied by the project
 * authority with Studio's own appliers, written to the log, and published to
 * everybody - the asker included, which is how the asker learns it landed. A
 * Studio that saw a gap in the seq reads `doc.effects` from its last one.
 *
 * Who may do what follows the project roles. Anyone who may see the project
 * may follow it and read what happened; editing, saving a version and
 * restoring one are for owners and editors. An editor may be kept to some
 * areas of the project (story, characters, assets, ui, localization, config):
 * an edit is refused unless the file it reaches is in one of them, and
 * restoring a version, which changes every area at once, needs all of them.
 */
import { editableAreas, PROJECT_AREAS, projectRole, type ProjectArea } from "../../projects/members.js";
import { recordActivity, recordEdit } from "../../collab/activity.js";
import { emitWebhookEvent } from "../../collab/webhooks.js";
import { versionRoles } from "../../authority/versions.js";
import type { DocIntent } from "../../authority/manager.js";
import { ProjectAuthority } from "../../authority/projectAuthority.js";
import {
  isProjectDocumentPath,
  isTeamFilePath,
  projectAreaOf,
  projectDocumentPath,
  projectOpClaimKeys,
} from "../../../studio-kernel/vendor/kernel.js";
import { lockedAgainst } from "../../collab/locks.js";
import { notifyWatchers, touchScenes } from "../../collab/watches.js";
import { findUserById } from "../../identity/users.js";
import {
  boundedCount,
  MethodError,
  optionalText,
  paramsObject,
  projectVisible,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  ANCHOR_FIELD_LIMIT,
  DOC_INTENT_LIMIT,
  INSTANCE_FIELD_LIMIT,
  PAGE_BYTES_LIMIT,
  TEAM_METHODS,
} from "../protocol.js";

const ID_LIMIT = 128;
const LABEL_LIMIT = 200;
const DEFAULT_EFFECTS = 500;
const MAXIMUM_EFFECTS = 5000;
/** One chunk of a base file, before base64: comfortably inside a page. */
const BASE_CHUNK_BYTES = 512 * 1024;

export function docMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.docHead,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = visibleProject(context, read);
        const authorities = authoritiesOf(context);
        const compatible = agreeKernel(context, projectId, read["kernel"]);
        if (!(await authorities.load(projectId))) {
          context.connection.kernel.forget(projectId);
          throw new MethodError("not-found", "no such project");
        }
        const head = authorities.head(projectId);
        return {
          project: projectId,
          kernel: ProjectAuthority.kernelVersion,
          compatible,
          session: context.connection.id,
          seq: head.seq,
          ...(head.snapshot === undefined
            ? {}
            : { snapshot: { seq: head.snapshot.seq, revision: head.snapshot.revision, at: head.snapshot.at } }),
          prunedThrough: head.prunedThrough,
          unreadable: authorities.unreadable(projectId),
          mayEdit: editableAreas(context.options.database, projectId, context.user).length > 0,
          areas: editableAreas(context.options.database, projectId, context.user),
        };
      },
    },
    {
      name: TEAM_METHODS.docEffects,
      capability: "documents",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = visibleProject(context, read);
        requireKernel(context, projectId);
        const after = read["after"];
        if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
          throw new MethodError("bad-params", "after has to be a whole number, zero or more");
        }
        const page = authoritiesOf(context).effects(projectId, after, {
          limit: boundedCount(read, "limit", DEFAULT_EFFECTS, MAXIMUM_EFFECTS),
          limitBytes: PAGE_BYTES_LIMIT,
        });
        return { project: projectId, effects: page.effects, more: page.more };
      },
    },
    {
      name: TEAM_METHODS.docBase,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = visibleProject(context, read);
        requireKernel(context, projectId);
        const base = await authoritiesOf(context).base(projectId);
        if (base === undefined) {
          throw new MethodError("not-found", "no such project");
        }
        const path = optionalText(read, "path", ANCHOR_FIELD_LIMIT);
        if (path === undefined) {
          // A file held only as a note is listed with its digest: one too large to hold is read from
          // the version (`doc.files`), one whose bytes are on their way is collected as a transfer.
          return {
            seq: base.seq,
            revision: base.revision,
            files: [
              ...[...base.files].map(([name, content]) => ({
                path: name,
                size: typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length,
              })),
              ...[...base.notes].map(([name, note]) => ({
                path: name,
                size: note.size,
                digest: note.digest,
                ...(note.transferId === undefined ? { stored: true } : { transferId: note.transferId }),
              })),
            ],
          };
        }
        const content = base.files.get(path);
        if (content === undefined) {
          throw new MethodError("not-found", "the last saved version has no such file");
        }
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        const offset = read["offset"] ?? 0;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
          throw new MethodError("bad-params", "offset has to be a whole number inside the file");
        }
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + BASE_CHUNK_BYTES));
        return {
          seq: base.seq,
          revision: base.revision,
          path,
          size: bytes.length,
          offset,
          chunk: chunk.toString("base64"),
        };
      },
    },
    {
      name: TEAM_METHODS.docFile,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = visibleProject(context, read);
        requireKernel(context, projectId);
        const path = requiredText(read, "path", ANCHOR_FIELD_LIMIT);
        const current = await authoritiesOf(context).current(projectId, path);
        if (current === undefined) {
          throw new MethodError("not-found", "no such project");
        }
        if (current.content === undefined) {
          return { seq: current.seq, path, absent: true };
        }
        if ("note" in current.content) {
          const note = current.content.note;
          return {
            seq: current.seq,
            path,
            size: note.size,
            digest: note.digest,
            ...(note.transferId === undefined ? { stored: true, revision: current.revision } : { transferId: note.transferId }),
          };
        }
        const bytes = current.content.bytes;
        const offset = read["offset"] ?? 0;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
          throw new MethodError("bad-params", "offset has to be a whole number inside the file");
        }
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + BASE_CHUNK_BYTES));
        return { seq: current.seq, path, size: bytes.length, offset, chunk: chunk.toString("base64") };
      },
    },
    {
      name: TEAM_METHODS.docFiles,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = visibleProject(context, read);
        const revision = requiredText(read, "revision", ANCHOR_FIELD_LIMIT);
        const path = optionalText(read, "path", ANCHOR_FIELD_LIMIT);
        const offset = read["offset"] ?? 0;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
          throw new MethodError("bad-params", "offset has to be a whole number, zero or more");
        }
        const reader = context.options.readings?.revisionFiles;
        if (reader === undefined) {
          throw new MethodError("unavailable", "this server reads no repositories");
        }
        const answer = await reader(projectId, revision, async (tree) => {
          if (path === undefined) {
            return {
              revision: tree.revision,
              files: tree.files
                .filter((file) => isProjectDocumentPath(file.path) || isTeamFilePath(file.path))
                .map((file) => ({ path: file.path, size: file.size })),
            };
          }
          const bytes = await tree.read(path);
          if (bytes === undefined || !(isProjectDocumentPath(path) || isTeamFilePath(path))) {
            throw new MethodError("not-found", "that version has no such document");
          }
          const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + BASE_CHUNK_BYTES));
          return { revision: tree.revision, path, size: bytes.length, offset, chunk: chunk.toString("base64") };
        });
        if (answer === undefined) {
          throw new MethodError("not-found", "this server has not read that version yet");
        }
        return answer;
      },
    },
    {
      name: TEAM_METHODS.docIntent,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = editableProject(context, read);
        requireKernel(context, projectId);
        const clientId = requiredText(read, "clientId", INSTANCE_FIELD_LIMIT);
        const document = read["document"];
        const op = read["op"];
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          throw new MethodError("bad-params", "document has to be an object");
        }
        if (typeof op !== "object" || op === null || typeof (op as { op?: unknown }).op !== "string") {
          throw new MethodError("bad-params", "op has to be an object with an op");
        }
        const derived = read["derived"];
        if (derived !== undefined && (typeof derived !== "object" || derived === null || Array.isArray(derived))) {
          throw new MethodError("bad-params", "derived has to be an object");
        }
        if (Buffer.byteLength(JSON.stringify({ document, op, derived }), "utf8") > DOC_INTENT_LIMIT) {
          throw new MethodError("bad-params", "that edit is larger than one edit may be");
        }
        const basedOn = read["basedOn"];
        if (basedOn !== undefined && (typeof basedOn !== "number" || !Number.isInteger(basedOn) || basedOn < 0)) {
          throw new MethodError("bad-params", "basedOn has to be a whole number, zero or more");
        }
        requireArea(context, projectId, areaOfEdit(document as DocIntent["document"]));
        requireUnlocked(context, projectId, document as DocIntent["document"], op as DocIntent["op"]);
        const intent: DocIntent = {
          clientId,
          accountId: context.user.id,
          by: context.account.displayName || context.account.username,
          document: document as DocIntent["document"],
          op: op as DocIntent["op"],
          ...(derived === undefined ? {} : { derived }),
          ...(basedOn === undefined ? {} : { basedOn }),
        };
        const authorities = authoritiesOf(context);
        const before = authorities.head(projectId).seq;
        const answer = await authorities.intent(projectId, intent);
        // A resend answers with the effect it already had; only a new one is counted.
        if (answer.kind === "effect" && answer.effect.seq > before) {
          recordEdit(context.options.database, { accountId: context.user.id, projectId });
          touchScenes(context.options.database, projectId, scenesOfEdit(intent.document, intent.op), context.user.id);
        }
        return answer;
      },
    },
    {
      name: TEAM_METHODS.docSnapshot,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = editableProject(context, read);
        requireVersionRole(context, projectId, "save");
        const label = optionalText(read, "label", LABEL_LIMIT);
        let saved;
        try {
          saved = await authoritiesOf(context).snapshot(projectId, label, context.user.id);
        } catch (error) {
          throw new MethodError("unavailable", `the version could not be saved: ${messageOf(error)}`);
        }
        if (saved.revision !== undefined) {
          announceVersion(context, projectId, saved.revision, label?.trim() || undefined, "saved");
        }
        return saved;
      },
    },
    {
      name: TEAM_METHODS.docRestore,
      capability: "documents",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = editableProject(context, read);
        requireVersionRole(context, projectId, "restore");
        requireAllAreas(context, projectId);
        const revision = requiredText(read, "revision", ANCHOR_FIELD_LIMIT);
        let restored;
        try {
          restored = await authoritiesOf(context).restore(projectId, revision, {
            accountId: context.user.id,
            by: context.account.displayName || context.account.username,
          });
        } catch (error) {
          throw new MethodError("unavailable", `that version could not be restored: ${messageOf(error)}`);
        }
        announceVersion(context, projectId, restored.revision, `Restored ${revision.slice(0, 12)}`, "restored");
        return restored;
      },
    },
  ];
}

/**
 * Agree this server's kernel for one project on this connection, from what the caller says it
 * applies edits with - or refuse a caller that does not say.
 *
 * Two kernels can apply the same operation differently, so a Studio on another one must not follow
 * or edit the project (docs/architecture.md). A caller that says nothing is a Studio from before
 * this was asked, whose version is unknown: refused, which such a Studio takes as being offline -
 * it keeps editing its own copy and sends the difference once it is updated. One that says another
 * version is answered, so it can tell its author why, and agrees nothing. Answers whether it agreed.
 */
function agreeKernel(context: MethodContext, projectId: string, said: unknown): boolean {
  const ours = ProjectAuthority.kernelVersion;
  if (said === undefined) {
    context.connection.kernel.forget(projectId);
    throw new MethodError(
      "refused",
      `this server applies edits with Studio kernel ${ours}; say which kernel this client applies them with (kernel) - a Studio that does not is too old to follow this project`,
    );
  }
  if (typeof said !== "number" || !Number.isInteger(said) || said < 1) {
    context.connection.kernel.forget(projectId);
    throw new MethodError("bad-params", "kernel has to be a whole number, one or more");
  }
  if (said !== ours) {
    context.connection.kernel.forget(projectId);
    return false;
  }
  context.connection.kernel.agree(projectId);
  return true;
}

/** Refuse a document read or edit on a connection that has not agreed this server's kernel for the project. */
function requireKernel(context: MethodContext, projectId: string): void {
  if (!context.connection.kernel.agreed(projectId)) {
    throw new MethodError(
      "refused",
      `this connection has not agreed Studio kernel ${ProjectAuthority.kernelVersion} for that project; call doc.head with kernel first`,
    );
  }
}

/** Refuse a member whose role is below what the project's owners set for saving or restoring. */
function requireVersionRole(context: MethodContext, projectId: string, doing: "save" | "restore"): void {
  const wanted = versionRoles(context.options.database, projectId)[doing];
  if (wanted === "owner" && projectRole(context.options.database, projectId, context.user) !== "owner") {
    throw new MethodError(
      "refused",
      doing === "save" ? "only this project's owners save versions of it" : "only this project's owners restore its versions",
    );
  }
}

/** A version saved by hand, or restored, is news: a timeline row and a webhook event. */
function announceVersion(
  context: MethodContext,
  projectId: string,
  revision: string,
  label: string | undefined,
  how: "saved" | "restored",
): void {
  const database = context.options.database;
  recordActivity(database, {
    accountId: context.user.id,
    projectId,
    kind: "version",
    ref: revision,
    ...(label === undefined ? {} : { summary: label }),
  });
  const actor = context.account.displayName || context.account.username;
  notifyWatchers(database, {
    projectId,
    kind: "version",
    actorId: context.user.id,
    ref: revision,
    summary: how === "restored" ? `恢复了较早的版本${label === undefined ? "" : `：${label}`}` : `保存了版本${label === undefined ? "" : `：${label}`}`,
  });
  emitWebhookEvent(database, {
    type: "version",
    projectId,
    actor: context.account.username,
    ref: revision,
    summary: how === "restored"
      ? `${actor} restored an earlier version${label === undefined ? "" : `: ${label}`}`
      : `${actor} saved a version${label === undefined ? "" : `: ${label}`}`,
  });
}

function authoritiesOf(context: MethodContext) {
  const authorities = context.options.authorities;
  if (authorities === undefined) {
    throw new MethodError("unavailable", "this server holds no project documents");
  }
  return authorities;
}

function visibleProject(context: MethodContext, read: Record<string, unknown>): string {
  const projectId = requiredText(read, "project", ID_LIMIT);
  if (!projectVisible(context, projectId)) {
    throw new MethodError("not-found", "no such project");
  }
  return projectId;
}

function editableProject(context: MethodContext, read: Record<string, unknown>): string {
  const projectId = visibleProject(context, read);
  if (editableAreas(context.options.database, projectId, context.user).length === 0) {
    throw new MethodError("refused", "your role in this project does not edit it");
  }
  return projectId;
}

/** The area an edit reaches, or undefined when its address names no file (the authority refuses it anyway). */
/** The assets an edit writes, by id, as the kernel names its claims (`asset:{id}`). */
function assetsOfEdit(document: DocIntent["document"], op: DocIntent["op"]): string[] {
  try {
    return projectOpClaimKeys(document, op)
      .filter((key) => key.startsWith("asset:"))
      .map((key) => key.slice("asset:".length));
  } catch {
    return [];
  }
}

/** The scenes an edit writes, by id, as the kernel names its claims (`scene:{id}`). */
function scenesOfEdit(document: DocIntent["document"], op: DocIntent["op"]): string[] {
  try {
    return projectOpClaimKeys(document, op)
      .filter((key) => key.startsWith("scene:"))
      .map((key) => key.slice("scene:".length));
  } catch {
    return [];
  }
}

/** Refuse an edit to an asset somebody else holds. */
function requireUnlocked(context: MethodContext, projectId: string, document: DocIntent["document"], op: DocIntent["op"]): void {
  const held = lockedAgainst(context.options.database, projectId, context.user.id, assetsOfEdit(document, op));
  if (held === undefined) return;
  const holder = findUserById(context.options.database, held.holderId);
  throw new MethodError(
    "refused",
    `${holder?.displayName || holder?.username || "somebody"} holds asset ${held.assetId} until ${new Date(held.expiresAt).toISOString()}`,
  );
}

function areaOfEdit(document: DocIntent["document"]): ProjectArea | undefined {
  try {
    return projectAreaOf(projectDocumentPath(document));
  } catch {
    return undefined;
  }
}

function requireArea(context: MethodContext, projectId: string, area: ProjectArea | undefined): void {
  const areas = editableAreas(context.options.database, projectId, context.user);
  if (area === undefined ? areas.length < PROJECT_AREAS.length : !areas.includes(area)) {
    throw new MethodError(
      "refused",
      area === undefined
        ? "you may not edit every area of this project"
        : `you may not edit the ${area} of this project`,
    );
  }
}

function requireAllAreas(context: MethodContext, projectId: string): void {
  if (editableAreas(context.options.database, projectId, context.user).length < PROJECT_AREAS.length) {
    throw new MethodError("refused", "restoring a version changes every area, and you may not edit all of them");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
