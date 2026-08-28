/**
 * Reading one project: its revision history, and the file inside it.
 *
 * Everything here happens against Team's own checkout of the repository — see
 * ./cache.ts for why there is one at all, which is the single rule this whole
 * feature is shaped by. The checkout is the only path a Lore call is given.
 *
 * Nothing raises. A repository that cannot be reached, a checkout that cannot
 * be made, a revision that cannot be walked: each of them answers with a
 * history Team did not count and a file it could not read, plus a sentence
 * saying which. That is what keeps a loreserver that is down or a Studio that
 * is newer costing freshness rather than costing the screen.
 */
import {
  closeStore,
  closeTree,
  listTreeChildren,
  loadTree,
  NODE_DIRECTORY,
  NODE_FILE,
  openStore,
  readAddress,
  releaseRepository,
  revisionDetails,
  revisionHistory,
  type RevisionDetails,
  type RevisionEntry,
  type StoreHandle,
  type TreeHandle,
} from "../lore/verbs.js";
import {
  ensureCheckout,
  offlineGlobals,
  onlineGlobals,
  projectCheckoutPath,
  type CheckoutOptions,
} from "./cache.js";
import { readProjectFile, revisionSizes, type RevisionFile, type RevisionSource } from "./content.js";

import type { LoreGlobals } from "../lore/call.js";
import type { ProjectFileView, RevisionView } from "../teamview.js";

/** What one read of a project produced. */
export interface ProjectReading {
  readonly history: RevisionView;
  readonly file: ProjectFileView;
  /** True when this read cloned the project rather than syncing it. */
  readonly cloned: boolean;
}

export type ReadProjectOptions = CheckoutOptions;

/**
 * How many tree entries a walk will visit.
 *
 * A project with more than this in one revision is not one this can describe
 * in the time a screen refresh has, and stopping is better than a total that
 * grew for a minute. The counts then read as unknown.
 */
const TREE_ENTRY_LIMIT = 200_000;

/** Raised inside the walk, and turned into a sentence before it leaves. */
class TreeTooLargeError extends Error {
  constructor() {
    super(
      `this revision holds more than ${TREE_ENTRY_LIMIT.toLocaleString("en-US")} entries, which is more than Team will walk`,
    );
    this.name = "TreeTooLargeError";
  }
}

/** Read everything Team can say about one project. Never throws. */
export async function readProject(options: ReadProjectOptions): Promise<ProjectReading> {
  try {
    return await read(options);
  } catch (error) {
    return {
      history: {},
      file: { readable: false, reason: unreachable(error) },
      cloned: false,
    };
  }
}

async function read(options: ReadProjectOptions): Promise<ProjectReading> {
  const checkout = await ensureCheckout(options);
  const local = offlineGlobals(checkout.path);
  const online = onlineGlobals(checkout.path);

  try {
    const { branch } = checkout;
    const revisions = await revisionHistory(local);
    const tip = revisions.at(-1);

    if (tip === undefined) {
      // Zero rather than absent, and the two are not the same thing on screen:
      // this is a project nobody has pushed to, which Team knows, rather than a
      // count Team did not take.
      return {
        history: { revisions: 0, ...(branch === undefined ? {} : { branch }) },
        file: {
          readable: false,
          reason: "nothing has been pushed to this project yet",
        },
        cloned: checkout.cloned,
      };
    }

    // A revision with no metadata Team could read still counts as a revision:
    // the count and the branch above it are true either way, and the who and
    // the when are absent rather than the whole history being lost.
    const details: RevisionDetails = await revisionDetails(local, tip.revision).catch(() => ({}));
    const history: RevisionView = {
      revisions: revisions.length,
      head: tip.revision,
      ...(branch === undefined ? {} : { branch }),
      ...(details.timestamp === undefined ? {} : { lastAt: details.timestamp }),
      ...(details.author === undefined ? {} : { lastBy: details.author }),
      ...(details.message === undefined ? {} : { lastMessage: details.message }),
    };

    const walked = await walkRevision(online, {
      path: checkout.path,
      remoteUrl: checkout.remoteUrl,
      repository: options.projectId,
      revision: tip.revision,
    });

    return {
      history: { ...history, ...(walked.bytes === undefined ? {} : { bytes: walked.bytes }) },
      file: walked.file,
      cloned: checkout.cloned,
    };
  } finally {
    // Whatever happened, let go of the checkout: on Windows a file the library
    // still holds cannot be deleted, and this directory is one somebody is
    // entitled to delete at any moment.
    await releaseRepository(local).catch(() => undefined);
  }
}

/** A revision walked, measured and read. */
interface WalkedRevision {
  /**
   * What the revision holds, absent when it could not be walked.
   *
   * Absent rather than nought, which the interface draws differently and
   * rightly: nought is a revision with nothing in it, and a size Team failed to
   * measure must not read as a project somebody emptied.
   */
  readonly bytes?: number;
  readonly file: ProjectFileView;
}

