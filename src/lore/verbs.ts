/**
 * The typed operations Team calls, and the only surface above this layer.
 *
 * Every wrapper fills in each field of its args struct rather than leaving koffi
 * to zero what is omitted: a struct literal naming all its fields is also the
 * documentation of what the verb accepts, and it makes an added field a
 * question the compiler asks rather than a silent default.
 *
 * Almost everything here reads. The exceptions are the four write verbs at the
 * end - stage, commit, flush, push - which exist for one caller: the project
 * authority, which is the place a team project's current state lives and puts
 * it into the repository as history versions (src/projects/workingCopy.ts).
 * Nothing else in Team writes a revision.
 */
import {
  LORE_ROOT_NODE_ID,
  LORE_METADATA_TAGS,
} from "./abi.js";
import { invoke, type LoreGlobals } from "./call.js";
import {
  LoreTag,
  type LoreBranchPushPayload,
  type LoreCloneEndPayload,
  type LoreCommitRevisionPayload,
  type LoreHistoryEntryPayload,
  type LoreMetadataPayload,
  type LoreStorageDataPayload,
  type LoreStorageItemCompletePayload,
  type LoreStorageOpenedPayload,
  type LoreSyncTargetPayload,
  type LoreTreeChildPayload,
  type LoreTreeLoadedPayload,
} from "./events.js";
import {
  contextBytes,
  loreString,
  loreStringArray,
  partitionBytes,
  revisionBytes,
  type LoreHex,
} from "./values.js";

/** Handles stay wrapped so a store handle cannot be passed where a tree belongs. */
export interface StoreHandle {
  readonly handleId: number;
}

export interface TreeHandle {
  readonly handleId: number;
}

export { LORE_ROOT_NODE_ID } from "./abi.js";

/** Whether a tree entry may be descended into. */
export const NODE_DIRECTORY = 0;
export const NODE_FILE = 1;

export interface CloneResult {
  branch: string;
  revision?: LoreHex;
  fileCount: number;
  /** What the clone pulled over the network, which a bare one makes nought. */
  bytesTransferred: number;
}

/**
 * Fetch a repository from a remote into `globals.repositoryPath`, checking
 * nothing out.
 *
 * `bare` is the whole reason this is affordable. Measured against a repository
 * holding an 8 MB asset: 187 ms, **nothing at all on the wire**, and 2 448
 * bytes in 38 files on disk. A full clone of the same repository moved 8.4 MB
 * and wrote 8.4 MB.
 *
 * What a bare clone leaves behind is enough to read everything: the branch,
 * the revision history and each revision's metadata are all answered from disk
 * with no network, and the revision tree — every directory, every file, every
 * size — is read through the store, which fetches what it needs on demand as
 * long as it was opened with the remote (see {@link openStore}). Measured, the
 * whole tree came back in 12 ms and the 8 MB asset in 7 ms, over a checkout
 * that never grew past 5.4 KB.
 *
 * The alternative — a sparse checkout naming one root entry — is worse in two
 * ways. It costs more, on the wire and on disk, and it has to name a file that
 * is really there: a `rootFiles` entry that is not in the revision fails the
 * whole clone with "Node not found", and the name of a Studio project file is
 * the project's own, which is not knowable before the clone.
 *
 * The destination has to be an empty directory that already exists — Lore
 * writes `.lore/` into it and does not ask first.
 */
export async function cloneRepository(
  globals: LoreGlobals,
  options: { repositoryUrl: string; /** Check the files out. Only a working copy that commits wants it. */ checkout?: boolean },
): Promise<CloneResult> {
  const result = await invoke("repositoryClone", globals, {
    repositoryUrl: loreString(options.repositoryUrl),
    revision: loreString(undefined),
    view: loreString(undefined),
    bare: options.checkout === true ? 0 : 1,
    // Not available in the published builds, which answer it with "Virtual
    // repositories not supported, build with --features=vfs".
    virtually: 0,
    directFileWrite: 0,
    directFileIo: 0,
    layer: loreString(undefined),
    layerMetadata: loreString(undefined),
    prefetch: loreString(undefined),
    useSharedStore: 0,
    sharedStorePath: loreString(undefined),
    noTracking: 0,
    rootFiles: loreStringArray(undefined),
    dependencyTags: loreStringArray(undefined),
    dependencyRecursive: 0,
    dependencyDepthLimit: 0,
  });

  const end = result.first<LoreCloneEndPayload>(LoreTag.REPOSITORY_CLONE_END);
  return {
    branch: end?.branch ?? "",
    ...(end?.revision === undefined ? {} : { revision: end.revision }),
    fileCount: end?.fileCount ?? 0,
    bytesTransferred: end?.bytesTransferred ?? 0,
  };
}

