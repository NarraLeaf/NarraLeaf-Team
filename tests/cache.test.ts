// The rule that decides the shape of everything Team reads: it never opens the
// store loreserver is serving.
//
// That is not a preference. A repository lock is exclusive, and opening a store
// a running loreserver holds does not fail — it waits, for ever, at no CPU,
// with nothing logged and no timeout to reach. A Team server that did it once would
// stop reading anything, and there would be no error anywhere to say why.
//
// So the checks below are about where paths come from. Team reads its own
// checkouts and nothing else, and the two assertions here are that those
// checkouts are somewhere else entirely, and that no module outside the two
// that own them is in a position to hand Lore a path at all.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLoreLibrary } from "../src/lore/library.js";
import type { RevisionDetails } from "../src/lore/verbs.js";
import {
  discardCheckout,
  projectCacheDir,
  projectCheckoutPath,
  repositoryUrl,
} from "../src/projects/cache.js";
import { fillRevisionPage, readProject, readRevisionPage } from "../src/projects/read.js";
import { PAGE_BYTES_LIMIT } from "../src/team/protocol.js";
import { storageRootOf } from "../src/view.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-cache-");

/** Every module under src, with its text. */
async function sources(directory: string): Promise<Array<{ path: string; text: string }>> {
  const found: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sources(path)));
      continue;
    }
    found.push({ path: path.replaceAll("\\", "/"), text: await readFile(path, "utf8") });
  }
  return found;
}

/** True when `inner` is `outer` or sits inside it. */
function contains(outer: string, inner: string): boolean {
  const between = relative(resolve(outer), resolve(inner));
  return between === "" || (!between.startsWith("..") && !between.startsWith(`..${sep}`));
}

describe("where Team's checkouts are", () => {
  const ROOTS = ["/srv/team", "D:\\team", "./relative", "/srv/team with spaces", "/srv/team/"];

  it("is never inside the store loreserver is serving, and never holds it", () => {
    for (const root of ROOTS) {
      const checkout = projectCheckoutPath(root, "0123456789abcdef0123456789abcdef");
      const served = storageRootOf(root);

      expect(contains(served, checkout)).toBe(false);
      expect(contains(checkout, served)).toBe(false);
      expect(contains(projectCacheDir(root), checkout)).toBe(true);
    }
  });

  it("keys a checkout by the repository, not by the name it is shown under", () => {
    // A renamed project is the same repository. A directory named after the
    // old name would be a second checkout of it rather than the same one.
    const first = projectCheckoutPath("/srv/team", "0123456789abcdef0123456789abcdef");
    const second = projectCheckoutPath("/srv/team", "fedcba9876543210fedcba9876543210");

    expect(first).not.toBe(second);
    expect(first).toContain("0123456789abcdef0123456789abcdef");
  });

  it("addresses a repository under the remote it was told about", () => {
    expect(repositoryUrl("lore://127.0.0.1:41337", "harbour")).toBe("lore://127.0.0.1:41337/harbour");
    expect(repositoryUrl("lore://127.0.0.1:41337/", "harbour")).toBe("lore://127.0.0.1:41337/harbour");
  });

  it("can be thrown away when there is nothing there", async () => {
    // Deleting the cache has to cost time and nothing else, which includes
    // deleting one that was never made.
    const root = await temporaryRoot();
    await expect(discardCheckout(root, "0123456789abcdef0123456789abcdef")).resolves.toBeUndefined();
  });
});

