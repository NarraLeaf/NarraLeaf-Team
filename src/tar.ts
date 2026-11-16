/**
 * A tar.gz writer and reader, enough for backups and project exports.
 *
 * Written here rather than taken from a package: the format is a 512-byte
 * header per file and the file padded to 512 bytes, and the only parts a
 * backup needs are regular files, directories, and the PAX record that carries
 * a path longer than the header holds. Anything else in an archive (links,
 * devices) is skipped when reading, never followed.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const BLOCK = 512;
/** The largest size an octal header field of 11 digits holds. */
const OCTAL_SIZE_LIMIT = 8 ** 11;

export interface TarEntry {
  /** Forward slashes, relative, no leading slash. */
  readonly name: string;
  readonly size: number;
  readonly mtime?: number;
  readonly mode?: number;
  /** The bytes, as one buffer or a stream of them; absent for a directory. */
  readonly body?: Buffer | (() => AsyncIterable<Buffer>);
  readonly directory?: boolean;
}

function octal(value: number, width: number): string {
  return `${Math.floor(value).toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number, mtime: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, "utf-8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size >= OCTAL_SIZE_LIMIT ? 0 : size, 12), 124, 12, "ascii");
  block.write(octal(mtime, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** One PAX record: "<length> <key>=<value>\n", where the length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest, 0);
}

async function* tarBlocks(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const name = entry.directory === true && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    const mtime = Math.floor((entry.mtime ?? Date.now()) / 1000);
    const size = entry.directory === true ? 0 : entry.size;
    const records: string[] = [];
    if (Buffer.byteLength(name) > 100) records.push(paxRecord("path", name));
    if (size >= OCTAL_SIZE_LIMIT) records.push(paxRecord("size", String(size)));
    if (records.length > 0) {
      const pax = Buffer.from(records.join(""), "utf-8");
      yield header("././@PaxHeader", pax.length, 0o644, mtime, "x");
      yield pax;
      yield padding(pax.length);
    }
    const shortName = Buffer.byteLength(name) > 100 ? Buffer.from(name).subarray(0, 100).toString("utf-8") : name;
    yield header(shortName, size, entry.mode ?? (entry.directory === true ? 0o755 : 0o644), mtime, entry.directory === true ? "5" : "0");
    if (entry.directory === true) continue;
    let written = 0;
    if (Buffer.isBuffer(entry.body)) {
      written = entry.body.length;
      yield entry.body;
    } else if (entry.body !== undefined) {
      for await (const chunk of entry.body()) {
        // A file that grew while it was read is cut at the size the header promised.
        const room = size - written;
        if (room <= 0) break;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        written += piece.length;
        yield piece;
      }
    }
    // And one that shrank is padded out, so every later header is where it says.
    if (written < size) yield Buffer.alloc(size - written, 0);
    yield padding(size);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

/** Write these entries as a gzipped tar to a stream. */
export async function writeTarGz(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>, destination: Writable): Promise<void> {
  await pipeline(Readable.from(tarBlocks(entries)), createGzip({ level: 6 }), destination);
}

/** A file's bytes as a stream for a {@link TarEntry}. */
export function fileBody(path: string): () => AsyncIterable<Buffer> {
  return () => createReadStream(path) as AsyncIterable<Buffer>;
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return (end === -1 ? raw : raw.subarray(0, end)).toString("utf-8");
}

function parseOctal(block: Buffer, start: number, length: number): number {
  const text = field(block, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf-8");
    const equals = record.indexOf("=");
    if (equals > 0) out.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return out;
}

/** Where an archive path lands under this directory, or undefined if it would land outside it. */
export function safeTarget(directory: string, name: string): string | undefined {
  const cleaned = name.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cleaned === "" || isAbsolute(cleaned) || cleaned.split("/").some((part) => part === "..")) {
    return undefined;
  }
  const base = resolve(directory);
  const target = resolve(base, cleaned);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

export interface ExtractResult {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
}

/**
 * Unpack a tar.gz into a directory.
 *
 * Only regular files and directories are written; a name that would land
 * outside the directory is skipped, as is every other kind of entry.
 */
export async function extractTarGz(source: string, directory: string): Promise<ExtractResult> {
  type State = "header" | "data" | "pax" | "skip";
  let buffer: Buffer = Buffer.alloc(0);
  let state: State = "header";
  let remaining = 0;
  let pad = 0;
  let pax = new Map<string, string>();
  let paxChunks: Buffer[] = [];
  let handle: FileHandle | undefined;
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let ended = false;

  const startEntry = async (block: Buffer): Promise<State> => {
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = field(block, 345, 155);
    let name = field(block, 0, 100);
    if (prefix !== "" && field(block, 257, 6).startsWith("ustar")) name = `${prefix}/${name}`;
    let size = parseOctal(block, 124, 12);
    if (type !== "x" && type !== "g") {
      name = pax.get("path") ?? name;
      const paxSize = pax.get("size");
      if (paxSize !== undefined) size = Number(paxSize);
      pax = new Map();
    }
    remaining = size;
    pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === "x") {
      paxChunks = [];
      return "pax";
    }
    if (type === "0" || type === "\0" || type === "5") {
      const target = safeTarget(directory, name);
      if (target === undefined) {
        skipped += 1;
        return "skip";
      }
      if (type === "5") {
        await mkdir(target, { recursive: true });
        return "skip";
      }
      await mkdir(dirname(target), { recursive: true });
      handle = await open(target, "w", 0o600);
      files += 1;
      return "data";
    }
    skipped += 1;
    return "skip";
  };

  const source$ = createReadStream(source).pipe(createGunzip());
  try {
    for await (const chunk of source$ as AsyncIterable<Buffer>) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (ended) break;
        if (state === "header") {
          if (buffer.length < BLOCK) break;
          const block = buffer.subarray(0, BLOCK);
          buffer = buffer.subarray(BLOCK);
          if (block.every((byte) => byte === 0)) {
            ended = true;
            break;
          }
          state = await startEntry(block);
          if (remaining === 0 && state !== "pax") {
            await handle?.close();
            handle = undefined;
            state = pad > 0 ? "skip" : "header";
          }
          continue;
        }
        // data, pax, skip: consume `remaining`, then `pad`.
        if (remaining > 0) {
          if (buffer.length === 0) break;
          const take = Math.min(remaining, buffer.length);
          const piece = buffer.subarray(0, take);
          buffer = buffer.subarray(take);
          remaining -= take;
          if (state === "data" && handle !== undefined) {
            await handle.write(piece);
            bytes += piece.length;
          } else if (state === "pax") {
            paxChunks.push(Buffer.from(piece));
          }
          if (remaining > 0) continue;
          if (state === "data") {
            await handle?.close();
            handle = undefined;
          } else if (state === "pax") {
            pax = parsePax(Buffer.concat(paxChunks));
          }
        }
        if (pad > 0) {
          if (buffer.length < pad) {
            pad -= buffer.length;
            buffer = Buffer.alloc(0);
            break;
          }
          buffer = buffer.subarray(pad);
          pad = 0;
        }
        state = "header";
      }
      if (ended) break;
    }
  } finally {
    await handle?.close();
    source$.destroy();
  }
  return { files, bytes, skipped };
}

/** Write a tar.gz to a file, through a `.part` name so a half-written one is never mistaken for an archive. */
export async function writeTarGzFile(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeTarGz(entries, createWriteStream(path, { mode: 0o600 }));
}

export function joinArchivePath(...parts: string[]): string {
  return join(...parts).split(sep).join("/");
}
