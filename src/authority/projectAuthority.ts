/**
 * The server as the authority over a team project's documents - all of them.
 *
 * This is the piece that makes Team the place a team project's current state lives, the way a
 * shared document service is. Every Studio sends an intent; this applies it, gives it the next
 * sequence number, and answers with the effect everybody then applies - or with a refusal. Nothing
 * reaches a Studio that the authority has not already done, and the authority depends on no
 * author's machine being there.
 *
 * **It applies with Studio's own code.** The project is a set of files - each held as the JSON it is
 * stored as, addressed by its project-relative path - and every operation goes through Studio's
 * kernel (`applyProjectOp`, bundled into studio-kernel/ by scripts/vendor-studio.mjs), which knows
 * which documents an operation reaches: deleting a character rewrites the rows that spoke it, a
 * paste carries the translations it derived. The server never models any of it.
 *
 * **Offline edits.** An intent may say which sequence number its author last saw (`basedOn`). Every
 * record an operation writes - its claim keys, from the kernel - remembers the sequence number that
 * last wrote it, and an intent based on an older state than a record it touches is refused as a
 * conflict rather than allowed to overwrite somebody's newer edit. Live intents carry no `basedOn`.
 *
 * **Durable first.** With a `persist` hook, an effect is handed to it after it applied cleanly and
 * before the authority's state moves; a throw there leaves the authority exactly as it was.
 */
import {
  applyProjectOp,
  fileClaimKey,
  isHeldFile,
  KERNEL_VERSION,
  projectOpClaimKeys,
  serializeProjectFile,
  type KernelDocument,
  type KernelOp,
  type KernelProjectView,
} from "../../studio-kernel/vendor/kernel.js";
import { heldFileOf } from "./projectFiles.js";

/** Something an author asked for. */
export interface ProjectIntent {
  /** Minted by the sender; the idempotency key. A resend gets the first answer again. */
  readonly clientId: string;
  /** Who is asking, as the session shows them. */
  readonly by: string;
  readonly document: KernelDocument;
  readonly op: KernelOp;
  /** Translations and takes a paste derived, which land with it. */
  readonly derived?: unknown;
  /** The sequence number of the state this was written against, for an edit made offline. */
  readonly basedOn?: number;
}

/** What the authority did. Every Studio applies it, the asker included. */
export interface ProjectEffect {
  readonly kind: "effect";
  readonly seq: number;
  readonly clientId: string;
  readonly by: string;
  readonly document: KernelDocument;
  /** The operation as applied, which every Studio applies in `seq` order. */
  readonly op: KernelOp;
  readonly derived?: unknown;
  /** Every file the operation wrote. */
  readonly touched: readonly string[];
  /** When it was applied, as the authority's clock read it. */
  readonly at: string;
}

export type ProjectRefusalReason =
  /** The operation does not apply to the project as it stands, or names a verb this kernel lacks. */
  | "rejected"
  /** It named records that are gone, and nothing was written. */
  | "nothing-there"
  /** An offline edit to records somebody changed after `basedOn`. */
  | "conflict";

export interface ProjectRefusal {
  readonly kind: "refusal";
  readonly clientId: string;
  readonly reason: ProjectRefusalReason;
  readonly detail?: string;
  /** For a conflict: the records that changed after `basedOn`. */
  readonly conflicts?: readonly string[];
}

export type ProjectAnswer = ProjectEffect | ProjectRefusal;

/** An effect read back from the log, to apply again on reopening. */
export interface RecordedProjectEffect {
  /** The files it wrote, when the log kept them. */
  readonly touched?: readonly string[];
  readonly seq: number;
  readonly clientId: string;
  readonly by: string;
  readonly document: KernelDocument;
  readonly op: KernelOp;
  readonly derived?: unknown;
  readonly at: string;
}

export interface ProjectAuthorityInput {
  /** The project's documents, by project-relative path, as the authority starts from them. */
  readonly files: ReadonlyMap<string, unknown>;
  /** The sequence number those documents stand at. */
  readonly seq?: number;
  readonly clock?: () => string;
  readonly persist?: (effect: ProjectEffect) => void;
  /**
   * Everything before this seq was replaced at once - a restore. A whole file sent from before it
   * collides with it, whatever wrote the file since.
   */
  readonly floor?: number;
}

/** A file held only as a note: too large to hold, or with its bytes still on their way. */
export interface HeldFileNote {
  readonly digest: string;
  readonly size: number;
  /** Set while the bytes are on their way, as the transfer bringing them. */
  readonly transferId?: string;
}

