/**
 * A team project's documents, between its files and its authority.
 *
 * Reading starts an authority from a project as a revision holds it: every file the kernel calls a
 * project document, parsed the way Studio parses it (stories migrated, a newer Studio's document
 * refused by name). Writing is the authority's own `serialize`, which is what a snapshot commits.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { isProjectDocumentPath, isWholeFilePath, parseProjectFile, type HeldFile } from "../../studio-kernel/vendor/kernel.js";

/** Reads one project-relative file, or answers undefined when it is not there. */
export type ProjectFileReader = (relativePath: string) => Promise<Buffer | string | undefined>;

/**
 * The largest whole file the authority keeps in memory. A larger one is held as a note of its digest
 * - "as the last saved version has it" - until somebody replaces it.
 */
export const HELD_FILE_LIMIT = 4 * 1024 * 1024;

/** A whole file's bytes as the authority holds them: text when it is text, base64 otherwise. */
export function heldFileOf(bytes: Buffer): HeldFile {
  if (bytes.length > HELD_FILE_LIMIT) {
    return { $file: 1, stored: { digest: sha256(bytes), size: bytes.length } };
  }
  const text = bytes.toString("utf8");
  const isText = !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes);
  return isText
    ? { $file: 1, encoding: "utf8", data: text }
    : { $file: 1, encoding: "base64", data: bytes.toString("base64") };
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface LoadedProject {
  /** The revision these were read from, when known. */
  readonly revision?: string;
  readonly files: ReadonlyMap<string, unknown>;
  /**
   * Documents that could not be read, and why. Left out rather than failing the project: one
   * damaged file should not take the whole project offline, and nobody can edit what nobody can read.
   */
  readonly unreadable: ReadonlyArray<{ path: string; reason: string }>;
}

/** Read every project document among `paths`, and every file that only travels whole. */
export async function loadProjectFiles(paths: readonly string[], read: ProjectFileReader): Promise<LoadedProject> {
  const files = new Map<string, unknown>();
  const unreadable: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    const whole = isWholeFilePath(path);
    if (!whole && !isProjectDocumentPath(path)) {
      continue;
    }
    const content = await read(path);
    if (content === undefined) {
      continue;
    }
    if (whole) {
      files.set(path, heldFileOf(typeof content === "string" ? Buffer.from(content, "utf8") : content));
      continue;
    }
    const text = typeof content === "string" ? content : content.toString("utf8");
    try {
      files.set(path, parseProjectFile(path, text));
    } catch (error) {
      unreadable.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { files, unreadable };
}

/** Every file under a checked-out project, project-relative with forward slashes, skipping `.lore`. */
export async function listCheckedOutFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".lore" || entry.name === ".nlstudio") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  await walk(root);
  return found.sort();
}
