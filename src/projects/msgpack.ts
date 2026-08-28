/**
 * Reading MessagePack, because that is what a Studio project file is.
 *
 * Team carries no parser library for this. The format it needs is small — maps,
 * arrays, strings, numbers, booleans and nil — and a hand-written reader that
 * refuses what it does not recognise is a better bargain here than a dependency
 * whose failure mode on a truncated file is somebody else's decision. Every
 * refusal below is a {@link MsgpackError}, and the caller turns that into the
 * sentence a person reads.
 *
 * What it deliberately does not do is guess. A byte that is not a type it
 * knows, a length that runs past the end of the buffer, or trailing bytes after
 * a complete value are all errors: a project file that was half written is far
 * likelier than one that legitimately ends early, and reporting the first half
 * of it as the whole would be worse than saying it cannot be read.
 */

export class MsgpackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsgpackError";
  }
}

/**
 * The most nesting a project file is read to.
 *
 * A depth limit rather than trust: the format allows a map inside a map without
 * end, and a file crafted or corrupted into deep nesting would otherwise be a
 * stack overflow rather than a refusal.
 */
const MAX_DEPTH = 64;

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  get consumed(): number {
    return this.offset;
  }

  private need(count: number): number {
    const start = this.offset;
    if (start + count > this.bytes.length) {
      throw new MsgpackError(
        `the file ends after ${this.bytes.length} bytes, in the middle of a value that needs ${count} more`,
      );
    }
    this.offset += count;
    return start;
  }

  u8(): number {
    return this.bytes.readUInt8(this.need(1));
  }

  u16(): number {
    return this.bytes.readUInt16BE(this.need(2));
  }

  u32(): number {
    return this.bytes.readUInt32BE(this.need(4));
  }

  /**
   * A 64-bit count as a JS number.
   *
   * Beyond 2^53 this loses precision, which is accepted: the values it is used
   * for are lengths and sizes, and a project file with a field that large is
   * not a precision problem.
   */
  u64(): number {
    return Number(this.bytes.readBigUInt64BE(this.need(8)));
  }

  i8(): number {
    return this.bytes.readInt8(this.need(1));
  }

  i16(): number {
    return this.bytes.readInt16BE(this.need(2));
  }

  i32(): number {
    return this.bytes.readInt32BE(this.need(4));
  }

  i64(): number {
    return Number(this.bytes.readBigInt64BE(this.need(8)));
  }

  f32(): number {
    return this.bytes.readFloatBE(this.need(4));
  }

  f64(): number {
    return this.bytes.readDoubleBE(this.need(8));
  }

  slice(length: number): Buffer {
    const start = this.need(length);
    return this.bytes.subarray(start, start + length);
  }

  text(length: number): string {
    return this.slice(length).toString("utf-8");
  }
}

function readValue(reader: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new MsgpackError(`the file nests more than ${MAX_DEPTH} levels deep`);
  }
  const type = reader.u8();

  // positive fixint
  if (type <= 0x7f) return type;
  // negative fixint
  if (type >= 0xe0) return type - 0x100;
  // fixmap
  if (type >= 0x80 && type <= 0x8f) return readMap(reader, type - 0x80, depth);
  // fixarray
  if (type >= 0x90 && type <= 0x9f) return readArray(reader, type - 0x90, depth);
  // fixstr
  if (type >= 0xa0 && type <= 0xbf) return reader.text(type - 0xa0);

  switch (type) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return reader.slice(reader.u8());
    case 0xc5:
      return reader.slice(reader.u16());
    case 0xc6:
      return reader.slice(reader.u32());
    case 0xca:
      return reader.f32();
    case 0xcb:
      return reader.f64();
    case 0xcc:
      return reader.u8();
    case 0xcd:
      return reader.u16();
    case 0xce:
      return reader.u32();
    case 0xcf:
      return reader.u64();
    case 0xd0:
      return reader.i8();
    case 0xd1:
      return reader.i16();
    case 0xd2:
      return reader.i32();
    case 0xd3:
      return reader.i64();
    case 0xd9:
      return reader.text(reader.u8());
    case 0xda:
      return reader.text(reader.u16());
    case 0xdb:
      return reader.text(reader.u32());
    case 0xdc:
      return readArray(reader, reader.u16(), depth);
    case 0xdd:
      return readArray(reader, reader.u32(), depth);
    case 0xde:
      return readMap(reader, reader.u16(), depth);
    case 0xdf:
      return readMap(reader, reader.u32(), depth);
    default:
      // Extension types among them. Team has no use for one and no way to know
      // what it would mean, and skipping it would hand back a value with a
      // hole in it that nothing downstream could see.
      throw new MsgpackError(`the file uses a value type this reads nothing of (0x${type.toString(16)})`);
  }
}

function readArray(reader: Reader, length: number, depth: number): unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(readValue(reader, depth + 1));
  }
  return values;
}

function readMap(reader: Reader, length: number, depth: number): Record<string, unknown> {
  // No prototype, so that a key is only ever a key.
  //
  // These bytes are a file a collaborator committed to a repository, and the
  // map's keys are whatever that file says they are. Written into an ordinary
  // object, a key of `__proto__` does not become a property of that object at
  // all — it replaces the object's prototype, so the file decides what the
  // value this server then walks answers for every name it was never asked
  // about. `constructor` and `toString` are the same confusion from the other
  // side: an ordinary object answers for those whether or not any file
  // mentioned them. An object with no prototype has neither problem. A name is
  // there only if the file held it, and answers only with what the file put
  // under it.
  const value = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < length; index += 1) {
    const key = readValue(reader, depth + 1);
    const read = readValue(reader, depth + 1);
    if (typeof key !== "string" && typeof key !== "number") {
      throw new MsgpackError("the file has a map key that is not a name or a number");
    }
    value[String(key)] = read;
  }
  return value;
}

/**
 * Read one MessagePack value from `bytes`.
 *
 * Trailing bytes are an error rather than something to ignore: a project file
 * is one value, and anything after it means the file is not what it claims.
 */
export function decodeMsgpack(bytes: Buffer): unknown {
  if (bytes.length === 0) {
    throw new MsgpackError("the file is empty");
  }
  const reader = new Reader(bytes);
  const value = readValue(reader, 0);
  if (reader.consumed !== bytes.length) {
    throw new MsgpackError(
      `the file carries ${bytes.length - reader.consumed} bytes after the value it holds`,
    );
  }
  return value;
}