/** How many effects are kept in memory for {@link ProjectAuthority.since}. */
const MEMORY_LOG_LIMIT = 5000;

export class ProjectAuthority {
  /** Which kernel the documents here are applied with. A Studio on another one is refused. */
  static readonly kernelVersion = KERNEL_VERSION;

  #files: Map<string, unknown>;
  readonly #log: ProjectEffect[] = [];
  readonly #answered = new Map<string, ProjectAnswer>();
  readonly #written = new Map<string, number>();
  readonly #clock: () => string;
  readonly #persist: ((effect: ProjectEffect) => void) | undefined;
  #seq: number;
  #floor: number;

  constructor(input: ProjectAuthorityInput) {
    this.#files = new Map([...input.files].map(([path, value]) => [path, structuredClone(value)]));
    this.#seq = input.seq ?? 0;
    this.#floor = input.floor ?? 0;
    this.#clock = input.clock ?? (() => new Date().toISOString());
    this.#persist = input.persist;
  }

  get seq(): number {
    return this.#seq;
  }

  /** The paths of every document held. */
  paths(): readonly string[] {
    return [...this.#files.keys()];
  }

  /** A copy of one document, or undefined. */
  file(path: string): unknown {
    const value = this.#files.get(path);
    return value === undefined ? undefined : structuredClone(value);
  }

  /**
   * Every file as it is written to disk - documents as the editor writes them, whole files as their
   * text or bytes - which is what a snapshot commits. A file held only as a note is not here: see
   * {@link notes}.
   */
  serialize(): Map<string, string | Buffer> {
    const out = new Map<string, string | Buffer>();
    for (const [path, value] of this.#files) {
      if (!isHeldFile(value)) {
        out.set(path, serializeProjectFile(path, value));
      } else if ("encoding" in value) {
        out.set(path, value.encoding === "utf8" ? value.data : Buffer.from(value.data, "base64"));
      }
    }
    return out;
  }

  /** One file as it is written to disk, or a note for one held only as a note, or undefined. */
  contentOf(path: string): { bytes: Buffer } | { note: HeldFileNote } | undefined {
    const value = this.#files.get(path);
    if (value === undefined) return undefined;
    if (!isHeldFile(value)) return { bytes: Buffer.from(serializeProjectFile(path, value), "utf8") };
    if ("encoding" in value) return { bytes: Buffer.from(value.data, value.encoding) };
    return { note: this.notes().get(path)! };
  }

  /** The files held only as a note of their digest, by path. */
  notes(): Map<string, HeldFileNote> {
    const out = new Map<string, HeldFileNote>();
    for (const [path, value] of this.#files) {
      if (!isHeldFile(value)) continue;
      if ("stored" in value) out.set(path, { ...value.stored });
      else if ("blob" in value) out.set(path, { digest: value.blob.digest, size: value.blob.size, transferId: value.blob.transferId });
    }
    return out;
  }

  /**
   * The bytes a whole file's transfer named have been written into a saved version: hold them (or,
   * when large, a note that the version has them) instead of the transfer. Not an edit - the file's
   * content is what it already was - so nothing is logged and the seq does not move.
   */
  settle(path: string, transferId: string, bytes: Buffer): void {
    const value = this.#files.get(path);
    if (isHeldFile(value) && "blob" in value && value.blob.transferId === transferId) {
      this.#files.set(path, heldFileOf(bytes));
    }
  }

  /** The sequence number that last wrote one record, or zero. */
  lastWrite(key: string): number {
    const written = this.#written.get(key) ?? 0;
    return key.startsWith("file:") ? Math.max(written, this.#floor) : written;
  }

  /** Everything applied after `seq` that memory still holds, or undefined when it reaches further back. */
  since(seq: number): readonly ProjectEffect[] | undefined {
    const oldest = this.#log[0];
    if (oldest !== undefined && oldest.seq > seq + 1) {
      return undefined;
    }
    return this.#log.filter((effect) => effect.seq > seq);
  }

  /** Apply one intent, or refuse it. All or nothing. */
  submit(intent: ProjectIntent): ProjectAnswer {
    const earlier = this.#answered.get(intent.clientId);
    if (earlier !== undefined) {
      return earlier;
    }
    const answer = this.#decide(intent);
    this.#answered.set(intent.clientId, answer);
    return answer;
  }

  /**
   * Apply an effect read back from the log, without asking anything of it. One that no longer
   * applies is skipped and answered false; the seq moves either way.
   */
  replay(effect: RecordedProjectEffect): boolean {
    this.#seq = Math.max(this.#seq, effect.seq);
    this.#note(effect.document, effect.op, effect.seq, effect.touched);
    const work = this.#working();
    try {
      applyProjectOp(work.view, effect.document, structuredClone(effect.op), { now: effect.at },
        effect.derived === undefined ? undefined : structuredClone(effect.derived));
    } catch {
      return false;
    }
    work.commit();
    this.#note(effect.document, effect.op, effect.seq, [...work.touched]);
    this.#remember({ kind: "effect", ...effect, touched: [...work.touched] });
    return true;
  }

  /** Remember which records (and files) an effect already in the snapshot wrote, without applying it. */
  noteWritten(document: KernelDocument, op: KernelOp, seq: number, touched: readonly string[] = []): void {
    this.#seq = Math.max(this.#seq, seq);
    this.#note(document, op, seq, touched);
  }

  /** Everything up to `seq` was replaced at once (a restore): see {@link ProjectAuthorityInput.floor}. */
  raiseFloor(seq: number): void {
    this.#floor = Math.max(this.#floor, seq);
  }

  #note(document: KernelDocument, op: KernelOp, seq: number, touched: readonly string[] = []): void {
    for (const key of [...claimKeys(document, op), ...touched.map(fileClaimKey)]) {
      this.#written.set(key, seq);
    }
  }

  /**
   * A copy-on-write view: documents an operation reads are copied the first time it touches them,
   * so a throw halfway leaves the real ones untouched and a success swaps in only what changed.
   * The cost is the documents an operation reaches, never the whole project.
   */
  #working(): { view: KernelProjectView; touched: Set<string>; commit(): void } {
    const copies = new Map<string, unknown>();
    const deleted = new Set<string>();
    const touched = new Set<string>();
    const files = this.#files;
    const view: KernelProjectView = {
      get: (path) => {
        if (deleted.has(path)) return undefined;
        if (copies.has(path)) return copies.get(path);
        const value = files.get(path);
        if (value === undefined) return undefined;
        const copy = structuredClone(value);
        copies.set(path, copy);
        return copy;
      },
      set: (path, value) => {
        deleted.delete(path);
        copies.set(path, value);
        touched.add(path);
      },
      delete: (path) => {
        copies.delete(path);
        deleted.add(path);
        touched.add(path);
      },
    };
    return {
      view,
      touched,
      commit: () => {
        for (const [path, value] of copies) files.set(path, value);
        for (const path of deleted) files.delete(path);
      },
    };
  }

