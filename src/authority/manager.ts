/**
 * The project authorities a running server holds: one per team project that somebody has open,
 * loaded on first use and let go when it goes quiet.
 *
 * This is what makes Team the place a team project's current state lives. Every Studio sends its
 * edits here (`doc.intent`); the authority applies them with Studio's own kernel, writes each to the
 * log before it counts, and publishes it on the project's `doc` topic for every Studio to apply.
 * Nobody's machine is in charge, and when everybody closes the project nothing ends: the state is
 * the last snapshot plus the log, and the next person to open it gets exactly that.
 *
 * History versions are snapshots: the authority's documents committed to the project's repository
 * as an ordinary revision - on a timer once the project has gone quiet, and on request when somebody
 * saves a version by hand. A restore puts an older revision's documents back as the current state,
 * and is itself a step in the log and a new version, so it can be undone too.
 *
 * An asset's file travels apart from its record: the operation names transfers, which the server
 * collects through its blob store (`collectBytes`) and writes into the snapshot beside the records.
 */
import type { DatabaseSync } from "node:sqlite";

import { ASSET_CONTENT_ROOT, assetBytesOf, fileBytesOf, type KernelDocument, type KernelOp } from "../../studio-kernel/vendor/kernel.js";
import type { LoadedProject } from "./projectFiles.js";
import { ProjectAuthority, type HeldFileNote, type ProjectEffect, type ProjectRefusalReason } from "./projectAuthority.js";
import {
  appendEffect,
  effectsAfter,
  lastSeq,
  markSnapshot,
  pruneEffects,
  prunedThrough,
  snapshotMark,
  type SnapshotMark,
  type StoredEffect,
} from "./store.js";
import { recordVersion } from "./versions.js";

export type { LoadedProject } from "./projectFiles.js";

/** A file a snapshot writes from bytes that came through the blob store. */
export interface SnapshotBlob {
  readonly path: string;
  readonly bytes: Buffer;
  /** Written over a different file at the path - a whole file - where an asset's content never is. */
  readonly replace?: boolean;
}

/**
 * Somewhere bytes owed to the next saved version are kept once they have arrived, so a restart
 * before that version does not lose them: the blob store itself is emptied whenever the server
 * starts. Dropped once a version holds them.
 */
export interface OwedBytesKeeper {
  save(projectId: string, transferId: string, bytes: Buffer): Promise<void>;
  load(projectId: string, transferId: string): Promise<Buffer | undefined>;
  drop(projectId: string, transferId: string): Promise<void>;
}

export interface ProjectAuthoritiesOptions {
  readonly database: DatabaseSync;
  /** The project's documents at the latest revision, or undefined when there is no such project. */
  readonly open: (projectId: string) => Promise<LoadedProject | undefined>;
  /** The project's documents at one revision, for a restore. */
  readonly openAt: (projectId: string, revision: string) => Promise<LoadedProject | undefined>;
  /** Commit files as one revision; answers the revision, absent when nothing changed. */
  readonly commit: (
    projectId: string,
    files: ReadonlyMap<string, string | Buffer>,
    message: string,
    blobs: readonly SnapshotBlob[],
    /** Files held only as a note, which the version keeps as they are rather than removes. */
    keep: ReadonlySet<string>,
  ) => Promise<{ readonly revision?: string }>;
  /**
   * The bytes of one transfer an asset operation named, once it has arrived, or undefined while it
   * has not. Absent on a server with nowhere for files to land: asset files then stay where the
   * author's Studio holds them until it publishes them some other way.
   */
  readonly collectBytes?: (projectId: string, transferId: string) => Promise<Buffer | undefined>;
  /** Where arrived bytes wait for the next saved version. Without one they wait in the blob store. */
  readonly keepBytes?: OwedBytesKeeper;
  /** Tell every Studio on the project what happened. */
  readonly publish: (projectId: string, event: DocTopicEvent) => void;
  readonly log?: (line: string) => void;
  readonly clock?: () => number;
  readonly idleSnapshotMs?: number;
  readonly maxSnapshotMs?: number;
  readonly unloadMs?: number;
  /**
   * How long an applied edit is kept in the log once a saved version holds it. Beyond this a
   * Studio that has been away starts again from the last saved version, and an offline edit based
   * on something older is refused - its collisions can no longer be checked. Default thirty days.
   */
  readonly retainMs?: number | (() => number | undefined);
}

