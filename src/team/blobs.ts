/**
 * The bytes a live session carries, while they are on their way.
 *
 * A live session is people editing one project at the same time, and most of what they say to each
 * other is small enough to state: a line of prose, a character record, an entry in a translation
 * library. An asset is a file, and a file is not a statement. So a machine that has one and a
 * machine that wants it need somewhere to put it down, and this is that place.
 *
 * ## Why this server holds them at all
 *
 * It did not, once. Files were cut into sixteen-kilobyte pieces and pushed through the room's
 * message topic, which made this server a relay and nothing more. That bought three properties
 * worth naming, because everything below is written to keep them:
 *
 *  1. **Nothing accumulates**, so nothing has to be swept.
 *  2. **A cancelled transfer leaves nothing behind**, because there was nowhere for it to be left.
 *  3. **Being in the room is the whole of the authorisation**, because the room was the channel.
 *
 * What it cost was the thing itself. A message channel's throughput is messages rather than bytes,
 * base64 puts a third more on the wire than there is on disk, and both machines had to hold the
 * whole file in memory - so the largest file a session could carry was a limit about memory
 * wearing the clothes of a limit about files, and it stopped at thirty-two megabytes, which is
 * under the size of a single piece of video in an ordinary visual novel.
 *
 * So the bytes land here, and the three properties are kept by construction rather than by
 * accident:
 *
 *  1. **Nothing outlives the run.** {@link TeamBlobStore.open} empties the whole directory before
 *     it serves anything. Rooms are held in memory and end when this process does (see
 *     src/team/presence.ts), so a file on disk at startup belongs to a room that no longer exists -
 *     there is no question of ownership to get wrong. What outlives a *room* but not the run is
 *     deliberate and is the whole of resumability: a transfer interrupted by a reconnect, by a
 *     session ending, or by Studio being restarted goes on from the byte it reached.
 *  2. **A cancel deletes the object**, and a cancel already exists - deleting the arriving asset is
 *     how a person cancels an import, and every machine in the room applies it. Anything that
 *     escapes that (the machine that would have deleted it crashed) is taken by
 *     {@link TeamBlobStore.sweep}, which is a policy an operator can read: bytes nobody has touched
 *     for a day are bytes nobody is coming back for.
 *  3. **Authorisation is unchanged in substance.** A request must carry a bearer token *and* name a
 *     client instance that this server currently knows to be on that project - which is to say, a
 *     window of that account, connected right now, with that project open. That is strictly more
 *     than "signed in", it is what the room's own membership is made of, and it survives the room
 *     ending, which is what makes resuming across a session boundary expressible at all.
 *
 * ## What bounds this
 *
 * A per-project reservation, and nothing per file. That inversion is the point: the old limit had
 * to be small because it was really a limit on two machines' heap, and the new one can be generous
 * because it is a limit on this server's disk. An author dropping a two-hundred-megabyte video into
 * a session is an ordinary thing to do and is now an ordinary thing to happen; an author dropping
 * four gigabytes of them into one project at once is told so, by name, before the operation that
 * names them is ever stated.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

/** Where the objects go, under the storage root. */
const DIRECTORY = "live-blobs";

/**
 * The most one project may have reserved at once.
 *
 * **A bound on this server's disk, which is what makes it statable.** The figure it replaces was a
 * bound on two machines' memory, so it had to be small enough for the smallest machine in the room
 * and could not be raised without making transfers fail rather than making them slower. This one
 * costs a directory an operator can look at, and four gigabytes is several videos and every other
 * kind of asset a project has, at once, waiting to be collected.
 *
 * ⚠ It counts what has been **reserved**, not what has arrived. A reservation is made before the
 * operation naming a file is stated, which is the only moment a refusal can still be a refusal
 * rather than a half-finished import - see {@link TeamBlobStore.reserve}.
 */
export const BLOB_PROJECT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * How long an object nobody touches is kept.
 *
 * The backstop rather than the mechanism: objects are normally deleted the moment a transfer is
 * cancelled or every machine has collected it, and this is for the ones where the machine that
 * would have said so is not there any more. Long enough that an author who closes a laptop over
 * lunch resumes rather than restarts, short enough to be a sentence an operator can be told.
 */
