/**
 * The web console: its sign-in, and the files of the page itself.
 *
 *     POST /api/console/v1/sign-in    a password, for a session cookie
 *     POST /api/console/v1/sign-out   end the session the cookie names
 *     GET  /api/console/v1/session    who the cookie signs in, or a 401
 *     GET  /console/…                 the page, a built single-page app
 *     GET  /                          a redirect to /console/
 *
 * Everything the console reads or changes after signing in travels on the same
 * socket Studio uses, upgraded with the cookie instead of a bearer — see
 * src/team/endpoint.ts. There is no second API for a browser.
 *
 * **The cookie is the credential, so every request that sets, ends or spends
 * it must come from a page of this server.** The sign-in and sign-out check
 * `origin` strictly (absent is refused: every browser sends it on a POST), and
 * so does the socket upgrade. `SameSite=Lax` is the second fence, not the
 * first.
 *
 * The page's files are served under a content security policy that admits
 * nothing but this origin: no inline script, no third-party anything. A page
 * that renders text other people wrote — comments, story lines, names — is a
 * page somebody will one day try to put a script into, and this is what makes
 * that attempt inert.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describeRefusal } from "../identity/bearer.js";
import { isOperator, type UserRecord } from "../identity/users.js";
import {
  clearedCookieHeader,
  createWebSession,
  describeWebSessionRefusal,
  endWebSession,
  identifyWebSession,
  sessionCookieHeader,
  webSessionCookie,
} from "../identity/websessions.js";
import { SIGN_IN_REFUSED_MESSAGE } from "../identity/users.js";
import type { TeamService } from "../team/service.js";
import { sameOrigin } from "./origin.js";
import { answering, checkSignIn, holdOff, onlyMethods, refuse, sendJson } from "./studio.js";

const API_PREFIX = "/api/console/v1";
export const CONSOLE_SIGN_IN_PATH = `${API_PREFIX}/sign-in`;
export const CONSOLE_SIGN_OUT_PATH = `${API_PREFIX}/sign-out`;
export const CONSOLE_SESSION_PATH = `${API_PREFIX}/session`;

/** Where the page lives. */
export const CONSOLE_PATH = "/console";

export interface ConsoleOptions {
  readonly service: TeamService;
  /**
   * The directory the built page is in, with an index.html at its top. Absent,
   * or without an index, and /console/ says the console is not built rather
   * than serving nothing.
   */
  readonly root?: string;
}

/**
 * Where the built page is: `console/` beside the running executable, which in
 * a build is dist/console beside dist/nlteam.js. `NLTEAM_CONSOLE_ROOT` names
 * another directory, for working on the page against a running server.
 */
export function consoleRoot(env: NodeJS.ProcessEnv = process.env): string {
  const named = env["NLTEAM_CONSOLE_ROOT"];
  return named !== undefined && named !== "" ? named : fileURLToPath(new URL("./console/", import.meta.url));
}

/** What a page of the console is allowed to load and talk to: this origin, and nothing else. */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** The account as the person signed in to the console sees it. */
function accountBody(user: UserRecord): Record<string, unknown> {
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    operator: isOperator(user.groups),
  };
}

/**
 * Answer a request if it is the console's, and say whether it was.
 */
export function serveConsole(
  options: ConsoleOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path === "/") {
    response.writeHead(302, { location: `${CONSOLE_PATH}/`, "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
    serveApi(options.service, request, response, path);
    return true;
  }

  if (path === CONSOLE_PATH || path.startsWith(`${CONSOLE_PATH}/`)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      onlyMethods(response, "GET, HEAD", "GET");
      return true;
    }
    answering(options.service, response, serveFile(options, request, response, path));
    return true;
  }

  return false;
}

