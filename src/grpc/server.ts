/**
 * A gRPC server, on HTTP/2 with TLS or without it.
 *
 * gRPC is HTTP/2 with four conventions on top: the method is POST, the path is
 * `/package.Service/Method`, the body is framed as src/grpc/framing.ts
 * describes, and the outcome is a `grpc-status` trailer rather than a status
 * code. That is the whole of what this implements, for calls of one message in
 * each direction — the only shape either service Team serves uses.
 *
 * Both transports are served, by two listeners over one set of methods, because
 * the two callers cannot use the same one:
 *
 *   - loreserver connects to the address in its `auth_url` over the loopback of
 *     the machine Team started it on, and speaks h2c there with no certificate
 *     involved. What travels is a token the caller already holds and a list of
 *     resource ids, over a socket nothing off the machine can reach.
 *   - A Studio installation refuses anything but TLS, and refuses a certificate
 *     that does not chain to a trust anchor of its own host. src/tls/ is what
 *     that costs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  createSecureServer,
  createServer,
  type Http2SecureServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
  type ServerHttp2Session,
} from "node:http2";

import { encodeFrame, FrameAssembler } from "./framing.js";
import {
  encodeStatusMessage,
  GRPC_INTERNAL,
  GRPC_INVALID_ARGUMENT,
  GRPC_OK,
  GRPC_UNIMPLEMENTED,
  GrpcStatusError,
} from "./status.js";

/** One call, as a method sees it. */
export interface GrpcCall {
  /** `/package.Service/Method`, exactly as it arrived. */
  readonly path: string;
  /** The `authorization` header, whatever it held, or undefined for none. */
  readonly authorization: string | undefined;
  /** The one request message, decoded out of its frame. */
  readonly message: Buffer;
  /** Where the call came from, for a log line. */
  readonly peer: string;
}

/** What a method does with a call: answer with one message, or fail. */
export type GrpcMethod = (call: GrpcCall) => Buffer | Promise<Buffer>;

/** Whether this listener has anything to say to a client that does not speak h2. */
function speaksHttp1(options: GrpcServerOptions): boolean {
  return options.http1 !== undefined || options.upgrade !== undefined;
}

/** The certificate and key a TLS listener presents. */
export interface GrpcTlsOptions {
  /** The endpoint's certificate, and the authority's after it. */
  readonly cert: string;
  readonly key: string;
}

/** What a server needs to answer. */
export interface GrpcServerOptions {
  readonly port: number;
  /**
   * Answer HTTP/1.1 requests on this listener as well, with this handler.
   *
   * Set only on the TLS endpoint, and only for the discovery document: a server that
   * hands out one address has to answer something at it before the caller has a token,
   * a session, or a reason to believe anything it is told. gRPC is untouched - it
   * negotiates h2 and arrives as a stream, which this never sees.
   */
  readonly http1?: (request: IncomingMessage, response: ServerResponse) => void;
  /**
   * Take an HTTP/1.1 upgrade on this listener, for the Team protocol's socket.
   *
   * The same listener, the same certificate and therefore the same decision to
   * trust as everything else a Studio installation talks to - the reason set out
   * in src/team/endpoint.ts. gRPC is untouched: an h2 client never sends one of
   * these, and this event is only reached by a connection whose ALPN settled on
   * HTTP/1.1.
   *
   * Handed the raw socket, because that is what an upgrade is. Whoever takes it
   * owns everything after this point, refusals included.
   */
  readonly upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Interface to listen on; the loopback by default. */
  readonly host?: string;
  /**
   * True to listen on every interface rather than one.
   *
   * No address is given to `listen` in that case, so node binds the unspecified
   * IPv6 address where IPv6 exists and falls back to the IPv4 one where it does
   * not. Naming `0.0.0.0` here instead would be reachable over IPv4 only, and
   * naming `::` would fail outright on a machine with IPv6 switched off.
   */
  readonly anyInterface?: boolean;
  /** Methods by full path. Anything else is answered `UNIMPLEMENTED`. */
  readonly methods: Readonly<Record<string, GrpcMethod>>;
  /** Present for an https listener; absent for a plaintext one. */
  readonly tls?: GrpcTlsOptions;
  /** The option that moves this listener, named in the message if it cannot start. */
  readonly portOption?: string;
  /**
   * Called for a failure that belongs to no call — a broken session, a socket
   * that died mid-reply. Without one, such a failure is swallowed, because
   * there is nobody left to answer.
   */
  readonly onError?: (error: Error) => void;
}

