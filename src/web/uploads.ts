/**
 * Bytes that ride beside a project rather than inside it, and the one door a
 * guest walks through.
 *
 *     PUT    /api/team/v1/projects/{project}/builds?name=&file=&note=&revision=&platform=&latest=   upload a build
 *     GET    /api/team/v1/projects/{project}/builds/{id}                                            download it
 *     PUT    /api/team/v1/projects/{project}/attachments                                            a picture for a comment
 *     GET    /api/team/v1/projects/{project}/attachments/{id}                                       that picture
 *
 *     GET    /api/team/v1/share/{token}                          what the link is (TeamShareView)
 *     GET    /api/team/v1/share/{token}/tree/{revision}          the files it shows
 *     GET    /api/team/v1/share/{token}/raw/{revision}/{path…}   one of them
 *     POST   /api/team/v1/share/{token}/comments                 a guest's note, where the link allows it
 *
 * Uploads are HTTP rather than calls because a call is held to 128 KB and a
 * build is hundreds of megabytes. A build is streamed to disk and hashed on the
 * way; nothing reads it whole into memory. Everything else about builds - the
 * list, renaming, which one to play, removing - is a call (src/team/methods/production.ts).
 *
 * A share link answers to nobody signed in. It reads only what the link lists,
 * at the revision the link was frozen at, and every use of it is written to the
 * audit log and counted on the link.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { recordActivity } from "../collab/activity.js";
import {
  attachmentView,
  attachmentsDir,
  buildView,
  buildsDir,
  cleanFileName,
  findAttachment,
  findBuild,
  mayAttach,
  mayUploadBuild,
  projectStorageBytes,
  recordAttachment,
  recordBuild,
} from "../collab/builds.js";
import { shareByToken, shareGuestView, shareShows, touchShare, type ShareRecord } from "../collab/shares.js";
import { emitWebhookEvent } from "../collab/webhooks.js";
import { createThread, threadView, nameResolver } from "../comments/store.js";
import { recordDecision } from "../identity/audit.js";
import { identifyCaller } from "../identity/bearer.js";
import type { UserRecord } from "../identity/users.js";
import { identifyWebSession, webSessionCookie } from "../identity/websessions.js";
import { maySeeProject } from "../projects/members.js";
import { findProject } from "../projects/registry.js";
import {
  ATTACHMENT_MAX_BYTES,
  BUILD_MAX_BYTES,
  COMMENT_BODY_LIMIT,
  projectBuildsTopic,
  projectThreadsTopic,
} from "../team/protocol.js";
import type { TeamService } from "../team/service.js";
import { imageKind } from "./avatars.js";
import { answerRevision } from "./files.js";
import { sameOrigin } from "./origin.js";
import { answering, refuse, sendJson } from "./studio.js";

const PROJECTS = "/api/team/v1/projects/";
const SHARE = "/api/team/v1/share/";
const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** How many notes one link takes in an hour, so an open link is not a firehose. */
const GUEST_NOTES_PER_HOUR = 30;
const GUEST_NAME_LIMIT = 40;

export type Publish = (topic: string, payload: unknown) => void;

function caller(service: TeamService, request: IncomingMessage): { user: UserRecord; cookie: boolean } | undefined {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const identified = identifyCaller(service.database, service.keys, service.config, Array.isArray(header) ? header[0] : header);
    return identified.kind === "identified" ? { user: identified.user, cookie: false } : undefined;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  return identified.kind === "identified" ? { user: identified.user, cookie: true } : undefined;
}

function decode(part: string | undefined): string | undefined {
  if (part === undefined) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** Answer a request if it is one of these, and say whether it was. */
export function serveUploads(service: TeamService, publish: Publish | undefined, request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path.startsWith(SHARE)) {
    answering(service, response, share(service, publish, request, response, path.slice(SHARE.length).split("/")));
    return true;
  }
  if (!path.startsWith(PROJECTS)) return false;
  const [projectRef, kind, id, ...more] = path.slice(PROJECTS.length).split("/");
  if (projectRef === undefined || (kind !== "builds" && kind !== "attachments") || more.length > 0) return false;
  answering(service, response, project(service, publish, request, response, projectRef, kind, id === "" ? undefined : id));
  return true;
}