async function walkRevision(
  globals: LoreGlobals,
  target: { path: string; remoteUrl: string; repository: string; revision: string },
): Promise<WalkedRevision> {
  // The remote URL is what makes a checkout holding nothing answer for every
  // file in the revision: without it, a blob that is not already here is a get
  // that fails rather than one that fetches.
  let store: StoreHandle | undefined;
  let tree: TreeHandle | undefined;
  try {
    store = await openStore(globals, { path: target.path, remoteUrl: target.remoteUrl });
    tree = await loadTree(globals, store, target.repository, target.revision);
    const files = await collectFiles(globals, tree);

    const source = revisionSource(globals, store, target.repository, files);
    const file = await readProjectFile(source);
    return { bytes: revisionSizes(source).totalBytes, file };
  } catch (error) {
    return { file: { readable: false, reason: unreadableRevision(error) } };
  } finally {
    if (tree !== undefined) {
      await closeTree(globals, tree).catch(() => undefined);
    }
    if (store !== undefined) {
      await closeStore(globals, store).catch(() => undefined);
    }
  }
}

/** One tree entry, kept with the address its bytes are at. */
interface TreeEntry extends RevisionFile {
  readonly address: { hash: string; context: string };
}

/**
 * Every file in a revision, with its size and where its bytes are.
 *
 * One call per directory, breadth first. Each entry already carries its own
 * address, so nothing here needs a lookup per file — which is what makes
 * measuring a revision cost the shape of the tree rather than the size of it.
 */
async function collectFiles(globals: LoreGlobals, tree: TreeHandle): Promise<TreeEntry[]> {
  const files: TreeEntry[] = [];
  const pending: Array<{ nodeId: number; prefix: string }> = [{ nodeId: 0, prefix: "" }];
  let visited = 0;

  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    for (const child of await listTreeChildren(globals, tree, next.nodeId)) {
      visited += 1;
      if (visited > TREE_ENTRY_LIMIT) {
        throw new TreeTooLargeError();
      }
      const path = next.prefix === "" ? child.name : `${next.prefix}/${child.name}`;
      if (child.kind === NODE_DIRECTORY) {
        pending.push({ nodeId: child.nodeId, prefix: path });
        continue;
      }
      if (child.kind === NODE_FILE) {
        files.push({ path, size: child.size, address: child.address });
      }
      // A link is neither walked nor counted: it has no bytes of its own, and
      // following one inside a revision would count something twice.
    }
  }

  return files;
}

/** The revision as ./content.ts wants it: entries, and a way to fetch one. */
function revisionSource(
  globals: LoreGlobals,
  store: StoreHandle,
  repository: string,
  files: readonly TreeEntry[],
): RevisionSource {
  const addresses = new Map(files.map((file) => [file.path, file.address]));
  return {
    files,
    async read(file) {
      const address = addresses.get(file.path);
      if (address === undefined) {
        throw new Error(`${file.path} is not in this revision`);
      }
      return readAddress(globals, store, repository, address);
    },
  };
}

/** The sentence for a project whose repository Team could not get to. */
function unreachable(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `this project's repository could not be read: ${detail}`;
}

/** The sentence for a revision Team reached but could not walk. */
function unreadableRevision(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `the latest revision of this project could not be read: ${detail}`;
}

/**
 * One page of a project's revision history, on demand.
 *
 * Separate from {@link readProject} and deliberately not part of it. What the
 * refresh loop reads is a summary — how many revisions there are and what the
 * newest one says — because that is what a screen shows and what it costs is
 * paid once a minute for every project on the server. A page of revisions is
 * asked for by one person looking at one project, so it is read when they ask
 * and never on the loop.
 *
 * It reads a checkout that already exists and never makes one. A project the
 * refresh has not reached yet answers undefined rather than waiting on a
 * clone: the caller says "not read yet", which is the same thing it already
 * says about that project's history, rather than holding a request open for
 * the slowest read this server does.
 *
 * Nothing here opens a store. The branch and every revision's metadata come
 * off the disk with no network at all — see ./cache.ts on why a checkout that
 * holds nothing can still answer this.
 */
export interface RevisionPageRequest {
  readonly root: string;
  /** The repository id, which is what the checkout is keyed by. */
  readonly projectId: string;
  /** How many revisions this page holds at most. */
  readonly limit: number;
  /**
   * The most the revisions on one page may weigh, in UTF-8 bytes.
   *
   * A second ceiling, because the count is not a bound on anything here. Every
   * variable-length field of a revision — the message somebody wrote when they
   * pushed, and the name they pushed as — comes out of a repository rather than
   * out of a column this server writes, so there is no per-field limit standing
   * behind the count the way there is on every other list this server answers
   * with. A hundred revisions whose messages are each a release note is an
   * answer nothing else would stop. Whichever of the two is reached first ends
   * the page.
   */
  readonly limitBytes: number;
  /** The revision the last page ended at; this one starts after it. */
  readonly before?: string;
}