/** Raised when the server could not take its port. */
export class GrpcListenError extends Error {
  constructor(address: string, cause: Error, portOption = "--auth-port") {
    super(
      `Team's authorization service could not listen on ${address}: ${cause.message}. ` +
        `Another program may hold that port; ${portOption} moves it.`,
      { cause },
    );
    this.name = "GrpcListenError";
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** End a call with a status and no message. */
function respondWithStatus(stream: ServerHttp2Stream, status: number, message: string): void {
  if (stream.destroyed || stream.headersSent) {
    return;
  }
  // A "Trailers-Only" reply: one HEADERS frame carrying both the HTTP status
  // and the gRPC status, and no body at all. The protocol allows it for a call
  // that failed before anything was produced, and a client reads the outcome
  // from these headers rather than waiting for trailers that never come.
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(status),
      "grpc-message": encodeStatusMessage(message),
    },
    { endStream: true },
  );
}

/** End a call with one message and a status of OK. */
function respondWithMessage(stream: ServerHttp2Stream, message: Uint8Array): void {
  if (stream.destroyed || stream.headersSent) {
    return;
  }
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  // The compat layer is switched on for the whole server the moment a
  // `request` listener is added — which serving HTTP/1.1 beside this does —
  // and it then builds a response object for every h2 stream, including the
  // gRPC ones it will never answer. That object listens for `wantTrailers`
  // too, and being first it sends an empty set; ours would arrive second and
  // node throws ERR_HTTP2_TRAILERS_ALREADY_SENT out of an event handler, which
  // is to say it takes the process down. This stream is answered here, so the
  // listeners on it are ours to clear.
  stream.removeAllListeners("wantTrailers");
  stream.once("wantTrailers", () => {
    stream.sendTrailers({ "grpc-status": String(GRPC_OK) });
  });
  stream.end(encodeFrame(message));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one request's single message, then run its method and answer. */
function handleStream(
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  options: GrpcServerOptions,
): void {
  const path = headerValue(headers, ":path") ?? "";
  const method = options.methods[path];
  const assembler = new FrameAssembler();
  /** The one message a call carries, once enough of the stream has arrived. */
  let message: Buffer | undefined;

  // A stream can fail at any point — the peer going away mid-call is ordinary.
  // Without this listener the failure is thrown at the process instead.
  stream.on("error", (error: Error) => {
    options.onError?.(error);
  });

  if (headerValue(headers, ":method") !== "POST") {
    respondWithStatus(stream, GRPC_UNIMPLEMENTED, "a gRPC call is a POST");
    return;
  }
  if (method === undefined) {
    respondWithStatus(stream, GRPC_UNIMPLEMENTED, `${path} is not a method this service serves`);
    return;
  }

  stream.on("data", (chunk: Buffer) => {
    // Nothing more is read once the call has been answered, which is what
    // makes the refusal below cost something to send rather than something to
    // hold: an answered stream stops feeding the assembler.
    if (stream.destroyed || stream.headersSent) {
      return;
    }
    try {
      for (const decoded of assembler.push(chunk)) {
        if (message === undefined) {
          message = decoded;
          continue;
        }
        // Every method this service serves is one message in and one message
        // out, so a second is not part of a call this can answer. Keeping them
        // to read the first would mean a four-mebibyte body of five-byte empty
        // frames retaining the best part of a million buffers, for a call
        // whose answer was decided by its first frame.
        respondWithStatus(
          stream,
          GRPC_INVALID_ARGUMENT,
          "this method takes one message, and this call carried more than one",
        );
        stream.close();
        return;
      }
    } catch (error) {
      const status = error instanceof GrpcStatusError ? error.status : GRPC_INTERNAL;
      respondWithStatus(stream, status, describe(error));
      stream.close();
    }
  });

  stream.on("end", () => {
    if (stream.destroyed || stream.headersSent) {
      return;
    }
    const carried = message;
    if (carried === undefined || assembler.incomplete) {
      respondWithStatus(
        stream,
        GRPC_INVALID_ARGUMENT,
        assembler.incomplete
          ? "the request ended in the middle of a message"
          : "the request carried no message",
      );
      return;
    }

    const call: GrpcCall = {
      path,
      authorization: headerValue(headers, "authorization"),
      message: carried,
      peer: `${stream.session?.socket.remoteAddress ?? "?"}:${
        stream.session?.socket.remotePort ?? 0
      }`,
    };

    void (async () => {
      try {
        respondWithMessage(stream, await method(call));
      } catch (error) {
        // A method that raises has already decided nothing is being sent, so
        // the failure becomes the whole reply. Anything that is not a status
        // of its own is INTERNAL: it is a fault in Team, not in the request.
        const status = error instanceof GrpcStatusError ? error.status : GRPC_INTERNAL;
        respondWithStatus(stream, status, describe(error));
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** A gRPC server, listening. */
export class GrpcServer {
  readonly #server: Http2Server | Http2SecureServer;
  readonly #sessions: Set<ServerHttp2Session>;
  readonly #host: string;
  readonly #port: number;
  readonly #scheme: "http" | "https";

  private constructor(
    server: Http2Server | Http2SecureServer,
    sessions: Set<ServerHttp2Session>,
    host: string,
    port: number,
    scheme: "http" | "https",
  ) {
    this.#server = server;
    this.#sessions = sessions;
    this.#host = host;
    this.#port = port;
    this.#scheme = scheme;
  }

  /** Start listening, or fail saying why. */
  static async start(options: GrpcServerOptions): Promise<GrpcServer> {
    const host = options.host ?? "127.0.0.1";
    const server =
      options.tls === undefined
        ? createServer()
        : createSecureServer({
            cert: options.tls.cert,
            key: options.tls.key,
            // gRPC over TLS is HTTP/2 over TLS, so `h2` comes first and is what
            // every client of the service negotiates. HTTP/1.1 is offered only
            // where there is something to answer with, and a client that
            // negotiates it reaches `http1` rather than a protocol error.
            ALPNProtocols: speaksHttp1(options) ? ["h2", "http/1.1"] : ["h2"],
            ...(speaksHttp1(options) ? { allowHTTP1: true } : {}),
          });
    const sessions = new Set<ServerHttp2Session>();

    server.on("session", (session: ServerHttp2Session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
      session.on("error", (error: Error) => options.onError?.(error));
    });
    if (options.tls !== undefined) {
      // A handshake that fails never becomes a session, and node reports it
      // here rather than as an `error`. Unlistened it is dropped silently,
      // which is the wrong thing for exactly the failure this endpoint is
      // most likely to have: a client whose host has not been told to trust
      // this Team server sees a connection error, and the server would say nothing.
      server.on("tlsClientError", (error: Error) => {
        options.onError?.(
          new Error(
            `a client could not complete a TLS handshake: ${error.message}. ` +
              "If it says the certificate is unknown, that machine has not run nlteam trust.",
          ),
        );
      });
    }
    server.on("stream", (stream, headers) => {
      handleStream(stream, headers, options);
    });

    // Guarded on the version rather than trusted to fire only for HTTP/1.1: the compat
    // layer emits `request` for an h2 stream as well, and that stream has already been
    // answered by the handler above.
    const http1 = options.http1;
    if (http1 !== undefined) {
      server.on("request", (request, response) => {
        if (request.httpVersionMajor === 1) {
          http1(request as unknown as IncomingMessage, response as unknown as ServerResponse);
        }
      });
    }

    // An upgrade is not a request and never reaches the handler above: node
    // emits it on the server itself, and a listener that is not there means the
    // socket is dropped without an answer.
    const upgrade = options.upgrade;
    if (upgrade !== undefined) {
      server.on("upgrade", (request, socket, head) => {
        upgrade(request as IncomingMessage, socket as Duplex, head as Buffer);
      });
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(
        new GrpcListenError(
          `${options.anyInterface === true ? "every interface" : host}:${options.port}`,
          error,
          options.portOption,
        ),
      );
      };
      server.once("error", onError);
      const listening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      if (options.anyInterface === true) {
        server.listen(options.port, listening);
      } else {
        server.listen(options.port, host, listening);
      }
    });

    // Port 0 means "any free port", and which one it landed on is only knowable
    // afterwards, which is how a test gets an address that cannot collide.
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return new GrpcServer(
      server,
      sessions,
      host,
      port,
      options.tls === undefined ? "http" : "https",
    );
  }

  /** The port it is listening on. */
  get port(): number {
    return this.#port;
  }

  /** Where it is listening, as a caller writes it. */
  get url(): string {
    return `${this.#scheme}://${this.#host}:${this.#port}`;
  }

  /**
   * Stop listening and return once nothing is left open.
   *
   * gRPC clients hold their connection open between calls, so the sessions are
   * destroyed rather than waited for; one idle client would otherwise keep the
   * process alive after the operator has asked it to stop.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      for (const session of this.#sessions) {
        session.destroy();
      }
      this.#sessions.clear();
    });
  }
}
