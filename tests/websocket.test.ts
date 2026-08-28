/**
 * The framing, on its own.
 *
 * A session test drives this through a real socket and a real client, which is
 * the right way to know the protocol works. It is the wrong way to know what
 * happens to a frame with a reserved bit set, a message that arrives in three
 * pieces, or a client that forgot to mask - because a well-behaved client never
 * sends any of those, and this is where a peer that is wrong or hostile is
 * dealt with.
 *
 * So this drives the connection directly, with bytes.
 */
import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { acceptKey, CLOSE, WebSocketConnection } from "../src/team/websocket.js";

/** A socket whose two directions a test drives by hand. */
class FakeSocket extends Duplex {
  readonly written: Buffer[] = [];

  /** Writes that have been handed over and not completed, as a stalled peer leaves them. */
  private readonly held: (() => void)[] = [];
  private holding = false;

  override _read(): void {
    // Nothing is ever read out of this: the connection listens for `data`,
    // which the test emits.
  }

  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.written.push(Buffer.from(chunk));
    if (this.holding) {
      // Left uncompleted, which is what a peer that has stopped reading does to
      // a real socket: the bytes stay counted against `writableLength`.
      this.held.push(done);
      return;
    }
    done();
  }

  /** Stop completing writes, so that whatever is written to this piles up. */
  hold(): void {
    this.holding = true;
  }

  /**
   * Start reading again, and let everything that piled up through.
   *
   * A stalled peer holds the frames written to it in the stream's own queue,
   * where `written` never sees them. This is how a test that stalled one reads
   * what it was sent - the close frame included.
   */
  release(): void {
    this.holding = false;
    while (this.held.length > 0) {
      this.held.shift()?.();
    }
  }

  /** Pretend these bytes arrived from the peer. */
  feed(...bytes: Buffer[]): void {
    for (const chunk of bytes) {
      this.emit("data", chunk);
    }
  }

  /** Everything the connection has written, as one buffer. */
  get output(): Buffer {
    return Buffer.concat(this.written);
  }
}

/** One client frame, masked as the specification requires of a client. */
function clientFrame(opcode: number, payload: Buffer, final = true): Buffer {
  const mask = Buffer.from([0x0a, 0x1b, 0x2c, 0x3d]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(final ? 0x80 : 0x00) | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (final ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function text(value: string, final = true, opcode = 0x1): Buffer {
  return clientFrame(opcode, Buffer.from(value, "utf-8"), final);
}

interface Driven {
  readonly socket: FakeSocket;
  readonly messages: string[];
  readonly closes: string[];
  readonly connection: WebSocketConnection;
}

function drive(maximumMessageBytes = 1024, maximumBufferedBytes = 64 * 1024): Driven {
  const socket = new FakeSocket();
  const messages: string[] = [];
  const closes: string[] = [];
  const connection = new WebSocketConnection(socket, Buffer.alloc(0), {
    maximumMessageBytes,
    maximumBufferedBytes,
    // Long enough that no test in here ever reaches it.
    heartbeatMs: 60_000,
    onMessage: (value) => messages.push(value),
    onClose: (reason) => closes.push(reason),
  });
  return { socket, messages, closes, connection };
}

/** The close code out of a close frame the server wrote, or undefined. */
function closeCode(output: Buffer): number | undefined {
  for (let index = 0; index + 4 <= output.length; index += 1) {
    if (output[index] === 0x88) {
      return output.readUInt16BE(index + 2);
    }
  }
  return undefined;
}

describe("the handshake", () => {
  it("answers the key with what the specification says", () => {
    // The example from RFC 6455 §1.3, which is the one value everybody's
    // implementation has been checked against since 2011.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("reading frames", () => {
  it("hands over a whole message", () => {
    const driven = drive();
    driven.socket.feed(text('{"t":"call"}'));
    expect(driven.messages).toEqual(['{"t":"call"}']);
  });

  it("waits for the rest of a frame that arrived in pieces", () => {
    const driven = drive();
    const frame = text("hello");
    driven.socket.feed(frame.subarray(0, 3));
    expect(driven.messages).toEqual([]);
    driven.socket.feed(frame.subarray(3));
    expect(driven.messages).toEqual(["hello"]);
  });

  it("joins a message that was sent as fragments", () => {
    const driven = drive();
    driven.socket.feed(text("one ", false), text("two ", false, 0x0), text("three", true, 0x0));
    expect(driven.messages).toEqual(["one two three"]);
  });

  it("refuses a frame a client did not mask", () => {
    const driven = drive();
    // Unmasked is what a server sends. A client that does it is either broken
    // or is trying to get a proxy to cache something.
    driven.socket.feed(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("hi")]));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.protocolError);
  });

  it("refuses a reserved bit, because no extension was agreed", () => {
    const driven = drive();
    const frame = text("hi");
    frame[0] = (frame[0] as number) | 0x40;
    driven.socket.feed(frame);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.protocolError);
  });

  it("refuses a message larger than it will hold", () => {
    const driven = drive(16);
    driven.socket.feed(text("a".repeat(64)));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("refuses a frame by what it says it carries, before any of it arrives", () => {
    const driven = drive(16);
    // A header announcing sixty-four bytes, and not one of them sent. Waiting
    // for them is exactly what a peer that dribbles a large frame is asking
    // this server to do with its memory.
    driven.socket.feed(Buffer.from([0x81, 0x80 | 64, 0x0a, 0x1b, 0x2c, 0x3d]));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("counts the fragments it already holds against what the next header announces", () => {
    const driven = drive(120);
    driven.socket.feed(text("a".repeat(100), false));
    // Fifty more would be a hundred and fifty, so the frame is refused on its
    // header and the fifty never have to arrive. A frame judged on its own
    // would have been let through and the message caught only once it was
    // whole, which is a hundred and fifty bytes held to learn nothing new.
    driven.socket.feed(Buffer.from([0x80, 0x80 | 50, 0x0a, 0x1b, 0x2c, 0x3d]));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("keeps nothing a peer sends after it has been closed", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x2, Buffer.from([1, 2, 3])));
    expect(closeCode(driven.socket.output)).toBe(CLOSE.unsupportedData);
    const afterClose = driven.socket.written.length;

    // Ending this server's half leaves the peer's open, and a peer that has
    // been refused is exactly the one that may go on talking.
    driven.socket.feed(text("still here"), text("and here"));

    expect(driven.messages).toEqual([]);
    expect(driven.socket.written.length).toBe(afterClose);
    // Dropped as they arrive rather than read into a buffer nothing is going to
    // parse. A connection that kept them would grow for as long as the peer
    // stayed connected, which is the one thing the ceiling on a frame does not
    // bound.
    expect(driven.connection.bufferedInput).toBe(0);
  });

  it("refuses fragments that add up to more than it will hold", () => {
    // The point of counting fragments rather than frames: eight frames of
    // fifty bytes are not eight small messages.
    const driven = drive(120);
    driven.socket.feed(text("a".repeat(50), false));
    driven.socket.feed(text("b".repeat(50), false, 0x0));
    driven.socket.feed(text("c".repeat(50), true, 0x0));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("refuses a binary frame, because this protocol is text", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x2, Buffer.from([1, 2, 3])));
    expect(closeCode(driven.socket.output)).toBe(CLOSE.unsupportedData);
  });

  it("answers a ping with the same bytes", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x9, Buffer.from("beat")));
    const output = driven.socket.output;
    expect(output[0]).toBe(0x8a);
    expect(output.subarray(2).toString("utf-8")).toBe("beat");
  });

  it("says a client that closed is closed, once", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x8, Buffer.alloc(0)));
    driven.socket.emit("close");
    expect(driven.closes).toHaveLength(1);
  });
});