function serveApi(service: TeamService, request: IncomingMessage, response: ServerResponse, path: string): void {
  if (path === CONSOLE_SIGN_IN_PATH) {
    if (request.method !== "POST") {
      onlyMethods(response, "POST", "POST");
      return;
    }
    answering(service, response, signIn(service, request, response));
    return;
  }
  if (path === CONSOLE_SIGN_OUT_PATH) {
    if (request.method !== "POST") {
      onlyMethods(response, "POST", "POST");
      return;
    }
    if (!sameOrigin(request)) {
      refuse(response, 403, "that request came from somewhere else");
      return;
    }
    const cookie = webSessionCookie(request.headers.cookie);
    if (cookie !== undefined) {
      endWebSession(service.database, cookie);
    }
    response.setHeader("set-cookie", clearedCookieHeader());
    sendJson(response, 200, {});
    return;
  }
  if (path === CONSOLE_SESSION_PATH) {
    if (request.method !== "GET") {
      onlyMethods(response, "GET", "GET");
      return;
    }
    const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
    if (identified.kind === "refused") {
      refuse(response, 401, describeWebSessionRefusal(identified.reason, describeRefusal));
      return;
    }
    sendJson(response, 200, { account: accountBody(identified.user) });
    return;
  }
  refuse(response, 404, "this server has nothing at that address.");
}

async function signIn(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!sameOrigin(request)) {
    // Strict, unlike the Studio route: what this answers with is a cookie, so a
    // page elsewhere that drove a browser here would be signing it in.
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const outcome = await checkSignIn(service, request, "console");
  switch (outcome.kind) {
    case "bad":
      refuse(response, 400, outcome.message);
      return;
    case "held":
      holdOff(response, outcome.seconds);
      return;
    case "refused":
      refuse(response, 401, SIGN_IN_REFUSED_MESSAGE);
      return;
    case "accepted":
      break;
  }
  const agent = request.headers["user-agent"];
  const { cookie } = createWebSession(service.database, outcome.user, {
    ...(agent === undefined ? {} : { userAgent: agent }),
  });
  service.log?.(`console: ${outcome.user.username} signed in`);
  response.setHeader("set-cookie", sessionCookieHeader(cookie));
  sendJson(response, 200, { account: accountBody(outcome.user) });
}

/** The headers every file of the page goes out with. */
function pageHeaders(contentType: string, immutable: boolean): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CONSOLE_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    // Built assets carry a hash in their names and never change under one;
    // everything else is asked for again so a new build is seen at once.
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
}

/**
 * One file of the built page, or index.html for an address that names a
 * screen rather than a file — the page routes itself once it is loaded.
 */
async function serveFile(
  options: ConsoleOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  const root = options.root;
  const index = root === undefined ? undefined : await fileAt(join(root, "index.html"));
  if (root === undefined || index === undefined) {
    const text = "the web console is not built into this server; run `npm run build:console`\n";
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : text);
    return;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(path.slice(CONSOLE_PATH.length)).replace(/^\/+/, "");
  } catch {
    refuse(response, 400, "that address is not one this server can read");
    return;
  }
  // Normalised and then held to the root: a `..` that climbs out of it, a
  // backslash on a platform that reads one as a separator, a NUL — none of them
  // name a file of the page, and every one is answered as a file that is not
  // there. So is anything starting with a dot.
  const resolved = normalize(join(root, relative));
  const inside = resolved === normalize(root) || resolved.startsWith(normalize(root).replace(/[\\/]*$/, sep));
  const dotted = relative.split(/[\\/]/).some((part) => part.startsWith("."));
  if (!inside || dotted || relative.includes("\0")) {
    refuse(response, 404, "there is nothing at that address");
    return;
  }

  const extension = extname(resolved).toLowerCase();
  const found = relative === "" ? undefined : await fileAt(resolved);
  if (found === undefined) {
    if (extension !== "") {
      // A file that is not there, rather than a screen.
      refuse(response, 404, "there is nothing at that address");
      return;
    }
    send(response, request, index, pageHeaders(CONTENT_TYPES[".html"] as string, false));
    return;
  }
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) {
    refuse(response, 404, "there is nothing at that address");
    return;
  }
  send(response, request, found, pageHeaders(contentType, relative.startsWith("assets/")));
}

async function fileAt(path: string): Promise<{ path: string; size: number } | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size } : undefined;
  } catch {
    return undefined;
  }
}

function send(
  response: ServerResponse,
  request: IncomingMessage,
  file: { path: string; size: number },
  headers: Record<string, string>,
): void {
  response.writeHead(200, { ...headers, "content-length": String(file.size) });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file.path).pipe(response);
}