/** What a Studio asked for. `document`, `op` and `derived` are Studio's. */
export interface DocIntent {
  readonly clientId: string;
  readonly accountId: string;
  readonly by: string;
  readonly document: KernelDocument;
  readonly op: KernelOp;
  readonly derived?: unknown;
  readonly basedOn?: number;
}

/** One applied edit, as it travels. */
export interface DocEffect {
  readonly seq: number;
  readonly clientId: string;
  readonly accountId: string | null;
  readonly by: string;
  readonly document: unknown;
  readonly op: unknown;
  readonly derived?: unknown;
  readonly at: string;
}

export type DocRefusalReason = ProjectRefusalReason;

export type DocAnswer =
  | { readonly kind: "effect"; readonly effect: DocEffect }
  | {
      readonly kind: "refusal";
      readonly clientId: string;
      readonly reason: DocRefusalReason;
      readonly detail?: string;
      readonly conflicts?: readonly string[];
    };

/** What a project's `doc` topic carries. */
export type DocTopicEvent =
  | { readonly kind: "doc-effect"; readonly effect: DocEffect }
  | { readonly kind: "doc-snapshot"; readonly seq: number; readonly revision: string; readonly label?: string }
  | { readonly kind: "doc-reset"; readonly seq: number; readonly revision: string; readonly by: string };

export interface DocHead {
  readonly seq: number;
  readonly snapshot?: SnapshotMark;
  /** The log is cleared up to here: a Studio behind it starts from the last saved version. */
  readonly prunedThrough: number;
}

/** The files of the last saved version, as a Studio starting from it reads them. */
export interface DocBase {
  readonly seq: number;
  readonly revision: string | null;
  readonly files: ReadonlyMap<string, string | Buffer>;
  /**
   * Files the version has that are not held here: too large (read them from the revision), or with
   * their bytes still on their way (collect the transfer).
   */
  readonly notes: ReadonlyMap<string, HeldFileNote>;
}

const RESTORE_OP = "restore-revision";

const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_ID = /^[0-9a-f]{64}$/i;

/**
 * Where an asset's bytes live in a project: `assets/content/<2>/<2>/<rest>` of the asset's id with
 * its hyphens dropped - the same split Studio's `splitAssetStorageId` makes, because that is where
 * every Studio reads the file from. A bundle's files sit under that directory by their own path.
 *
 * ❗ **The id, never the digest.** A part's `path` is null for "the asset's own file", and an
 * earlier reading of that as "file it by its content" put every imported asset where no Studio looks,
 * so a fresh clone showed them all as unreadable.
 *
 * Undefined for an id that is neither a UUID nor a legacy 64-hex digest, or a bundle path that is
 * absolute or climbs out of the asset: both arrive from a client, and a path decides where bytes land.
 */
