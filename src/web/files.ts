/**
 * A project's files at a revision, for the web console's viewers.
 *
 *     GET /api/team/v1/projects/{project}/tree/{revision}          the file list
 *     GET /api/team/v1/projects/{project}/raw/{revision}/{path…}   one file's bytes
 *
 * `{revision}` is a revision id, `head` for the newest Team has read, or `current` for what a team
 * project holds right now: the documents and whole files the project authority keeps, which are
 * ahead of the last saved version by whatever was edited since, and the last saved version for
 * everything it does not keep (an asset's bytes, a file too large to hold). A server without an
 * authority answers `current` as `head`.
 *
 * **Bytes, never interpretation.** The console parses story, blueprint and
 * project files itself (docs/architecture.md, D2), so this server does not
 * learn Studio's formats and does not have to be upgraded with Studio.
 *
 * Who may read: any role in the project, by console cookie or bearer token. A
 * project the caller has no role in is a 404, as everywhere. Reviewers and
 * viewers read the project here and only here — they never reach loreserver.
 *
 * What is served is held to the revision's own tree: a path is looked up in the
 * list Lore gave, never joined onto a directory, so `..` and friends name
 * nothing. Only a short list of types is served as itself; everything else is
 * an attachment. Every answer carries `nosniff` and a sandboxing policy, so an
 * SVG or an HTML file somebody committed cannot run in this origin.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { identifyCaller } from "../identity/bearer.js";
import { identifyWebSession, webSessionCookie } from "../identity/websessions.js";
import type { UserRecord } from "../identity/users.js";
import { maySeeProject } from "../projects/members.js";
import { findProject } from "../projects/registry.js";
import type { RevisionTree } from "../projects/read.js";
import type { TeamService } from "../team/service.js";
import { refuse } from "./studio.js";
import { isProjectDocumentPath, isWholeFilePath } from "../../studio-kernel/vendor/kernel.js";

const PREFIX = "/api/team/v1/projects/";

/** The largest file served in one answer. A story or an image, not a video archive. */
export const MAXIMUM_RAW_BYTES = 32 * 1024 * 1024;

/** The most files a tree answer lists. Past this the list is cut and says so. */
const MAXIMUM_TREE_FILES = 20_000;

