/**
 * The slice of the Lore C ABI Team binds.
 *
 * Pure data: no koffi import, no shared library, nothing here can fail to
 * load. ./library.ts turns it into koffi types, ./events.ts decodes payloads
 * with them, and ./verbs.ts is the only surface above.
 *
 * It is deliberately a fraction of what lorelib exports. Team reads: it clones,
 * it syncs, it walks a revision and it fetches blobs. It never stages, never
 * commits, never pushes and never merges, so none of those verbs are here — an
 * unbound verb is one less thing to keep true, and one less thing that looks
 * supported.
 *
 * Field names and types are transcribed from lorelib 0.8.6's header. A wrong
 * type is not a compile error and not a crash: it is a struct read at the wrong
 * offsets, which produces plausible values. Nothing in this file may be
 * adjusted to make a call work.
 */

/** A koffi type expression: a primitive, a registered name, `T*` or `T[n]`. */
export type LoreFieldType = string;

export type LoreStructDefinition = Readonly<Record<string, LoreFieldType>>;

/** Aliases lorelib's header declares for its enums and id types. */
export const LORE_ALIASES = {
  lore_node_id_t: "uint32_t",
  LoreErrorCode: "uint32_t",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Aliases whose target is a struct, so koffi has to see them after it.
 * Split from the primitive ones purely for registration order.
 */
export const LORE_STRUCT_ALIASES = {
  LoreBranchId: "LoreContext",
  LoreRepositoryId: "LorePartition",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Every struct Team binds, in dependency order — koffi resolves a type name when
 * the struct mentioning it is declared, so a struct must follow everything it
 * names.
 */
export const LORE_STRUCTS = {
  // -- primitives -----------------------------------------------------------
  LoreString: { string: "uint8_t*", length: "uintptr_t" },
  LoreHash: { data: "uint8_t[32]" },
  LoreContext: { data: "uint8_t[16]" },
  LorePartition: { data: "uint8_t[16]" },
  LoreAddress: { hash: "LoreHash", context: "LoreContext" },
  LoreBytes: { ptr: "uint8_t*", len: "uintptr_t" },
  LoreStringArray: { ptr: "LoreString*", count: "uintptr_t" },
  LoreTraceLocation: {
    file: "LoreString",
    line: "uint32_t",
    column: "uint32_t",
    context: "LoreString",
  },
  LoreTraceLocationArray: { ptr: "LoreTraceLocation*", count: "uintptr_t" },
  LoreErrorDetail: {
    errorCode: "int32_t",
    message: "LoreString",
    traceLocations: "LoreTraceLocationArray",
  },

  // -- handles --------------------------------------------------------------
  LoreStore: { handleId: "uint64_t" },
  LoreRevisionTree: { handleId: "uint64_t" },

  // -- shared aggregates ----------------------------------------------------
  LoreStorageRemoteConfig: { remoteUrl: "LoreString" },
  LoreStorageGetItem: {
    id: "uint64_t",
    partition: "LorePartition",
    address: "LoreAddress",
    streaming: "uint8_t",
    localCache: "uint8_t",
  },
  LoreStorageGetItemArray: { ptr: "LoreStorageGetItem*", count: "uintptr_t" },
  /**
   * One metadata value: a discriminant plus the union it selects.
   *
   * The `data` field is the one deliberate divergence from the header, which
   * spells it `uint8_t[sizeof(LoreMetadataUnion)]`. koffi needs a literal, and
   * 48 is that size: the widest member is a `LoreAddress`, a 32-byte hash plus
   * a 16-byte context. The payload is never read through this declaration —
   * ./events.ts reads the selected member off the event pointer at its real
   * offset, because koffi lays this array out at 4 while the union, having
   * pointer members, is 8-aligned.
   */
  LoreMetadata: { tag: "uint32_t", data: "uint8_t[48]" },
  LoreRepositoryCloneCountData: {
    fileComplete: "uint64_t",
    fileRetain: "uint64_t",
    fileReplace: "uint64_t",
    fileCount: "uint64_t",
    fileInflight: "uint64_t",
    fragmentInflight: "uint64_t",
    bytesTransferred: "uint64_t",
    bytesTotal: "uint64_t",
    discoveryComplete: "uint8_t",
  },

  // -- globals --------------------------------------------------------------
  LoreGlobalArgs: {
    repositoryPath: "LoreString",
    correlationId: "LoreString",
    identity: "LoreString",
    force: "uint8_t",
    offline: "uint8_t",
    local: "uint8_t",
    remote: "uint8_t",
    dryRun: "uint8_t",
    noAtime: "uint8_t",
    maxConnections: "uint32_t",
    searchLimit: "uint32_t",
    searchNearest: "uint8_t",
    noGc: "uint8_t",
    inMemory: "uint8_t",
    fileCountLimit: "uint64_t",
    fileSizeLimit: "uint64_t",
    compressTaskLimit: "uint64_t",
    storeKeepAlive: "uint8_t",
    storeKeepAliveSeconds: "uint64_t",
    syncData: "uint8_t",
    cache: "uint8_t",
  },

  // -- args -----------------------------------------------------------------
  LoreRepositoryReleaseArgs: { unused: "int" },
  LoreRepositoryCloneArgs: {
    repositoryUrl: "LoreString",
    revision: "LoreString",
    view: "LoreString",
    bare: "uint8_t",
    virtually: "uint8_t",
    directFileWrite: "uint8_t",
    directFileIo: "uint8_t",
    layer: "LoreString",
    layerMetadata: "LoreString",
    prefetch: "LoreString",
    useSharedStore: "uint8_t",
    sharedStorePath: "LoreString",
    noTracking: "uint8_t",
    rootFiles: "LoreStringArray",
    dependencyTags: "LoreStringArray",
    dependencyRecursive: "uint8_t",
    dependencyDepthLimit: "uint32_t",
  },
  LoreRevisionSyncArgs: {
    revision: "LoreString",
    forwardChanges: "uint8_t",
    reset: "uint8_t",
    rootFiles: "LoreStringArray",
    dependencyTags: "LoreStringArray",
    dependencyRecursive: "uint8_t",
    dependencyDepthLimit: "uint32_t",
  },
  LoreRevisionHistoryArgs: {
    revision: "LoreString",
    branch: "LoreString",
    date: "uint64_t",
    length: "uint32_t",
    onlyBranch: "uint8_t",
  },
  LoreRevisionMetadataListArgs: { revision: "LoreString" },
  LoreStorageOpenArgs: {
    repositoryPath: "LoreString",
    inMemory: "uint8_t",
    remoteConfig: "LoreStorageRemoteConfig",
    hasRemoteConfig: "uint8_t",
    cacheTargetBytes: "uint64_t",
    cacheTargetFragments: "uint64_t",
  },
  LoreStorageCloseArgs: { handle: "LoreStore" },
  LoreStorageGetArgs: { handle: "LoreStore", items: "LoreStorageGetItemArray" },
  LoreRevisionTreeLoadArgs: {
    store: "LoreStore",
    repository: "LorePartition",
    revisionHash: "LoreHash",
  },
  LoreRevisionTreeCloseArgs: { id: "uint64_t", handle: "LoreRevisionTree" },
  LoreRevisionTreeListChildrenArgs: {
    id: "uint64_t",
    handle: "LoreRevisionTree",
    parentNodeId: "lore_node_id_t",
  },
  LoreAuthLoginWithTokenArgs: {
    remoteUrl: "LoreString",
    token: "LoreString",
    tokenType: "LoreString",
    authUrl: "LoreString",
  },
  // The write side, which only the project authority's working copy uses (see
  // src/projects/workingCopy.ts). Transcribed from Studio's ABI table, which is
  // checked field by field against upstream's own snapshot.
  LoreRepositoryFlushArgs: { unused: "int" },
  LoreFileStageArgs: { paths: "LoreStringArray", caseChange: "uint32_t", scan: "uint8_t" },
  LoreRevisionCommitArgs: {
    message: "LoreString",
    link: "LoreString",
    linkPaths: "LoreStringArray",
    linkMessages: "LoreStringArray",
    layer: "LoreString",
    layerPaths: "LoreStringArray",
    layerMessages: "LoreStringArray",
    stats: "uint8_t",
  },
  LoreBranchPushArgs: { branch: "LoreString", fastForwardMerge: "uint8_t" },

  // -- events ---------------------------------------------------------------
  LoreMetadataEventData: { key: "LoreString", value: "LoreMetadata" },
  LoreErrorEventData: { errorType: "uint32_t", errorInner: "LoreString" },
  LoreCompleteEventData: { status: "int32_t", error: "LoreErrorDetail" },
  LoreAuthIdentityEventData: {
    authUrl: "LoreString",
    resource: "LoreString",
    userId: "LoreString",
    authorizedDomains: "LoreString",
    expires: "uint64_t",
    token: "LoreString",
  },
  LoreRepositoryCloneEndEventData: {
    branch: "LoreString",
    revision: "LoreHash",
    count: "LoreRepositoryCloneCountData",
  },
  LoreRevisionSyncTargetEventData: {
    remote: "LoreString",
    repository: "LoreRepositoryId",
    branch: "LoreBranchId",
    branchName: "LoreString",
    sourceRevision: "LoreHash",
    sourceRevisionNumber: "uint64_t",
    targetRevision: "LoreHash",
    targetRevisionNumber: "uint64_t",
    isLatest: "uint8_t",
    local: "uint8_t",
  },
  LoreRevisionHistoryEntryEventData: {
    revision: "LoreHash",
    revisionNumber: "uint64_t",
    parent: "LoreHash[2]",
  },
  LoreStorageOpenedEventData: { handleId: "uint64_t" },
  LoreStorageGetDataEventData: {
    id: "uint64_t",
    address: "LoreAddress",
    offset: "uint64_t",
    bytes: "LoreBytes",
  },
  LoreStorageGetItemCompleteEventData: {
    id: "uint64_t",
    address: "LoreAddress",
    errorCode: "LoreErrorCode",
  },
  LoreRevisionTreeLoadedEventData: { handleId: "uint64_t" },
  LoreRevisionCommitRevisionEventData: {
    repository: "LoreRepositoryId",
    branch: "LoreBranchId",
    revision: "LoreHash",
    revisionNumber: "uint64_t",
    parent: "LoreHash",
    parentOther: "LoreHash",
  },
  LoreBranchPushEventData: {
    remote: "LoreString",
    repository: "LoreRepositoryId",
    branch: "LoreBranchId",
    branchName: "LoreString",
    remoteRevision: "LoreHash",
    localRevision: "LoreHash",
    remoteHistory: "uint64_t",
    localHistory: "uint64_t",
    flagAlreadyPushed: "uint8_t",
    flagDefault: "uint8_t",
    flagLink: "uint8_t",
    flagLayer: "uint8_t",
  },
  /**
   * One entry of a directory at a revision.
   *
   * Note there is no `repository`/`revision` pair and no `fileId` here, unlike
   * the node-info event next door: the two are not the same shape, and reading
   * one with the other's layout gives plausible-looking rubbish rather than an
   * error.
   */
  LoreRevisionTreeChildEventData: {
    id: "uint64_t",
    nodeId: "lore_node_id_t",
    name: "LoreString",
    parentId: "lore_node_id_t",
    kind: "uint32_t",
    mode: "uint16_t",
    size: "uint64_t",
    address: "LoreAddress",
    errorCode: "LoreErrorCode",
  },
} as const satisfies Readonly<Record<string, LoreStructDefinition>>;

export type LoreStructName = keyof typeof LORE_STRUCTS;

/**
 * The event tags Team decodes, with their wire values.
 *
 * Enum values are ABI. A renumbered tag routes an event to the wrong decoder,
 * which then reads a struct at the wrong layout, so these are transcribed
 * rather than derived from their neighbours — they are not contiguous.
 */
export const LORE_EVENT_TAGS = {
  ERROR: 1,
  COMPLETE: 2,
  METADATA: 3,
  AUTH_IDENTITY: 10,
  BRANCH_PUSH: 65,
  /** A path a verb was given that it would not touch: outside the repository, or ignored. No payload read. */
  PATH_IGNORE: 130,
  REPOSITORY_CLONE_END: 134,
  REVISION_COMMIT_REVISION: 159,
  REVISION_HISTORY_ENTRY: 165,
  REVISION_SYNC_TARGET: 176,
  STORAGE_OPENED: 191,
  STORAGE_GET_DATA: 194,
  STORAGE_GET_ITEM_COMPLETE: 195,
  REVISION_TREE_LOADED: 200,
  REVISION_TREE_CHILD: 202,
} as const;

/**
 * `LoreMetadataTag` — which member of the metadata union a value carries.
 *
 * Load-bearing on the read side: the discriminant is what makes decoding the
 * union safe. A value tagged anything but STRING must not be read as a
 * `LoreString`, because the first eight bytes of a NUMERIC would then be
 * dereferenced as a pointer.
 */
export const LORE_METADATA_TAGS = {
  ADDRESS: 0,
  BOOLEAN: 1,
  BINARY: 2,
  CONTEXT: 3,
  HASH: 4,
  NUMERIC: 5,
  STRING: 6,
} as const;

/** `LoreNodeType`. A walk has to know which entries it may descend into. */
export const LORE_NODE_TYPES = { DIRECTORY: 0, FILE: 1, LINK: 2 } as const;

/** The node id a tree walk starts from. */
export const LORE_ROOT_NODE_ID = 0;

/**
 * Payload offset inside an event blob.
 *
 * The blob is `{ uint32_t tag; <payload>; }` with the payload aligned to 8, so
 * the tag reads at 0 and every payload struct decodes at 8.
 */
export const LORE_EVENT_PAYLOAD_OFFSET = 8;

/**
 * The callback every verb takes:
 * `void (*)(const uint8_t *event, uint64_t userContext)`.
 */
export const LORE_CALLBACK_PROTOTYPE = {
  name: "LoreEventCallbackFunction",
  returns: "void",
  args: ["uint8_t*", "uint64_t"],
} as const;

/** `struct LoreEventCallbackConfig` — passed by value as the third argument. */
export const LORE_CALLBACK_CONFIG = {
  userContext: "uint64_t",
  callback: "LoreEventCallbackFunction*",
} as const;

/**
 * The verbs Team binds, mapped to their args struct.
 *
 * Every Lore verb has one shape — `int32_t f(const LoreGlobalArgs*, const
 * LoreXArgs*, LoreEventCallbackConfig)` — so the args struct is the only thing
 * that varies and the only thing worth tabulating.
 */
export const LORE_VERBS = {
  repositoryRelease: { symbol: "lore_repository_release", args: "LoreRepositoryReleaseArgs" },
  repositoryClone: { symbol: "lore_repository_clone", args: "LoreRepositoryCloneArgs" },
  revisionSync: { symbol: "lore_revision_sync", args: "LoreRevisionSyncArgs" },
  revisionHistory: { symbol: "lore_revision_history", args: "LoreRevisionHistoryArgs" },
  revisionMetadataList: { symbol: "lore_revision_metadata_list", args: "LoreRevisionMetadataListArgs" },
  storageOpen: { symbol: "lore_storage_open", args: "LoreStorageOpenArgs" },
  storageClose: { symbol: "lore_storage_close", args: "LoreStorageCloseArgs" },
  storageGet: { symbol: "lore_storage_get", args: "LoreStorageGetArgs" },
  revisionTreeLoad: { symbol: "lore_revision_tree_load", args: "LoreRevisionTreeLoadArgs" },
  revisionTreeClose: { symbol: "lore_revision_tree_close", args: "LoreRevisionTreeCloseArgs" },
  revisionTreeListChildren: {
    symbol: "lore_revision_tree_list_children",
    args: "LoreRevisionTreeListChildrenArgs",
  },
  authLoginWithToken: { symbol: "lore_auth_login_with_token", args: "LoreAuthLoginWithTokenArgs" },
  repositoryFlush: { symbol: "lore_repository_flush", args: "LoreRepositoryFlushArgs" },
  fileStage: { symbol: "lore_file_stage", args: "LoreFileStageArgs" },
  revisionCommit: { symbol: "lore_revision_commit", args: "LoreRevisionCommitArgs" },
  branchPush: { symbol: "lore_branch_push", args: "LoreBranchPushArgs" },
} as const satisfies Readonly<Record<string, { symbol: string; args: LoreStructName }>>;

export type LoreVerbName = keyof typeof LORE_VERBS;
