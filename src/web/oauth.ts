/**
 * The OAuth endpoints Studio talks to, and the console API the approval page uses.
 *
 *     GET  /oauth/authorize            send the browser to the console's approval page
 *     POST /oauth/token                a code, a refresh token or a device code, for tokens
 *     POST /oauth/device               begin a device sign-in (RFC 8628)
 *     GET  /api/console/v1/oauth/authorize?…   what is being asked, for the approval page
 *     POST /api/console/v1/oauth/authorize     approve or refuse it; answers where to go
 *     GET  /api/console/v1/oauth/device?code=  what a typed user code names
 *     POST /api/console/v1/oauth/device        approve or refuse it
 *
 * The token and device endpoints are called by Studio, not by a page, and take
 * no cookie: everything they need is in the request. The console endpoints are
 * the reverse — a cookie and a same-origin page, and nothing else — because
 * approving is something only the person signed in to this server may do.
 * src/identity/oauth.ts holds the rules.
 */
import { policyNumber, STUDIO_ACCESS_HOURS } from "../identity/policy.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describeRefusal } from "../identity/bearer.js";
import { authUrl } from "../identity/config.js";
import {
  approveAuthorization,
  checkAuthorizeRequest,
  decideDevice,
  denyAuthorization,
  findDevice,
  pollDevice,
  redeemCode,
  refreshGrant,
  startDevice,
  type IssuedGrant,
  type OAuthError,
} from "../identity/oauth.js";
import { mintToken } from "../identity/tokens.js";
import { describeWebSessionRefusal, identifyWebSession, webSessionCookie } from "../identity/websessions.js";
import type { UserRecord } from "../identity/users.js";
import { mintingConfig, type TeamService } from "../team/service.js";
import { sameOrigin } from "./origin.js";
import { answering, onlyMethods, readJson, refuse, sendJson } from "./studio.js";

export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_DEVICE_PATH = "/oauth/device";
const CONSOLE_AUTHORIZE_API = "/api/console/v1/oauth/authorize";
const CONSOLE_DEVICE_API = "/api/console/v1/oauth/device";

/** The most of a form body read: a code, a verifier and a redirect, not a document. */
const MAXIMUM_FORM_BYTES = 8 * 1024;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Answer a request if it is one of these, and say whether it was. */
export function serveOAuth(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  switch (path) {
    case OAUTH_AUTHORIZE_PATH: {
      // The page does the work; this keeps the address RFC 8414 clients expect.
      const query = new URL(request.url ?? "/", "http://team.invalid").search;
      response.writeHead(302, { location: `/console/oauth/authorize${query}`, "cache-control": "no-store" });
      response.end();
      return true;
    }
    case OAUTH_TOKEN_PATH:
      if (request.method !== "POST") {
        onlyMethods(response, "POST", "POST");
        return true;
      }
      answering(service, response, token(service, request, response));
      return true;
    case OAUTH_DEVICE_PATH:
      if (request.method !== "POST") {
        onlyMethods(response, "POST", "POST");
        return true;
      }
      answering(service, response, device(service, request, response));
      return true;
    case CONSOLE_AUTHORIZE_API:
      answering(service, response, consoleAuthorize(service, request, response));
      return true;
    case CONSOLE_DEVICE_API:
      answering(service, response, consoleDevice(service, request, response));
      return true;
    default:
      return false;
  }
}

/* ------------------------------------------------------------ Studio's half */

function oauthError(response: ServerResponse, failure: OAuthError): void {
  const status = failure.error === "invalid_client" ? 401 : 400;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(JSON.stringify({ error: failure.error, error_description: failure.description }));
}

/** A form body (as RFC 6749 says) or a JSON one (as is kinder), read the same way. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAXIMUM_FORM_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(request.headers["content-type"] ?? "");
  if (type.startsWith("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return undefined;
      }
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") {
          form.set(key, value);
        }
      }
      return form;
    } catch {
      return undefined;
    }
  }
  return new URLSearchParams(text);
}

/** The token response for a grant: Studio's usual token, under its grant, plus the next refresh token. */
function issue(service: TeamService, response: ServerResponse, issued: IssuedGrant): void {
  const minted = mintToken(issued.user, service.keys.signingKey, mintingConfig(service), {
    purpose: "sign-in",
    // Studio refreshes on its own, so its token can be short: a day unless the operator says otherwise.
    lifetimeSeconds: policyNumber(service.database, STUDIO_ACCESS_HOURS) * 3600,
    grant: issued.grantId,
    ...(service.fingerprint === undefined ? {} : { authorityFingerprint: service.fingerprint }),
  });
  service.log?.(`oauth: issued a token to ${issued.user.username} under grant ${issued.grantId}`);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(
    JSON.stringify({
      access_token: minted.token,
      token_type: "Bearer",
      expires_in: minted.claims.exp - minted.claims.iat,
      refresh_token: issued.refreshToken,
      // The account, as the password sign-in has always answered with it, so
      // Studio can name who is signed in without decoding the token.
      account: {
        username: issued.user.username,
        displayName: issued.user.displayName,
        ...(issued.user.email === undefined ? {} : { email: issued.user.email }),
      },
    }),
  );
}

