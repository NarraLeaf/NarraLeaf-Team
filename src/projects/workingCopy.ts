/**
 * The project authority's working copy: where a team project's current state
 * becomes a history version.
 *
 * The authority holds a project's documents and applies every edit to them
 * (src/authority/). What it holds is put into the repository as an ordinary
 * revision - a snapshot - so the history is still Lore's history, every
 * revision is still one any Studio can open, and restoring one is reading it
 * back. This module is the Lore half of that: a checked-out clone of the
 * project, the files written into it, and stage, commit, flush, push.
 *
 * It holds the rule the read cache holds (./cache.ts): **the working copy is
 * Team's own clone, reached over the network, and never the store loreserver
 * is serving.** Its path comes from {@link authorityWorkingCopyPath} and from
 * nowhere else.
 *
 * And it is disposable the same way. Everything in it is either already in
 * the repository or still in the authority, so on any failure it is thrown
 * away and cloned again next time - which is also the whole answer to a push
 * the remote refused: the local commit goes with the directory, and the next
 * snapshot writes the authority's state on top of whatever the remote holds.
 *
 * One writer per project. The repository lock is exclusive and blocking, even
 * within one process, so two snapshots of one project must never overlap; the
 * caller serialises them (see {@link commitSnapshot}).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import type { LoreGlobals } from "../lore/call.js";
import {
  cloneRepository,
  commitStaged,
  flushRepository,
  loginWithToken,
  pushBranch,
  releaseRepository,
  revisionHistory,
  stagePaths,
  syncRevision,
} from "../lore/verbs.js";
import { authorityWorkingCopyPath, repositoryUrl, type CheckoutOptions } from "./cache.js";
import { listCheckedOutFiles } from "../authority/projectFiles.js";
import { isProjectDocumentPath, isWholeFilePath } from "../../studio-kernel/vendor/kernel.js";

export interface WorkingCopyOptions extends CheckoutOptions {
  /**
   * Remove project documents the snapshot does not name - a story deleted since the last version.
   * Only project documents and files that travel whole are ever removed, and never one the
   * snapshot was told to keep; nothing else is touched.
   */
  readonly removeMissing?: boolean;
  /**
   * The account a snapshot is recorded as committing. Lore wants an account id
   * here, not a display name.
   */
  readonly identity?: string;
}

export interface WorkingCopy {
  /** The checked-out directory. */
  readonly path: string;
  readonly remoteUrl: string;
  /** True when this call cloned it rather than syncing one already there. */
  readonly cloned: boolean;
}

/** The marker beside a working copy that finished cloning. */
function readyMarker(path: string): string {
  return `${path}.ready`;
}

function globalsFor(path: string, options: WorkingCopyOptions): LoreGlobals {
  return {
    repositoryPath: path,
    offline: false,
    cache: true,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  };
}

/**
 * Make sure a project has a working copy at the latest revision.
 *
 * A repository nobody has pushed to yet is cloned like any other, and the
 * authority's first snapshot commits and pushes from that clone - measured
 * against loreserver 0.8.6, it lands on the branch the server registered.
 * (Making a fresh local repository addressed at the remote instead does not
 * work: its `main` is a different branch from the one registration made, and
 * the push is refused with "Branch main already exists".) What an empty clone
 * cannot do is sync - it has no remote revision to sync from - and a failed
 * sync here throws the copy away and clones again, which is the same answer.
 */