async function project(
  service: TeamService,
  publish: Publish | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  projectRef: string,
  kind: "builds" | "attachments",
  id: string | undefined,
): Promise<void> {
  const write = id === undefined;
  if (write ? request.method !== "PUT" : request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: write ? "PUT" : "GET, HEAD" }).end();
    request.resume();
    return;
  }
  const who = caller(service, request);
  if (who === undefined) {
    refuse(response, 401, "sign in to do that");
    request.resume();
    return;
  }
  if (write && who.cookie && !sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    request.resume();
    return;
  }
  const ref = decode(projectRef);
  const found = ref === undefined ? undefined : findProject(service.database, ref);
  if (found === undefined || !maySeeProject(service.database, found.id, who.user)) {
    refuse(response, 404, "there is no project of that id on this server");
    request.resume();
    return;
  }
  if (kind === "builds") {
    if (write) await uploadBuild(service, publish, request, response, found.id, who.user);
    else await downloadBuild(service, request, response, found.id, decode(id) ?? "");
  } else if (write) {
    await uploadAttachment(service, request, response, found.id, who.user);
  } else {
    await servePicture(service, request, response, found.id, decode(id) ?? "");
  }
}

/* ---------------------------------------------------------------- builds */

async function uploadBuild(
  service: TeamService,
  publish: Publish | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  projectId: string,
  user: UserRecord,
): Promise<void> {
  if (!mayUploadBuild(service.database, projectId, user)) {
    refuse(response, 403, "only owners and editors upload a project's builds");
    request.resume();
    return;
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > BUILD_MAX_BYTES) {
    response.setHeader("connection", "close");
    refuse(response, 413, "that build is larger than this server keeps");
    request.resume();
    return;
  }
  const query = new URL(request.url ?? "/", "http://team.invalid").searchParams;
  const file = cleanFileName(query.get("file") ?? undefined, "build.zip");
  const name = (query.get("name") ?? "").trim().slice(0, 120) || file;
  const note = (query.get("note") ?? "").trim().slice(0, 2000);
  const revision = (query.get("revision") ?? "").trim();
  const platform = (query.get("platform") ?? "").trim().slice(0, 40);
  if (revision !== "" && !/^[A-Za-z0-9]{8,128}$/.test(revision)) {
    refuse(response, 400, "that is not a revision id");
    request.resume();
    return;
  }

  const id = randomUUID();
  const dir = buildsDir(service.root, projectId);
  await mkdir(dir, { recursive: true });
  const partial = join(dir, `${id}.part`);
  const hash = createHash("sha256");
  let size = 0;
  let tooLarge = false;
  const out = createWriteStream(partial);
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > BUILD_MAX_BYTES) {
        tooLarge = true;
        request.resume();
        break;
      }
      hash.update(buffer);
      if (!out.write(buffer)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  if (tooLarge || size === 0) {
    await rm(partial, { force: true });
    refuse(response, tooLarge ? 413 : 400, tooLarge ? "that build is larger than this server keeps" : "that build has nothing in it");
    return;
  }
  await rename(partial, join(dir, id));
  const build = recordBuild(service.database, {
    id,
    projectId,
    name,
    ...(note === "" ? {} : { note }),
    ...(revision === "" ? {} : { revision }),
    ...(platform === "" ? {} : { platform }),
    file,
    size,
    sha256: hash.digest("hex"),
    uploadedBy: user.id,
    latest: query.get("latest") === "1" || query.get("latest") === "true",
  });
  const view = buildView(service.database, build);
  if (build.latest) {
    // The others stopped being the one to play; a reader redraws them from the list.
    for (const other of service.database.prepare("SELECT id FROM builds WHERE project_id = ? AND id != ?").all(projectId, id) as Array<{ id: string }>) {
      const record = findBuild(service.database, other.id);
      if (record !== undefined) publish?.(projectBuildsTopic(projectId), { kind: "build-set", build: buildView(service.database, record) });
    }
  }
  publish?.(projectBuildsTopic(projectId), { kind: "build-set", build: view });
  recordActivity(service.database, { accountId: user.id, projectId, kind: "build", ref: `build:${id}`, summary: name });
  emitWebhookEvent(service.database, { type: "build", projectId, actor: user.username, ref: id, summary: `${user.username} uploaded a build: ${name}` });
  service.log?.(`team: ${user.username} uploaded build ${name} (${size} bytes) to ${projectId}`);
  sendJson(response, 200, { build: view, storageBytes: projectStorageBytes(service.database, projectId) });
}

