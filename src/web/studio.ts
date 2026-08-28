/**
 * The one thing a Studio installation asks this server for over HTTP.
 *
 * Studio is handed one address and nothing else. The discovery document turns
 * the address into a server; this turns a username and a password into the token
 * everything after it needs. Everything after it is the session — every project a
 * person reads, makes or forgets travels on the WebSocket, because a read and the
 * event that invalidates it have to arrive down one connection in order.
 *
 * So there is exactly one route:
 *
 *     POST   /api/studio/v1/sign-in   a password, for a token
 *
 * It takes no bearer, because it is where a bearer comes from, and it is the only
 * thing here that has to work before a session exists. It is a second door onto
 * what `nlteam token mint` does at the server, for the same accounts and with the
 * same refusals: an operator who would otherwise mint a token and send it through
 * a chat window can hand over a username and a password instead. What it mints is
 * the same token, claim for claim — see {@link answerSignIn}.
 *
 * Every other address under the prefix is answered here too, as a 404, so that a
 * mistyped API address is refused as one rather than falling through to something
 * that knows nothing about this API.
 *
 * It is served on the same HTTP/1.1 listener as the discovery document and the
 * socket upgrade. One listener means one certificate, and therefore one decision
 * to trust — the reason set out in ./router.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { defaultPasswordHasher } from "../identity/passwords.js";
import {
  holdRefusedSignIn,
  sharedSignInLimiter,
} from "../identity/signin.js";
import { mintToken } from "../identity/tokens.js";
import { authenticate, SIGN_IN_REFUSED_MESSAGE } from "../identity/users.js";
import { mintingConfig, type TeamService } from "../team/service.js";
import { originIsOurs, remoteAddressOf } from "./origin.js";

/** Where the route lives. Versioned, because a client older than the server is ordinary. */
const PREFIX = "/api/studio/v1";

/**
 * Where a username and a password become a token.
 *
 * Exported because this server is no longer the only thing in this repository
 * that knows the address: `nlteam login` posts to it too. One constant, so that
 * the route cannot come to be served at one address and asked for at another.
 */
export const STUDIO_SIGN_IN_PATH = `${PREFIX}/sign-in`;

/** How much of a request body is read before it is refused as nonsense. */
const MAXIMUM_BODY_BYTES = 4 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * Say no, in the shape everything else here answers in.
 *
 * One sentence and nothing else. A client that cannot act on the difference
 * between two refusals is a client that will print whichever it got, so the
 * sentence is the whole of the answer.
 */
function refuse(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

/**
 * Say that this one was not tried, and when the next one will be.
 *
 * `retry-after` as well as the sentence, because a client that reads it can
 * wait rather than keep asking, and one that does not has been told in words.
 */
function holdOff(response: ServerResponse, seconds: number): void {
  const body = JSON.stringify({
    error: `too many sign-ins from here have been refused; try again in ${seconds} seconds`,
  });
  response.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "retry-after": String(seconds),
  });
  response.end(body);
}

/**
 * Answer, and turn anything nobody planned for into one sentence.
 *
 * The route here is reached over the network before any token has been
 * presented, so a handler whose promise rejects is an unhandled rejection —
 * which takes the whole server down rather than the one request. A body
 * abandoned halfway through is enough to make one. The same guard ./api.ts puts
 * in front of the operator's interface, for the same reason.
 */
function answering(
  options: TeamService,
  response: ServerResponse,
  work: Promise<void>,
): void {
  void work.catch((error: unknown) => {
    options.log?.(`studio: ${error instanceof Error ? error.message : String(error)}`);
    if (response.headersSent) {
      // Whatever was being written is finished with; the socket must not be
      // left open on a page waiting for the rest of an answer.
      response.end();
      return;
    }
    refuse(response, 500, "something went wrong answering that");
  });
}

/** Read a JSON body, or say what was wrong with it. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAXIMUM_BODY_BYTES) {
      return "that request body is larger than anything this API takes";
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    return "that request needs a JSON body";
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "that request body is not a JSON object";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "that request body is not JSON";
  }
}

function text(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Answer a request if it is one of ours, and say whether it was.
 *
 * Returns false for everything outside this API's prefix, so the router can go
 * on to whatever else it serves without this having to know what that is.
 *
 * Everything **inside** the prefix is answered here, including the addresses
 * there is nothing at, so that a mistyped API address is refused as one rather
 * than falling through to something that knows nothing about this API. That is
 * most of the prefix: everything a Studio installation asks a server for beyond
 * a token is a method on the session, so an address under here that is not the
 * sign-in route is one nothing has ever served.
 */
export function serveStudioApi(
  options: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    return false;
  }

  if (path === STUDIO_SIGN_IN_PATH) {
    if (request.method !== "POST") {
      onlyMethods(response, "POST", "POST");
      return true;
    }
    answering(options, response, answerSignIn(options, request, response));
    return true;
  }

  refuse(response, 404, "this server has nothing at that address.");
  return true;
}