export async function ensureWorkingCopy(options: WorkingCopyOptions): Promise<WorkingCopy> {
  const path = authorityWorkingCopyPath(options.root, options.projectId);
  const remoteUrl = repositoryUrl(options.remote, options.projectName);
  const globals = globalsFor(path, options);

  if (options.token !== undefined) {
    // Harmless against a loreserver that asks nobody; see ensureCheckout.
    await loginWithToken(globals, {
      remoteUrl,
      token: options.token,
      ...(options.authUrl === undefined ? {} : { authUrl: options.authUrl }),
    }).catch(() => undefined);
  }

  if (existsSync(readyMarker(path)) && existsSync(join(path, ".lore"))) {
    try {
      await syncRevision(globals);
      return { path, remoteUrl, cloned: false };
    } catch {
      // Whatever went wrong, a fresh clone is the answer to it.
      await discardWorkingCopy(options.root, options.projectId);
    }
  }

  await releaseRepository(globals).catch(() => undefined);
  await rm(readyMarker(path), { force: true });
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  try {
    await cloneRepository(globals, { repositoryUrl: remoteUrl, checkout: true });
  } catch (error) {
    await releaseRepository(globals).catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await writeFile(readyMarker(path), "", "utf8");
  return { path, remoteUrl, cloned: true };
}

/** The revision a working copy stands at, or undefined for one with none yet. */
export async function workingCopyHead(copy: WorkingCopy, options: WorkingCopyOptions): Promise<string | undefined> {
  const entries = await revisionHistory({ ...globalsFor(copy.path, options), offline: true });
  let newest: { revision: string; revisionNumber: number } | undefined;
  for (const entry of entries) {
    if (newest === undefined || entry.revisionNumber > newest.revisionNumber) {
      newest = entry;
    }
  }
  return newest?.revision;
}

/** One file of a working copy, as text, or undefined when there is no such file. */
export async function readWorkingFile(copy: WorkingCopy, relativePath: string): Promise<string | undefined> {
  return (await readWorkingBytes(copy, relativePath))?.toString("utf8");
}

/** One file of the working copy as bytes, or undefined when it is not there. */
export async function readWorkingBytes(copy: WorkingCopy, relativePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(inside(copy.path, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** A file a snapshot writes as bytes that came through the blob store. */
export interface SnapshotBlobInput {
  readonly path: string;
  readonly bytes: Buffer;
  /** Written over a different file at the path; an asset's digest-addressed content never is. */
  readonly replace?: boolean;
}

export interface SnapshotResult {
  /** The revision the snapshot made, absent when nothing had changed. */
  readonly revision?: string;
  /** The files that differed from the latest revision and were committed. */
  readonly changed: readonly string[];
}

/** Snapshots in flight, by working copy, so two of one project never overlap. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Write a project's current state into its working copy and commit it as one
 * revision, then push it.
 *
 * `files` maps project-relative paths to their full text. Only files whose
 * text differs from the latest revision are written and staged, and a
 * snapshot with nothing to say commits nothing - so an idle project's
 * periodic snapshot is free and leaves no empty revisions behind.
 *
 * On any failure after the clone the working copy is thrown away: a commit
 * that could not be pushed must not linger to diverge from the remote, and
 * the authority still holds everything that was in it.
 */
export async function commitSnapshot(
  options: WorkingCopyOptions,
  files: ReadonlyMap<string, string | Buffer>,
  message: string,
  blobs: ReadonlyArray<SnapshotBlobInput> = [],
  keep: ReadonlySet<string> = new Set(),
): Promise<SnapshotResult> {
  const key = authorityWorkingCopyPath(options.root, options.projectId);
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => snapshotOnce(options, files, message, blobs, keep));
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) {
      inFlight.delete(key);
    }
  }
}

async function snapshotOnce(
  options: WorkingCopyOptions,
  files: ReadonlyMap<string, string | Buffer>,
  message: string,
  blobs: ReadonlyArray<SnapshotBlobInput>,
  keep: ReadonlySet<string>,
): Promise<SnapshotResult> {
  const copy = await ensureWorkingCopy(options);
  const globals = globalsFor(copy.path, options);
  try {
    const changed: string[] = [];
    for (const [relativePath, content] of files) {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      if ((await readWorkingBytes(copy, relativePath))?.equals(bytes) === true) {
        continue;
      }
      const absolute = inside(copy.path, relativePath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      changed.push(relativePath);
    }
    // Files that travelled through the blob store, written as bytes. An asset's content is
    // addressed by its digest, so one already on disk is the same file and is left alone; any other
    // file (`replace`) is written over whatever was there.
    for (const blob of blobs) {
      const absolute = inside(copy.path, blob.path);
      if (blob.replace === true ? (await readWorkingBytes(copy, blob.path))?.equals(blob.bytes) === true : existsSync(absolute)) {
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, blob.bytes);
      changed.push(blob.path);
    }
    // A document the authority no longer holds - a deleted story - goes from the working copy too.
    for (const relativePath of options.removeMissing === true ? await documentsNotIn(copy, files, keep, blobs) : []) {
      await rm(inside(copy.path, relativePath), { force: true });
      changed.push(relativePath);
    }
    if (changed.length === 0) {
      return { changed };
    }

    await stagePaths(globals, changed.map((relativePath) => inside(copy.path, relativePath)));
    const committed = await commitStaged(globals, message);
    await flushRepository(globals);
    await pushBranch(globals);
    return { revision: committed.revision, changed };
  } catch (error) {
    await discardWorkingCopy(options.root, options.projectId);
    throw error;
  } finally {
    await releaseRepository(globals).catch(() => undefined);
  }
}

/** A repository that already has a revision, so it is not one a first version can be put into. */
export class RepositoryNotEmptyError extends Error {
  constructor() {
    super("this project already holds a version");
    this.name = "RepositoryNotEmptyError";
  }
}

/**
 * Put a project's first version into its repository: the files `write` puts
 * into the working copy, committed and pushed as one revision.
 *
 * For a project made from a package, whose files arrive as bytes on this
 * server's disk rather than through the authority. `write` is handed a way to
 * turn a project-relative path into a path inside the working copy (checked the
 * way every other write here is) and answers the paths it wrote, so a project's
 * assets are copied file to file rather than held in memory.
 *
 * **Only into a repository with no revision yet**, and that is asked of the
 * clone itself rather than of anything this server remembers: a Studio may have
 * pushed to the repository directly, and a first version written over somebody
 * else's would be a second history nobody asked for. The question and the
 * commit sit in the same serialised turn as every snapshot of the project, so
 * nothing commits between them.
 */
export async function seedWorkingCopy(
  options: WorkingCopyOptions,
  write: (place: (relativePath: string) => string) => Promise<readonly string[]>,
  message: string,
): Promise<SnapshotResult> {
  const key = authorityWorkingCopyPath(options.root, options.projectId);
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => seedOnce(options, write, message));
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) {
      inFlight.delete(key);
    }
  }
}