/**
 * Where a branch name comes from, and where it deliberately does not.
 *
 * Both the clone and the sync report the branch they worked on, so nothing has
 * to ask for it. Asking is what the obvious verb would do, and `branchList`
 * costs 642 ms of a 717 ms read — it dials the remote to enumerate branches
 * there, whatever it is told about being offline. A name Team already has is
 * not worth six sevenths of a refresh.
 */
export interface SyncResult {
  branchName: string;
  targetRevision?: LoreHex;
  /** Nothing had to be fetched: the checkout was already at the target. */
  local: boolean;
}

/**
 * Bring a checkout up to the latest revision of its branch.
 *
 * `rootFiles` is deliberately not passed, and would not help if it were: on a
 * sync it only filters which of the *changed* files are written, so asking for
 * a subtree a clone left out reports no files and transfers nothing, which
 * reads exactly like a repository that has not moved.
 *
 * `forwardChanges` and `reset` are both off. Team never edits a checkout, so
 * there is nothing to carry forward and nothing to throw away; either flag
 * would turn this into a merge.
 *
 * This fails with "No remote configured" against a checkout of a repository
 * that had no revisions when it was cloned — there was nothing for the clone to
 * write a remote from. See ./cache.ts, which re-clones rather than syncing
 * those.
 */
export async function syncRevision(globals: LoreGlobals): Promise<SyncResult> {
  const result = await invoke("revisionSync", globals, {
    revision: loreString(undefined),
    forwardChanges: 0,
    reset: 0,
    rootFiles: loreStringArray(undefined),
    dependencyTags: loreStringArray(undefined),
    dependencyRecursive: 0,
    dependencyDepthLimit: 0,
  });

  const target = result.first<LoreSyncTargetPayload>(LoreTag.REVISION_SYNC_TARGET);
  return {
    branchName: target?.branchName ?? "",
    ...(target?.targetRevision === undefined ? {} : { targetRevision: target.targetRevision }),
    local: target?.local ?? true,
  };
}

/**
 * Present a bearer token to a remote and keep the session it gives back.
 *
 * Lore keeps the session in its own per-user store rather than in the
 * repository, so this is a machine-level act. Against a loreserver with no
 * `[server.auth]` section — one that accepts anybody — it is harmless.
 */
export async function loginWithToken(
  globals: LoreGlobals,
  options: { remoteUrl: string; token: string; authUrl?: string },
): Promise<void> {
  await invoke("authLoginWithToken", globals, {
    remoteUrl: loreString(options.remoteUrl),
    token: loreString(options.token),
    tokenType: loreString(undefined),
    authUrl: loreString(options.authUrl),
  });
}

/**
 * Let go of whatever Lore is holding open for this repository path.
 *
 * Called after every read, and not only for tidiness: on Windows a file the
 * library still has open cannot be deleted, and the cache this reads is
 * supposed to be a directory somebody can remove at any moment.
 */
export async function releaseRepository(globals: LoreGlobals): Promise<void> {
  await invoke("repositoryRelease", globals, { unused: 0 });
}

export interface RevisionEntry {
  revision: LoreHex;
  revisionNumber: number;
}

/**
 * Every revision on the current branch, newest last by revision number.
 *
 * An empty list is a real answer: a repository created and never pushed to has
 * no revisions, which is a different fact from a history Team failed to read.
 */
export async function revisionHistory(globals: LoreGlobals): Promise<RevisionEntry[]> {
  const result = await invoke("revisionHistory", globals, {
    revision: loreString(undefined),
    branch: loreString(undefined),
    date: 0,
    length: 0,
    onlyBranch: 0,
  });
  return result
    .of<LoreHistoryEntryPayload>(LoreTag.REVISION_HISTORY_ENTRY)
    .map((entry) => ({ revision: entry.revision, revisionNumber: entry.revisionNumber }))
    .sort((left, right) => left.revisionNumber - right.revisionNumber);
}

/** What a revision says about itself. Every field may be absent. */
export interface RevisionDetails {
  message?: string;
  /** Epoch milliseconds. */
  timestamp?: number;
  author?: string;
}

/**
 * Lore's own metadata keys, whose spelling is Lore's rather than Team's.
 *
 * `committed-by` rather than `created-by`: a revision carries both and they
 * differ once a revision has been rewritten, and what a history wants is who
 * put this revision on the branch.
 */
