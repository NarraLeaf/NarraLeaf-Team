/**
 * Avatars: an account's face.
 *
 *     PUT    /api/console/v1/avatar                       the signed-in account's new image (body: the bytes)
 *     DELETE /api/console/v1/avatar                       take it away
 *     GET    /api/team/v1/avatars/{username}/{file}       one account's current image
 *     PUT    /api/console/v1/brand/signin-image          an operator sets the sign-in page's picture
 *     GET    /api/team/v1/brand/signin-image/{file}      that picture, to anybody
 *
 * The console crops and re-encodes a picture in the browser before it sends it
 * (a canvas re-encode drops whatever metadata the original carried); this
 * server holds no image library and does not decode it. What it does check is
 * that the bytes are the PNG, JPEG or WebP they claim to be, by their magic
 * number, and that they are small. Stored under avatars/ in the storage root,
 * named by their SHA-256, so an avatar's address changes when it does and can
 * be cached for ever; served with `nosniff` and a sandbox, to signed-in callers
 * only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { identifyCaller } from "../identity/bearer.js";
import { findUser, isOperator, type UserRecord } from "../identity/users.js";
import { setBrandLogo, setSigninImage, storedBrand, storedSigninLook } from "../identity/settings.js";
import { identifyWebSession, webSessionCookie } from "../identity/websessions.js";
import type { TeamService } from "../team/service.js";
import { sameOrigin } from "./origin.js";
import { answering, refuse, sendJson } from "./studio.js";

export const AVATAR_PATH = "/api/console/v1/avatar";
const SERVE_PREFIX = "/api/team/v1/avatars/";
export const LOGO_PATH = "/api/console/v1/brand/logo";
export const LOGO_SERVE_PREFIX = "/api/team/v1/brand/logo/";
export const SIGNIN_IMAGE_PATH = "/api/console/v1/brand/signin-image";
export const SIGNIN_IMAGE_SERVE_PREFIX = "/api/team/v1/brand/signin-image/";

/** The largest sign-in picture: a wide photograph, re-encoded by the console first. */
export const SIGNIN_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The largest image accepted: a re-encoded square, not a photograph. */
export const AVATAR_MAX_BYTES = 512 * 1024;

const TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** What the bytes are, by their first few, or undefined for anything else. */
export function imageKind(bytes: Buffer): "png" | "jpg" | "webp" | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  return undefined;
}

function avatarsDir(service: TeamService): string {
  return join(service.root, "avatars");
}

function caller(service: TeamService, request: IncomingMessage): UserRecord | undefined {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const identified = identifyCaller(service.database, service.keys, service.config, Array.isArray(header) ? header[0] : header);
    return identified.kind === "identified" ? identified.user : undefined;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  return identified.kind === "identified" ? identified.user : undefined;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > limit) {
      // Drained rather than left: a client still sending would otherwise never
      // read the refusal.
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Answer a request if it is one of these, and say whether it was. */
export function serveAvatars(service: TeamService, request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path === LOGO_PATH) {
    answering(service, response, changeLogo(service, request, response));
    return true;
  }
  if (path.startsWith(LOGO_SERVE_PREFIX)) {
    answering(service, response, serveLogo(service, request, response, path.slice(LOGO_SERVE_PREFIX.length)));
    return true;
  }
  if (path === SIGNIN_IMAGE_PATH) {
    answering(service, response, changeSigninImage(service, request, response));
    return true;
  }
  if (path.startsWith(SIGNIN_IMAGE_SERVE_PREFIX)) {
    answering(service, response, serveSigninImage(service, request, response, path.slice(SIGNIN_IMAGE_SERVE_PREFIX.length)));
    return true;
  }
  if (path === AVATAR_PATH) {
    answering(service, response, change(service, request, response));
    return true;
  }
  if (path.startsWith(SERVE_PREFIX)) {
    answering(service, response, serve(service, request, response, path.slice(SERVE_PREFIX.length)));
    return true;
  }
  return false;
}

