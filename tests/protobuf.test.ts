import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  FrameAssembler,
  MAXIMUM_MESSAGE_BYTES,
  UNARY_CALL_MESSAGES,
} from "../src/grpc/framing.js";
import {
  MalformedMessageError,
  MessageReader,
  MessageWriter,
  readFields,
  UnwritableValueError,
  WIRE_DELIMITED,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_VARINT,
} from "../src/grpc/protobuf.js";
import {
  decodeStatusMessage,
  encodeStatusMessage,
  GRPC_INVALID_ARGUMENT,
  GrpcStatusError,
} from "../src/grpc/status.js";

/** The bytes of a message, as hex, which is how a wire format is compared. */
function hex(writer: MessageWriter): string {
  return writer.finish().toString("hex");
}

describe("varints", () => {
  it("writes the values the format's own examples give", () => {
    // Field 1, varint: tag 0x08. The rest is the number, seven bits per byte,
    // least significant group first, with the high bit set on every byte but
    // the last.
    expect(hex(new MessageWriter().varint(1, 0))).toBe("0800");
    expect(hex(new MessageWriter().varint(1, 1))).toBe("0801");
    expect(hex(new MessageWriter().varint(1, 127))).toBe("087f");
    expect(hex(new MessageWriter().varint(1, 128))).toBe("088001");
    expect(hex(new MessageWriter().varint(1, 300))).toBe("08ac02");
    expect(hex(new MessageWriter().varint(1, 16_383))).toBe("08ff7f");
    expect(hex(new MessageWriter().varint(1, 16_384))).toBe("08808001");
  });

  it("writes a negative number as its 64-bit two's complement, in ten bytes", () => {
    // This is why a varint can be ten bytes long rather than nine: an int32 of
    // -1 is sign-extended before it is written.
    expect(hex(new MessageWriter().varint(1, -1))).toBe("08ffffffffffffffffff01");
    expect(hex(new MessageWriter().varint(1, -2))).toBe("08feffffffffffffffff01");
  });

  it("round-trips every value on and around a byte boundary", () => {
    const values = [
      0,
      1,
      127,
      128,
      129,
      255,
      256,
      16_383,
      16_384,
      2 ** 21 - 1,
      2 ** 21,
      2 ** 28 - 1,
      2 ** 28,
      2 ** 32 - 1,
      2 ** 32,
      Number.MAX_SAFE_INTEGER,
    ];

    for (const value of values) {
      const reader = new MessageReader(new MessageWriter().varint(1, value).finish());
      expect(reader.readTag()).toEqual({ field: 1, wireType: WIRE_VARINT });
      expect(reader.readNumber()).toBe(value);
      expect(reader.done).toBe(true);
    }
  });

  it("carries a 64-bit value that no double could hold", () => {
    const value = 2n ** 63n - 1n;

    const reader = new MessageReader(new MessageWriter().varint(1, value).finish());
    reader.readTag();

    expect(reader.readVarint()).toBe(value);
  });

  it("refuses a value too large to read exactly, rather than rounding it", () => {
    const reader = new MessageReader(
      new MessageWriter().varint(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n).finish(),
    );
    reader.readTag();

    expect(() => reader.readNumber()).toThrow(MalformedMessageError);
  });

  it("refuses a varint that never ends", () => {
    // Eleven continuation bytes: no 64-bit value is that long, and reading on
    // would be reading whatever follows as part of the number.
    const reader = new MessageReader(Buffer.from("08" + "ff".repeat(11), "hex"));
    reader.readTag();

    expect(() => reader.readVarint()).toThrow(MalformedMessageError);
  });

  it("refuses a varint the message ends in the middle of", () => {
    const reader = new MessageReader(Buffer.from("08ff", "hex"));
    reader.readTag();

    expect(() => reader.readVarint()).toThrow(MalformedMessageError);
  });

  it("refuses to write a number that is not an integer", () => {
    expect(() => new MessageWriter().varint(1, 1.5)).toThrow(UnwritableValueError);
  });
});