export function assetContentPath(assetId: string, inBundle: string | null = null): string | undefined {
  if (!UUID_ID.test(assetId) && !LEGACY_ID.test(assetId)) return undefined;
  const hex = assetId.replaceAll("-", "");
  const root = `assets/content/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
  if (inBundle === null) return root;
  const segments = inBundle.split(/[\\/]/);
  if (inBundle.length === 0 || inBundle.startsWith("/") || segments.some((part) => part === "" || part === "." || part === "..")) {
    return undefined;
  }
  return `${root}/${segments.join("/")}`;
}

interface Loaded {
  authority: ProjectAuthority;
  base: DocBase;
  snapshotSeq: number;
  lastEdit: number;
  lastSnapshot: number;
  lastTouch: number;
  unreadable: LoadedProject["unreadable"];
  /** File transfers named since the last snapshot, still to be written into one. */
  owedBytes: Map<string, OwedTransfer>;
  calling?: { accountId: string };
}

interface OwedTransfer {
  transferId: string;
  path: string;
  /** A whole file, written over what was there; an asset's content is not. */
  replace: boolean;
  /** Kept by the {@link OwedBytesKeeper}: safe across a restart. */
  kept: boolean;
}

/** Every transfer an operation names, with where its bytes go. */
function owedBy(document: KernelDocument, op: KernelOp): OwedTransfer[] {
  const owed: OwedTransfer[] = assetBytesOf(op).flatMap((part) => {
    const path = assetContentPath(part.assetId, part.path);
    return path === undefined ? [] : [{ transferId: part.transferId, path, replace: false, kept: false }];
  });
  const file = fileBytesOf(document, op);
  if (file !== undefined) {
    owed.push({
      transferId: file.transferId,
      path: file.path,
      replace: !file.path.startsWith(`${ASSET_CONTENT_ROOT}/`),
      kept: false,
    });
  }
  return owed;
}

export class ProjectAuthorities {
  readonly #options: ProjectAuthoritiesOptions;
  readonly #loaded = new Map<string, Loaded>();
  readonly #loading = new Map<string, Promise<Loaded | undefined>>();
  readonly #snapshotting = new Map<string, Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ProjectAuthoritiesOptions) {
    this.#options = options;
  }

  #retainMs(): number {
    const value = typeof this.#options.retainMs === "function" ? this.#options.retainMs() : this.#options.retainMs;
    return value ?? 30 * 24 * 60 * 60_000;
  }

  #now(): number {
    return this.#options.clock?.() ?? Date.now();
  }

  start(everyMs = 15_000): void {
    this.#timer ??= setInterval(() => {
      void this.tick();
    }, everyMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await Promise.all(
      [...this.#loaded.entries()]
        .filter(([, loaded]) => loaded.authority.seq > loaded.snapshotSeq)
        .map(([projectId]) => this.snapshot(projectId).catch(() => undefined)),
    );
  }

  head(projectId: string): DocHead {
    const mark = snapshotMark(this.#options.database, projectId);
    const seq = Math.max(lastSeq(this.#options.database, projectId), mark?.seq ?? 0);
    return { seq, ...(mark === undefined ? {} : { snapshot: mark }), prunedThrough: prunedThrough(this.#options.database, projectId) };
  }

  async base(projectId: string): Promise<DocBase | undefined> {
    return (await this.#ensure(projectId))?.base;
  }

  /** One file as the project holds it now, and the seq that is. Undefined for no such project. */
  async current(
    projectId: string,
    path: string,
  ): Promise<{ seq: number; revision: string | null; content: ReturnType<ProjectAuthority["contentOf"]> } | undefined> {
    const loaded = await this.#ensure(projectId);
    if (loaded === undefined) return undefined;
    loaded.lastTouch = this.#now();
    // A file held only as a note is as the last saved version has it: that revision is where to read it.
    return { seq: loaded.authority.seq, revision: loaded.base.revision, content: loaded.authority.contentOf(path) };
  }

  /** How every project held in memory stands, for an operator. */
  status(): Array<{
    projectId: string;
    seq: number;
    snapshotSeq: number;
    lastSnapshotAt: number;
    lastEditAt: number;
    owedFiles: number;
    unreadable: number;
    documents: number;
  }> {
    return [...this.#loaded.entries()].map(([projectId, loaded]) => ({
      projectId,
      seq: loaded.authority.seq,
      snapshotSeq: loaded.snapshotSeq,
      lastSnapshotAt: loaded.lastSnapshot,
      lastEditAt: loaded.lastEdit,
      owedFiles: loaded.owedBytes.size,
      unreadable: loaded.unreadable.length,
      documents: loaded.authority.paths().length,
    }));
  }

  /**
   * Every file the project holds now that the authority keeps, with its size: documents and whole
   * files, and the ones held only as a note of their digest. Undefined for no such project.
   */
  async currentFiles(projectId: string): Promise<{ seq: number; revision: string | null; files: Array<{ path: string; size: number; note: boolean }> } | undefined> {
    const loaded = await this.#ensure(projectId);
    if (loaded === undefined) return undefined;
    loaded.lastTouch = this.#now();
    const files: Array<{ path: string; size: number; note: boolean }> = [];
    for (const path of loaded.authority.paths()) {
      const content = loaded.authority.contentOf(path);
      if (content === undefined) continue;
      files.push("bytes" in content ? { path, size: content.bytes.length, note: false } : { path, size: content.note.size, note: true });
    }
    return { seq: loaded.authority.seq, revision: loaded.base.revision, files };
  }

  /** Documents the authority could not read when it loaded the project. */
  unreadable(projectId: string): LoadedProject["unreadable"] {
    return this.#loaded.get(projectId)?.unreadable ?? [];
  }

  effects(
    projectId: string,
    after: number,
    page: { readonly limit: number; readonly limitBytes: number },
  ): { effects: DocEffect[]; more: boolean } {
    const read = effectsAfter(this.#options.database, projectId, after, page);
    return { effects: read.effects.map(toDocEffect), more: read.more };
  }

  async load(projectId: string): Promise<boolean> {
    return (await this.#ensure(projectId)) !== undefined;
  }

  async intent(projectId: string, intent: DocIntent): Promise<DocAnswer> {
    // A resend of something already applied - perhaps before a restart - gets the first effect.
    const earlier = this.#options.database
      .prepare("SELECT seq FROM doc_effects WHERE project_id = ? AND client_id = ?")
      .get(projectId, intent.clientId) as { seq: number } | undefined;
    if (earlier !== undefined) {
      const found = effectsAfter(this.#options.database, projectId, earlier.seq - 1, { limit: 1 }).effects[0];
      if (found !== undefined) {
        return { kind: "effect", effect: toDocEffect(found) };
      }
    }

    const loaded = await this.#ensure(projectId);
    if (loaded === undefined) {
      return { kind: "refusal", clientId: intent.clientId, reason: "rejected", detail: "no such project" };
    }
    if (intent.basedOn !== undefined && intent.basedOn < prunedThrough(this.#options.database, projectId)) {
      // Written against a state the log no longer reaches back to: nothing can say what it collides
      // with, so it is handed back to its author rather than allowed to land over anybody.
      return {
        kind: "refusal",
        clientId: intent.clientId,
        reason: "conflict",
        detail: "this edit was made against a version too old to check",
        conflicts: ["*"],
      };
    }
    loaded.lastTouch = this.#now();
    loaded.calling = { accountId: intent.accountId };
    let answer;
    try {
      answer = loaded.authority.submit({
        clientId: intent.clientId,
        by: intent.by,
        document: intent.document,
        op: intent.op,
        ...(intent.derived === undefined ? {} : { derived: intent.derived }),
        ...(intent.basedOn === undefined ? {} : { basedOn: intent.basedOn }),
      });
    } finally {
      delete loaded.calling;
    }
    if (answer.kind === "refusal") {
      return {
        kind: "refusal",
        clientId: answer.clientId,
        reason: answer.reason,
        ...(answer.detail === undefined ? {} : { detail: answer.detail }),
        ...(answer.conflicts === undefined ? {} : { conflicts: answer.conflicts }),
      };
    }
    loaded.lastEdit = this.#now();
    for (const owed of owedBy(intent.document, intent.op)) {
      loaded.owedBytes.set(owed.transferId, owed);
      // Perhaps already here: a file is sent before the edit that names it.
      void this.bytesArrived(projectId, owed.transferId);
    }
    const effect: DocEffect = {
      seq: answer.seq,
      clientId: answer.clientId,
      accountId: intent.accountId,
      by: answer.by,
      document: answer.document,
      op: answer.op,
      ...(answer.derived === undefined ? {} : { derived: answer.derived }),
      at: answer.at,
    };
    this.#options.publish(projectId, { kind: "doc-effect", effect });
    return { kind: "effect", effect };
  }

  /**
   * A transfer has finished arriving. When a loaded project owes it to its next version, keep it
   * somewhere that survives a restart. Safe to call for any transfer, and more than once.
   */
  async bytesArrived(projectId: string, transferId: string): Promise<void> {
    const keeper = this.#options.keepBytes;
    const owed = this.#loaded.get(projectId)?.owedBytes.get(transferId);
    if (keeper === undefined || this.#options.collectBytes === undefined || owed === undefined || owed.kept) {
      return;
    }
    try {
      const bytes = await this.#options.collectBytes(projectId, transferId);
      if (bytes !== undefined) {
        await keeper.save(projectId, transferId, bytes);
        owed.kept = true;
      }
    } catch (error) {
      this.#options.log?.(`authority: ${projectId} could not keep transfer ${transferId}: ${String(error)}`);
    }
  }

  /** The bytes of an owed transfer: kept, or still in the blob store, or not here yet. */
  async #owedBytes(projectId: string, owed: OwedTransfer): Promise<Buffer | undefined> {
    const kept = await this.#options.keepBytes?.load(projectId, owed.transferId).catch(() => undefined);
    if (kept !== undefined) {
      owed.kept = true;
      return kept;
    }
    return this.#options.collectBytes?.(projectId, owed.transferId);
  }

  /**
   * Save what the project holds now as a history version. `savedBy` is the account that asked, for
   * a version saved by hand; one the server saves on its own names nobody and is marked automatic.
   */
  async snapshot(projectId: string, label?: string, savedBy?: string): Promise<{ revision?: string; seq: number }> {
    const previous = this.#snapshotting.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#snapshotOnce(projectId, label, savedBy));
    this.#snapshotting.set(projectId, run);
    try {
      return await run;
    } finally {
      if (this.#snapshotting.get(projectId) === run) {
        this.#snapshotting.delete(projectId);
      }
    }
  }

  async #snapshotOnce(projectId: string, label?: string, savedBy?: string): Promise<{ revision?: string; seq: number }> {
    const loaded = await this.#ensure(projectId);
    if (loaded === undefined) {
      throw new Error("no such project");
    }
    const seq = loaded.authority.seq;
    const trimmed = label?.trim();
    const message = trimmed === undefined || trimmed === ""
      ? `Team snapshot at seq ${seq}`
      : `${trimmed}\n\nTeam snapshot at seq ${seq}`;
    const files = loaded.authority.serialize();

    // Files that have arrived go in with their records; one still on its way waits for the next
    // snapshot, which is what keeps a version from naming a file it does not hold for long.
    const blobs: SnapshotBlob[] = [];
    const written: Array<{ owed: OwedTransfer; bytes: Buffer }> = [];
    for (const owed of loaded.owedBytes.values()) {
      const bytes = await this.#owedBytes(projectId, owed);
      if (bytes !== undefined) {
        blobs.push({ path: owed.path, bytes, ...(owed.replace ? { replace: true } : {}) });
        written.push({ owed, bytes });
      }
    }

    const notes = loaded.authority.notes();
    const committed = await this.#options.commit(projectId, files, message, blobs, new Set(notes.keys()));
    for (const { owed, bytes } of written) {
      loaded.owedBytes.delete(owed.transferId);
      loaded.authority.settle(owed.path, owed.transferId, bytes);
      await this.#options.keepBytes?.drop(projectId, owed.transferId).catch(() => undefined);
    }
    const now = this.#now();
    if (committed.revision !== undefined) {
      recordVersion(this.#options.database, {
        projectId,
        revision: committed.revision,
        seq,
        fromSeq: loaded.snapshotSeq,
        ...(trimmed === undefined || trimmed === "" ? {} : { label: trimmed }),
        ...(savedBy === undefined ? {} : { savedBy }),
        auto: savedBy === undefined,
        at: now,
      });
    }
    const revision = committed.revision ?? snapshotMark(this.#options.database, projectId)?.revision ?? null;
    markSnapshot(this.#options.database, projectId, { seq, revision, at: now });
    loaded.base = { seq, revision, files: loaded.authority.serialize(), notes: loaded.authority.notes() };
    loaded.snapshotSeq = seq;
    loaded.lastSnapshot = now;
    if (committed.revision !== undefined) {
      this.#options.publish(projectId, {
        kind: "doc-snapshot",
        seq,
        revision: committed.revision,
        ...(trimmed === undefined || trimmed === "" ? {} : { label: trimmed }),
      });
      this.#options.log?.(`authority: ${projectId} saved a version at seq ${seq} (${committed.revision.slice(0, 12)})`);
    }
    return { ...(committed.revision === undefined ? {} : { revision: committed.revision }), seq };
  }

  async restore(projectId: string, revision: string, who: { accountId: string; by: string }): Promise<{ seq: number; revision: string }> {
    const documents = await this.#options.openAt(projectId, revision);
    if (documents === undefined) {
      throw new Error("that revision could not be read");
    }
    const loaded = await this.#ensure(projectId);
    if (loaded === undefined) {
      throw new Error("no such project");
    }
    const seq = loaded.authority.seq + 1;
    appendEffect(this.#options.database, projectId, {
      seq,
      clientId: `restore:${projectId}:${seq}`,
      accountId: who.accountId,
      by: who.by,
      document: { doc: "project" },
      op: { op: RESTORE_OP, revision },
      at: this.#now(),
    });
    loaded.authority = this.#authorityFrom(projectId, loaded, documents.files, seq);
    loaded.authority.raiseFloor(seq);
    loaded.unreadable = documents.unreadable;
    loaded.lastEdit = this.#now();
    const saved = await this.snapshot(projectId, `Restored ${revision.slice(0, 12)}`, who.accountId);
    const head = saved.revision ?? snapshotMark(this.#options.database, projectId)?.revision ?? revision;
    this.#options.publish(projectId, { kind: "doc-reset", seq, revision: head, by: who.by });
    return { seq, revision: head };
  }

  async tick(): Promise<void> {
    const now = this.#now();
    const idle = this.#options.idleSnapshotMs ?? 60_000;
    const max = this.#options.maxSnapshotMs ?? 10 * 60_000;
    const unload = this.#options.unloadMs ?? 30 * 60_000;
    for (const [projectId, loaded] of [...this.#loaded.entries()]) {
      for (const owed of loaded.owedBytes.values()) {
        if (!owed.kept) await this.bytesArrived(projectId, owed.transferId);
      }
      const unsaved = loaded.authority.seq > loaded.snapshotSeq || loaded.owedBytes.size > 0;
      if (unsaved && (now - loaded.lastEdit >= idle || now - loaded.lastSnapshot >= max)) {
        await this.snapshot(projectId).catch((error: unknown) => {
          this.#options.log?.(`authority: ${projectId} could not save a version: ${String(error)}`);
        });
        continue;
      }
      pruneEffects(this.#options.database, projectId, loaded.snapshotSeq, now - this.#retainMs());
      if (!unsaved && now - loaded.lastTouch >= unload && !this.#snapshotting.has(projectId)) {
        this.#loaded.delete(projectId);
      }
    }
  }

  async #ensure(projectId: string): Promise<Loaded | undefined> {
    const loaded = this.#loaded.get(projectId);
    if (loaded !== undefined) return loaded;
    const pending = this.#loading.get(projectId);
    if (pending !== undefined) return pending;
    const loading = this.#load(projectId);
    this.#loading.set(projectId, loading);
    try {
      return await loading;
    } finally {
      this.#loading.delete(projectId);
    }
  }

  async #load(projectId: string): Promise<Loaded | undefined> {
    const database = this.#options.database;
    const mark = snapshotMark(database, projectId);
    const all = effectsAfter(database, projectId, 0).effects;
    const restoreAt = [...all].reverse().find((effect) => isRestore(effect.op) && effect.seq > (mark?.seq ?? 0));
    const documents = restoreAt === undefined
      ? await this.#options.open(projectId)
      : await this.#options.openAt(projectId, (restoreAt.op as { revision: string }).revision);
    if (documents === undefined) {
      return undefined;
    }
    const now = this.#now();
    const entry: Loaded = {
      authority: undefined as unknown as ProjectAuthority,
      base: { seq: 0, revision: null, files: new Map(), notes: new Map() },
      snapshotSeq: mark?.seq ?? 0,
      lastEdit: now,
      lastSnapshot: mark?.at ?? now,
      lastTouch: now,
      unreadable: documents.unreadable,
      owedBytes: new Map(),
    };
    entry.authority = this.#authorityFrom(projectId, entry, documents.files, 0);
    const replayFrom = Math.max(mark?.seq ?? 0, restoreAt?.seq ?? 0);
    entry.base = {
      seq: replayFrom,
      revision: documents.revision ?? mark?.revision ?? null,
      files: entry.authority.serialize(),
      notes: entry.authority.notes(),
    };
    if (mark === undefined && documents.revision !== undefined) {
      markSnapshot(database, projectId, { seq: 0, revision: documents.revision, at: now });
    }
    let skipped = 0;
    for (const effect of all) {
      const document = effect.document as KernelDocument;
      const op = effect.op as KernelOp;
      if (isRestore(op)) {
        entry.authority.noteWritten({ doc: "project" }, { op: RESTORE_OP }, effect.seq);
        entry.authority.raiseFloor(effect.seq);
        continue;
      }
      if (effect.seq <= replayFrom) {
        entry.authority.noteWritten(document, op, effect.seq, effect.touched ?? []);
        continue;
      }
      const applied = entry.authority.replay({
        seq: effect.seq,
        clientId: effect.clientId,
        by: effect.by,
        document,
        op,
        ...(effect.derived === undefined ? {} : { derived: effect.derived }),
        at: new Date(effect.at).toISOString(),
      });
      if (!applied) skipped += 1;
      // Files an unsnapshotted operation named are still owed to the next version.
      for (const owed of owedBy(document, op)) {
        entry.owedBytes.set(owed.transferId, owed);
      }
    }
    if (skipped > 0) {
      this.#options.log?.(`authority: ${projectId} reopened with ${skipped} logged edits that no longer applied`);
    }
    this.#loaded.set(projectId, entry);
    return entry;
  }

  #authorityFrom(projectId: string, entry: Loaded, files: ReadonlyMap<string, unknown>, seq: number): ProjectAuthority {
    return new ProjectAuthority({
      files,
      seq,
      clock: () => new Date(this.#now()).toISOString(),
      persist: (effect: ProjectEffect) => {
        appendEffect(this.#options.database, projectId, {
          seq: effect.seq,
          clientId: effect.clientId,
          accountId: entry.calling?.accountId ?? null,
          by: effect.by,
          document: effect.document,
          op: effect.op,
          ...(effect.derived === undefined ? {} : { derived: effect.derived }),
          touched: effect.touched,
          at: Date.parse(effect.at),
        });
      },
    });
  }
}

function isRestore(op: unknown): boolean {
  return typeof op === "object" && op !== null && (op as { op?: unknown }).op === RESTORE_OP;
}

function toDocEffect(stored: StoredEffect): DocEffect {
  return {
    seq: stored.seq,
    clientId: stored.clientId,
    accountId: stored.accountId,
    by: stored.by,
    document: stored.document,
    op: stored.op,
    ...(stored.derived === undefined ? {} : { derived: stored.derived }),
    at: new Date(stored.at).toISOString(),
  };
}
