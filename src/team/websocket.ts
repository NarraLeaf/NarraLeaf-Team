/**
 * A WebSocket server, in the amount of it this protocol uses.
 *
 * Written here rather than taken from a package for the reason every other wire
 * format in this repository is written here: Team has no runtime dependencies
 * beyond the two it cannot avoid, and this is a framing layer of a few hundred
 * lines whose specification has not moved since 2011. The gRPC framing next door
 * and the X.509 encoder under src/tls are the same decision.
 *
 * What is implemented is what a session needs and nothing else:
 *
 *   - the opening handshake, as a reply to an `upgrade` event;
 *   - text messages, fragmented or not;
 *   - ping, pong and close, as control frames;
 *   - a bound on how much one message may be, so that a peer cannot ask this
 *     process to hold an arbitrary amount of memory by never finishing a frame;
 *   - a bound on how much may be queued for a peer that has stopped reading,
 *     because the bound on one message says nothing about how many of them.
 *
 * **Both directions are bounded, and neither bound is the other one.** What
 * arrives is held only while it is on its way to being a frame: a frame that
 * announces more than a message may be is refused when its header is read
 * rather than when its last byte lands, and what reaches a connection that has
 * already ended is dropped as it arrives rather than read into a buffer nothing
 * will ever parse. What is sent is refused once more is queued for the peer than
 * it is worth holding: delivery on this protocol is deliberately weak, so a
 * subscriber too slow to keep up is dropped rather than grown for.
 *
 * What is deliberately not implemented: extensions of any kind, and therefore
 * `permessage-deflate`. The reserved bits are refused rather than ignored, which
 * is what the specification asks of an endpoint that negotiated no extension,
 * and is also the honest thing for a peer to be told.
 *
 * **Binary frames are refused.** Everything on this protocol is JSON, and a
 * binary frame is either a client that has misunderstood or one that has been
 * told to send something this cannot read. Either way the answer is the same
 * sentence rather than a silent discard.
 *
 * ⚠ This attaches to the `upgrade` event of the HTTP/2 secure listener that
 * `allowHTTP1` puts in front of the same port everything else answers on.
 * Measured rather than assumed: a connection whose ALPN settles on `http/1.1`
 * reaches that event, so the socket, the certificate and the trust decision are
 * the ones the discovery document already arrives over.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

/** The constant every WebSocket handshake is hashed with. Fixed by the specification. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The only version of the protocol there is. */
const SUPPORTED_VERSION = "13";

/** Opcodes, as the specification numbers them. */
const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/**
 * The close codes this uses.
 *
 * A subset, because a code a peer cannot act on is a number in a log. `normal`
 * ends a session that is finished, `policy` ends one that broke the rules, and
 * the rest name the specific rule so that a client author has something to fix.
 */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  policy: 1008,
  tooLarge: 1009,
  internal: 1011,
} as const;

/** The most a control frame may carry, fixed by the specification. */
const CONTROL_PAYLOAD_LIMIT = 125;

export interface WebSocketOptions {
  /** The most one message may total, fragments included. */
  readonly maximumMessageBytes: number;
  /**
   * The most that may be waiting to go out to this peer before it is closed.
   *
   * A peer that asked for a busy topic and then stopped reading is the case
   * this exists for: every frame handed to the socket that the socket cannot
   * write stays in this process's memory, and nothing about a message's own
   * ceiling limits how many of them pile up. Past this the connection is closed
   * with `policy` rather than grown, which is the answer the protocol already
   * gives for a subscriber that cannot keep up - it reconnects and re-reads.
   */
  readonly maximumBufferedBytes: number;
  /**
   * How long between pings, and therefore how long a silent peer has.
   *
   * A connection that has not been heard from for two of these is closed. Two
   * rather than one because the first is when a ping is sent and the second is
   * how long the answer has: a peer on a slow link is quiet, not gone.
   */
  readonly heartbeatMs: number;
  readonly onMessage: (text: string) => void;
  /** Called exactly once, whatever ended it. */
  readonly onClose: (reason: string) => void;
}

/**
 * Whether a request is asking to become a WebSocket, and is allowed to.
 *
 * Every check the specification requires of a server, and one that it does not:
 * a request carrying `sec-websocket-extensions` is answered without them rather
 * than refused, because a client offering an extension has to cope with a server
 * that declines it, and refusing the connection over an offer would be refusing
 * every browser that has ever offered deflate.
 */