async function change(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    response.writeHead(405, { allow: "PUT, DELETE" }).end();
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  // The console's cookie only: this is a page's action, and a bearer has
  // `account.profile.update` and the console for it.
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  if (identified.kind !== "identified") {
    refuse(response, 401, "sign in to change your picture");
    return;
  }
  const user = identified.user;
  if (request.method === "DELETE") {
    service.database.prepare("UPDATE users SET avatar = NULL WHERE id = ?").run(user.id);
    sendJson(response, 200, {});
    return;
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > AVATAR_MAX_BYTES) {
    response.setHeader("connection", "close");
    refuse(response, 413, "that picture is larger than an avatar may be");
    request.resume();
    return;
  }
  const bytes = await readBody(request, AVATAR_MAX_BYTES);
  if (bytes === undefined) {
    refuse(response, 413, "that picture is larger than an avatar may be");
    return;
  }
  const kind = imageKind(bytes);
  if (kind === undefined) {
    refuse(response, 415, "an avatar has to be a PNG, JPEG or WebP image");
    return;
  }
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${kind}`;
  await mkdir(avatarsDir(service), { recursive: true });
  await writeFile(join(avatarsDir(service), name), bytes);
  service.database.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(name, user.id);
  sendJson(response, 200, { avatarUrl: `${SERVE_PREFIX}${encodeURIComponent(user.username)}/${name}` });
}

async function serve(service: TeamService, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (caller(service, request) === undefined) {
    refuse(response, 401, "sign in to see this");
    return;
  }
  const [username, file] = rest.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const owner = username === undefined ? undefined : findUser(service.database, username);
  // Only the account's current picture, and only by its own name: nothing here
  // is a path anybody chose.
  if (owner?.avatar === undefined || file !== owner.avatar || !/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(file)) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  const bytes = await readFile(join(avatarsDir(service), file)).catch(() => undefined);
  if (bytes === undefined) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

/* ------------------------------------------------------------------ logo */

function brandDir(service: TeamService): string {
  return join(service.root, "brand");
}

/**
 * The team's logo: uploaded by an operator from the console, served to anybody
 * — the sign-in page shows it before anybody has signed in. The same checks as
 * an avatar: an image by its magic number, small, content-addressed.
 */
async function changeLogo(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    response.writeHead(405, { allow: "PUT, DELETE" }).end();
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  if (identified.kind !== "identified" || !isOperator(identified.user.groups)) {
    refuse(response, identified.kind === "identified" ? 403 : 401, "only an operator of this server may change its logo");
    return;
  }
  if (request.method === "DELETE") {
    setBrandLogo(service.database, null);
    sendJson(response, 200, {});
    return;
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  const bytes = declared > AVATAR_MAX_BYTES ? undefined : await readBody(request, AVATAR_MAX_BYTES);
  if (bytes === undefined) {
    response.setHeader("connection", "close");
    refuse(response, 413, "that logo is larger than this server keeps");
    request.resume();
    return;
  }
  const kind = imageKind(bytes);
  if (kind === undefined) {
    refuse(response, 415, "a logo has to be a PNG, JPEG or WebP image");
    return;
  }
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${kind}`;
  await mkdir(brandDir(service), { recursive: true });
  await writeFile(join(brandDir(service), name), bytes);
  setBrandLogo(service.database, name);
  sendJson(response, 200, { logoUrl: `${LOGO_SERVE_PREFIX}${name}` });
}

async function serveLogo(service: TeamService, request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const current = storedBrand(service.database).logo;
  if (current === undefined || file !== current) {
    refuse(response, 404, "there is no such logo");
    return;
  }
  const bytes = await readFile(join(brandDir(service), file)).catch(() => undefined);
  if (bytes === undefined) {
    refuse(response, 404, "there is no such logo");
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

/* ------------------------------------------------------- sign-in picture */

/**
 * The picture on the sign-in page: the logo's rules, a larger allowance. Shown
 * to anybody, as the logo is - the page it is on is the one before signing in.
 */
async function changeSigninImage(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    response.writeHead(405, { allow: "PUT, DELETE" }).end();
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  if (identified.kind !== "identified" || !isOperator(identified.user.groups)) {
    refuse(response, identified.kind === "identified" ? 403 : 401, "only an operator of this server may change its sign-in picture");
    return;
  }
  if (request.method === "DELETE") {
    setSigninImage(service.database, null);
    sendJson(response, 200, {});
    return;
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  const bytes = declared > SIGNIN_IMAGE_MAX_BYTES ? undefined : await readBody(request, SIGNIN_IMAGE_MAX_BYTES);
  if (bytes === undefined) {
    response.setHeader("connection", "close");
    refuse(response, 413, "that picture is larger than this server keeps");
    request.resume();
    return;
  }
  const kind = imageKind(bytes);
  if (kind === undefined) {
    refuse(response, 415, "a sign-in picture has to be a PNG, JPEG or WebP image");
    return;
  }
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${kind}`;
  await mkdir(brandDir(service), { recursive: true });
  await writeFile(join(brandDir(service), name), bytes);
  setSigninImage(service.database, name);
  sendJson(response, 200, { imageUrl: `${SIGNIN_IMAGE_SERVE_PREFIX}${name}` });
}

async function serveSigninImage(service: TeamService, request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const current = storedSigninLook(service.database).image;
  if (current === undefined || file !== current) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  const bytes = await readFile(join(brandDir(service), file)).catch(() => undefined);
  if (bytes === undefined) {
    refuse(response, 404, "there is no such picture");
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}