describe("writing frames", () => {
  it("does not mask, because a server that masks is one nobody reads", () => {
    const driven = drive();
    driven.connection.send("hi");
    const output = driven.socket.output;
    expect(output[0]).toBe(0x81);
    // The length byte carries no mask bit, and the payload follows immediately.
    expect(output[1]).toBe(2);
    expect(output.subarray(2).toString("utf-8")).toBe("hi");
  });

  it("uses the longer length field for a message that needs it", () => {
    const driven = drive(1024 * 1024);
    driven.connection.send("x".repeat(200));
    const output = driven.socket.output;
    expect(output[1]).toBe(126);
    expect(output.readUInt16BE(2)).toBe(200);
  });

  it("writes nothing once it has closed", () => {
    const driven = drive();
    driven.connection.close(CLOSE.normal, "done");
    const afterClose = driven.socket.written.length;
    driven.connection.send("anything");
    expect(driven.socket.written.length).toBe(afterClose);
  });

  it("closes a peer that has stopped reading rather than queueing more for it", () => {
    const driven = drive(1024, 256);
    // From here nothing the connection writes leaves this socket, which is what
    // a client that subscribed to a busy topic and stopped reading looks like.
    driven.socket.hold();

    // No one of these is anywhere near the ceiling. What passes it is the pile.
    driven.connection.send("x".repeat(200));
    driven.connection.send("x".repeat(200));
    driven.connection.send("x".repeat(200));

    expect(driven.closes).toEqual(["more is queued for this connection than it is reading"]);
    // The peer is told why in a close frame rather than by the socket simply
    // going away, so it reads the same thing as a client that broke any other
    // rule. It is behind everything that piled up, which is where a close
    // frame belongs.
    driven.socket.release();
    expect(closeCode(driven.socket.output)).toBe(CLOSE.policy);
  });

  it("writes a large answer rather than closing over it", () => {
    const driven = drive(1024, 256);
    driven.socket.hold();

    // One frame bigger than the whole ceiling, written to a socket holding
    // nothing. A client on a slow link asking for a big page is not a client
    // that has stopped reading, and the two must not have the same answer.
    driven.connection.send("x".repeat(1000));

    expect(closeCode(driven.socket.output)).toBeUndefined();
    expect(driven.closes).toEqual([]);
  });

  it("cuts a close reason down rather than writing an illegal control frame", () => {
    const driven = drive();
    driven.connection.close(CLOSE.policy, "why ".repeat(80));
    const output = driven.socket.output;
    // Two bytes of header, then the code and the words: a control frame's
    // payload may not exceed 125.
    expect(output[1]).toBeLessThanOrEqual(125);
  });
});
