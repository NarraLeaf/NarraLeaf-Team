/**
 * Reading a Studio project package (`.nlspkg`), the file a project becomes a
 * team project from.
 *
 * A team project is made on this server rather than uploaded from a project's
 * window: its author exports the project from Studio as a package and uploads
 * that here. This module reads the package where the upload left it on disk and
 * says which bytes of it are which file. It never holds the files themselves -
 * a project is mostly its assets, hundreds of megabytes in a real game - only
 * the index, which is names and sizes.
 *
 * The layout is Studio's (`src/shared/utils/projectPackage.ts` in Studio), and
 * only its current version is read:
 *
 *     [0, 8)                 magic, ending in the format version
 *     [8, 8 + bodyLength)    every file's bytes, back to back, in index order
 *     [.., length - 4)       the MessagePack index
 *     [length - 4, length)   uint32 LE: how long that index is
 *
 * A version 1 package, which put the whole project inside one MessagePack value,
 * is refused with the remedy rather than read: exporting again from any current
 * Studio writes version 2.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

import { decodeMsgpack, MsgpackError } from "./msgpack.js";

export const PROJECT_PACKAGE_EXTENSION = ".nlspkg";
const PROJECT_PACKAGE_FORMAT = "narraleaf-studio.project-package";
const CURRENT_VERSION = 2;
const LEGACY_VERSION = 1;
const MAGIC_PREFIX = Buffer.from([0x4e, 0x4c, 0x53, 0x50, 0x4b, 0x47, 0x00]);
const BODY_OFFSET = 8;
const INDEX_LENGTH_SIZE = 4;
/** An index is names and sizes; one larger than this is not a project's. */
const INDEX_LIMIT = 64 * 1024 * 1024;

/** A package that cannot become a project, with the sentence a person reads. */
export class ProjectPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPackageError";
  }
}

/** One file of a package: where it goes in the project, and which bytes of the package are it. */
export interface PackageFile {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
}

export interface ProjectPackage {
  /** What the project was called in Studio when it was exported. */
  readonly projectName: string;
  /** The project's identifier in Studio, when the package carries one. */
  readonly projectIdentifier?: string;
  /** The files to put in the project, in package order, with what the project never carries left out. */
  readonly files: readonly PackageFile[];
  /** Files the package carried that a team project does not take (see {@link isLeftOut}). */
  readonly leftOut: number;
}

/**
 * Read the index of the package at `path` and check it hard enough that the
 * offsets taken from it can be trusted.
 */
export async function readProjectPackage(path: string): Promise<ProjectPackage> {
  const handle = await open(path, "r");
  try {
    const { size: length } = await handle.stat();
    if (length < BODY_OFFSET + INDEX_LENGTH_SIZE) {
      throw new ProjectPackageError("that file is not a NarraLeaf Studio project package");
    }
    const head = Buffer.alloc(BODY_OFFSET);
    await handle.read(head, 0, BODY_OFFSET, 0);
    if (!head.subarray(0, MAGIC_PREFIX.length).equals(MAGIC_PREFIX)) {
      throw new ProjectPackageError("that file is not a NarraLeaf Studio project package");
    }
    const version = head[MAGIC_PREFIX.length];
    if (version === LEGACY_VERSION) {
      throw new ProjectPackageError("that package was exported by an older NarraLeaf Studio; export the project again and upload the new package");
    }
    if (version !== CURRENT_VERSION) {
      throw new ProjectPackageError("that package was exported by a newer NarraLeaf Studio than this server reads");
    }

    const trailer = Buffer.alloc(INDEX_LENGTH_SIZE);
    await handle.read(trailer, 0, INDEX_LENGTH_SIZE, length - INDEX_LENGTH_SIZE);
    const indexLength = trailer.readUInt32LE(0);
    const bodyLength = length - BODY_OFFSET - INDEX_LENGTH_SIZE - indexLength;
    if (indexLength === 0 || indexLength > INDEX_LIMIT || bodyLength < 0) {
      throw new ProjectPackageError("that package is damaged or incomplete");
    }
    const indexBytes = Buffer.alloc(indexLength);
    await handle.read(indexBytes, 0, indexLength, length - INDEX_LENGTH_SIZE - indexLength);
    let index: unknown;
    try {
      index = decodeMsgpack(indexBytes);
    } catch (error) {
      if (error instanceof MsgpackError) throw new ProjectPackageError("that package is damaged or incomplete");
      throw error;
    }
    return describe(index, bodyLength);
  } finally {
    await handle.close();
  }
}

