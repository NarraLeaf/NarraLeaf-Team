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
import { X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext } from "node:tls";
import {
  createSecureServer,
  createServer,
  type Http2SecureServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
  type ServerHttp2Session,
} from "node:http2";

import { encodeFrame, FrameAssembler, UNARY_CALL_MESSAGES } from "./framing.js";
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

/** The most of a plaintext request read before answering it, so a client cannot make it grow. */
const PLAINTEXT_HEAD_LIMIT = 8192;

/** How long a plaintext connection may take to send its request line and headers. */
const PLAINTEXT_HEAD_TIMEOUT_MS = 10_000;

/**
 * Send one connection to the TLS server, or answer it as the plaintext request it is.
 *
 * A browser given `192.168.1.100:54080` with no scheme asks for `http://`, and a TLS listener
 * that is sent an HTTP request line instead of a ClientHello can only drop the connection: the
 * browser shows an empty response and says nothing about why. The first byte tells the two
 * apart. A TLS record that opens a handshake starts with 0x16; every HTTP method starts with
 * an ASCII letter. Anything else still goes to TLS, which fails it and says so as it always did.
 *
 * The byte is read and put back, so the TLS socket built over this one sees the whole stream:
 * node feeds whatever the socket already buffered into the handshake before it reads on.
 */
function routeByFirstByte(socket: Socket, tlsServer: Http2SecureServer): void {
  // Until a TLS socket owns it, a reset here has no other listener, and an unlistened `error`
  // takes the process down.
  socket.on("error", () => socket.destroy());
  const onReadable = (): void => {
    const first = socket.read(1) as Buffer | null;
    if (first === null) {
      socket.once("readable", onReadable);
      return;
    }
    socket.unshift(first);
    const byte = first[0]!;
    const isLetter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    if (isLetter) {
      redirectToHttps(socket);
    } else {
      tlsServer.emit("connection", socket);
    }
  };
  socket.once("readable", onReadable);
}

/** A Host header that can go into a Location as it is: a name or address, and a port. */
const HOST_HEADER = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** A request target that can go into a Location as it is. */
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/;

/**
 * Answer a plaintext HTTP request on the TLS port with a redirect to the same address over https.
 *
 * Read by hand rather than by node's HTTP server: all it needs is the request line and the Host
 * header, it never reads a body, and it closes the connection once it has answered. The
 * redirect is temporary (307), so nothing caches a port number as meaning https for ever.
 */
function redirectToHttps(socket: Socket): void {
  let head = Buffer.alloc(0);
  socket.setTimeout(PLAINTEXT_HEAD_TIMEOUT_MS, () => socket.destroy());
  const onData = (chunk: Buffer): void => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1 && head.length < PLAINTEXT_HEAD_LIMIT) {
      return;
    }
    socket.removeListener("data", onData);
    socket.setTimeout(0);
    const lines = head
      .subarray(0, end === -1 ? head.length : end)
      .toString("latin1")
      .split("\r\n");
    const target = lines[0]?.split(" ")[1] ?? "/";
    const host = lines
      .slice(1)
      .find((line) => /^host:/i.test(line))
      ?.slice("host:".length)
      .trim();
    socket.end(plaintextAnswer(host, target));
  };
  socket.on("data", onData);
}

/** The bytes of the answer to one plaintext request. */
function plaintextAnswer(host: string | undefined, target: string): string {
  if (host === undefined || !HOST_HEADER.test(host)) {
    const body = "This port speaks HTTPS only. Open it with an https:// address.\n";
    return (
      "HTTP/1.1 400 Bad Request\r\n" +
      "content-type: text/plain; charset=utf-8\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body
    );
  }
  const location = `https://${host}${REQUEST_TARGET.test(target) ? target : "/"}`;
  const body = `This port speaks HTTPS only: ${location}\n`;
  return (
    "HTTP/1.1 307 Temporary Redirect\r\n" +
    `location: ${location}\r\n` +
    "content-type: text/plain; charset=utf-8\r\n" +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    "connection: close\r\n\r\n" +
    body
  );
}

/** Whether this listener has anything to say to a client that does not speak h2. */
function speaksHttp1(options: GrpcServerOptions): boolean {
  return options.http1 !== undefined || options.upgrade !== undefined;
}

/** The certificate and key a TLS listener presents. */
export interface GrpcTlsOptions {
  /** The endpoint's certificate, and the authority's after it. */
  readonly cert: string;
  readonly key: string;
  /**
   * A second certificate, presented to a client that asks for a name it covers.
   *
   * For an operator who already holds a certificate for the name their
   * collaborators use. Their machines trust its issuer already, so nobody
   * compares a fingerprint or installs anything — and this cannot simply
   * replace the pair above, because loreserver reaches this same listener at
   * `https://127.0.0.1` and verifies it against Team's own authority. No public
   * certificate names the loopback.
   *
   * Which one a connection gets is decided by the server name it asked for.
   * A connection to an address sends none at all, so the loopback always
   * reaches the certificate above; a name this one does not cover falls back to
   * it too, which is what makes `localhost` go on working beside a certificate
   * issued for a public name.
   */
  readonly forNames?: {
    readonly cert: string;
    readonly key: string;
  };
}