export function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const upgrade = request.headers.upgrade?.toLowerCase();
  const connection = request.headers.connection?.toLowerCase() ?? "";
  return (
    request.method === "GET" &&
    upgrade === "websocket" &&
    connection.split(",").some((token) => token.trim() === "upgrade") &&
    request.headers["sec-websocket-version"] === SUPPORTED_VERSION &&
    typeof request.headers["sec-websocket-key"] === "string"
  );
}

/** The value of `sec-websocket-accept` for one key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + HANDSHAKE_GUID).digest("base64");
}

/**
 * Refuse an upgrade before it becomes one, in HTTP.
 *
 * The socket is still speaking HTTP/1.1 at this point, so a refusal is a status
 * line and a sentence. After the handshake it would have to be a close frame,
 * and a client that has not yet seen 101 has no framing to read one with.
 */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      "content-type: text/plain; charset=utf-8\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 404:
      return "Not Found";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

/**
 * One WebSocket connection, after the handshake has been written.
 *
 * Constructed rather than returned from a function so that the caller decides
 * when the handshake happens: the session has to identify the caller before it
 * writes 101, since a refusal is worth far more to whoever is holding it as an
 * HTTP status than as a close code nobody sees.
 */
export class WebSocketConnection {
  /** For a log line that has to match one connection to one session. */
  readonly id = randomUUID();

  private readonly socket: Duplex;
  private readonly options: WebSocketOptions;

  /** What has arrived and not yet been read as whole frames. */
  private pending: Buffer = Buffer.alloc(0);

  /** The fragments of a message that is not finished, and how much they total. */
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentedOpcode: number | undefined;

  private heartbeat: NodeJS.Timeout | undefined;
  private lastHeard = Date.now();

  private ended = false;

  /** True from the moment a close frame is being written, so writing one cannot close again. */
  private closing = false;