async function downloadBuild(service: TeamService, request: IncomingMessage, response: ServerResponse, projectId: string, id: string): Promise<void> {
  const build = findBuild(service.database, id);
  if (build === undefined || build.projectId !== projectId) {
    refuse(response, 404, "there is no build of that id");
    return;
  }
  const path = join(buildsDir(service.root, projectId), build.id);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) {
    refuse(response, 404, "that build's file is no longer on this server");
    return;
  }
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": info.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(build.file)}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-team-sha256": build.sha256,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

/* --------------------------------------------------------------- pictures */

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > limit) {
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function uploadAttachment(service: TeamService, request: IncomingMessage, response: ServerResponse, projectId: string, user: UserRecord): Promise<void> {
  if (!mayAttach(service.database, projectId, user)) {
    refuse(response, 403, "a viewer does not put pictures beside comments");
    request.resume();
    return;
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  const bytes = declared > ATTACHMENT_MAX_BYTES ? undefined : await readBody(request, ATTACHMENT_MAX_BYTES);
  if (bytes === undefined) {
    response.setHeader("connection", "close");
    refuse(response, 413, "that picture is larger than this server keeps");
    request.resume();
    return;
  }
  const type = imageKind(bytes);
  if (type === undefined) {
    refuse(response, 415, "a picture has to be a PNG, JPEG or WebP image");
    return;
  }
  const attachment = recordAttachment(service.database, { projectId, type, size: bytes.length, uploadedBy: user.id });
  await mkdir(attachmentsDir(service.root, projectId), { recursive: true });
  await writeFile(join(attachmentsDir(service.root, projectId), `${attachment.id}.${type}`), bytes);
  sendJson(response, 200, { attachment: attachmentView(service.database, attachment), url: `${PROJECTS}${projectId}/attachments/${attachment.id}` });
}

async function servePicture(service: TeamService, request: IncomingMessage, response: ServerResponse, projectId: string, id: string): Promise<void> {
  const attachment = findAttachment(service.database, id);
  if (attachment === undefined || attachment.projectId !== projectId) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  const bytes = await readFile(join(attachmentsDir(service.root, projectId), `${attachment.id}.${attachment.type}`)).catch(() => undefined);
  if (bytes === undefined) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  response.writeHead(200, {
    "content-type": IMAGE_TYPES[attachment.type] ?? "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

/* ------------------------------------------------------------ share links */

const guestNotes = new Map<string, number[]>();

function allowGuestNote(shareId: string, now: number): boolean {
  const recent = (guestNotes.get(shareId) ?? []).filter((at) => at > now - 60 * 60 * 1000);
  if (recent.length >= GUEST_NOTES_PER_HOUR) {
    guestNotes.set(shareId, recent);
    return false;
  }
  recent.push(now);
  guestNotes.set(shareId, recent);
  return true;
}

function audit(service: TeamService, share: ShareRecord, allowed: boolean, detail: string): void {
  recordDecision(service.database, { username: `share:${share.id.slice(0, 8)}`, resource: `project:${share.projectId}`, allowed, detail });
}

async function share(service: TeamService, publish: Publish | undefined, request: IncomingMessage, response: ServerResponse, parts: string[]): Promise<void> {
  const [rawToken, kind, revision, ...rest] = parts;
  const token = decode(rawToken) ?? "";
  const found = shareByToken(service.database, token);
  if (found === undefined) {
    refuse(response, 404, "this link does not open anything, or no longer does");
    request.resume();
    return;
  }
  if (kind === undefined || kind === "") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    touchShare(service.database, found.id);
    audit(service, found, true, "opened a share link");
    sendJson(response, 200, shareGuestView(service.database, found));
    return;
  }
  if (kind === "comments") {
    await guestComment(service, publish, request, response, found);
    return;
  }
  if ((kind !== "tree" && kind !== "raw") || revision === undefined) {
    refuse(response, 404, "there is nothing at that address");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const filePath = rest.map((part) => decode(part) ?? "\0").join("/");
  // The revision asked for is not the caller's to choose: a link shows what it was frozen at.
  await answerRevision(service, request, response, {
    projectId: found.projectId,
    kind,
    revision: found.revision,
    filePath,
    shows: (path) => shareShows(found, path),
  });
}

async function guestComment(service: TeamService, publish: Publish | undefined, request: IncomingMessage, response: ServerResponse, found: ShareRecord): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    request.resume();
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    request.resume();
    return;
  }
  if (!found.allowComments) {
    audit(service, found, false, "a guest note on a link that takes none");
    refuse(response, 403, "this link does not take notes");
    request.resume();
    return;
  }
  const body = await readBody(request, COMMENT_BODY_LIMIT + 2048);
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(body?.toString("utf8") ?? "") as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    refuse(response, 400, "that is not a note this server can read");
    return;
  }
  const name = typeof parsed["name"] === "string" ? [...parsed["name"]].filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f && char !== ":").join("").trim().slice(0, GUEST_NAME_LIMIT) : "";
  const text = typeof parsed["body"] === "string" ? parsed["body"].trim() : "";
  const document = typeof parsed["document"] === "string" ? parsed["document"] : undefined;
  const element = typeof parsed["element"] === "string" ? parsed["element"].slice(0, 512) : undefined;
  if (name === "" || text === "" || Buffer.byteLength(text) > COMMENT_BODY_LIMIT) {
    refuse(response, 400, "a note needs your name and something to say");
    return;
  }
  // A note is put on a story by its anchor (`story:<id>`), which is the link's scope when it shows one story.
  if (document !== undefined && (document.length > 512 || (document !== found.scope && !shareShows(found, document)))) {
    refuse(response, 400, "this link does not show that document");
    return;
  }
  const now = Date.now();
  if (!allowGuestNote(found.id, now)) {
    refuse(response, 429, "this link has taken all the notes it takes for now; try again later");
    return;
  }
  const created = createThread(service.database, {
    projectId: found.projectId,
    anchor: {
      ...(document === undefined ? {} : { document }),
      ...(element === undefined ? {} : { element }),
      ...(found.revision === "head" ? {} : { revision: found.revision }),
    },
    kind: "comment",
    createdBy: `guest:${name}`,
    body: text,
    now,
  });
  const thread = threadView(service.database, created.thread, nameResolver(service.database));
  publish?.(projectThreadsTopic(found.projectId), { kind: "thread-created", thread });
  recordActivity(service.database, { actorLabel: `${name}（访客）`, projectId: found.projectId, kind: "thread", ref: created.thread.id, summary: text });
  emitWebhookEvent(service.database, {
    type: "thread",
    projectId: found.projectId,
    actor: `guest:${name}`,
    ref: created.thread.id,
    summary: `${name} (guest) commented: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
  });
  touchShare(service.database, found.id, now);
  audit(service, found, true, `a guest note from ${name}`);
  sendJson(response, 200, { thread: created.thread.id });
}