async function seedOnce(
  options: WorkingCopyOptions,
  write: (place: (relativePath: string) => string) => Promise<readonly string[]>,
  message: string,
): Promise<SnapshotResult> {
  const copy = await ensureWorkingCopy(options);
  const globals = globalsFor(copy.path, options);
  try {
    if ((await workingCopyHead(copy, options)) !== undefined) {
      throw new RepositoryNotEmptyError();
    }
    const changed = await write((relativePath) => inside(copy.path, relativePath));
    if (changed.length === 0) {
      return { changed: [] };
    }
    await stagePaths(globals, changed.map((relativePath) => inside(copy.path, relativePath)));
    const committed = await commitStaged(globals, message);
    await flushRepository(globals);
    await pushBranch(globals);
    return { revision: committed.revision, changed };
  } catch (error) {
    // The same rule as a snapshot: a commit that could not be pushed must not linger. A refusal
    // because the repository already had a version wrote nothing, so the copy is fine to keep.
    if (!(error instanceof RepositoryNotEmptyError)) {
      await discardWorkingCopy(options.root, options.projectId);
    }
    throw error;
  } finally {
    await releaseRepository(globals).catch(() => undefined);
  }
}

async function documentsNotIn(
  copy: WorkingCopy,
  files: ReadonlyMap<string, unknown>,
  keep: ReadonlySet<string>,
  blobs: ReadonlyArray<SnapshotBlobInput>,
): Promise<string[]> {
  const written = new Set(blobs.map((blob) => blob.path));
  return (await listCheckedOutFiles(copy.path)).filter((path) =>
    (isProjectDocumentPath(path) || isWholeFilePath(path)) && !files.has(path) && !keep.has(path) && !written.has(path));
}

/** Throw one project's working copy away. The next snapshot clones it again. */
export async function discardWorkingCopy(root: string, projectId: string): Promise<void> {
  const path = authorityWorkingCopyPath(root, projectId);
  await releaseRepository({ repositoryPath: path, offline: true }).catch(() => undefined);
  await rm(readyMarker(path), { force: true });
  await rm(path, { recursive: true, force: true });
}

/**
 * A project-relative path, resolved inside the working copy, or an error.
 *
 * The paths come from Studio's kernel, but a path that climbed out of the
 * working copy would be a write anywhere on the server's disk, so it is
 * checked here rather than trusted.
 */
function inside(root: string, relativePath: string): string {
  const absolute = join(root, relativePath);
  if (relativePath.startsWith("/") || relativePath.includes("\0") || !absolute.startsWith(root + sep)) {
    throw new Error(`not a path inside the project: ${relativePath}`);
  }
  return absolute;
}