/** One revision, as a history is read. Everything but the id may be absent. */
export interface RevisionPageEntry {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at?: number;
  readonly by?: string;
  readonly message?: string;
}

export interface RevisionPage {
  /** Newest first, which is the order a history is read in. */
  readonly revisions: readonly RevisionPageEntry[];
  /** Whether asking again with the last id here would answer with anything. */
  readonly more: boolean;
}

/**
 * Read one page of revisions, or answer undefined. Never throws.
 *
 * Undefined means Team has no checkout of this project to read, which is a
 * different fact from a project with no revisions in it — the second answers
 * with an empty page.
 */
export async function readRevisionPage(
  request: RevisionPageRequest,
): Promise<RevisionPage | undefined> {
  const globals = offlineGlobals(projectCheckoutPath(request.root, request.projectId));
  try {
    // Newest first, which is the order somebody reads a history in and the
    // reverse of the order it arrives in.
    const history = (await revisionHistory(globals)).reverse();

    // A cursor naming a revision this repository does not have is answered
    // with the end of the history rather than the start of it: it is a page
    // token from a history that has since been rewritten, and beginning again
    // from the top would look to whoever sent it like the list looping.
    const after = request.before === undefined ? -1 : indexOfRevision(history, request.before);
    const start = after === undefined ? history.length : after + 1;
    const page = history.slice(start, start + request.limit);

    const revisions = await fillRevisionPage(
      page.map((entry) => entry.revision),
      request.limitBytes,
      (revision) => revisionDetails(globals, revision),
    );

    // Counted from what went on the page rather than from what was offered to
    // it, so that a page the budget cut short says there is more — which there
    // is, and the cursor beside it is the revision to carry on after.
    return { revisions, more: start + revisions.length < history.length };
  } catch {
    // A project with no checkout, or one whose checkout is half made. Both are
    // "Team has not read this yet", and neither is an error a person can act on.
    return undefined;
  } finally {
    // On Windows a file the library still holds cannot be deleted, and this
    // directory is one the refresh may be about to replace.
    await releaseRepository(globals).catch(() => undefined);
  }
}

/**
 * What one revision adds to an answer, in UTF-8 bytes.
 *
 * The three fields that came out of the repository, which is the whole of what
 * is not bounded elsewhere: the message somebody wrote when they pushed, the
 * name they pushed as, and the id. The timestamp beside them is the same
 * handful of bytes on every revision there is, and the count ceiling is what
 * bounds that.
 */
function weigh(entry: RevisionPageEntry): number {
  return (
    Buffer.byteLength(entry.id, "utf-8") +
    Buffer.byteLength(entry.by ?? "", "utf-8") +
    Buffer.byteLength(entry.message ?? "", "utf-8")
  );
}

/**
 * Read the revisions of one page, and stop at the budget.
 *
 * Its own function because it is the half of a page that can be checked without
 * a repository behind it: which revisions go on and where the page stops, apart
 * from the calls that fill them in.
 *
 * **The metadata is read inside the loop rather than before it**, which is the
 * reason a history is weighed here and not where the answer is composed: a page
 * cut down afterwards would have read every revision it was offered first, and
 * that reading is most of what a page of history costs. One revision past the
 * budget is read, because a commit message cannot be weighed without being
 * read - the same one row past the page that every other list here reads to
 * find out whether there is more.
 *
 * The first revision goes on whatever it weighs, for the reason every page on
 * this server admits its first: a page that came back empty because one message
 * was larger than the whole budget would be a cursor that never moved, and a
 * history nobody could read past.
 */
export async function fillRevisionPage(
  revisions: readonly string[],
  limitBytes: number,
  detailsOf: (revision: string) => Promise<RevisionDetails>,
): Promise<RevisionPageEntry[]> {
  const page: RevisionPageEntry[] = [];
  let bytes = 0;
  for (const revision of revisions) {
    // A revision whose metadata cannot be read still counts as a revision: the
    // id is true either way, and the who and the when are absent rather than
    // the page being lost.
    const details: RevisionDetails = await detailsOf(revision).catch(() => ({}));
    const entry: RevisionPageEntry = {
      id: revision,
      ...(details.timestamp === undefined ? {} : { at: details.timestamp }),
      ...(details.author === undefined ? {} : { by: details.author }),
      ...(details.message === undefined ? {} : { message: details.message }),
    };
    if (page.length > 0 && bytes + weigh(entry) > limitBytes) {
      break;
    }
    bytes += weigh(entry);
    page.push(entry);
  }
  return page;
}

/** Where a revision sits in a history, or undefined if it is not in one. */
function indexOfRevision(history: readonly RevisionEntry[], revision: string): number | undefined {
  const wanted = revision.toLowerCase();
  const at = history.findIndex((entry) => entry.revision.toLowerCase() === wanted);
  return at === -1 ? undefined : at;
}