  constructor(socket: Duplex, head: Buffer, options: WebSocketOptions) {
    this.socket = socket;
    this.options = options;

    socket.on("data", (chunk: Buffer) => {
      // Nothing that arrives after this connection ended will ever be parsed,
      // so nothing that arrives after it is kept. Ending the write side does
      // not stop a peer sending, and a peer that goes on sending into a
      // connection this server has already refused would otherwise grow this
      // buffer for as long as it stayed connected - which is the one way the
      // frame ceiling below does not bound what is held.
      if (this.ended) {
        return;
      }
      this.lastHeard = Date.now();
      this.pending = Buffer.concat([this.pending, chunk]);
      this.drain();
    });
    socket.on("error", () => {
      this.finish("the connection failed");
    });
    socket.on("close", () => {
      this.finish("the connection closed");
    });

    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastHeard > options.heartbeatMs * 2) {
        this.close(CLOSE.goingAway, "no answer");
        return;
      }
      this.write(OPCODE.ping, Buffer.alloc(0));
    }, options.heartbeatMs);
    // A heartbeat is not a reason to keep this process alive: `up` exits when
    // its listeners are closed, and a timer that held the loop open would make
    // one idle session enough to stop that happening.
    this.heartbeat.unref?.();

    if (head.length > 0) {
      this.pending = Buffer.concat([this.pending, head]);
      this.drain();
    }
  }

  /** Whether anything more can be sent on this. */
  get closed(): boolean {
    return this.ended;
  }

  /**
   * How much has arrived and is not yet a whole frame.
   *
   * Never more than one frame's worth for a connection that is open, because a
   * frame announcing more than a message may be is refused on its header; and
   * nought for one that has ended, because what arrives after that is dropped
   * as it arrives. Both are properties this file is built to keep rather than
   * things it happens to do, so both are readable rather than only argued for.
   */
  get bufferedInput(): number {
    return this.pending.length;
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
   * The reason is truncated rather than refused: a close frame is limited to a
   * hundred and twenty-five bytes, and a sentence that is one byte too long must
   * not turn a tidy close into a dropped socket.
   */
  close(code: number, reason: string): void {
    if (this.ended) {
      return;
    }
    // Set before the close frame is written, because writing is what notices a
    // backlog and closing is what it does about it: without this, closing a
    // peer that is not reading would be the thing that tried to close it again.
    this.closing = true;
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

  /**
   * One frame, or undefined because not all of it is here yet.
   *
   * Everything a peer may get wrong is refused with a close rather than
   * tolerated: a reserved bit set means an extension nobody negotiated, and an
   * unmasked frame from a client is the one the specification is most explicit
   * about, because tolerating it is what lets a proxy be poisoned.
   */
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
    if (!masked) {
      this.close(CLOSE.protocolError, "a frame from a client must be masked");
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
        this.close(CLOSE.tooLarge, "that message is larger than this server accepts");
        return undefined;
      }
      length = Number(big);
      offset += 8;
    }

    // A data frame is judged on what its header says it carries, before any of
    // the body is waited for, and the fragments already held count towards it
    // because they are the same message. That is the whole reason nothing here
    // ever holds more than one frame's worth: a peer that announced a large
    // frame and then dribbled it would otherwise be keeping every byte of it
    // until the last one arrived.
    if (opcode >= 0x8) {
      if (!final || length > CONTROL_PAYLOAD_LIMIT) {
        this.close(CLOSE.protocolError, "a control frame must be short and unfragmented");
        return undefined;
      }
    } else if (this.fragmentBytes + length > this.options.maximumMessageBytes) {
      this.close(CLOSE.tooLarge, "that message is larger than this server accepts");
      return undefined;
    }

    if (buffer.length < offset + 4 + length) {
      return undefined;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      // The mask is four bytes, applied in turn. Written out rather than reached
      // for through a helper because this runs once per byte of every message.
      payload[index] = (buffer[offset + index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.pending = buffer.subarray(offset + length);
    return { opcode, payload, final };
  }

  private handle(frame: { opcode: number; payload: Buffer; final: boolean }): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        this.write(OPCODE.pong, frame.payload);
        return;
      case OPCODE.pong:
        // The heartbeat only needs to know that something arrived, which the
        // data handler already recorded.
        return;
      case OPCODE.close:
        this.finish("the client closed the session");
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
        this.close(CLOSE.protocolError, `opcode ${frame.opcode} is not one this server speaks`);
    }
  }

  /** Gather a message that may have arrived in pieces, then hand it over whole. */
  private collect(frame: { opcode: number; payload: Buffer; final: boolean }): void {
    if (frame.opcode === OPCODE.text) {
      if (this.fragmentedOpcode !== undefined) {
        this.close(CLOSE.protocolError, "a message began before the last one finished");
        return;
      }
      this.fragmentedOpcode = OPCODE.text;
    } else if (this.fragmentedOpcode === undefined) {
      this.close(CLOSE.protocolError, "a continuation arrived with nothing to continue");
      return;
    }

    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > this.options.maximumMessageBytes) {
      this.close(CLOSE.tooLarge, "that message is larger than this server accepts");
      return;
    }
    this.fragments.push(frame.payload);

    if (!frame.final) {
      return;
    }
    const text = Buffer.concat(this.fragments).toString("utf-8");
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentedOpcode = undefined;
    this.options.onMessage(text);
  }

  /**
   * Write one frame.
   *
   * Never masked: masking is what a client does, and a server that masks is a
   * server no client will read.
   */
  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || this.socket.writableEnded) {
      return;
    }
    // What the socket has taken and not yet got out. Checked before this frame
    // is added to it rather than after, so that one large answer to a client on
    // a slow link is written rather than being the thing that closes it: what
    // is refused is piling a further frame on a backlog that is already past
    // what this server will hold. The heartbeat is a write too, so a peer that
    // has gone quiet under a backlog is closed within one of those rather than
    // whenever it next asks for something.
    if (!this.closing && this.socket.writableLength > this.options.maximumBufferedBytes) {
      this.close(CLOSE.policy, "more is queued for this connection than it is reading");
      return;
    }
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0b1000_0000 | opcode, payload.length]);
    } else if (payload.length < 0x1_0000) {
      header = Buffer.alloc(4);
      header[0] = 0b1000_0000 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0b1000_0000 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Say it is over, once, whatever route got here. */
  private finish(reason: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.closing = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    // Nothing more will be read out of these, so nothing more is kept in them.
    // The socket is left reading rather than paused: what still arrives is
    // dropped as it arrives, which costs nothing, where a paused socket would
    // never see the peer's own end of the connection and would sit half open
    // until something else closed it.
    this.pending = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.options.onClose(reason);
  }
}

/**
 * Complete the handshake and hand back a connection.
 *
 * Called after the caller has decided the request may become a session. The 101
 * is written here so that the accept value is worked out in one place.
 */
export function completeUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WebSocketOptions,
): WebSocketConnection {
  const key = request.headers["sec-websocket-key"] as string;
  // A `Duplex` in the type system and a TCP socket in practice. Frames here are
  // small and latency is the whole point of having a socket at all, so Nagle's
  // algorithm - which would hold one back waiting for a second to pack with it -
  // is switched off where the underlying socket has the switch.
  (socket as Duplex & { setNoDelay?: (on?: boolean) => void }).setNoDelay?.(true);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "upgrade: websocket\r\n" +
      "connection: Upgrade\r\n" +
      `sec-websocket-accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, head, options);
}
