/**
 * Decoding Lore's event stream into plain JS values.
 *
 * Every verb reports through one callback: a pointer to
 * `{ uint32_t tag; <payload>; }`, called once per event, with the payload valid
 * only for the length of that call. Decoding here is therefore eager and total
 * — by the time a payload leaves {@link decodeEvent} it is an ordinary object
 * holding copied strings and Buffers, with nothing borrowed left to outlive the
 * callback. A lazy reader would hand back whatever that memory later became.
 *
 * A tag with no reader is reported as `{ tag }` and nothing else. lorelib
 * defines a couple of hundred of them and most are progress chatter.
 */
import koffi from "koffi";

import {
  LORE_EVENT_PAYLOAD_OFFSET,
  LORE_EVENT_TAGS,
  LORE_METADATA_TAGS,
  type LoreStructName,
} from "./abi.js";
import type { LoreLibrary } from "./library.js";
import {
  decodeBool,
  decodeBytes,
  decodeCount,
  decodeHash,
  decodeOptionalHash,
  decodeString,
  nested,
  type LoreHex,
} from "./values.js";

export const LoreTag = LORE_EVENT_TAGS;

export interface LoreErrorPayload {
  message: string;
}

export interface LoreCompletePayload {
  status: number;
  errorCode: number;
  message: string;
  /** Rust `file:line` locations, which are the difference between a message and a place to look. */
  trace: string[];
}

/**
 * One metadata entry on a revision.
 *
 * `text` and `numeric` are exclusive and both may be absent: only those two
 * members of the union are read, because a value read as the wrong member is a
 * crash rather than a wrong answer — a NUMERIC's eight bytes decoded as a
 * `LoreString` would be dereferenced as a pointer.
 */
export interface LoreMetadataPayload {
  key: string;
  tag: number;
  text?: string;
  numeric?: number;
}

export interface LoreAuthIdentityPayload {
  userId: string;
  expires: number;
}

export interface LoreCloneEndPayload {
  branch: string;
  revision?: LoreHex;
  fileCount: number;
  bytesTransferred: number;
}

export interface LoreSyncTargetPayload {
  branchName: string;
  sourceRevision?: LoreHex;
  targetRevision?: LoreHex;
  targetRevisionNumber: number;
  /** The target was already here; nothing had to be fetched. */
  local: boolean;
}

export interface LoreHistoryEntryPayload {
  revision: LoreHex;
  /** Monotonic per repository; a cheap topological rank. */
  revisionNumber: number;
}

export interface LoreStorageOpenedPayload {
  handleId: number;
}

export interface LoreStorageDataPayload {
  id: number;
  offset: number;
  bytes: Buffer;
}

export interface LoreStorageItemCompletePayload {
  id: number;
  errorCode: number;
}

export interface LoreTreeLoadedPayload {
  handleId: number;
}

export interface LoreTreeChildPayload {
  nodeId: number;
  name: string;
  kind: number;
  size: number;
  address: { hash: LoreHex; context: LoreHex };
}

/** A revision a commit made. */
export interface LoreCommitRevisionPayload {
  revision: LoreHex;
  revisionNumber: number;
  parent?: LoreHex;
}

/** What a push did. */
export interface LoreBranchPushPayload {
  remote: string;
  branchName: string;
  localRevision?: LoreHex;
  remoteRevision?: LoreHex;
  /** The remote already had the local tip; nothing was sent. */
  alreadyPushed: boolean;
}

export interface LoreEvent<T = unknown> {
  tag: number;
  data?: T;
}

/**
 * A payload reader.
 *
 * `pointer` is the raw event pointer, passed because one payload cannot be read
 * from the decoded struct alone: see the metadata reader, whose value is a
 * union at an offset the struct declaration deliberately does not describe.
 * Every other reader ignores it.
 */
type Reader = (raw: Record<string, unknown>, pointer: unknown) => unknown;

