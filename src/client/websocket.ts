/**
 * A WebSocket client, in the amount of it this protocol uses.
 *
 * Written here for the same reason the server half next door is written there:
 * this package has no runtime dependencies beyond the two it cannot avoid, and
 * the framing is a few hundred lines whose specification has not moved since
 * 2011. What is implemented is the opening handshake, text messages fragmented
 * or not, ping, pong and close, and a bound on how much one message may be.
 *
 * The reason it cannot be the global `WebSocket` node already has is one line
 * long: **there is nowhere to put a certificate authority**. A Team server's
 * certificate chains to an authority it generated for itself, so every
 * connection this program makes has to be given that authority as `ca:` with
 * `rejectUnauthorized: true`, and the WHATWG constructor takes a URL and a
 * subprotocol list. So the upgrade is made over a `https.request` that is
 * configured, and the socket it hands back is framed here.
 *
 * The one asymmetry with src/team/websocket.ts is masking, and it runs both
 * ways: a client masks every frame it sends, and a server masks none. Each side
 * refuses the other's mistake rather than tolerating it — tolerating an unmasked
 * client frame is what lets a proxy be poisoned, which is why the specification
 * is more explicit about that one than about anything else here.
 */
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import { acceptKey, CLOSE } from "../team/websocket.js";
import { hostAndPortOf } from "./config.js";

/** Opcodes, as the specification numbers them. */
const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** The most a control frame may carry, fixed by the specification. */
const CONTROL_PAYLOAD_LIMIT = 125;

/** How long the handshake has before the server is called unanswering. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface ClientSocketOptions {
  /** The address whose authority was pinned, and the one dialled. */
  readonly address: string;
  /** That authority, as PEM. */
  readonly ca: string;
  readonly path: string;
  /** The bearer the session is opened as. */
  readonly token: string;
  /** The most one message may total, fragments included. */
  readonly maximumMessageBytes: number;
  readonly onMessage: (text: string) => void;
  /** Called exactly once, whatever ended it. */
  readonly onClose: (reason: string) => void;
}

/**
 * Raised when the upgrade was answered with a status rather than a 101.
 *
 * The server's own sentence, because a refusal at this door is an HTTP status
 * and a line of text on purpose — see src/team/endpoint.ts. A 101 followed by a
 * close frame would be a connection that opened and then did not, which is the
 * hardest kind of failure to report, and this server deliberately does not do
 * that.
 */
export class UpgradeRefusedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "UpgradeRefusedError";
  }
}

/** One connection, after the handshake has been answered. */
export class ClientWebSocket {
  private readonly socket: Duplex;
  private readonly options: ClientSocketOptions;

  /** What has arrived and not yet been read as whole frames. */
  private pending: Buffer = Buffer.alloc(0);

  /** The fragments of a message that is not finished, and how much they total. */
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmented = false;

  private ended = false;