const MESSAGE_KEY = "message";
const TIMESTAMP_KEY = "timestamp";
const COMMITTER_KEY = "committed-by";

/**
 * Everything one revision says, in one call.
 *
 * An absent key is a real answer rather than a failure, so every field is
 * optional and an empty string is treated as absent — it would otherwise draw
 * as a revision with a blank author rather than one that did not say.
 */
export async function revisionDetails(
  globals: LoreGlobals,
  revision: LoreHex,
): Promise<RevisionDetails> {
  const result = await invoke("revisionMetadataList", globals, {
    revision: loreString(revision),
  });
  const byKey = new Map(
    result.of<LoreMetadataPayload>(LoreTag.METADATA).map((entry) => [entry.key, entry]),
  );

  const details: RevisionDetails = {};
  const message = byKey.get(MESSAGE_KEY)?.text;
  if (message !== undefined && message !== "") {
    details.message = message;
  }
  const timestamp = byKey.get(TIMESTAMP_KEY);
  if (timestamp?.tag === LORE_METADATA_TAGS.NUMERIC && timestamp.numeric !== undefined) {
    details.timestamp = timestamp.numeric;
  }
  const author = byKey.get(COMMITTER_KEY)?.text;
  if (author !== undefined && author !== "") {
    details.author = author;
  }
  return details;
}

/**
 * Open the content store of a checkout.
 *
 * `remoteUrl`, when given, is what makes a checkout that holds nothing
 * readable: with it, a blob that is not already here is fetched from the
 * remote on demand, and so are the tree fragments a walk needs. Left out, the
 * same read fails with a get item that could not be satisfied. Measured, that
 * is the difference between a 2.4 KB directory that can hand back an 8 MB
 * asset in 7 ms and one that cannot describe its own revision.
 *
 * The path opened must be a checkout of Team's own. Opening the store loreserver
 * is serving does not fail — it waits for a lock that will not be released
 * while the server runs, with nothing logged and no timeout to reach.
 */
export async function openStore(
  globals: LoreGlobals,
  options: { path: string; remoteUrl?: string },
): Promise<StoreHandle> {
  const result = await invoke("storageOpen", globals, {
    repositoryPath: loreString(options.path),
    inMemory: 0,
    remoteConfig: { remoteUrl: loreString(options.remoteUrl) },
    hasRemoteConfig: options.remoteUrl === undefined ? 0 : 1,
    cacheTargetBytes: 0,
    cacheTargetFragments: 0,
  });
  return {
    handleId: result.first<LoreStorageOpenedPayload>(LoreTag.STORAGE_OPENED)?.handleId ?? 0,
  };
}

export async function closeStore(globals: LoreGlobals, handle: StoreHandle): Promise<void> {
  await invoke("storageClose", globals, { handle: { handleId: handle.handleId } });
}

/**
 * Load one revision's tree.
 *
 * `repository` and `revisionHash` are fixed-width binary fields, not hex
 * strings; ./values.ts says what happens to a caller who gets that the wrong
 * way round.
 */
export async function loadTree(
  globals: LoreGlobals,
  store: StoreHandle,
  repository: LoreHex,
  revision: LoreHex,
): Promise<TreeHandle> {
  const result = await invoke("revisionTreeLoad", globals, {
    store: { handleId: store.handleId },
    repository: partitionBytes(repository),
    revisionHash: revisionBytes(revision),
  });
  return {
    handleId: result.first<LoreTreeLoadedPayload>(LoreTag.REVISION_TREE_LOADED)?.handleId ?? 0,
  };
}

export async function closeTree(globals: LoreGlobals, handle: TreeHandle): Promise<void> {
  await invoke("revisionTreeClose", globals, { id: 1, handle: { handleId: handle.handleId } });
}

/**
 * The entries directly under one node of a loaded tree.
 *
 * Each entry carries its own content address and size, so walking a revision
 * costs one call per directory and needs no lookup per file.
 */
export async function listTreeChildren(
  globals: LoreGlobals,
  handle: TreeHandle,
  parentNodeId: number = LORE_ROOT_NODE_ID,
): Promise<LoreTreeChildPayload[]> {
  const result = await invoke("revisionTreeListChildren", globals, {
    id: 1,
    handle: { handleId: handle.handleId },
    parentNodeId,
  });
  return result.of<LoreTreeChildPayload>(LoreTag.REVISION_TREE_CHILD);
}