/** The types served as themselves. Anything else is an attachment. */
const INLINE_TYPES: Readonly<Record<string, string>> = {
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** What every file answer may do in a browser: nothing but be shown. */
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

/** The caller, by console cookie or bearer token, or undefined. */
function caller(service: TeamService, request: IncomingMessage): UserRecord | undefined {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const identified = identifyCaller(service.database, service.keys, service.config, Array.isArray(header) ? header[0] : header);
    return identified.kind === "identified" ? identified.user : undefined;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  return identified.kind === "identified" ? identified.user : undefined;
}

/** Answer a request if it is one of these, and say whether it was. */
export function serveProjectFiles(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (!path.startsWith(PREFIX)) {
    return false;
  }
  const parts = path.slice(PREFIX.length).split("/");
  const [projectRef, kind, revision, ...rest] = parts;
  if (projectRef === undefined || revision === undefined || (kind !== "tree" && kind !== "raw")) {
    return false;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  void answer(service, request, response, { projectRef, kind, revision, rest }).catch((error: unknown) => {
    service.log?.(`files: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) refuse(response, 500, "something went wrong answering that");
    else response.end();
  });
  return true;
}

/** Whether a path is one the project authority keeps, rather than one only a revision has. */
function heldByAuthority(path: string): boolean {
  return isWholeFilePath(path) || isProjectDocumentPath(path);
}

/**
 * Answer a `current` read from the project authority, or say it did not (no authority, or no such
 * project there) so the caller reads `head` instead. A file the authority does not keep falls
 * through to the newest revision, which is the last saved version.
 */
async function answerCurrent(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  projectId: string,
  kind: "tree" | "raw",
  filePath: string,
): Promise<boolean> {
  const authorities = service.authorities;
  const reader = service.readings;
  if (authorities === undefined || reader?.revisionFiles === undefined) return false;
  if (kind === "tree") {
    const current = await authorities.currentFiles(projectId);
    if (current === undefined) return false;
    const unreadable = new Set(authorities.unreadable(projectId).map((entry) => entry.path));
    const held = new Map(current.files.map((file) => [file.path, file.size]));
    const fromHead = await reader.revisionFiles(projectId, "head", async (tree) => tree.files).catch(() => undefined);
    const files: Array<{ path: string; size: number }> = [];
    for (const file of fromHead ?? []) {
      if (held.has(file.path)) continue;
      // A document the authority would keep but does not was deleted since the last save; one it
      // could not read is still shown as the revision has it.
      if (heldByAuthority(file.path) && !unreadable.has(file.path)) continue;
      files.push(file);
    }
    for (const [path, size] of held) files.push({ path, size });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const text = JSON.stringify({
      revision: "current",
      seq: current.seq,
      ...(current.revision === null ? {} : { base: current.revision }),
      files: files.slice(0, MAXIMUM_TREE_FILES),
      total: files.length,
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : text);
    return true;
  }
  if (filePath === "" || filePath.includes("\0") || !heldByAuthority(filePath)) return false;
  const current = await authorities.current(projectId, filePath);
  if (current === undefined) return false;
  if (current.content === undefined) {
    if (authorities.unreadable(projectId).some((entry) => entry.path === filePath)) return false;
    refuse(response, 404, "there is no such file in this project now");
    return true;
  }
  // Held only as a note of its digest: the last saved version has the bytes.
  if (!("bytes" in current.content)) return false;
  const bytes = current.content.bytes;
  if (bytes.length > MAXIMUM_RAW_BYTES) {
    refuse(response, 413, "that file is larger than this server hands to a browser");
    return true;
  }
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const inline = INLINE_TYPES[extension];
  const name = filePath.split("/").pop() ?? "file";
  response.writeHead(200, {
    "content-type": inline ?? "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": FILE_CSP,
    "cross-origin-resource-policy": "same-origin",
    "x-team-revision": "current",
    "x-team-seq": String(current.seq),
    ...(inline === undefined ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
  return true;
}

async function answer(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  asked: { projectRef: string; kind: "tree" | "raw"; revision: string; rest: string[] },
): Promise<void> {
  const user = caller(service, request);
  if (user === undefined) {
    refuse(response, 401, "sign in to read this project");
    return;
  }
  let projectRef: string;
  let revision: string;
  let filePath: string;
  try {
    projectRef = decodeURIComponent(asked.projectRef);
    revision = decodeURIComponent(asked.revision);
    filePath = asked.rest.map((part) => decodeURIComponent(part)).join("/");
  } catch {
    refuse(response, 400, "that address is not one this server can read");
    return;
  }
  const project = findProject(service.database, projectRef);
  if (project === undefined || !maySeeProject(service.database, project.id, user)) {
    refuse(response, 404, "there is no project of that id on this server");
    return;
  }
  if (revision === "current") {
    const answered = await answerCurrent(service, request, response, project.id, asked.kind, filePath);
    if (answered) return;
    revision = "head";
  }
  await answerRevision(service, request, response, { projectId: project.id, kind: asked.kind, revision, filePath });
}

/**
 * Answer a tree or a file of one revision of a project the caller may already read. `shows`, where
 * given, is the list of paths the caller may see - a share link's - and holds both the tree and the
 * file to it: a path it does not show is not there.
 */
export async function answerRevision(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  asked: { projectId: string; kind: "tree" | "raw"; revision: string; filePath: string; shows?: (path: string) => boolean },
): Promise<void> {
  const { revision, filePath, shows } = asked;
  const project = { id: asked.projectId };
  if (revision !== "head" && !/^[A-Za-z0-9]{8,128}$/.test(revision)) {
    refuse(response, 400, "that is not a revision id");
    return;
  }
  const reader = service.readings;
  if (reader?.revisionFiles === undefined) {
    refuse(response, 503, "this server reads no repositories");
    return;
  }
  // Called on the reader, never lifted off it: it is a class method that keeps
  // its own state, and a detached copy has no `this` (the trap projects.history
  // documents) — which a test's object-literal stand-in would never show.
  const readings = <T>(projectId: string, at: string, use: (tree: RevisionTree) => Promise<T>) =>
    reader.revisionFiles!(projectId, at, use);
  // A revision id names immutable bytes; `head` names whatever is newest.
  const cache = revision === "head" ? "private, no-cache" : "private, max-age=31536000, immutable";

  if (asked.kind === "tree") {
    const listed = await readings(project.id, revision, async (tree) => ({
      revision: tree.revision,
      files: (shows === undefined ? tree.files : tree.files.filter((file) => shows(file.path))).slice(0, MAXIMUM_TREE_FILES),
      total: shows === undefined ? tree.files.length : tree.files.filter((file) => shows(file.path)).length,
    }));
    if (listed === undefined) {
      refuse(response, 404, "Team has not read that revision of this project");
      return;
    }
    response.setHeader("cache-control", cache);
    response.setHeader("x-content-type-options", "nosniff");
    const text = JSON.stringify(listed);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    response.end(request.method === "HEAD" ? undefined : text);
    return;
  }

  if (filePath === "" || filePath.includes("\0") || (shows !== undefined && !shows(filePath))) {
    refuse(response, 404, "there is nothing at that address");
    return;
  }
  const read = await readings(project.id, revision, async (tree) => {
    const entry = tree.files.find((file) => file.path === filePath);
    if (entry === undefined) return { kind: "missing" as const };
    if (entry.size > MAXIMUM_RAW_BYTES) return { kind: "large" as const };
    const bytes = await tree.read(filePath);
    return bytes === undefined ? { kind: "missing" as const } : { kind: "file" as const, bytes, revision: tree.revision };
  });
  if (read === undefined || read.kind === "missing") {
    refuse(response, 404, "there is no such file in that revision");
    return;
  }
  if (read.kind === "large") {
    refuse(response, 413, "that file is larger than this server hands to a browser");
    return;
  }
  // Asset bytes are stored without an extension (assets/content/ab/cd/…); the
  // page knows the type from the asset register and says so with `?as=png`.
  // Only for that directory, and only a type on the list.
  const as = new URL(request.url ?? "/", "http://team.invalid").searchParams.get("as")?.toLowerCase();
  const extension =
    as !== undefined && filePath.startsWith("assets/content/") ? as : (filePath.split(".").pop()?.toLowerCase() ?? "");
  const inline = INLINE_TYPES[extension];
  const name = filePath.split("/").pop() ?? "file";
  response.writeHead(200, {
    "content-type": inline ?? "application/octet-stream",
    "content-length": read.bytes.length,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "content-security-policy": FILE_CSP,
    "cross-origin-resource-policy": "same-origin",
    "x-team-revision": read.revision,
    ...(inline === undefined
      ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }
      : {}),
  });
  response.end(request.method === "HEAD" ? undefined : read.bytes);
}