/**
 * Choose a certificate for one connection, by the name it asked for.
 *
 * Answering `undefined` leaves node with the context built from `cert` and
 * `key`, which is the point: everything that is not one of these names — the
 * loopback included, which sends no name — keeps Team's own certificate.
 */
function chooseCertificate(
  supplied: NonNullable<GrpcTlsOptions["forNames"]>,
): (servername: string, callback: (error: Error | null, context?: SecureContext) => void) => void {
  // Both built once. A secure context per connection would parse a certificate
  // on every handshake, and `checkHost` is asked of a parsed certificate.
  const context = createSecureContext({ cert: supplied.cert, key: supplied.key });
  const certificate = new X509Certificate(supplied.cert);
  return (servername, callback) => {
    callback(null, certificate.checkHost(servername) === undefined ? undefined : context);
  };
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
  constructor(address: string, cause: Error, portOption = "--auth-tls-port") {
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
  const assembler = new FrameAssembler(UNARY_CALL_MESSAGES);
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
      // At most one, because the assembler was told what a call to this service
      // carries and refuses a second where it would otherwise have decoded it.
      // So a caller that sends more is turned away by the same typed failure
      // every other framing refusal travels as, rather than by a second
      // mechanism written here.
      for (const decoded of assembler.push(chunk)) {
        message = decoded;
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

/** Whether a request is a gRPC call, which is to say its content type says so. */
function isGrpcRequest(headers: { readonly [name: string]: unknown }): boolean {
  const type = headers["content-type"];
  return typeof type === "string" && type.toLowerCase().startsWith("application/grpc");
}

/** A gRPC server, listening. */
export class GrpcServer {
  /** What listens: the HTTP/2 server itself, or, for TLS, the socket server in front of it. */
  readonly #listener: NetServer | Http2Server | Http2SecureServer;
  readonly #sessions: Set<ServerHttp2Session>;
  readonly #sockets: Set<Socket>;
  readonly #host: string;
  readonly #port: number;
  readonly #scheme: "http" | "https";

  private constructor(
    listener: NetServer | Http2Server | Http2SecureServer,
    sessions: Set<ServerHttp2Session>,
    sockets: Set<Socket>,
    host: string,
    port: number,
    scheme: "http" | "https",
  ) {
    this.#listener = listener;
    this.#sessions = sessions;
    this.#sockets = sockets;
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
            ...(options.tls.forNames === undefined
              ? {}
              : { SNICallback: chooseCertificate(options.tls.forNames) }),
            // gRPC over TLS is HTTP/2 over TLS, so `h2` comes first and is what
            // every client of the service negotiates. HTTP/1.1 is offered only
            // where there is something to answer with, and a client that
            // negotiates it reaches `http1` rather than a protocol error.
            ALPNProtocols: speaksHttp1(options) ? ["h2", "http/1.1"] : ["h2"],
            ...(speaksHttp1(options) ? { allowHTTP1: true } : {}),
          });
    const sessions = new Set<ServerHttp2Session>();
    // Every raw connection, whatever it became: an HTTP/2 session, an HTTP/1.1 keep-alive
    // connection, or a socket upgraded to the Team protocol. Node tracks none of the last two once
    // the server is closing, so without this one open console page or Studio keeps `close()`
    // waiting for ever.
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

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
    const http1 = options.http1;
    server.on("stream", (stream, headers) => {
      // A browser negotiates h2 on this port as readily as a gRPC client does,
      // because it is offered first. So on h2 it is the content type, not the
      // protocol, that says which side a request is for: gRPC always says
      // application/grpc, and a page, its sign-in and the discovery document
      // never do. Those go to the same handler HTTP/1.1 reaches, below.
      if (http1 !== undefined && !isGrpcRequest(headers)) {
        return;
      }
      handleStream(stream, headers, options);
    });

    // The compat layer emits `request` for every h2 stream as well as for every
    // HTTP/1.1 request, so an h2 stream is taken here only when the handler
    // above left it — when it is not gRPC.
    if (http1 !== undefined) {
      server.on("request", (request, response) => {
        if (request.httpVersionMajor === 1 || !isGrpcRequest(request.headers)) {
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

    // A TLS listener is fronted by a plain socket server, which looks at each connection's first
    // byte and answers a plaintext HTTP request with a redirect rather than handing it to a
    // handshake that can only drop it. routeByFirstByte says how.
    const secure = options.tls === undefined ? undefined : (server as Http2SecureServer);
    const listener: NetServer | Http2Server | Http2SecureServer =
      secure === undefined
        ? server
        : createNetServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            routeByFirstByte(socket, secure);
          });

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
      listener.once("error", onError);
      const listening = (): void => {
        listener.removeListener("error", onError);
        resolve();
      };
      if (options.anyInterface === true) {
        listener.listen(options.port, listening);
      } else {
        listener.listen(options.port, host, listening);
      }
    });

    // Port 0 means "any free port", and which one it landed on is only knowable
    // afterwards, which is how a test gets an address that cannot collide.
    const address = listener.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return new GrpcServer(
      listener,
      sessions,
      sockets,
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
      this.#listener.close(() => resolve());
      for (const session of this.#sessions) {
        session.destroy();
      }
      this.#sessions.clear();
      // What is left: HTTP/1.1 keep-alive connections and upgraded sockets, which node never
      // closes for a closing server.
      for (const socket of this.#sockets) {
        socket.destroy();
      }
      this.#sockets.clear();
    });
  }
}
