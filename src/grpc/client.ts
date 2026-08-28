/**
 * Making a gRPC call, on HTTP/2 without TLS.
 *
 * One call of one message in each direction is the whole of what Team asks of
 * loreserver, so a call is a function rather than a channel: connect, send,
 * read the answer, close. A long-lived connection would be worth having for a
 * program that called repeatedly, and `nlteam project create` makes one call.
 *
 * The outcome of a gRPC call is not its HTTP status. A call that failed answers
 * `:status 200` and puts the failure in a `grpc-status` trailer, or in the
 * headers when it failed before producing anything, so both are read here and
 * neither is enough on its own.
 */
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";

import { encodeFrame, FrameAssembler, UNARY_CALL_MESSAGES } from "./framing.js";
import {
  decodeStatusMessage,
  GRPC_INTERNAL,
  GRPC_OK,
  GRPC_UNAVAILABLE,
  statusName,
} from "./status.js";

/** How long a call waits before giving up, when the caller names nothing. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** What one call needs. */
export interface UnaryCallOptions {
  /** Where the service is, as `http://host:port` or `https://host:port`. */
  readonly url: string;
  /** `/package.Service/Method`. */
  readonly path: string;
  /** The request message, already encoded. */
  readonly message: Uint8Array;
  /** The `authorization` header to present, if any. */
  readonly authorization?: string | undefined;
  /**
   * The certificate authority to verify an `https` service against, as PEM.
   *
   * Given, it replaces the host's trust store for this call rather than adding
   * to it — which is what makes a call to a Team server whose authority nobody has
   * installed possible without installing it.
   */
  readonly ca?: string | undefined;
  readonly timeoutMs?: number;
}

/** Raised when a call was answered with anything but OK. */
export class GrpcCallError extends Error {
  constructor(
    readonly status: number,
    readonly statusMessage: string,
    readonly path: string,
  ) {
    super(
      `${path} answered ${statusName(status)}${
        statusMessage === "" ? "" : `: ${statusMessage}`
      }`,
    );
    this.name = "GrpcCallError";
  }
}

/** Raised when the call never reached a service at all. */
export class GrpcConnectionError extends Error {
  constructor(url: string, cause: Error) {
    super(`no gRPC service answered at ${url}: ${cause.message}`, { cause });
    this.name = "GrpcConnectionError";
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The `grpc-status` and `grpc-message` of one set of headers or trailers. */
function readStatus(headers: IncomingHttpHeaders): { status: number; message: string } | undefined {
  const status = headerValue(headers, "grpc-status");
  if (status === undefined) {
    return undefined;
  }
  return {
    status: Number(status),
    message: decodeStatusMessage(headerValue(headers, "grpc-message") ?? ""),
  };
}

/** Make one call and return the message it answered with. */
export async function unaryCall(options: UnaryCallOptions): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const session: ClientHttp2Session = connect(
    options.url,
    options.ca === undefined ? {} : { ca: options.ca },
  );

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      session.on("error", (error: Error) => {
        reject(new GrpcConnectionError(options.url, error));
      });

      const request = session.request({
        ":method": "POST",
        ":path": options.path,
        "content-type": "application/grpc",
        // Announced, not negotiated: this client neither compresses what it
        // sends nor accepts anything compressed back.
        "grpc-encoding": "identity",
        "grpc-accept-encoding": "identity",
        // The server's own deadline for the call, so that it stops working on
        // one this side has already given up on. The `m` is milliseconds.
        "grpc-timeout": `${timeoutMs}m`,
        // Required of a gRPC client: it promises the peer that trailers will be
        // read, which is where the outcome of the call arrives.
        te: "trailers",
        ...(options.authorization === undefined
          ? {}
          : { authorization: options.authorization }),
      });

      request.setTimeout(timeoutMs, () => {
        reject(
          new GrpcCallError(
            GRPC_UNAVAILABLE,
            `nothing was answered within ${timeoutMs}ms`,
            options.path,
          ),
        );
        request.close();
      });

      // A reply to a unary call is one message, and only the first is read
      // below in any case. Saying so here means a service that sent more is
      // refused rather than quietly held while this side ignores it.
      const assembler = new FrameAssembler(UNARY_CALL_MESSAGES);
      const messages: Buffer[] = [];
      let outcome: { status: number; message: string } | undefined;

      request.on("response", (headers) => {
        // `:status` is the one header node hands over as a number rather than
        // as text, so it is compared as one.
        const httpStatus = headers[":status"];
        if (httpStatus !== 200) {
          reject(
            new GrpcCallError(
              GRPC_INTERNAL,
              `the service answered HTTP ${httpStatus ?? "with no status"}`,
              options.path,
            ),
          );
          request.close();
          return;
        }
        // Present here only for a call that failed before it produced anything.
        outcome ??= readStatus(headers);
      });
      request.on("trailers", (trailers) => {
        outcome = readStatus(trailers) ?? outcome;
      });
      request.on("data", (chunk: Buffer) => {
        try {
          messages.push(...assembler.push(chunk));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          request.close();
        }
      });
      request.on("error", (error: Error) => {
        reject(new GrpcConnectionError(options.url, error));
      });
      request.on("end", () => {
        if (outcome === undefined) {
          reject(
            new GrpcCallError(GRPC_INTERNAL, "the reply carried no grpc-status", options.path),
          );
          return;
        }
        if (outcome.status !== GRPC_OK) {
          reject(new GrpcCallError(outcome.status, outcome.message, options.path));
          return;
        }
        const message = messages[0];
        if (message === undefined) {
          reject(
            new GrpcCallError(GRPC_INTERNAL, "the reply carried no message", options.path),
          );
          return;
        }
        resolve(message);
      });

      request.end(encodeFrame(options.message));
    });
  } finally {
    // Closing rather than waiting: this client makes one call per connection,
    // and an HTTP/2 session left open holds the process open with it.
    session.destroy();
  }
}