function describe(index: unknown, bodyLength: number): ProjectPackage {
  const read = typeof index === "object" && index !== null ? (index as Record<string, unknown>) : undefined;
  if (read === undefined || read["format"] !== PROJECT_PACKAGE_FORMAT || read["version"] !== CURRENT_VERSION) {
    throw new ProjectPackageError("that file is not a NarraLeaf Studio project package");
  }
  const entries = read["files"];
  if (!Array.isArray(entries)) {
    throw new ProjectPackageError("that package is damaged or incomplete");
  }

  let offset = BODY_OFFSET;
  let claimed = 0;
  let leftOut = 0;
  const seen = new Set<string>();
  const files: PackageFile[] = [];
  for (const entry of entries) {
    const file = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
    const rawPath = file?.["path"];
    const size = file?.["size"];
    if (typeof rawPath !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new ProjectPackageError("that package is damaged or incomplete");
    }
    const path = packagePath(rawPath);
    const located = { path, offset, size };
    offset += size;
    claimed += size;
    if (isLeftOut(path)) {
      leftOut += 1;
      continue;
    }
    // Two entries for one file would be two writes to one path, the second silently winning.
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new ProjectPackageError(`that package names ${path} twice`);
    }
    seen.add(key);
    files.push(located);
  }
  // Equality, not "fits": sizes that do not add up to exactly the body are a truncated or altered
  // package, and every entry after the first wrong size would be read from the wrong place.
  if (claimed !== bodyLength) {
    throw new ProjectPackageError("that package is damaged or incomplete");
  }
  if (!files.some((file) => !file.path.includes("/") && file.path.toLowerCase().endsWith(".nlproj"))) {
    throw new ProjectPackageError("that package holds no NarraLeaf project (there is no .nlproj file at its top)");
  }

  const name = read["projectName"];
  const identifier = read["projectIdentifier"];
  return {
    projectName: typeof name === "string" && name.trim() !== "" ? name : "Imported project",
    ...(typeof identifier === "string" && identifier.trim() !== "" ? { projectIdentifier: identifier } : {}),
    files,
    leftOut,
  };
}

/**
 * A path inside the project, or a refusal.
 *
 * The same rule Studio's importer holds: relative, forward slashes, and no
 * segment that is empty or climbs. A package is a file somebody uploaded, so a
 * path in it is checked here rather than trusted - the working copy checks
 * again before it writes.
 */
export function packagePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.trim() === "" || normalized.includes("\0") || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new ProjectPackageError(`that package names a file outside the project: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectPackageError(`that package names a file outside the project: ${value}`);
  }
  return segments.join("/");
}

/**
 * What a team project never takes from a package, whatever the package says.
 *
 * Studio already leaves these out when it exports (its
 * `shouldExcludeProjectPackagePath`); the rule is held here as well because the
 * package is an uploaded file. `.lore` above all: a team project's repository is
 * this server's, made fresh, and a repository's own store files written into it
 * would be written into the working copy's.
 */
export function isLeftOut(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const fileName = segments.at(-1) ?? "";
  if (fileName === ".ds_store" || fileName === "thumbs.db" || fileName.endsWith(PROJECT_PACKAGE_EXTENSION)) return true;
  if (segments[0] === ".lore" || segments[0] === ".git" || segments[0] === ".nlstudio" || segments[0] === "dist") return true;
  if (segments.includes("node_modules")) return true;
  if (segments[0] === "scripts" && segments[1] === ".narraleaf") return true;
  if (segments[0] === "editor" && segments[1] === "cache") return true;
  if (segments[0] === "editor" && segments[1] === "assets" && segments[2] === "remote") return true;
  return false;
}

/**
 * Copy each file of the package at `source` to where `place` says it goes, a stream at a time, and
 * answer the project paths written. Nothing is held whole: a file is read from its span of the
 * package straight into its place.
 */
export async function copyPackageFiles(
  source: string,
  files: readonly PackageFile[],
  place: (relativePath: string) => string,
): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const target = place(file.path);
    await mkdir(dirname(target), { recursive: true });
    if (file.size === 0) {
      await writeFile(target, "");
    } else {
      await pipeline(createReadStream(source, { start: file.offset, end: file.offset + file.size - 1 }), createWriteStream(target));
    }
    written.push(file.path);
  }
  return written;
}
