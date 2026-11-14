/**
 * Whether a request that means to do something came from a page of this server.
 *
 * A browser sends `origin` on every request that can do harm, and it is the one
 * header a page on somebody else's site cannot forge. Both HTTP APIs served
 * here check it on the routes that change something or check a password, so it
 * lives beside neither of them.
 *
 * What it stops is not a stolen session — one of these APIs answers with a
 * bearer token rather than a cookie, so a page elsewhere gains nothing by
 * making the request. It is that any page a person visits can otherwise drive
 * their browser at this server's sign-in, and a password check is the most
 * expensive thing this server will do for whoever asks.
 */
import type { IncomingMessage } from "node:http";

/**
 * True when this request came from this server, or from something that is not a
 * browser at all.
 *
 * An absent `origin` is allowed: a browser sends one on every request that can
 * do harm, and a command-line client which sends none has whatever credential
 * it holds because somebody deliberately gave it one. A present one that names
 * another host is refused, which is the case the header exists for.
 */
export function originIsOurs(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined || origin === "null") {
    return origin === undefined;
  }
  // HTTP/2 names the host in `:authority` rather than in a `host` header, and a
  // browser speaks HTTP/2 on this port as readily as HTTP/1.1.
  const authority = request.headers[":authority"];
  const host = request.headers.host ?? (typeof authority === "string" ? authority : undefined);
  if (host === undefined) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Where a request came from, as the sign-in limiter keys on it.
 *
 * A socket with no address is a socket that has already gone; it is named
 * rather than left undefined so that every attempt is counted against
 * something.
 */
export function remoteAddressOf(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "an unknown address";
}

/**
 * True only when a browser said the request came from a page of this server.
 *
 * Stricter than {@link originIsOurs}: an absent `origin` is refused. Used where
 * the answer is a cookie or the credential is one — the console's sign-in and
 * sign-out, and a socket upgrade that is signed in by a cookie — because there
 * the only client is a browser, every browser sends the header on these
 * requests, and a request without one is not a page of this server.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  return request.headers.origin !== undefined && originIsOurs(request);
}
