/**
 * How a gRPC message sits inside an HTTP/2 stream.
 *
 * One message is five bytes of prefix and then its encoding: a compression
 * flag, then the length as four bytes big-endian. That is the whole framing —
 * a request or a reply of one message is one frame, and the HTTP/2 layer below
 * is free to split it across as many DATA frames as it likes, which is why
 * reassembly is a class rather than a function.
 *
 * The compression flag is written as 0 and refused when it is anything else.
 * Accepting it would mean claiming to understand a `grpc-encoding` this code
 * never negotiated, and answering with the compressed bytes read as a message
 * is worse than saying so.
 */
import {
  GRPC_INVALID_ARGUMENT,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNIMPLEMENTED,
  GrpcStatusError,
} from "./status.js";

/** The five bytes in front of every message. */
const PREFIX_BYTES = 5;

/**
 * How many messages one call carries.
 *
 * Both services Team serves are unary — one message in each direction, which is
 * the whole of what src/grpc/server.ts implements — and the calls this side
 * makes read one reply and no more. A second message on such a call is a caller
 * doing something this protocol does not describe.
 *
 * Handed to an assembler rather than assumed by it: the framing is the framing
 * whatever a service does with it, and a service that streamed would say so
 * here rather than have this file decide quietly for it. Every caller in this
 * repository hands it this one.
 */
export const UNARY_CALL_MESSAGES = 1;

/**
 * The largest message either side will read.
 *
 * Four mebibytes is gRPC's own default limit. Nothing Team exchanges comes near
 * it — the largest is a list of resource ids — and the point of the limit is
 * that a length field is a promise about memory made by whoever sent it.
 */
export const MAXIMUM_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Put one message in a frame, ready to be written to a stream. */
export function encodeFrame(message: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + message.byteLength);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.byteLength, 1);
  Buffer.from(message.buffer, message.byteOffset, message.byteLength).copy(frame, PREFIX_BYTES);
  return frame;
}

/**
 * Chunks of a stream as they arrive, turned back into whole messages.
 *
 * A caller pushes whatever the socket produced and is handed the messages that
 * are now complete, which may be none. Two things are bounded here rather than
 * by whoever reads them: how large one message may be, and how many of them one
 * call may carry. Both have to be, because this is where a message stops being
 * a length somebody promised and starts being memory this process holds.
 */
export class FrameAssembler {
  #buffered: Buffer = Buffer.alloc(0);
  #decoded = 0;
  readonly #maximumMessages: number;

  /** Read a call that carries at most this many messages. */
  constructor(maximumMessages: number) {
    this.#maximumMessages = maximumMessages;
  }

  /** Take one chunk and return every message it completed. */
  push(chunk: Uint8Array): Buffer[] {
    this.#buffered = Buffer.concat([
      this.#buffered,
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ]);

    const messages: Buffer[] = [];
    while (this.#buffered.length >= PREFIX_BYTES) {
      const compressed = this.#buffered.readUInt8(0);
      if (compressed !== 0) {
        throw new GrpcStatusError(
          GRPC_UNIMPLEMENTED,
          "this message is compressed, and no compression was agreed for this call",
        );
      }
      const length = this.#buffered.readUInt32BE(1);
      if (length > MAXIMUM_MESSAGE_BYTES) {
        throw new GrpcStatusError(
          GRPC_RESOURCE_EXHAUSTED,
          `a message of ${length} bytes is larger than the ${MAXIMUM_MESSAGE_BYTES} this accepts`,
        );
      }
      if (this.#buffered.length < PREFIX_BYTES + length) {
        break;
      }
      // Refused where the message would have been decoded, rather than by
      // whoever is reading them. A caller that turned the second one away would
      // already have been handed however many arrived in the same chunk, which
      // is exactly how a bounded per-message limit becomes an unbounded
      // per-call one: a four-mebibyte body of five-byte empty frames is the
      // best part of a million buffers, for a call whose answer was settled by
      // its first message.
      //
      // INVALID_ARGUMENT, where an oversized message is RESOURCE_EXHAUSTED, and
      // the distinction is the one src/grpc/messages.ts draws: that request is
      // well formed and asks for more than this service will spend, where this
      // one is not the shape the method takes at all.
      if (this.#decoded >= this.#maximumMessages) {
        const allowed =
          this.#maximumMessages === 1 ? "one message" : `${this.#maximumMessages} messages`;
        throw new GrpcStatusError(
          GRPC_INVALID_ARGUMENT,
          `this method takes ${allowed}, and this call carried more`,
        );
      }
      messages.push(this.#buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + length));
      this.#buffered = this.#buffered.subarray(PREFIX_BYTES + length);
      this.#decoded += 1;
    }
    return messages;
  }

  /**
   * True when bytes are held that are not yet a whole message.
   *
   * A stream that ends in this state ended in the middle of a message, which is
   * a different failure from a stream that carried none.
   */
  get incomplete(): boolean {
    return this.#buffered.length > 0;
  }
}