describe("tags", () => {
  it("packs the field number and the wire type into one number", () => {
    // Field 2, length-delimited: (2 << 3) | 2 = 0x12.
    expect(hex(new MessageWriter().string(2, ""))).toBe("1200");
    // Field 16 needs two bytes of tag, which is where a hand-written encoder
    // that assumed one would start writing into the wrong field.
    expect(hex(new MessageWriter().varint(16, 1))).toBe("800101");
  });

  it("refuses a field number the format has no room for", () => {
    expect(() => new MessageWriter().varint(0, 1)).toThrow(UnwritableValueError);
    expect(() => new MessageWriter().varint(536_870_912, 1)).toThrow(UnwritableValueError);
  });

  it("refuses to read a message whose first field is numbered zero", () => {
    const reader = new MessageReader(Buffer.from("0001", "hex"));

    expect(() => reader.readTag()).toThrow(MalformedMessageError);
  });
});

describe("length-delimited fields", () => {
  it("writes a length and then that many bytes", () => {
    expect(hex(new MessageWriter().string(1, "hello"))).toBe("0a0568656c6c6f");
    expect(hex(new MessageWriter().bytes(1, Buffer.from([0, 255])))).toBe("0a0200ff");
  });

  it("round-trips text that is not ASCII, by bytes and not by characters", () => {
    const text = "ハブ — project 🎮";

    const reader = new MessageReader(new MessageWriter().string(1, text).finish());
    reader.readTag();

    expect(reader.readString()).toBe(text);
  });

  it("hands back a copy, so that a decoded value cannot change underneath", () => {
    const encoded = new MessageWriter().bytes(1, Buffer.from([1, 2, 3])).finish();
    const reader = new MessageReader(encoded);
    reader.readTag();

    const value = reader.readDelimited();
    encoded.fill(0);

    expect([...value]).toEqual([1, 2, 3]);
  });

  it("refuses a length that runs past the end of the message", () => {
    const reader = new MessageReader(Buffer.from("0a0568656c", "hex"));
    reader.readTag();

    expect(() => reader.readDelimited()).toThrow(MalformedMessageError);
  });
});

describe("repeated fields", () => {
  it("writes one tag per value, and reads them back in order", () => {
    const encoded = new MessageWriter()
      .string(1, "one")
      .string(1, "two")
      .string(1, "three")
      .finish();

    const values: string[] = [];
    readFields(new MessageReader(encoded), (tag, reader) => {
      if (tag.field === 1) {
        values.push(reader.readString());
        return true;
      }
      return false;
    });

    expect(values).toEqual(["one", "two", "three"]);
  });

  it("keeps a repeated field's values apart from a later field's", () => {
    const encoded = new MessageWriter().string(1, "a").string(2, "b").string(1, "c").finish();

    const first: string[] = [];
    const second: string[] = [];
    readFields(new MessageReader(encoded), (tag, reader) => {
      if (tag.field === 1) {
        first.push(reader.readString());
        return true;
      }
      if (tag.field === 2) {
        second.push(reader.readString());
        return true;
      }
      return false;
    });

    expect(first).toEqual(["a", "c"]);
    expect(second).toEqual(["b"]);
  });
});

describe("nested messages", () => {
  it("writes a message as a length-delimited field, and reads it back", () => {
    const inner = new MessageWriter().string(1, "urc-1").string(2, "read");
    const encoded = new MessageWriter().message(3, inner).finish();

    const parts: string[] = [];
    readFields(new MessageReader(encoded), (tag, reader) => {
      if (tag.field === 3) {
        readFields(reader.readMessage(), (innerTag, innerReader) => {
          parts.push(`${innerTag.field}=${innerReader.readString()}`);
          return true;
        });
        return true;
      }
      return false;
    });

    expect(parts).toEqual(["1=urc-1", "2=read"]);
  });

  it("encodes an empty message as no bytes at all", () => {
    expect(new MessageWriter().finish()).toHaveLength(0);
    expect(hex(new MessageWriter().message(1, new MessageWriter()))).toBe("0a00");
  });
});

