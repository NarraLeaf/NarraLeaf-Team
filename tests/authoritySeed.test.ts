// A project's first version from a package (ProjectAuthorities.seed): only into
// a project that holds nothing, and what the authority held for the empty
// project is let go so nothing writes it back over the new version.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectAuthorities, type DocTopicEvent, type LoadedProject } from "../src/authority/manager.js";
import { appendEffect, markSnapshot } from "../src/authority/store.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { RepositoryNotEmptyError } from "../src/projects/workingCopy.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-seed-");
const PROJECT = "0123456789abcdef0123456789abcdef";

const opened: DatabaseSync[] = [];
afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.close();
  }
});

async function database(): Promise<DatabaseSync> {
  const db = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  opened.push(db);
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ('u1', 'ada', 'Ada', 'x', 1)`).run();
  db.prepare("INSERT INTO projects (id, name, description, created_by, created_at) VALUES (?, 'harbour', '', 'u1', 1)").run(PROJECT);
  return db;
}

/** A repository that is empty until it is seeded, and then holds one revision. */
function harness(db: DatabaseSync, withSeed = true) {
  const state: { seeded: boolean } = { seeded: false };
  const events: DocTopicEvent[] = [];
  const seed = vi.fn(async (_project: string, write: (place: (path: string) => string) => Promise<readonly string[]>) => {
    const changed = await write((path) => `/copy/${path}`);
    state.seeded = true;
    return { revision: "r1", changed };
  });
  const open = async (): Promise<LoadedProject> =>
    state.seeded
      ? { revision: "r1", files: new Map<string, unknown>([["editor/dlc.json", Buffer.from("{}")]]), unreadable: [] }
      : { files: new Map(), unreadable: [] };
  const authorities = new ProjectAuthorities({
    database: db,
    open,
    openAt: async () => undefined,
    commit: async () => ({}),
    ...(withSeed ? { seed } : {}),
    publish: (_project, event) => {
      events.push(event);
    },
  });
  return { authorities, seed, events, state };
}

const writeOne = async (place: (path: string) => string) => {
  expect(place("game.nlproj")).toBe("/copy/game.nlproj");
  return ["game.nlproj"];
};

describe("giving an empty project its first version", () => {
  it("writes it, tells any open Studio to start again from it, and answers the revision", async () => {
    const db = await database();
    const { authorities, seed, events } = harness(db);

    await expect(authorities.seed(PROJECT, writeOne, "Imported", "ada")).resolves.toEqual({ revision: "r1", changed: ["game.nlproj"] });

    expect(seed).toHaveBeenCalledWith(PROJECT, expect.any(Function), "Imported");
    expect(events).toEqual([{ kind: "doc-reset", seq: 0, revision: "r1", by: "ada" }]);
  });

  it("lets go of what it held for the empty project, so the next use reads the new version", async () => {
    const db = await database();
    const { authorities } = harness(db);
    expect((await authorities.base(PROJECT))?.revision).toBeNull();

    await authorities.seed(PROJECT, writeOne, "Imported", "ada");

    expect((await authorities.base(PROJECT))?.revision).toBe("r1");
  });

  it("refuses a project with an edit in its log, and writes nothing", async () => {
    const db = await database();
    const { authorities, seed } = harness(db);
    appendEffect(db, PROJECT, {
      seq: 1,
      clientId: "c1",
      accountId: "u1",
      by: "ada",
      document: { doc: "project" },
      op: { op: "noop" },
      at: 1,
    });

    await expect(authorities.seed(PROJECT, writeOne, "Imported", "ada")).rejects.toThrow(RepositoryNotEmptyError);
    expect(seed).not.toHaveBeenCalled();
  });

  it("refuses a project that already has a saved version", async () => {
    const db = await database();
    const { authorities, seed } = harness(db);
    markSnapshot(db, PROJECT, { seq: 0, revision: "r0", at: 1 });

    await expect(authorities.seed(PROJECT, writeOne, "Imported", "ada")).rejects.toThrow(RepositoryNotEmptyError);
    expect(seed).not.toHaveBeenCalled();
  });

  it("refuses on a server that cannot write a first version", async () => {
    const db = await database();
    const { authorities } = harness(db, false);

    await expect(authorities.seed(PROJECT, writeOne, "Imported", "ada")).rejects.toThrow("cannot put a first version");
  });
});