  constructor(socket: Duplex, head: Buffer, options: ClientSocketOptions) {
    this.socket = socket;
    this.options = options;

    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.drain();
    });
    socket.on("error", () => {
      this.finish("the connection failed");
    });
    socket.on("close", () => {
      this.finish("the connection closed");
    });

    if (head.length > 0) {
      this.pending = Buffer.concat([this.pending, head]);
      this.drain();
    }
  }

  /** Whether anything more can be sent on this. */
  get closed(): boolean {
    return this.ended;
  }

  /** Send one text message. Silently does nothing once the connection has ended. */
  send(text: string): void {
    if (this.ended) {
      return;
    }
    this.write(OPCODE.text, Buffer.from(text, "utf-8"));
  }

  /**
   * Close, saying why.
   *
   * The reason is truncated rather than refused, for the reason the server half
   * truncates it: a close frame is limited to a hundred and twenty-five bytes,
   * and a sentence one byte too long must not turn a tidy close into a dropped
   * socket.
   */
  close(code: number = CLOSE.normal, reason = ""): void {
    if (this.ended) {
      return;
    }
    const words = Buffer.from(reason, "utf-8").subarray(0, CONTROL_PAYLOAD_LIMIT - 2);
    const payload = Buffer.alloc(2 + words.length);
    payload.writeUInt16BE(code, 0);
    words.copy(payload, 2);
    this.write(OPCODE.close, payload);
    this.finish(reason === "" ? `closed with ${code}` : reason);
    this.socket.end();
  }

  /** Read whole frames out of what has arrived, and stop where one is incomplete. */
  private drain(): void {
    while (!this.ended) {
      const frame = this.readFrame();
      if (frame === undefined) {
        return;
      }
      this.handle(frame);
    }
  }

  /** One frame, or undefined because not all of it is here yet. */
  private readFrame(): { opcode: number; payload: Buffer; final: boolean } | undefined {
    const buffer = this.pending;
    if (buffer.length < 2) {
      return undefined;
    }

    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const final = (first & 0b1000_0000) !== 0;
    const reserved = first & 0b0111_0000;
    const opcode = first & 0b0000_1111;
    const masked = (second & 0b1000_0000) !== 0;
    let length = second & 0b0111_1111;
    let offset = 2;

    if (reserved !== 0) {
      this.close(CLOSE.protocolError, "a reserved bit was set and no extension was agreed");
      return undefined;
    }
    // The mirror of the server's rule. A masked frame from a server is a peer
    // that has the roles the wrong way round, and reading it anyway would be
    // agreeing with it.
    if (masked) {
      this.close(CLOSE.protocolError, "a frame from a server must not be masked");
      return undefined;
    }

    if (length === 126) {
      if (buffer.length < offset + 2) {
        return undefined;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) {
        return undefined;
      }
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(this.options.maximumMessageBytes)) {
        this.close(CLOSE.tooLarge, "that message is larger than this client accepts");
        return undefined;
      }
      length = Number(big);
      offset += 8;
    }

    if (opcode >= 0x8) {
      if (!final || length > CONTROL_PAYLOAD_LIMIT) {
        this.close(CLOSE.protocolError, "a control frame must be short and unfragmented");
        return undefined;
      }
    } else if (length > this.options.maximumMessageBytes) {
      this.close(CLOSE.tooLarge, "that message is larger than this client accepts");
      return undefined;
    }

    if (buffer.length < offset + length) {
      return undefined;
    }
    const payload = buffer.subarray(offset, offset + length);
    this.pending = buffer.subarray(offset + length);
    return { opcode, payload, final };
  }

  private handle(frame: { opcode: number; payload: Buffer; final: boolean }): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        // The server pings on its heartbeat and closes a peer it has not heard
        // from for two of them, so answering is what keeps a session that is
        // waiting for a slow call from being dropped underneath it.
        this.write(OPCODE.pong, frame.payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close:
        this.finish("the server closed the session");
        this.socket.end();
        return;
      case OPCODE.binary:
        this.close(CLOSE.unsupportedData, "this protocol is text");
        return;
      case OPCODE.text:
      case OPCODE.continuation:
        this.collect(frame);
        return;
      default:
        this.close(CLOSE.protocolError, `opcode ${frame.opcode} is not one this client speaks`);
    }
  }

  /** Gather a message that may have arrived in pieces, then hand it over whole. */
  private collect(frame: { opcode: number; payload: Buffer; final: boolean }): void {
    if (frame.opcode === OPCODE.text) {
      if (this.fragmented) {
        this.close(CLOSE.protocolError, "a message began before the last one finished");
        return;
      }
      this.fragmented = true;
    } else if (!this.fragmented) {
      this.close(CLOSE.protocolError, "a continuation arrived with nothing to continue");
      return;
    }

    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > this.options.maximumMessageBytes) {
      this.close(CLOSE.tooLarge, "that message is larger than this client accepts");
      return;
    }
    this.fragments.push(Buffer.from(frame.payload));

    if (!frame.final) {
      return;
    }
    const text = Buffer.concat(this.fragments).toString("utf-8");
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmented = false;
    this.options.onMessage(text);
  }

  /**
   * Write one frame, masked.
   *
   * Always masked: masking is what a client does, and a server is required to
   * drop the connection of one that does not.
   */
  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || this.socket.writableEnded) {
      return;
    }
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0b1000_0000 | opcode, 0b1000_0000 | payload.length]);
    } else if (payload.length < 0x1_0000) {
      header = Buffer.alloc(4);
      header[0] = 0b1000_0000 | opcode;
      header[1] = 0b1000_0000 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0b1000_0000 | opcode;
      header[1] = 0b1000_0000 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** Say it is over, once, whatever route got here. */
  private finish(reason: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.options.onClose(reason);
  }
}

/**
 * Ask for the upgrade, check the answer, and hand back a framed connection.
 *
 * The accept value is verified rather than assumed. It proves the answer came
 * from something that read the key rather than from a cache or a proxy that
 * replayed a 101 at whoever asked, which is the whole of what that header is
 * for.
 */
export function openWebSocket(options: ClientSocketOptions): Promise<ClientWebSocket> {
  const { host, port } = hostAndPortOf(options.address);
  const key = randomBytes(16).toString("base64");

  return new Promise((settle, fail) => {
    const call = httpsRequest({
      host,
      port,
      path: options.path,
      method: "GET",
      // The same two lines every connection this program makes is configured
      // with: this authority, and no exceptions.
      ca: options.ca,
      rejectUnauthorized: true,
      // A connection that is about to stop being HTTP has no business in a pool
      // that would try to reuse it afterwards.
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        // Where the session's identity comes from. The server decides who is
        // calling here, before it writes the 101.
        authorization: `Bearer ${options.token}`,
      },
    });

    call.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      call.destroy(
        new Error(`no answer within ${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)} seconds`),
      );
    });

    call.on("error", (error: Error) => {
      fail(new Error(`${options.address} could not be reached: ${error.message}`));
    });

    // Anything other than a 101. The server refuses at this door with a status
    // and a sentence rather than a close code, so there is something to print.
    call.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const said = Buffer.concat(chunks).toString("utf8").trim();
        fail(
          new UpgradeRefusedError(
            response.statusCode ?? 0,
            said === "" ? `${options.address} refused the session (${response.statusCode})` : said,
          ),
        );
      });
    });

    call.on("upgrade", (response, socket: Duplex, head: Buffer) => {
      const accepted = response.headers["sec-websocket-accept"];
      if (accepted !== acceptKey(key)) {
        socket.destroy();
        fail(
          new Error(
            `${options.address} answered the handshake with a key that does not match the ` +
              "one asked with, so whatever answered is not the server that was asked",
          ),
        );
        return;
      }
      // Frames here are small and latency is the whole point of having a socket,
      // so Nagle's algorithm — which would hold one back waiting for a second to
      // pack with it — is switched off where the underlying socket has the switch.
      (socket as Duplex & { setNoDelay?: (on?: boolean) => void }).setNoDelay?.(true);
      settle(new ClientWebSocket(socket, head, options));
    });

    call.end();
  });
}
