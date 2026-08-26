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
import {
  discardCheckout,
  projectCacheDir,
  projectCheckoutPath,
  repositoryUrl,
} from "../src/projects/cache.js";
import { readProject, readRevisionPage } from "../src/projects/read.js";
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
    });

    expect(page).toBeUndefined();
    await expect(stat(projectCheckoutPath(root, "0123456789abcdef0123456789abcdef"))).rejects.toThrow();
  }, 120_000);
});
