/**
 * Bytes a team project owes its next saved version, kept on disk until a version holds them.
 *
 * A file an author adds travels apart from the edit that names it: up to the blob store, and from
 * there into the next snapshot. The blob store is emptied whenever the server starts (its objects
 * belong to transfers, and transfers are in memory), so a restart between the file arriving and
 * the next snapshot would leave the log naming a file nothing holds. Once a transfer is complete
 * the authority copies it here; the snapshot reads it from here and drops it once committed.
 *
 * `<root>/authority/owed/<project>/<transfer>`.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { OwedBytesKeeper } from "./manager.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class OwedBytesStore implements OwedBytesKeeper {
  readonly #directory: string;

  constructor(root: string) {
    this.#directory = join(resolve(root), "authority", "owed");
  }

  async save(projectId: string, transferId: string, bytes: Buffer): Promise<void> {
    const path = this.#path(projectId, transferId);
    await mkdir(join(path, ".."), { recursive: true });
    // Written beside and renamed, so a crash halfway never leaves a short file that looks kept.
    const partial = `${path}.partial`;
    await writeFile(partial, bytes);
    await rename(partial, path);
  }

  async load(projectId: string, transferId: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#path(projectId, transferId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async drop(projectId: string, transferId: string): Promise<void> {
    await rm(this.#path(projectId, transferId), { force: true });
  }

  #path(projectId: string, transferId: string): string {
    if (!NAME.test(projectId) || !NAME.test(transferId)) {
      throw new Error("not a name a kept file can have");
    }
    return join(this.#directory, projectId, transferId);
  }
}
