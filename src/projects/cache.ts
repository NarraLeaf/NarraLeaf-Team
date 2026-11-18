/**
 * Team's own checkouts of the projects it serves.
 *
 * The rule this file exists to hold
 * ---------------------------------
 * **Team never opens the store loreserver is serving.** A repository lock is
 * exclusive, and it is exclusive within one process as hard as between two:
 * opening a store loreserver holds does not fail and does not time out. It
 * waits, at no CPU, with nothing logged, for a lock that will not be released
 * while the server is running. There is no setting to tune and no error to
 * catch — the read simply never returns, and so does everything queued behind
 * it.
 *
 * So Team reads a project the way a Studio installation on somebody else's
 * machine reads it: as a client, over the network, against its own loreserver.
 * It clones into a directory of its own and opens that. Every path a Lore call
 * is given comes from {@link projectCheckoutPath} and from nowhere else.
 *
 * What the cache is
 * -----------------
 * One checkout per project, under `<root>/cache/`, with nothing checked out.
 * It is disposable by definition: deleting the whole directory, at any moment,
 * costs the time of the next read and nothing else. Nothing is kept here that
 * is not also in the repository it came from, so there is nothing in it to
 * lose.
 *
 * Why nothing is checked out
 * --------------------------
 * A full clone of a project costs its whole content twice over — once on the
 * wire and once on disk. A bare one costs neither: measured against a
 * repository holding an 8 MB asset, 187 ms, nothing on the wire, and 2 448
 * bytes on disk. What it leaves behind still answers everything Team asks — the
 * branch, the history and each revision's metadata come off the disk with no
 * network at all, and the revision tree and any file in it are read through
 * the store, which fetches what it needs on demand. The cost tracks the shape
 * of the tree rather than the size of the content.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  cloneRepository,
  loginWithToken,
  releaseRepository,
  revisionHistory,
  syncRevision,
} from "../lore/verbs.js";
import type { LoreGlobals } from "../lore/call.js";

/** Where every checkout lives, under one storage root. */
export function projectCacheDir(root: string): string {
  return join(resolve(root), "cache", "projects");
}

/**
 * Where one project's checkout lives.
 *
 * Keyed by repository id rather than by name, because a project can be renamed
 * and a directory named after the old one would be a second checkout of the
 * same repository rather than the same one.
 */
export function projectCheckoutPath(root: string, projectId: string): string {
  return join(projectCacheDir(root), projectId);
}

/**
 * Where the project authority's working copy of one project lives.
 *
 * A second checkout beside the read cache, and a different kind: this one has
 * its files checked out, because it is where the authority writes a snapshot
 * of the project's current state and commits it as a history version
 * (./workingCopy.ts). It obeys the same rule as the read cache - it is Team's
 * own clone, reached over the network, never the store loreserver serves - and
 * it is just as disposable: everything in it is either in the repository or in
 * the authority, so deleting it costs one clone.
 */
export function authorityWorkingCopyPath(root: string, projectId: string): string {
  return join(resolve(root), "cache", "authority", projectId);
}

/**
 * The file that says a checkout finished.
 *
 * Outside the checkout rather than in it, so that nothing Team writes ever
 * appears in a working tree. Without it, a clone interrupted partway — a
 * machine that lost power, an operator who pressed Ctrl-C — leaves a directory
 * that looks like a checkout, and every later sync of it fails in the same way
 * for ever with no way out but deleting it by hand.
 */
export function readyMarkerPath(root: string, projectId: string): string {
  return `${projectCheckoutPath(root, projectId)}.ready`;
}

/** What a project has to be told to reach its repository. */
export interface CheckoutOptions {
  readonly root: string;
  /** The repository id, which is what the project row is keyed by. */
  readonly projectId: string;
  /** The repository name, which is the last part of its URL. */
  readonly projectName: string;
  /** Where loreserver is, as a client writes it: `lore://host:port`. */
  readonly remote: string;
  /** A token to present, for a loreserver that demands one. */
  readonly token?: string;
  /** Where that token was issued, for a loreserver that demands one. */
  readonly authUrl?: string;
}

/** A checkout that is ready to be read. */
export interface Checkout {
  /** The directory the checkout is in, which is the only path Lore is given. */
  readonly path: string;
  /** The repository URL it came from, which is also what its store fetches from. */
  readonly remoteUrl: string;
  /** True when this call cloned it rather than finding it. */
  readonly cloned: boolean;
  /** The branch the checkout is on, as the clone or the sync reported it. */
  readonly branch?: string;
  /** What this call pulled over the network. */
  readonly bytesTransferred: number;
}

