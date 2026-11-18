/**
 * The one way Team calls Lore.
 *
 * Everything that has to be got right about the call path is handled here,
 * once:
 *
 *   - **Exactly one native callback per call, released on every path.** koffi
 *     has a bounded pool of registered callbacks; leaking one per call empties
 *     it after a few thousand operations and the failure then looks nothing
 *     like its cause.
 *   - **No borrowed memory escapes.** Payloads are copied inside the callback
 *     (see ./events.ts) and collected; nothing reads FFI memory afterwards.
 *   - **No re-entry.** Calling Lore from inside a callback is forbidden, so the
 *     only work done in the callback is decoding, and the events are examined
 *     after the call settles.
 *   - **A failure says what it was.** Lore reports the detail through events
 *     rather than through the return code, so a non-zero return is turned into
 *     an error carrying the messages and the trace locations. Without them the
 *     whole of a failure is "invalid arguments".
 */
import koffi from "koffi";

import type { LoreVerbName } from "./abi.js";
import {
  decodeEvent,
  LoreTag,
  type LoreCompletePayload,
  type LoreErrorPayload,
  type LoreEvent,
} from "./events.js";
import { loadLoreLibrary, type LoreLibrary } from "./library.js";
import { loreBool, loreString } from "./values.js";

/** The global arguments every verb takes. */
export interface LoreGlobals {
  /**
   * The repository root, absolute.
   *
   * Absolute because Lore resolves a relative path against the process working
   * directory, which is never the directory meant.
   */
  readonly repositoryPath: string;
  /**
   * Not a network kill switch. Most verbs honour it; anything that has to
   * reach the remote has to be told false, and anything local should be told
   * true so that it cannot wait on a socket.
   */
  readonly offline?: boolean;
  /**
   * Keep fragments fetched from a remote. Off upstream by default, which makes
   * every read of the same content fetch it again.
   */
  readonly cache?: boolean;
  /**
   * Who a write is recorded as - the account id a commit's `committed-by`
   * names. Absent for every read, which records nothing.
   */
  readonly identity?: string;
}

export class LoreCallError extends Error {
  constructor(
    message: string,
    readonly verb: LoreVerbName,
    readonly errorCode: number | undefined,
    readonly trace: readonly string[],
  ) {
    super(message);
    this.name = "LoreCallError";
  }
}

export interface LoreCallResult {
  readonly events: readonly LoreEvent[];
  /** Every event of one tag, typed by the caller. */
  of<T>(tag: number): T[];
  /** The first event of one tag, or undefined. */
  first<T>(tag: number): T | undefined;
}

function buildGlobals(globals: LoreGlobals): object {
  return {
    repositoryPath: loreString(globals.repositoryPath),
    correlationId: loreString(undefined),
    identity: loreString(globals.identity),
    force: 0,
    offline: loreBool(globals.offline),
    local: 0,
    remote: 0,
    dryRun: 0,
    noAtime: 0,
    maxConnections: 0,
    searchLimit: 0,
    searchNearest: 0,
    noGc: 0,
    inMemory: 0,
    fileCountLimit: 0,
    fileSizeLimit: 0,
    compressTaskLimit: 0,
    storeKeepAlive: 0,
    storeKeepAliveSeconds: 0,
    syncData: 0,
    cache: loreBool(globals.cache),
  };
}

/**
 * Run one verb and collect its events.
 *
 * The call runs on koffi's worker pool, so a clone or a fetch does not block
 * the thread drawing the screen.
 */
export async function invoke(
  verb: LoreVerbName,
  globals: LoreGlobals,
  args: object,
  library: LoreLibrary = loadLoreLibrary(),
): Promise<LoreCallResult> {
  const fn = library.verb(verb);
  const globalArgs = buildGlobals(globals);

  const events: LoreEvent[] = [];
  let readFailure: unknown = null;

  const trampoline = (pointer: unknown): void => {
    try {
      events.push(decodeEvent(library, pointer));
    } catch (error) {
      // Never let this propagate into native code: it would unwind through the
      // FFI boundary. Recorded here and raised after the call settles.
      readFailure ??= error;
    }
  };

  const registered = koffi.register(trampoline, koffi.pointer(library.callbackPrototype));
  let status: number;
  try {
    status = await new Promise<number>((resolve, reject) => {
      fn.async(globalArgs, args, { userContext: 0, callback: registered }, (error, result) =>
        error !== null ? reject(error) : resolve(result),
      );
    });
  } finally {
    // After the call settles rather than on an end event: an early failure
    // never reaches one, and releasing a callback native code might still hold
    // is worse than releasing it a moment late.
    koffi.unregister(registered);
  }

  if (readFailure !== null) {
    throw readFailure;
  }

  const result = makeResult(events);
  if (status !== 0) {
    throw describeFailure(verb, result);
  }
  return result;
}

function makeResult(events: LoreEvent[]): LoreCallResult {
  const of = <T,>(tag: number): T[] =>
    events.filter((event) => event.tag === tag && event.data !== undefined).map((event) => event.data as T);
  return { events, of, first: <T,>(tag: number) => of<T>(tag)[0] };
}

function describeFailure(verb: LoreVerbName, result: LoreCallResult): LoreCallError {
  const messages = result
    .of<LoreErrorPayload>(LoreTag.ERROR)
    .map((event) => event.message)
    .filter((message) => message !== "");
  const complete = result.first<LoreCompletePayload>(LoreTag.COMPLETE);
  const detail =
    messages.length > 0 ? messages.join("\n") : complete?.message !== undefined && complete.message !== ""
      ? complete.message
      : `${verb} failed`;
  return new LoreCallError(`${verb}: ${detail}`, verb, complete?.errorCode, complete?.trace ?? []);
}