describe("unknown fields", () => {
  it("steps over every wire type a later version could add", () => {
    const encoded = Buffer.concat([
      new MessageWriter().varint(9, 300).finish(),
      Buffer.from([(10 << 3) | WIRE_FIXED64, 1, 2, 3, 4, 5, 6, 7, 8]),
      Buffer.from([(11 << 3) | WIRE_FIXED32, 1, 2, 3, 4]),
      new MessageWriter().string(12, "unknown").finish(),
      new MessageWriter().string(1, "known").finish(),
    ]);

    let known: string | undefined;
    readFields(new MessageReader(encoded), (tag, reader) => {
      if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
        known = reader.readString();
        return true;
      }
      return false;
    });

    // The point of the test is the last field: a decoder that mis-stepped over
    // any of the four before it would not have found this one where it is.
    expect(known).toBe("known");
  });

  it("refuses a wire type that has no length, because it cannot be stepped over", () => {
    for (const wireType of [3, 4, 6, 7]) {
      const reader = new MessageReader(Buffer.from([(1 << 3) | wireType, 0]));
      const tag = reader.readTag();

      expect(() => reader.skip(tag.wireType)).toThrow(MalformedMessageError);
    }
  });

  it("refuses a fixed-width field the message ends in the middle of", () => {
    const reader = new MessageReader(Buffer.from([(1 << 3) | WIRE_FIXED32, 1, 2]));
    reader.readTag();

    expect(() => reader.skip(WIRE_FIXED32)).toThrow(MalformedMessageError);
  });
});

describe("gRPC framing", () => {
  it("puts a flag and a big-endian length in front of a message", () => {
    expect(encodeFrame(Buffer.from("hello", "utf8")).toString("hex")).toBe(
      "000000000568656c6c6f",
    );
    expect(encodeFrame(Buffer.alloc(0)).toString("hex")).toBe("0000000000");
  });

  it("reassembles a message split across chunks, one byte at a time", () => {
    const frame = encodeFrame(Buffer.from("a message worth splitting", "utf8"));
    const assembler = new FrameAssembler(UNARY_CALL_MESSAGES);

    const messages: Buffer[] = [];
    for (const byte of frame) {
      messages.push(...assembler.push(Buffer.from([byte])));
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]?.toString("utf8")).toBe("a message worth splitting");
    expect(assembler.incomplete).toBe(false);
  });

  it("finds every message a chunk completed, up to what the call may carry", () => {
    const assembler = new FrameAssembler(2);

    const messages = assembler.push(
      Buffer.concat([encodeFrame(Buffer.from("one")), encodeFrame(Buffer.from("two"))]),
    );

    expect(messages.map((message) => message.toString("utf8"))).toEqual(["one", "two"]);
  });

  it("refuses a second message on a call that carries one, and never decodes it", () => {
    const assembler = new FrameAssembler(UNARY_CALL_MESSAGES);
    const frame = encodeFrame(Buffer.from("one"));

    // Both in the same chunk, which is the case a reader that turned the second
    // one away could not have helped with: by the time it saw the first, every
    // message in that chunk would already have been decoded and held.
    let refusal: unknown;
    try {
      assembler.push(Buffer.concat([frame, frame]));
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(GrpcStatusError);
    expect((refusal as GrpcStatusError).status).toBe(GRPC_INVALID_ARGUMENT);
    expect((refusal as GrpcStatusError).message).toContain("one message");
  });

  it("says so when a stream stopped in the middle of a message", () => {
    const assembler = new FrameAssembler(UNARY_CALL_MESSAGES);

    expect(assembler.push(encodeFrame(Buffer.from("truncated")).subarray(0, 8))).toEqual([]);
    expect(assembler.incomplete).toBe(true);
  });

  it("refuses a compressed message, rather than reading the compressed bytes", () => {
    const frame = encodeFrame(Buffer.from("compressed"));
    frame.writeUInt8(1, 0);

    expect(() => new FrameAssembler(UNARY_CALL_MESSAGES).push(frame)).toThrow(GrpcStatusError);
  });

  it("refuses a length larger than it will ever accept, before allocating for it", () => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAXIMUM_MESSAGE_BYTES + 1, 1);

    expect(() => new FrameAssembler(UNARY_CALL_MESSAGES).push(header)).toThrow(/larger than/);
  });
});

describe("status messages", () => {
  it("percent-encodes what a header cannot carry, and reads it back", () => {
    const message = 'the token expired\nand "100%" of it is gone — really';

    const encoded = encodeStatusMessage(message);

    expect(encoded).not.toContain("\n");
    expect(encoded).toContain("%0A");
    expect(decodeStatusMessage(encoded)).toBe(message);
  });
});
