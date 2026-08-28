/**
 * The two documents Team serves about itself.
 *
 *     GET /.well-known/jwks.json   the public halves of the signing keys
 *     GET /health                  proof that this process is answering
 *
 * There is no user data here, nothing that writes, and no CORS headers: a
 * browser has no business calling these, and the one program that does — the
 * loreserver Team started, fetching the JWKS — is not a browser.
 *
 * They are served twice, from one implementation. src/web/router.ts serves them
 * on the TLS listener, which is the address an operator has and the one every
 * other question about this server is asked at. {@link IdentityEndpoint} serves
 * them again over plain HTTP on the loopback, for loreserver alone.
 *
 * **The plaintext listener is a measured concession, not a preference.** The
 * keys are what every token is verified against, so a JWKS fetched over a
 * connection somebody had tampered with is a token that verifies when it should
 * not, and serving them on the TLS listener would close that. loreserver will
 * not have it: it is already given Team's own authority as its only trust
 * anchor and verifies the certificate on the address it asks about callers at,
 * but the client behind `[server.auth.jwk] endpoint` does not use that anchor.
 * Pointed at `https://…/.well-known/jwks.json` it fails the handshake with
 * `tlsv1 alert unknown ca` and exits at once with `Internal Error`, before it
 * has served anything — measured against loreserver 0.8.6 on Windows. So the
 * fetch stays on plain HTTP, and what bounds it is that the listener answers on
 * the loopback of the machine Team runs loreserver on and nowhere else. A
 * deployment that ever runs loreserver on another machine has to revisit this.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { JwksDocument } from "./keys.js";

/** What these two routes need to answer with. */
export interface IdentityRoutesOptions {
  /**
   * Consulted per request, so a rotation is served without a restart. It may
   * do work — reading the keys directory again, for instance — which is why it
   * is allowed to be asynchronous.
   */
  readonly jwks: () => JwksDocument | Promise<JwksDocument>;
  /** Reported by `/health`. */
  readonly version: string;
}

/** What the loopback listener needs beyond the routes themselves. */
export interface EndpointOptions extends IdentityRoutesOptions {
  readonly port: number;
  /**
   * Interface to listen on. The loopback by default, and there is no caller
   * for whom that is not enough: see the note at the top of this file.
   */
  readonly host?: string;
}

/** Raised when the endpoint could not take its port. */
export class EndpointListenError extends Error {
  constructor(address: string, cause: Error) {
    super(
      `Team's endpoint could not listen on ${address}: ${cause.message}. ` +
        "Another program may hold that port; --team-port moves it.",
      { cause },
    );
    this.name = "EndpointListenError";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // A JWKS that a verifier holds on to after a key is retired is a token
    // that verifies when it should not. Caching it is the verifier's decision
    // to make deliberately, not one Team server makes for it by saying nothing.
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * Answer one request if it is for one of these two, and say whether it was.
 *
 * The shape every arm of src/web/router.ts takes: a false return is "this was
 * not mine", which is what lets the router try the next one and answer for a
 * missing address in one place rather than in several.
 */
export function serveIdentityRoutes(
  options: IdentityRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== "/.well-known/jwks.json" && path !== "/health") {
    return false;
  }

  // Answered here rather than passed on, because the path is one of these two
  // and the only thing wrong with the request is its verb. A router that went
  // on to the next arm would end up calling this a missing address.
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "only GET is served here" });
    return true;
  }

  if (path === "/health") {
    sendJson(response, 200, { ok: true, version: options.version });
    return true;
  }

  void Promise.resolve(options.jwks()).then(
    (document) => {
      sendJson(response, 200, document);
    },
    (error: unknown) => {
      // The keys could not be read. Saying so beats an open connection that
      // never answers, and there is nothing here worth hiding: a verifier that
      // cannot fetch the keys is going to fail anyway.
      sendJson(response, 500, {
        error: `the signing keys could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    },
  );
  return true;
}

/** The loopback listener loreserver fetches the keys from, listening. */
export class IdentityEndpoint {
  readonly #server: Server;
  readonly #host: string;
  readonly #port: number;

  private constructor(server: Server, host: string, port: number) {
    this.#server = server;
    this.#host = host;
    this.#port = port;
  }

  /** Start listening, or fail saying why. */
  static async start(options: EndpointOptions): Promise<IdentityEndpoint> {
    const host = options.host ?? "127.0.0.1";
    const server = createServer((request, response) => {
      // The path is taken apart with the URL parser rather than compared as a
      // string, so a query string or an escaped separator cannot make one route
      // look like another. The same reasoning as src/web/router.ts.
      const path = new URL(request.url ?? "/", "http://team.invalid").pathname;
      if (!serveIdentityRoutes(options, request, response, path)) {
        sendJson(response, 404, { error: "not found" });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new EndpointListenError(`${host}:${options.port}`, error));
      };
      server.once("error", onError);
      server.listen(options.port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    // Port 0 means "any free port", and the number it landed on is only
    // knowable afterwards. Reading it back means the address reported is the
    // one that works, whichever was asked for.
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return new IdentityEndpoint(server, host, port);
  }

  /** Where it is listening, as it is written in a URL. */
  get url(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  /**
   * Stop listening and return once nothing is left open.
   *
   * Open keep-alive connections are closed rather than waited for: a client
   * holding one would otherwise keep the process alive after the operator has
   * asked it to stop.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}