describe("who is in a position to open a store", () => {
  it("is the two modules that own the checkouts, and nothing else", async () => {
    // Every Lore call takes the repository path it works on. If only these two
    // modules can make one of those calls, then every path Lore is ever given
    // came from projectCheckoutPath, which is what the assertion above is
    // about. A third module here is how the storage root would get in.
    const callers = (await sources("src"))
      .filter(({ path }) => !path.startsWith("src/lore/"))
      .filter(({ text }) => /from "[^"]*lore\/(verbs|call|library|events|values)\.js"/.test(text))
      .map(({ path }) => path)
      .sort();

    expect(callers).toEqual(["src/projects/cache.ts", "src/projects/read.ts"]);
  });

  it("is nothing that also knows where loreserver's own store is", async () => {
    // The two names that lead to the served store. Neither belongs anywhere a
    // repository path is built.
    const offenders = (await sources("src"))
      .filter(({ path }) => path === "src/projects/cache.ts" || path === "src/projects/read.ts")
      .filter(({ text }) => /instanceLayout|storageRootOf|immutableStore|mutableStore/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

/**
 * The last of the four ways a project can be unreadable, which is the only one
 * that has to go through the whole reader to happen at all.
 *
 * It contacts nothing: the port is one on the loopback that nothing is
 * listening on, which is what an operator's Team looks like when loreserver has
 * stopped. Skipped where lorelib will not load, since there is then nothing to
 * drive — and the load is attempted rather than the path merely resolved,
 * because a package being on disk is not the same as a library this machine can
 * open.
 */
const libraryPresent = ((): boolean => {
  try {
    loadLoreLibrary();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!libraryPresent)("a project whose repository cannot be reached", () => {
  it("says so in a sentence, and leaves the history uncounted", async () => {
    const root = await temporaryRoot();
    const reading = await readProject({
      root,
      projectId: "0123456789abcdef0123456789abcdef",
      projectName: "harbour",
      // Chosen away from every port Team uses, so that a Team server running on this
      // machine cannot accidentally answer.
      remote: "lore://127.0.0.1:41938",
    });

    expect(reading.file.readable).toBe(false);
    expect(reading.file.reason).toMatch(/could not be read/i);
    // Absent, not zero: nobody counted, which is not the same as none.
    expect(reading.history.revisions).toBeUndefined();
    expect(reading.history.bytes).toBeUndefined();
    expect(reading.history.lastAt).toBeUndefined();
  }, 120_000);

  it("leaves nothing behind that a later read would take for a checkout", async () => {
    const root = await temporaryRoot();
    await readProject({
      root,
      projectId: "0123456789abcdef0123456789abcdef",
      projectName: "harbour",
      remote: "lore://127.0.0.1:41938",
    });

    const path = projectCheckoutPath(root, "0123456789abcdef0123456789abcdef");
    await expect(stat(path)).rejects.toThrow();
  }, 120_000);
});

describe.skipIf(!libraryPresent)("a page of a project's revisions", () => {
  it("is absent for a project there is no checkout of, rather than empty", async () => {
    // The difference this asserts is the whole discipline: a project the
    // reader has not reached yet must not answer like one with no revisions in
    // it. Nothing is cloned here — a page is read out of a checkout that
    // already exists or it is not read at all, so that a request cannot end up
    // waiting on the slowest thing this server does.
    const root = await temporaryRoot();

    const page = await readRevisionPage({
      root,
      projectId: "0123456789abcdef0123456789abcdef",
      limit: 20,
      limitBytes: PAGE_BYTES_LIMIT,
    });

    expect(page).toBeUndefined();
    await expect(stat(projectCheckoutPath(root, "0123456789abcdef0123456789abcdef"))).rejects.toThrow();
  }, 120_000);
});

describe("where a page of revisions stops", () => {
  /** A metadata reader that remembers which revisions it was asked about. */
  type Reader = ((revision: string) => Promise<RevisionDetails>) & { asked: string[] };

  /** A history of `count` revisions, each pushed with a message of `bytes`. */
  function history(count: number, bytes: number): { ids: string[]; read: Reader } {
    const ids = Array.from({ length: count }, (_, index) => `r${String(index).padStart(4, "0")}`);
    const asked: string[] = [];
    return {
      ids,
      read: Object.assign(
        (revision: string) => {
          asked.push(revision);
          return Promise.resolve({
            timestamp: 1_700_000_000_000,
            author: "ada",
            message: "m".repeat(bytes),
          });
        },
        { asked },
      ),
    };
  }

  it("ends at the bytes on the messages, not at the count", async () => {
    // A commit message is whatever the version control that took it accepted,
    // so a hundred of them is an answer with no figure behind it at all. Each
    // of these is a hundred kilobytes, which is a long release note rather than
    // an attack.
    const { ids, read } = history(100, 100 * 1024);

    const page = await fillRevisionPage(ids, PAGE_BYTES_LIMIT, read);

    expect(page.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page), "utf-8")).toBeLessThanOrEqual(
      PAGE_BYTES_LIMIT + 100 * 1024,
    );
  });

  it("never reads the revisions past the budget", async () => {
    // The reason the ceiling is here rather than where the answer is composed.
    // Reading a revision's metadata is most of what a page of history costs, so
    // a page cut down afterwards would have paid for every row it then threw
    // away. One row past the page is read, because a message cannot be weighed
    // without being read, and that is the same one row every list here reads to
    // find out whether there is more.
    const { ids, read } = history(100, 100 * 1024);

    const page = await fillRevisionPage(ids, PAGE_BYTES_LIMIT, read);

    expect(read.asked).toHaveLength(page.length + 1);
  });

  it("puts one revision on the page even where its message is larger than the budget", async () => {
    // A page that came back empty because one message was larger than the whole
    // budget would be a cursor that never moved, and a history nobody could
    // read past.
    const { ids, read } = history(3, PAGE_BYTES_LIMIT * 2);

    const page = await fillRevisionPage(ids, PAGE_BYTES_LIMIT, read);

    expect(page).toHaveLength(1);
  });

  it("carries the whole page where the messages are ordinary", async () => {
    const { ids, read } = history(100, 64);

    const page = await fillRevisionPage(ids, PAGE_BYTES_LIMIT, read);

    // The count is what ends an ordinary page, which is what it was there for
    // before there was anything beside it.
    expect(page.map((entry) => entry.id)).toEqual(ids);
    expect(page[0]).toMatchObject({ by: "ada", at: 1_700_000_000_000 });
  });

  it("keeps a revision whose metadata could not be read", async () => {
    const failing = (): Promise<RevisionDetails> => Promise.reject(new Error("no such object"));

    const page = await fillRevisionPage(["r1", "r2"], PAGE_BYTES_LIMIT, failing);

    // The id is true whether or not the rest of it could be read, and a page
    // lost because one revision's metadata was unreadable would lose the
    // revisions around it too.
    expect(page).toEqual([{ id: "r1" }, { id: "r2" }]);
  });
});
