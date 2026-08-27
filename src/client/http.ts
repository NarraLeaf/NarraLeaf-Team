/**
 * The two things this program asks a server for over HTTP, both verified.
 *
 * A session is a WebSocket and everything an administrator does travels on one.
 * Before there can be a session there has to be a token, and before there can be
 * a token there has to be an address that has turned into a server — which is
 * the discovery document. So exactly two requests are made here, in that order,
 * and both of them are made **against the authority this program pinned**:
 * `ca:` with `rejectUnauthorized: true`, the way Studio does it.
 *
 * There is no third request and there must not be one. A CLI that reached for a
 * REST route the protocol does not have would be a CLI Studio's own management
 * surface could never catch up with.
 */
import { request as httpsRequest, type RequestOptions } from "node:https";

import { DISCOVERY_PATH, type DiscoveryDocument } from "../identity/discovery.js";
import { STUDIO_SIGN_IN_PATH } from "../web/studio.js";
import { hostAndPortOf } from "./config.js";

/** How long one request waits before it is called unanswered. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The most of an answer that is read before it is treated as something else. */
const MAXIMUM_BODY_BYTES = 256 * 1024;

/** Everything one verified request needs. */
export interface VerifiedRequest {
  /** The address the authority was pinned for, and the one dialled. */
  readonly address: string;
  /** That authority, as PEM. Nothing here connects without one. */
  readonly ca: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Sent as JSON, for the one route that takes a body. */
  readonly body?: unknown;
}

/**
 * Raised when a server answered and said no.
 *
 * The sentence is the server's own. It is printed as it arrived rather than
 * translated, because a refusal a client rewords is a refusal an operator cannot
 * search the server's log for.
 */
export class ServerRefusedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ServerRefusedError";
  }
}

/**
 * Raised when the connection itself failed.
 *
 * The certificate cases are named rather than passed through, because node's
 * wording for them describes a trust store this program does not use, and an
 * operator reading "unable to verify the first certificate" has no way of
 * knowing it means the authority moved.
 */
export class ConnectionError extends Error {
  constructor(address: string, error: NodeJS.ErrnoException) {
    super(`${address} could not be reached: ${describeTlsFailure(error)}`);
    this.name = "ConnectionError";
  }
}

function describeTlsFailure(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return (
        "its certificate is not made out to that address. A Team server's certificate " +
        "names the loopback and whatever hosts up was given with --hostname; reaching it " +
        "by any other name needs that name adding there"
      );
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "CERT_SIGNATURE_FAILURE":
      return (
        "its certificate no longer chains to the authority this account trusts for it. " +
        "Compare the fingerprint with nlteam trust run on the server itself"
      );
    case "CERT_HAS_EXPIRED":
      return "its certificate has expired; the server has to be restarted to issue a new one";
    default:
      return error.message;
  }
}

/**
 * Make one request and hand back what came back, parsed.
 *
 * Every failure is one of the two errors above, so a caller has a sentence to
 * print and never a stack trace.
 */
export function requestJson(options: VerifiedRequest): Promise<unknown> {
  const { host, port } = hostAndPortOf(options.address);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const requestOptions: RequestOptions = {
    host,
    port,
    method: options.method,
    path: options.path,
    // The whole of the trust decision, in two lines: this authority, and no
    // exceptions. Both are written out rather than left to a default, because
    // this is the line a reader comes here to check.
    ca: options.ca,
    rejectUnauthorized: true,
    headers: {
      accept: "application/json",
      // Named so that a server's log says which client was asking. There is no
      // behaviour anywhere that turns on it.
      "user-agent": "nlteam",
      ...(payload === undefined
        ? {}
        : {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(Buffer.byteLength(payload)),
          }),
    },
  };

  return new Promise((settle, fail) => {
    const call = httpsRequest(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAXIMUM_BODY_BYTES) {
          response.destroy();
          fail(
            new ServerRefusedError(
              response.statusCode ?? 0,
              `${options.address} answered with more than this reads from that address`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        let parsed: unknown;
        try {
          parsed = text === "" ? undefined : JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        if (status >= 200 && status < 300) {
          settle(parsed);
          return;
        }
        fail(new ServerRefusedError(status, refusalSentence(options, status, parsed)));
      });
    });

    call.setTimeout(REQUEST_TIMEOUT_MS, () => {
      call.destroy(new Error(`no answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds`));
    });
    call.on("error", (error: NodeJS.ErrnoException) => {
      fail(new ConnectionError(options.address, error));
    });
    if (payload !== undefined) {
      call.write(payload);
    }
    call.end();
  });
}

/**
 * What to print when a server said no.
 *
 * Its own sentence where it wrote one — every route in this repository answers a
 * refusal as `{"error": "…"}` — and the address and the status where it did not,
 * so that a proxy answering in HTML is still something an operator can act on.
 */
function refusalSentence(options: VerifiedRequest, status: number, parsed: unknown): string {
  if (typeof parsed === "object" && parsed !== null) {
    const message = (parsed as Record<string, unknown>)["error"];
    if (typeof message === "string" && message !== "") {
      return message;
    }
  }
  return `${options.address} answered ${status} for ${options.path}`;
}

/**
 * The document that turns an address into a server.
 *
 * Read over the pinned authority rather than over the connection the
 * fingerprint came off, so that what a client goes on to believe about a
 * deployment — where to sign in, what it serves — arrived over a connection that
 * was verified rather than merely observed.
 */
export async function readDiscoveryDocument(
  address: string,
  ca: string,
): Promise<DiscoveryDocument> {
  const answer = await requestJson({ address, ca, method: "GET", path: DISCOVERY_PATH });
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new Error(
      `${address} answered something other than a discovery document at ${DISCOVERY_PATH}. ` +
        "That address may not be a Team server.",
    );
  }
  const document = answer as Record<string, unknown>;
  if (typeof document["protocol"] !== "number") {
    throw new Error(
      `${address} answered a document with no protocol number in it, so it is not a Team ` +
        "server this understands.",
    );
  }
  return answer as unknown as DiscoveryDocument;
}

/** What a sign-in answers with. */
export interface SignedIn {
  readonly token: string;
  readonly username: string;
}

/**
 * A username and a password, for the token every session takes.
 *
 * The same route Studio posts to, answering with the same token `nlteam token
 * mint` would have printed. It is the only place a password crosses this
 * program's boundary, and it does so over the verified connection rather than
 * the one the fingerprint was read off.
 */
export async function signIn(
  address: string,
  ca: string,
  username: string,
  password: string,
): Promise<SignedIn> {
  const answer = await requestJson({
    address,
    ca,
    method: "POST",
    path: STUDIO_SIGN_IN_PATH,
    body: { username, password },
  });
  const body = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const token = body["token"];
  if (typeof token !== "string" || token === "") {
    throw new Error(`${address} accepted the sign-in and answered without a token`);
  }
  const account = body["account"];
  const named =
    typeof account === "object" && account !== null
      ? (account as Record<string, unknown>)["username"]
      : undefined;
  return { token, username: typeof named === "string" ? named : username };
}