/** Lore's all-zero hash, which marks a tree entry with no content behind it. */
const ZERO_HASH = "0".repeat(64);

/**
 * Read content by address.
 *
 * `localCache: 1` keeps the payload bytes after they arrive; without it every
 * read of the same content fetches it from the remote again.
 */
export async function readAddress(
  globals: LoreGlobals,
  store: StoreHandle,
  repository: LoreHex,
  address: { hash: LoreHex; context: LoreHex },
): Promise<Buffer> {
  if (address.hash === "" || address.hash === ZERO_HASH) {
    return Buffer.alloc(0);
  }

  const result = await invoke("storageGet", globals, {
    handle: { handleId: store.handleId },
    items: {
      ptr: [
        {
          id: 1,
          partition: partitionBytes(repository),
          address: {
            hash: revisionBytes(address.hash, "address.hash"),
            context: contextBytes(address.context, "address.context"),
          },
          streaming: 0,
          localCache: 1,
        },
      ],
      count: 1,
    },
  });

  const failed = result
    .of<LoreStorageItemCompletePayload>(LoreTag.STORAGE_GET_ITEM_COMPLETE)
    .find((item) => item.errorCode !== 0);
  if (failed !== undefined) {
    throw new Error(`the store could not answer for ${address.hash} (error ${failed.errorCode})`);
  }

  // Ordered by offset rather than by arrival: a non-streaming read arrives in
  // order today, and paying nothing for not depending on that is worth it.
  return Buffer.concat(
    result
      .of<LoreStorageDataPayload>(LoreTag.STORAGE_GET_DATA)
      .slice()
      .sort((left, right) => left.offset - right.offset)
      .map((chunk) => chunk.bytes),
  );
}

/* ------------------------------------------------------------------ writing */

/**
 * Stage paths for the next commit.
 *
 * Paths must be absolute and inside the repository. Lore resolves a relative
 * path against the process working directory, and answers a path outside the
 * repository with success and a PATH_IGNORE event - so that event is turned
 * into an error here, which is the only thing standing between a mistyped path
 * and a snapshot that silently leaves a file out.
 */
export async function stagePaths(globals: LoreGlobals, paths: readonly string[]): Promise<void> {
  const result = await invoke("fileStage", globals, {
    paths: loreStringArray(paths),
    caseChange: 0,
    scan: 1,
  });
  if (result.events.some((event) => event.tag === LoreTag.PATH_IGNORE)) {
    throw new Error(`fileStage: Lore ignored a path it was given: ${paths.join(", ")}`);
  }
}

/**
 * Commit what is staged, recorded as `globals.identity`.
 *
 * **The caller must flush afterwards** ({@link flushRepository}): the store
 * holding branch tips is flushed lazily, and a process that commits and moves
 * on can lose the commit outright - Studio measured it (its
 * docs/version-control.md §4.11).
 */
export async function commitStaged(globals: LoreGlobals, message: string): Promise<LoreCommitRevisionPayload> {
  const result = await invoke("revisionCommit", globals, {
    message: loreString(message),
    link: loreString(undefined),
    linkPaths: loreStringArray(undefined),
    linkMessages: loreStringArray(undefined),
    layer: loreString(undefined),
    layerPaths: loreStringArray(undefined),
    layerMessages: loreStringArray(undefined),
    stats: 0,
  });
  const committed = result.first<LoreCommitRevisionPayload>(LoreTag.REVISION_COMMIT_REVISION);
  if (committed === undefined) {
    throw new Error("revisionCommit: Lore committed and reported no revision");
  }
  return committed;
}

/** Force Lore's stores to disk. Not optional after a commit; see {@link commitStaged}. */
export async function flushRepository(globals: LoreGlobals): Promise<void> {
  await invoke("repositoryFlush", globals, { unused: 0 });
}

/**
 * Send this branch's revisions to the remote.
 *
 * `fastForwardMerge` stays off: a push that is not a fast-forward is refused
 * rather than merged on the server, because a merge nobody can see is not
 * something a snapshot should be able to cause. The caller decides what a
 * refusal means.
 */
export async function pushBranch(globals: LoreGlobals): Promise<LoreBranchPushPayload> {
  const result = await invoke("branchPush", globals, {
    branch: loreString(undefined),
    fastForwardMerge: 0,
  });
  const pushed = result.first<LoreBranchPushPayload>(LoreTag.BRANCH_PUSH);
  if (pushed === undefined) {
    throw new Error("branchPush: Lore pushed and reported nothing");
  }
  return pushed;
}