/** Which struct each tag's payload is. Both this and a reader, or neither. */
const PAYLOAD_STRUCTS: Readonly<Record<number, LoreStructName>> = {
  [LoreTag.ERROR]: "LoreErrorEventData",
  [LoreTag.COMPLETE]: "LoreCompleteEventData",
  [LoreTag.METADATA]: "LoreMetadataEventData",
  [LoreTag.AUTH_IDENTITY]: "LoreAuthIdentityEventData",
  [LoreTag.REPOSITORY_CLONE_END]: "LoreRepositoryCloneEndEventData",
  [LoreTag.REVISION_HISTORY_ENTRY]: "LoreRevisionHistoryEntryEventData",
  [LoreTag.REVISION_SYNC_TARGET]: "LoreRevisionSyncTargetEventData",
  [LoreTag.STORAGE_OPENED]: "LoreStorageOpenedEventData",
  [LoreTag.STORAGE_GET_DATA]: "LoreStorageGetDataEventData",
  [LoreTag.STORAGE_GET_ITEM_COMPLETE]: "LoreStorageGetItemCompleteEventData",
  [LoreTag.REVISION_TREE_LOADED]: "LoreRevisionTreeLoadedEventData",
  [LoreTag.REVISION_TREE_CHILD]: "LoreRevisionTreeChildEventData",
  [LoreTag.REVISION_COMMIT_REVISION]: "LoreRevisionCommitRevisionEventData",
  [LoreTag.BRANCH_PUSH]: "LoreBranchPushEventData",
};

/**
 * The tag-to-reader table for a loaded library.
 *
 * Bound to a library because reading needs its registered koffi types, and
 * remembered per library because the table is pure.
 */
const tables = new WeakMap<LoreLibrary, Map<number, Reader>>();

