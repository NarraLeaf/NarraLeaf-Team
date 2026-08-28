/**
 * What answers an HTTP/1.1 request on the TLS listener.
 *
 * The listener speaks gRPC over h2, and these three paths are everything it
 * answers in HTTP/1.1. They are here rather than on a port of their own, and
 * the reason is the one written at the top of src/identity/discovery.ts.
 * **One listener, one certificate, and therefore one decision to trust.** An
 * operator has already been asked to compare a fingerprint and run
 * `nlteam trust`; a second port with a second certificate would be a second
 * such conversation.
 *
 * So this is a router with four arms, in the order they are tried:
 *
 *   - `/.well-known/nlteam`, which is served to whoever asks. It is what turns
 *     one address into a server, so nothing may get in its way.
 *   - `/.well-known/jwks.json` and `/health`, which src/identity/endpoint.ts
 *     answers. Two documents about this server rather than about anybody using
 *     it, and the file says why they are no longer a listener of their own.
 *   - `/api/studio/…`, which src/web/studio.ts answers. That is the sign-in
 *     route and nothing else: everything an author does afterwards travels on
 *     the WebSocket this listener also upgrades, which is not HTTP/1.1 by the
 *     time it carries anything and so is not routed here.
 *   - `/api/team/v1/blobs/…`, which src/web/blobs.ts answers. It is the only
 *     thing on this listener that is bytes rather than a document, and it is
 *     kept apart for that reason: it neither reads a body into memory nor
 *     writes one, and the arm above does neither by design.
 *
 * Anything else is a 404. There are no pages on this port: this server is
 * administered from Studio and from the `nlteam` commands, and neither of them
 * is a browser.
 */
import { serveDiscovery, type DiscoveryDocument } from "../identity/discovery.js";
import { serveIdentityRoutes, type IdentityRoutesOptions } from "../identity/endpoint.js";
import type { TeamService } from "../team/service.js";
import { serveTeamBlobs, type BlobRoutesOptions } from "./blobs.js";
import { serveStudioApi } from "./studio.js";

import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebOptions {
  /**
   * The signing keys and this process's health.
   *
   * Optional for the same reason the two below are: a test that wants a router
   * to try one arm should not have to hand it the others.
   */
  readonly identity?: IdentityRoutesOptions;
  /** What a Studio installation talks to. Absent only where nothing serves it. */
  readonly studio?: TeamService;
  /**
   * Where a live session puts a file down. Absent for a build with no store.
   *
   * Optional in the sense a method module is: a build without it neither serves
   * these addresses nor announces the capability, and the two cannot drift apart
   * because the second is worked out from the first.
   */
  readonly blobs?: BlobRoutesOptions;
}

/**
 * Serve one HTTP/1.1 request.
 *
 * Returned as a handler rather than exported as a function of many arguments,
 * because that is the shape the listener takes.
 *
 * The discovery document arrives as something to call rather than as a value.
 * Most of it is settled when `up` starts, but the name a server calls itself is
 * a stored setting — one somebody changes from another terminal while this
 * process is running — and a document composed once would go on announcing the
 * name that server had at boot.
 */
export function webHandler(
  discovery: () => DiscoveryDocument,
  options: WebOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    // Taken apart with the URL parser rather than compared as a string, so a
    // query string or an escaped separator cannot make one route look like
    // another. Every arm below is handed this path rather than the raw one, so
    // that decision is made once for all of them.
    const path = new URL(request.url ?? "/", "http://team.invalid").pathname;

    if (path === "/.well-known/nlteam") {
      serveDiscovery(discovery(), request, response);
      return;
    }

    if (
      options.identity !== undefined &&
      serveIdentityRoutes(options.identity, request, response, path)
    ) {
      return;
    }

    if (options.studio !== undefined && serveStudioApi(options.studio, request, response, path)) {
      return;
    }

    if (options.blobs !== undefined && serveTeamBlobs(options.blobs, request, response, path)) {
      return;
    }

    const text = "there is nothing at that address\n";
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    response.end(text);
  };
}