  #remember(effect: ProjectEffect): void {
    this.#log.push(effect);
    if (this.#log.length > MEMORY_LOG_LIMIT) {
      this.#log.splice(0, this.#log.length - MEMORY_LOG_LIMIT);
    }
  }

  #decide(intent: ProjectIntent): ProjectAnswer {
    const refuse = (reason: ProjectRefusalReason, extra: Partial<ProjectRefusal> = {}): ProjectRefusal => ({
      kind: "refusal",
      clientId: intent.clientId,
      reason,
      ...extra,
    });

    const keys = claimKeys(intent.document, intent.op);
    if (intent.basedOn !== undefined) {
      const basedOn = intent.basedOn;
      const conflicts = keys.filter((key) => this.lastWrite(key) > basedOn);
      if (conflicts.length > 0) {
        return refuse("conflict", { conflicts });
      }
    }

    const at = this.#clock();
    const work = this.#working();
    let applied: { changed: boolean; touched: string[] };
    try {
      applied = applyProjectOp(work.view, intent.document, structuredClone(intent.op), { now: at },
        intent.derived === undefined ? undefined : structuredClone(intent.derived));
    } catch (error) {
      return refuse("rejected", { detail: error instanceof Error ? error.message : String(error) });
    }
    if (!applied.changed) {
      return refuse("nothing-there");
    }

    const effect: ProjectEffect = {
      kind: "effect",
      seq: this.#seq + 1,
      clientId: intent.clientId,
      by: intent.by,
      document: intent.document,
      op: structuredClone(intent.op),
      ...(intent.derived === undefined ? {} : { derived: structuredClone(intent.derived) }),
      touched: applied.touched,
      at,
    };
    this.#persist?.(effect);
    work.commit();
    this.#seq = effect.seq;
    for (const key of [...keys, ...applied.touched.map(fileClaimKey)]) {
      this.#written.set(key, this.#seq);
    }
    this.#remember(effect);
    return effect;
  }
}

function claimKeys(document: KernelDocument, op: KernelOp): readonly string[] {
  try {
    return projectOpClaimKeys(document, op);
  } catch {
    return [];
  }
}