function readerTable(library: LoreLibrary): Map<number, Reader> {
  const cached = tables.get(library);
  if (cached !== undefined) {
    return cached;
  }

  const type = (name: string): koffi.IKoffiCType => library.type(name);
  const table = new Map<number, Reader>();

  table.set(LoreTag.ERROR, (raw): LoreErrorPayload => ({
    message: decodeString(nested(raw, "errorInner")),
  }));

  table.set(LoreTag.COMPLETE, (raw): LoreCompletePayload => {
    const error = nested(raw, "error");
    const locations = nested(error, "traceLocations");
    const count = Number(locations["count"] ?? 0);
    const trace: string[] = [];
    const pointer = locations["ptr"];
    if (pointer !== undefined && pointer !== null && count > 0) {
      const entries = koffi.decode(pointer, type("LoreTraceLocation"), count) as Array<
        Record<string, unknown>
      >;
      for (const entry of entries) {
        const file = decodeString(nested(entry, "file"));
        if (file !== "") {
          trace.push(`${file}:${decodeCount(entry["line"])}`);
        }
      }
    }
    return {
      status: decodeCount(raw["status"]),
      errorCode: decodeCount(error["errorCode"]),
      message: decodeString(nested(error, "message")),
      trace,
    };
  });

  /**
   * The metadata value is read off the event pointer rather than out of the
   * decoded struct, and its offset is computed rather than assumed.
   *
   * `LoreMetadata` is declared as `{ uint32_t tag; uint8_t data[48]; }`, which
   * koffi lays out with `data` at offset 4. The real union is 8-aligned — it
   * has pointer members — so it begins at offset 8, and reading through `data`
   * would take four bytes of padding for the front of the value.
   */
  const metadataValueOffset =
    LORE_EVENT_PAYLOAD_OFFSET +
    koffi.offsetof(type("LoreMetadataEventData"), "value") +
    koffi.offsetof(type("LoreMetadata"), "data") +
    koffi.sizeof("uint32_t");

  table.set(LoreTag.METADATA, (raw, pointer): LoreMetadataPayload => {
    const value = nested(raw, "value");
    const tag = decodeCount(value["tag"]);
    const key = decodeString(nested(raw, "key"));
    if (tag === LORE_METADATA_TAGS.STRING) {
      const text = koffi.decode(pointer, metadataValueOffset, type("LoreString")) as Record<
        string,
        unknown
      >;
      return { key, tag, text: decodeString(text) };
    }
    if (tag === LORE_METADATA_TAGS.NUMERIC) {
      // A revision's `timestamp` is the one key Lore does not write as a
      // string, and it is what dates the last revision on screen. Without this
      // member the value arrives silently absent.
      return { key, tag, numeric: decodeCount(koffi.decode(pointer, metadataValueOffset, "uint64_t")) };
    }
    return { key, tag };
  });

  table.set(LoreTag.AUTH_IDENTITY, (raw): LoreAuthIdentityPayload => ({
    userId: decodeString(nested(raw, "userId")),
    expires: decodeCount(raw["expires"]),
  }));

  table.set(LoreTag.REPOSITORY_CLONE_END, (raw): LoreCloneEndPayload => {
    const count = nested(raw, "count");
    const revision = decodeOptionalHash(nested(raw, "revision"));
    return {
      branch: decodeString(nested(raw, "branch")),
      ...(revision === undefined ? {} : { revision }),
      fileCount: decodeCount(count["fileCount"]),
      bytesTransferred: decodeCount(count["bytesTransferred"]),
    };
  });

  table.set(LoreTag.REVISION_SYNC_TARGET, (raw): LoreSyncTargetPayload => {
    const source = decodeOptionalHash(nested(raw, "sourceRevision"));
    const target = decodeOptionalHash(nested(raw, "targetRevision"));
    return {
      branchName: decodeString(nested(raw, "branchName")),
      ...(source === undefined ? {} : { sourceRevision: source }),
      ...(target === undefined ? {} : { targetRevision: target }),
      targetRevisionNumber: decodeCount(raw["targetRevisionNumber"]),
      local: decodeBool(raw["local"]),
    };
  });

  table.set(LoreTag.REVISION_HISTORY_ENTRY, (raw): LoreHistoryEntryPayload => ({
    revision: decodeHash(nested(raw, "revision")),
    revisionNumber: decodeCount(raw["revisionNumber"]),
  }));

  table.set(LoreTag.STORAGE_OPENED, (raw): LoreStorageOpenedPayload => ({
    handleId: decodeCount(raw["handleId"]),
  }));

  table.set(LoreTag.STORAGE_GET_DATA, (raw): LoreStorageDataPayload => ({
    id: decodeCount(raw["id"]),
    offset: decodeCount(raw["offset"]),
    bytes: decodeBytes(nested(raw, "bytes")),
  }));

  table.set(LoreTag.STORAGE_GET_ITEM_COMPLETE, (raw): LoreStorageItemCompletePayload => ({
    id: decodeCount(raw["id"]),
    errorCode: decodeCount(raw["errorCode"]),
  }));

  table.set(LoreTag.REVISION_TREE_LOADED, (raw): LoreTreeLoadedPayload => ({
    handleId: decodeCount(raw["handleId"]),
  }));

  table.set(LoreTag.REVISION_TREE_CHILD, (raw): LoreTreeChildPayload => {
    const address = nested(raw, "address");
    return {
      nodeId: decodeCount(raw["nodeId"]),
      name: decodeString(nested(raw, "name")),
      kind: decodeCount(raw["kind"]),
      size: decodeCount(raw["size"]),
      address: {
        hash: decodeHash(nested(address, "hash")),
        context: decodeHash(nested(address, "context")),
      },
    };
  });

  table.set(LoreTag.REVISION_COMMIT_REVISION, (raw): LoreCommitRevisionPayload => {
    const parent = decodeOptionalHash(nested(raw, "parent"));
    return {
      revision: decodeHash(nested(raw, "revision")),
      revisionNumber: decodeCount(raw["revisionNumber"]),
      ...(parent === undefined ? {} : { parent }),
    };
  });

  table.set(LoreTag.BRANCH_PUSH, (raw): LoreBranchPushPayload => {
    const local = decodeOptionalHash(nested(raw, "localRevision"));
    const remote = decodeOptionalHash(nested(raw, "remoteRevision"));
    return {
      remote: decodeString(nested(raw, "remote")),
      branchName: decodeString(nested(raw, "branchName")),
      ...(local === undefined ? {} : { localRevision: local }),
      ...(remote === undefined ? {} : { remoteRevision: remote }),
      alreadyPushed: decodeBool(raw["flagAlreadyPushed"]),
    };
  });

  tables.set(library, table);
  return table;
}

/**
 * Read one event off the pointer, copying everything it needs.
 *
 * Must be called inside the native callback: after it returns, the pointer is
 * dangling. Everything it produces is already copied, so the result is safe to
 * keep and inspect later — which is what the caller does, because re-entering
 * Lore from inside a callback is forbidden.
 */
export function decodeEvent(library: LoreLibrary, pointer: unknown): LoreEvent {
  const tag = Number(koffi.decode(pointer, 0, "uint32_t"));
  const structName = PAYLOAD_STRUCTS[tag];
  const reader = readerTable(library).get(tag);
  // Both or neither: a struct with no reader would be decoded and thrown away,
  // and a reader with no struct has nothing to read.
  if (structName === undefined || reader === undefined) {
    return { tag };
  }
  const raw = koffi.decode(pointer, LORE_EVENT_PAYLOAD_OFFSET, library.type(structName)) as Record<
    string,
    unknown
  >;
  return { tag, data: reader(raw, pointer) };
}