export const BLOB_KEEP_MS = 24 * 60 * 60 * 1000;

/** How often the backstop runs. */
export const BLOB_SWEEP_MS = 60 * 60 * 1000;

/**
 * How long a reader waits for a byte that never comes.
 *
 * A reader that has caught up with a writer is held rather than answered, so that a file arrives on
 * the far machine as it arrives here rather than a poll at a time. That is only safe with an end to
 * it: the writer may be a Studio that has been closed, and a held response is a socket. When this
 * elapses the reader is answered with what there is and told the object is short, which is exactly
 * what it is told after a lost connection - so there is one resumption path rather than two.
 */
export const BLOB_STALL_MS = 30 * 1000;

/** What a caller is told about an object. */
export interface BlobDescription {
  /** How long the whole file is, as the machine that reserved it said. */
  readonly length: number;
  /** What the whole file must hash to. Carried for the receiver, never checked here. */
  readonly digest: string;
  /** How many bytes have arrived. */
  readonly received: number;
  /** Whether every byte has. */
  readonly complete: boolean;
}

/** Why a reservation was not made. */
export type BlobRefusal =
  /** This project has reserved as much as it may. */
  | { readonly kind: "quota"; readonly reserved: number; readonly limit: number }
  /** Something is already here under that name, and it is not the same thing. */
  | { readonly kind: "taken" };

/** What one object is, while this process is running. */
interface BlobEntry {
  readonly project: string;
  readonly transfer: string;
  readonly length: number;
  readonly digest: string;
  readonly path: string;
  received: number;
  touchedAt: number;
  /** Set while a request is appending, so two writers cannot interleave into one file. */
  writing: boolean;
  /** Readers parked at the end of the file, woken by an append or by the object going. */
  waiting: (() => void)[];
  /** True once the object has been dropped, so a parked reader stops rather than waits out its stall. */
  gone: boolean;
}

/** An append that was not taken, and what the writer should do about it. */
export type BlobAppendOutcome =
  | { readonly ok: true; readonly received: number }
  /** The writer is not where it thinks it is. `received` is where it actually is. */
  | { readonly ok: false; readonly kind: "offset"; readonly received: number }
  /** More bytes than were reserved. The writer is sending a different file. */
  | { readonly ok: false; readonly kind: "over" }
  /** Somebody else is appending to this object right now. */
  | { readonly ok: false; readonly kind: "busy" }
  /** No such object; it was dropped, or this server has been restarted. */
  | { readonly ok: false; readonly kind: "gone" };

/**
 * The objects, and the directory under them.
 *
 * Opened rather than constructed, because opening empties the directory and that is not something a
 * constructor should do quietly.
 */
export class TeamBlobStore {
  private readonly entries = new Map<string, BlobEntry>();
  private timer: NodeJS.Timeout | undefined;

  private constructor(private readonly directory: string) {}

  /**
   * Take the directory over, discarding whatever a previous run left in it.
   *
   * ⚠ **The emptying is the design, not tidiness.** What an object belongs to is a room, and rooms
   * are in memory - so every object on disk at this moment belongs to a room that ended when the
   * process holding it did. Keeping them would mean inventing an owner for them.
   */
  public static async open(root: string): Promise<TeamBlobStore> {
    const directory = join(resolve(root), DIRECTORY);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const store = new TeamBlobStore(directory);
    store.timer = setInterval(() => {
      void store.sweep();
    }, BLOB_SWEEP_MS);
    // Never a reason to keep this process alive on its own.
    store.timer.unref();
    return store;
  }

