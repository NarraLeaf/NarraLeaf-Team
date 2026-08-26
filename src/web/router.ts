/**
 * What answers an HTTP/1.1 request on the TLS listener.
 *
 * The listener speaks gRPC over h2, and these two paths are everything it
 * answers in HTTP/1.1. They are here rather than on a port of their own, and
 * the reason is the one written at the top of src/identity/discovery.ts.
 * **One listener, one certificate, and therefore one decision to trust.** An
 * operator has already been asked to compare a fingerprint and run
 * `nlteam trust`; a second port with a second certificate would be a second
 * such conversation.
 *
 * So this is a router with two arms, in the order they are tried:
 *
 *   - `/.well-known/nlteam`, which is served to whoever asks. It is what turns
 *     one address into a server, so nothing may get in its way.
 *   - `/api/studio/…`, which src/web/studio.ts answers. It is how every Studio
 *     installation finds its work.
 *
 * Anything else is a 404. There are no pages on this port: this server is
 * administered from Studio and from the `nlteam` commands, and neither of them
 * is a browser.
 */
import { serveDiscovery, type DiscoveryDocument } from "../identity/discovery.js";
import { serveStudioApi, type StudioApiOptions } from "./studio.js";

import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebOptions {
  /** What a Studio installation talks to. Absent only where nothing serves it. */
  readonly studio?: StudioApiOptions;
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
    // another. The same reasoning as src/identity/endpoint.ts.
    const path = new URL(request.url ?? "/", "http://team.invalid").pathname;

    if (path === "/.well-known/nlteam") {
      serveDiscovery(discovery(), request, response);
      return;
    }

    if (options.studio !== undefined && serveStudioApi(options.studio, request, response, path)) {
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