async function token(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const form = await readForm(request);
  if (form === undefined) {
    oauthError(response, { error: "invalid_request", description: "that request body is not a form" });
    return;
  }
  const clientId = form.get("client_id") ?? "";
  let outcome: IssuedGrant | OAuthError;
  switch (form.get("grant_type")) {
    case "authorization_code":
      outcome = redeemCode(service.database, {
        code: form.get("code") ?? "",
        clientId,
        redirectUri: form.get("redirect_uri") ?? "",
        verifier: form.get("code_verifier") ?? "",
      });
      break;
    case "refresh_token":
      outcome = refreshGrant(service.database, { refreshToken: form.get("refresh_token") ?? "", clientId });
      break;
    case DEVICE_GRANT:
      outcome = pollDevice(service.database, { deviceCode: form.get("device_code") ?? "", clientId });
      break;
    default:
      oauthError(response, { error: "unsupported_grant_type", description: "that grant type is not served" });
      return;
  }
  if ("error" in outcome) {
    oauthError(response, outcome);
    return;
  }
  issue(service, response, outcome);
}

async function device(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const form = await readForm(request);
  if (form === undefined) {
    oauthError(response, { error: "invalid_request", description: "that request body is not a form" });
    return;
  }
  const deviceName = form.get("device_name");
  const started = startDevice(service.database, {
    clientId: form.get("client_id") ?? "",
    ...(deviceName === null ? {} : { deviceName }),
  });
  if ("error" in started) {
    oauthError(response, started);
    return;
  }
  const verification = `${authUrl(service.config)}/console/device`;
  sendJson(response, 200, {
    device_code: started.deviceCode,
    user_code: started.userCode,
    verification_uri: verification,
    verification_uri_complete: `${verification}?code=${encodeURIComponent(started.userCode)}`,
    expires_in: started.expiresIn,
    interval: started.interval,
  });
}

/* ------------------------------------------------------- the console's half */

/** The person signed in to the console, or a 401 already sent. */
function signedIn(service: TeamService, request: IncomingMessage, response: ServerResponse): UserRecord | undefined {
  const identified = identifyWebSession(service.database, webSessionCookie(request.headers.cookie));
  if (identified.kind === "refused") {
    refuse(response, 401, describeWebSessionRefusal(identified.reason, describeRefusal));
    return undefined;
  }
  return identified.user;
}

async function consoleAuthorize(
  service: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET") {
    const user = signedIn(service, request, response);
    if (user === undefined) return;
    const checked = checkAuthorizeRequest(new URL(request.url ?? "/", "http://team.invalid").searchParams);
    if ("error" in checked) {
      sendJson(response, 400, { error: checked.error, description: checked.description });
      return;
    }
    sendJson(response, 200, { clientName: checked.clientName, deviceName: checked.deviceName });
    return;
  }
  if (request.method !== "POST") {
    onlyMethods(response, "GET, POST", "GET or POST");
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const user = signedIn(service, request, response);
  if (user === undefined) return;
  const body = await readJson(request);
  if (typeof body === "string") {
    refuse(response, 400, body);
    return;
  }
  const query = typeof body["query"] === "string" ? body["query"] : "";
  const checked = checkAuthorizeRequest(new URLSearchParams(query));
  if ("error" in checked) {
    sendJson(response, 400, { error: checked.error, description: checked.description });
    return;
  }
  if (body["approve"] !== true) {
    sendJson(response, 200, { redirect: denyAuthorization(checked) });
    return;
  }
  service.log?.(`oauth: ${user.username} approved ${checked.clientName} on ${checked.deviceName}`);
  sendJson(response, 200, { redirect: approveAuthorization(service.database, user, checked) });
}

async function consoleDevice(service: TeamService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET") {
    const user = signedIn(service, request, response);
    if (user === undefined) return;
    const code = new URL(request.url ?? "/", "http://team.invalid").searchParams.get("code") ?? "";
    const found = findDevice(service.database, code);
    if (found === undefined) {
      refuse(response, 404, "that code is not one waiting here; check it, or start again on the device");
      return;
    }
    sendJson(response, 200, found);
    return;
  }
  if (request.method !== "POST") {
    onlyMethods(response, "GET, POST", "GET or POST");
    return;
  }
  if (!sameOrigin(request)) {
    refuse(response, 403, "that request came from somewhere else");
    return;
  }
  const user = signedIn(service, request, response);
  if (user === undefined) return;
  const body = await readJson(request);
  if (typeof body === "string") {
    refuse(response, 400, body);
    return;
  }
  const code = typeof body["code"] === "string" ? body["code"] : "";
  if (!decideDevice(service.database, code, user, body["approve"] === true)) {
    refuse(response, 404, "that code is not one waiting here; check it, or start again on the device");
    return;
  }
  sendJson(response, 200, {});
}
