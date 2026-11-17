/**
 * Studio's preferences, carried from one computer to the next.
 *
 *     GET    /api/team/v1/studio-config     the signed-in account's stored document (the bytes)
 *     HEAD   /api/team/v1/studio-config     whether there is one, and its ETag
 *     PUT    /api/team/v1/studio-config     keep a new one in its place (body: the bytes)
 *     DELETE /api/team/v1/studio-config     forget it
 *
 * Studio calls this with its bearer; the console with its cookie, for which a write must come
 * from the console's own origin. The bytes are opaque here: they must be JSON-shaped text no
 * larger than STUDIO_CONFIG_MAX_BYTES and nothing more is asked of them. An account's policy
 * may let it only read back what it has ("read") or keep nothing at all ("off").
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { studioConfigAccess } from "../identity/accountPolicy.js";
import { recordDecision } from "../identity/audit.js";
import { identifyCaller } from "../identity/bearer.js";
import { deleteStudioConfig, readStudioConfig, studioConfigStatus, writeStudioConfig } from "../identity/studioConfig.js";
import type { UserRecord } from "../identity/users.js";
import { identifyWebSession, webSessionCookie } from "../identity/websessions.js";
import { STUDIO_CONFIG_MAX_BYTES, STUDIO_CONFIG_PATH } from "../team/protocol.js";
import type { TeamService } from "../team/service.js";
import { sameOrigin } from "./origin.js";
import { answering, refuse, sendJson } from "./studio.js";

const VERSION_HEADER = "x-narraleaf-studio-version";
const VERSION_LIMIT = 64;
const STORED_HEADER = "x-narraleaf-studio-config";

interface Caller {
  readonly user: UserRecord;
  readonly cookie: boolean;
}

function caller(service: TeamService, request: IncomingMessage): Caller | undefined {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const identified = identifyCaller(service.database, service.keys, service.config, Array.isArray(header) ? header[0] : header);
    return identified.kind === "identified" ? { user: identified.user, cookie: false } : undefined;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  return identified.kind === "identified" ? { user: identified.user, cookie: true } : undefined;
}

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

/** Answer a request if it is this one, and say whether it was. */
export function serveStudioConfig(service: TeamService, request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path !== STUDIO_CONFIG_PATH) return false;
  answering(service, response, handle(service, request, response));
  return true;
}

async function handle(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "PUT" && method !== "DELETE") {
    response.writeHead(405, { allow: "GET, HEAD, PUT, DELETE" }).end();
    return;
  }
  const who = caller(service, request);
  if (who === undefined) {
    request.resume();
    refuse(response, 401, "sign in to reach your Studio settings");
    return;
  }
  const writing = method === "PUT" || method === "DELETE";
  if (writing && who.cookie && !sameOrigin(request)) {
    request.resume();
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const database = service.database;
  const user = who.user;
  const access = studioConfigAccess(database, user.id);
  if (access === "off" || (writing && access !== "on")) {
    request.resume();
    recordDecision(database, { username: user.username, resource: "studio-config", allowed: false, detail: `studio settings ${method} refused by account policy` });
    refuse(response, 403, access === "off" ? "this account does not keep Studio settings on the server" : "an administrator has made this account's Studio settings read-only");
    return;
  }

  if (method === "GET" || method === "HEAD") {
    const stored = readStudioConfig(database, user.id);
    if (stored === undefined) {
      // Said in a header as well, so Studio can tell "nothing kept yet" from a server too old to have this road.
      response.setHeader(STORED_HEADER, "none");
      refuse(response, 404, "no Studio settings are kept for this account yet");
      return;
    }
    const etag = `"${stored.sha256}"`;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": 'attachment; filename="narraleaf-studio-settings.json"',
      "last-modified": new Date(stored.updatedAt).toUTCString(),
      etag,
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers).end();
      return;
    }
    response.writeHead(200, { ...headers, "content-length": String(stored.body.length) });
    response.end(method === "HEAD" ? undefined : stored.body);
    return;
  }

  if (method === "DELETE") {
    if (deleteStudioConfig(database, user.id)) {
      recordDecision(database, { username: user.username, resource: "studio-config", allowed: true, detail: "studio settings removed" });
    }
    sendJson(response, 200, studioConfigStatus(database, user.id));
    return;
  }

  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > STUDIO_CONFIG_MAX_BYTES) {
    response.setHeader("connection", "close");
    request.resume();
    refuse(response, 413, "those settings are larger than the server keeps");
    return;
  }
  const body = await readBody(request, STUDIO_CONFIG_MAX_BYTES);
  if (body === undefined) {
    response.setHeader("connection", "close");
    refuse(response, 413, "those settings are larger than the server keeps");
    return;
  }
  if (!jsonShaped(body)) {
    refuse(response, 400, "Studio settings are a JSON document");
    return;
  }
  const rawVersion = request.headers[VERSION_HEADER];
  const version = typeof rawVersion === "string" ? rawVersion.trim().slice(0, VERSION_LIMIT) : "";
  writeStudioConfig(database, user.id, body, version === "" ? undefined : version);
  recordDecision(database, { username: user.username, resource: "studio-config", allowed: true, detail: `studio settings kept (${body.length} bytes)` });
  sendJson(response, 200, studioConfigStatus(database, user.id));
}

/** Whether the bytes are a JSON object: parsed, not interpreted. */
function jsonShaped(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