/** The address of one project's repository. */
export function repositoryUrl(remote: string, projectName: string): string {
  return `${remote.replace(/\/+$/, "")}/${projectName}`;
}

/**
 * Globals for a call that has to reach the remote.
 *
 * `cache` is on so that fragments fetched from the remote are kept: without
 * it, reading the same file twice fetches it twice, and a refresh that reads
 * an unchanged project would pay full price every time.
 */
export function onlineGlobals(path: string): LoreGlobals {
  return { repositoryPath: path, offline: false, cache: true };
}

/**
 * Globals for a call that must not reach the remote.
 *
 * Offline is not a network kill switch — some verbs dial anyway — but for the
 * ones used here it is the difference between reading what is on disk and
 * waiting on a socket for a server that may not be there.
 */
export function offlineGlobals(path: string): LoreGlobals {
  return { repositoryPath: path, offline: true, cache: true };
}

/**
 * Whether a checkout can be brought up to date rather than made again.
 *
 * A checkout of a repository that had no revisions when it was cloned has no
 * remote written into it — there was nothing for the clone to write one from —
 * and syncing it fails with "No remote configured" for ever, however many
 * revisions have been pushed since. So one with no revision in it is not
 * synced, it is cloned again, which costs a couple of hundred milliseconds and
 * nothing on the wire.
 */
async function hasRevision(path: string): Promise<boolean> {
  try {
    return (await revisionHistory(offlineGlobals(path))).length > 0;
  } catch {
    return false;
  }
}

/**
 * Make sure a project has a checkout, and bring it up to date.
 *
 * Cloned the first time and synced afterwards. A partial checkout — one with no
 * marker beside it — is thrown away and cloned again rather than synced, and a
 * clone that fails takes its directory with it, so what is left behind is
 * always either a finished checkout or nothing.
 */
export async function ensureCheckout(options: CheckoutOptions): Promise<Checkout> {
  const path = projectCheckoutPath(options.root, options.projectId);
  const marker = readyMarkerPath(options.root, options.projectId);
  const remoteUrl = repositoryUrl(options.remote, options.projectName);
  const globals = onlineGlobals(path);

  if (options.token !== undefined) {
    // Before anything that touches the remote, including a sync: the session
    // Lore keeps is per machine and per user, not per repository, and it
    // expires on its own schedule.
    //
    // A failure here is not a failure to read. A loreserver that asks nobody
    // who they are — one brought up without identity — serves the clone that
    // follows perfectly well and has no endpoint to exchange a token at, so
    // stopping here would make Team unable to read the simplest Team there is.
    // One that does ask refuses the clone in its own words a moment later,
    // and that sentence is the one worth putting on screen.
    await loginWithToken(globals, {
      remoteUrl,
      token: options.token,
      ...(options.authUrl === undefined ? {} : { authUrl: options.authUrl }),
    }).catch(() => undefined);
  }

  if (existsSync(marker) && existsSync(join(path, ".lore")) && (await hasRevision(path))) {
    const synced = await syncRevision(globals);
    return {
      path,
      remoteUrl,
      cloned: false,
      ...(synced.branchName === "" ? {} : { branch: synced.branchName }),
      bytesTransferred: 0,
    };
  }

  // Lore may be holding the directory about to be removed, and on Windows a
  // file it holds cannot be deleted.
  await releaseRepository(offlineGlobals(path)).catch(() => undefined);
  await rm(marker, { force: true });
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });

  let cloned;
  try {
    cloned = await cloneRepository(globals, { repositoryUrl: remoteUrl });
  } catch (error) {
    // Lore may still be holding the directory it was writing into, and on
    // Windows a file it holds cannot be removed. Letting go first is what makes
    // the removal work rather than leaving a half-clone the next run finds.
    await releaseRepository(globals).catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await writeFile(marker, "", "utf8");
  return {
    path,
    remoteUrl,
    cloned: true,
    ...(cloned.branch === "" ? {} : { branch: cloned.branch }),
    bytesTransferred: cloned.bytesTransferred,
  };
}

/**
 * Throw one project's checkout away.
 *
 * The next read clones it again. Nothing else notices, which is the property
 * the cache is built around.
 */
export async function discardCheckout(root: string, projectId: string): Promise<void> {
  const path = projectCheckoutPath(root, projectId);
  await releaseRepository(offlineGlobals(path)).catch(() => undefined);
  await rm(readyMarkerPath(root, projectId), { force: true });
  await rm(path, { recursive: true, force: true });
}