  /** Stop sweeping. What shutting down does; the directory is emptied by the next `open`. */
  public close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const entry of this.entries.values()) {
      entry.gone = true;
      this.wake(entry);
    }
    this.entries.clear();
  }

  /**
   * Put an object's name and length down before any of it is sent.
   *
   * **Separate from the first append on purpose.** This is the only moment at which "there is no
   * room for this file" can be a refusal rather than a half-finished import: the machine holding
   * the file asks here, and only states the operation that names the file once it has an answer. A
   * store that counted bytes as they landed would have every other machine already holding a record
   * for a file that is never going to arrive.
   *
   * Asking twice for the same object with the same length and digest is the same reservation - a
   * client that lost its connection between reserving and sending must be able to say it again
   * without being told the name is taken.
   */
  public async reserve(input: {
    project: string;
    transfer: string;
    length: number;
    digest: string;
  }): Promise<{ ok: true; description: BlobDescription } | { ok: false; refusal: BlobRefusal }> {
    const key = keyOf(input.project, input.transfer);
    const already = this.entries.get(key);
    if (already !== undefined) {
      if (already.length !== input.length || already.digest !== input.digest) {
        return { ok: false, refusal: { kind: "taken" } };
      }
      already.touchedAt = Date.now();
      return { ok: true, description: describe(already) };
    }

    const reserved = this.reservedFor(input.project);
    if (reserved + input.length > BLOB_PROJECT_BYTES) {
      return {
        ok: false,
        refusal: { kind: "quota", reserved, limit: BLOB_PROJECT_BYTES },
      };
    }

    const directory = join(this.directory, safeSegment(input.project));
    await mkdir(directory, { recursive: true });
    const path = join(directory, safeSegment(input.transfer));
    // Made now rather than on the first append, so that a reader may open an object that has been
    // reserved and nothing more, and be held at its end rather than told it does not exist.
    const handle = await open(path, "w");
    await handle.close();

    const entry: BlobEntry = {
      project: input.project,
      transfer: input.transfer,
      length: input.length,
      digest: input.digest,
      path,
      received: 0,
      touchedAt: Date.now(),
      writing: false,
      waiting: [],
      gone: false,
    };
    this.entries.set(key, entry);
    return { ok: true, description: describe(entry) };
  }

  /** What is known about an object, or undefined for one this run has never held. */
  public describe(project: string, transfer: string): BlobDescription | undefined {
    const entry = this.entries.get(keyOf(project, transfer));
    return entry === undefined ? undefined : describe(entry);
  }

  /**
   * Take bytes in at the end of an object.
   *
   * **Appends rather than writes at an offset**, and refuses one that does not start where the file
   * ends. A writer that has reconnected asks what it has landed and goes on from there, so an
   * offset that disagrees is a writer that is confused rather than one that is early - and writing
   * into the middle of a file that has a hole in it would produce something that hashes to nothing.
   *
   * Backpressure is the stream's own: the source is paused whenever the disk is behind, which is
   * the whole of the flow control here and the reason there is no chunk count to tune.
   */
  public async append(input: {
    project: string;
    transfer: string;
    offset: number;
    source: Readable;
  }): Promise<BlobAppendOutcome> {
    const entry = this.entries.get(keyOf(input.project, input.transfer));
    if (entry === undefined || entry.gone) {
      return { ok: false, kind: "gone" };
    }
    if (entry.writing) {
      return { ok: false, kind: "busy" };
    }
    if (input.offset !== entry.received) {
      return { ok: false, kind: "offset", received: entry.received };
    }

    entry.writing = true;
    const handle = await open(entry.path, "r+");
    try {
      for await (const chunk of input.source) {
        const bytes = chunk as Buffer;
        if (entry.gone) {
          return { ok: false, kind: "gone" };
        }
        if (entry.received + bytes.length > entry.length) {
          // More than was reserved. Refused rather than kept: the reservation is what the quota
          // counted and what the receiver is waiting for, and a file longer than both is a
          // different file.
          return { ok: false, kind: "over" };
        }
        await handle.write(bytes, 0, bytes.length, entry.received);
        entry.received += bytes.length;
        entry.touchedAt = Date.now();
        // Woken per chunk rather than at the end: a reader that is parked here is a machine
        // watching this file arrive, and the whole reason it is parked is that it should see it
        // arriving rather than appearing.
        this.wake(entry);
      }
      return { ok: true, received: entry.received };
    } finally {
      await handle.close();
      entry.writing = false;
      entry.touchedAt = Date.now();
      this.wake(entry);
    }
  }

  /**
   * Read an object from an offset, going on as it is written.
   *
   * Yields what is already there, and then waits rather than ending - so a machine that starts
   * collecting a file while it is still being sent receives it as it lands. Ends when the object is
   * whole, when it is dropped, or when nothing has arrived for {@link BLOB_STALL_MS}; the caller
   * tells the difference from the object's own description, and the answer to all three is the
   * same - ask again from where you got to.
   */
  public async *read(project: string, transfer: string, from: number): AsyncGenerator<Buffer> {
    const entry = this.entries.get(keyOf(project, transfer));
    if (entry === undefined) {
      return;
    }
    let at = from;
    for (;;) {
      if (at < entry.received) {
        const until = entry.received;
        const stream = createReadStream(entry.path, { start: at, end: until - 1 });
        for await (const chunk of stream) {
          yield chunk as Buffer;
        }
        at = until;
        entry.touchedAt = Date.now();
        continue;
      }
      if (entry.gone || at >= entry.length) {
        return;
      }
      const woken = await this.park(entry);
      if (!woken) {
        return;
      }
    }
  }

  /**
   * Forget an object and delete its bytes.
   *
   * What cancelling an import reaches. Every machine in a room applies the deletion that cancels
   * one, so this arrives from whichever of them gets here first and the rest are answered the same
   * way - there is nothing to be right about twice.
   */
  public async drop(project: string, transfer: string): Promise<boolean> {
    const key = keyOf(project, transfer);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    entry.gone = true;
    this.entries.delete(key);
    this.wake(entry);
    await rm(entry.path, { force: true });
    return true;
  }

  /** Everything one project has reserved. What the quota is measured against. */
  public reservedFor(project: string): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.project === project) {
        total += entry.length;
      }
    }
    return total;
  }

  /** How many objects are held. For a test that pins the sweep, and for diagnostics. */
  public get count(): number {
    return this.entries.size;
  }

  /**
   * Drop everything nobody has touched for {@link BLOB_KEEP_MS}.
   *
   * The backstop for the machine that was going to say it did not want this any more and then went
   * away. Deliberately not a lease that has to be renewed: a transfer is touched by being written
   * to and by being read from, so a slow one on a bad link renews itself simply by making progress.
   */
  public async sweep(now = Date.now()): Promise<number> {
    let dropped = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.writing || now - entry.touchedAt < BLOB_KEEP_MS) {
        continue;
      }
      await this.drop(entry.project, entry.transfer);
      dropped += 1;
    }
    if (dropped > 0) {
      await this.prune();
    }
    return dropped;
  }

  /** Remove project directories with nothing in them. Cosmetic, and cheap because it is rare. */
  private async prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.directory, name);
      try {
        const entries = await readdir(path);
        if (entries.length === 0) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // A directory that vanished under the sweep needed no sweeping.
      }
    }
  }

  /** Wake every parked reader. Called on every append and whenever an object ends. */
  private wake(entry: BlobEntry): void {
    const parked = entry.waiting;
    entry.waiting = [];
    for (const resume of parked) {
      resume();
    }
  }

  /** Park until there is more, or until the stall elapses. False when it elapsed. */
  private park(entry: BlobEntry): Promise<boolean> {
    return new Promise<boolean>((settle) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        settle(false);
      }, BLOB_STALL_MS);
      timer.unref();
      entry.waiting.push(() => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        settle(true);
      });
    });
  }
}

/** Whether a name may be a directory entry. Ids are minted by clients, so this is not decoration. */
export function isBlobName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.startsWith(".");
}

/**
 * One path segment for a name a client chose.
 *
 * ⚠ Names reach here from another machine. Anything that is not plainly a name is replaced with one
 * that is, rather than refused here - the refusal belongs at the edge, where there is a status code
 * to say it with, and this is the guard that holds even if that one is ever moved.
 */
function safeSegment(value: string): string {
  return isBlobName(value) ? value : randomUUID();
}

function keyOf(project: string, transfer: string): string {
  return `${project}\n${transfer}`;
}

function describe(entry: BlobEntry): BlobDescription {
  return {
    length: entry.length,
    digest: entry.digest,
    received: entry.received,
    complete: entry.received >= entry.length,
  };
}

/** What a directory listing says an object weighs, for a test that looks at the disk. */
export async function blobBytesOnDisk(root: string, project: string, transfer: string): Promise<number> {
  const path = join(resolve(root), DIRECTORY, project, transfer);
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}