/** Say which methods an address takes, in the header and in the sentence. */
function onlyMethods(response: ServerResponse, allow: string, spoken: string): void {
  response.writeHead(405, { allow, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `that address takes ${spoken}` }));
}

/**
 * A username and a password, for the token everything else here takes.
 *
 * The token is the one `nlteam token mint` prints, and it has to be: Studio
 * compares a token's audience against the address it dialled and refuses one
 * that differs, and it reads the authority's fingerprint out of the claims to
 * know which machine it has been asked to trust. So the claims are not composed
 * here — {@link mintToken} writes them, from the stored lifetimes and the same
 * account record, exactly as the command does.
 *
 * Every refusal is the same refusal
 * ---------------------------------
 * One status and one sentence for an account that is not there, a password that
 * is wrong, an account that has been disabled and an account that belongs to a
 * machine. Whoever is at the other end learns nothing about which accounts
 * exist on this server, which is the same rule `nlteam token mint` and the
 * operator's sign-in are written to.
 *
 * A service account is refused for a different reason and answered the same
 * way: it is an account no person signs in to, and a password prompt that
 * accepted one would be an interactive door onto a machine's credentials.
 *
 * Nothing about the body is logged, ever. A refusal may name the username that
 * was tried, because an operator reading the log needs to know what is being
 * guessed at; the password does not appear in any line here, or in any error
 * this can raise.
 *
 * What it costs to knock
 * ----------------------
 * A password check is the most expensive thing this server does for somebody
 * who has presented nothing, and an unknown username costs the same as a known
 * one because it is hashed against a decoy. So the door is guarded before the
 * check rather than after it: a request from a page of another site is refused
 * on its `origin`, and a name that has been refused often enough from one place
 * is answered without its password being looked at.
 */
async function answerSignIn(
  options: TeamService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!originIsOurs(request)) {
    // The token this answers with goes in the body rather than in a cookie, so
    // a page elsewhere gains nothing by making the request. What it would gain
    // is the ability to spend this server's password checking through the
    // browser of anybody who visits it.
    refuse(response, 403, "that request came from somewhere else");
    return;
  }

  const body = await readJson(request);
  if (typeof body === "string") {
    // What was wrong with the request, which is not a statement about any
    // account: a body too long or not JSON is answered before a password is
    // read out of it.
    refuse(response, 400, body);
    return;
  }
  const username = text(body, "username");
  const password = typeof body["password"] === "string" ? body["password"] : undefined;
  if (username === undefined || password === undefined) {
    refuse(response, 400, "a sign-in takes a username and a password");
    return;
  }

  const limiter = options.signIns ?? sharedSignInLimiter();
  const address = remoteAddressOf(request);
  const wait = limiter.waitFor(username, address);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    options.log?.(`studio: sign-in for ${JSON.stringify(username)} held off for ${seconds}s`);
    // A different sentence from the refusal below, and it may be: what it says
    // is how often this caller has been wrong, which they already know, and
    // nothing about whether the account they named is one this server has.
    holdOff(response, seconds);
    return;
  }

  // Not wrapped in anything: how many password checks this process runs at once
  // is the hasher's own business now, so this door and the management plane's
  // `admin.users.create` are held to one budget rather than to two.
  const result = await authenticate(
    options.database,
    defaultPasswordHasher(),
    username,
    password,
  );
  if (result.kind === "refused" || result.user.isServiceAccount) {
    if (result.kind === "refused") {
      limiter.refused(username, address);
    } else {
      // The password was right; the account is simply not one a person signs
      // in to. Counting it would hold that against whoever typed it.
      limiter.accepted(username, address);
    }
    await holdRefusedSignIn();
    options.log?.(`studio: sign-in refused for ${JSON.stringify(username)}`);
    refuse(response, 401, SIGN_IN_REFUSED_MESSAGE);
    return;
  }
  limiter.accepted(username, address);

  const config = mintingConfig(options);
  const minted = mintToken(result.user, options.keys.signingKey, config, {
    purpose: "sign-in",
    ...(options.fingerprint === undefined ? {} : { authorityFingerprint: options.fingerprint }),
  });

  options.log?.(`studio: ${result.user.username} signed in`);
  sendJson(response, 200, {
    token: minted.token,
    // The account as the person who just signed in is entitled to see it, which
    // is their own row and nothing about anybody else's. What groups they are
    // in is not here: it decides nothing about the projects this API serves,
    // and Studio has no screen that would be different for an operator.
    account: {
      username: result.user.username,
      displayName: result.user.displayName,
      ...(result.user.email === undefined ? {} : { email: result.user.email }),
    },
  });
}

