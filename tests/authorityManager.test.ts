import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectAuthorities,
  type DocTopicEvent,
  type LoadedProject,
  type OwedBytesKeeper,
  type SnapshotBlob,
} from "../src/authority/manager.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { parseStoryDocument, storyDocumentPath } from "../studio-kernel/vendor/kernel.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-authority-");

const PROJECT = "0123456789abcdef0123456789abcdef";
const STORY = "00000000-0000-4000-8000-000000000001";
const SCENE = "00000000-0000-4000-8000-000000000102";
const NOW = "2026-11-14T00:00:00.000Z";

function story(rows: string[] = []): object {
  return {
    schemaVersion: 31,
    id: STORY,
    name: "Story",
    entrySceneId: SCENE,
    chapters: [{ id: "c1", name: "Chapter 1", sceneIds: [SCENE], meta: { createdAt: NOW, updatedAt: NOW } }],
    scenes: {
      [SCENE]: {
        id: SCENE,
        name: "Scene 1",
        runtimeName: "scene_1",
        description: "",
        rootBlockIds: rows,
        blocks: Object.fromEntries(rows.map((id) => [id, narration(id, id)])),
        meta: { createdAt: NOW, updatedAt: NOW },
      },
    },
    meta: { createdAt: NOW, updatedAt: NOW },
  };
}

function narration(id: string, value: string) {
  return {
    id,
    kind: "nodeAction",
    parentId: null,
    childrenIds: [],
    payload: { action: "narration", text: { textId: `t-${id}`, role: "narration", value } },
  };
}

const DOCUMENT = { doc: "story", storyId: STORY };

/** A repository in memory: revisions are the story file's text, newest last. */
class FakeRepository {
  readonly revisions: Array<{ id: string; text: string }> = [
    { id: "r0", text: JSON.stringify(story(), null, 2) },
  ];
  commits = 0;

  documentsAt(id?: string): LoadedProject | undefined {
    const revision = id === undefined ? this.revisions.at(-1) : this.revisions.find((one) => one.id === id);
    if (revision === undefined) {
      return undefined;
    }
    return {
      revision: revision.id,
      files: new Map<string, unknown>([[storyDocumentPath(STORY), parseStoryDocument(STORY, revision.text)]]),
      unreadable: [],
    };
  }

  /** Every other file each commit wrote, by revision. */
  readonly others: Array<Map<string, string | Buffer>> = [];
  readonly blobs: SnapshotBlob[][] = [];

  commit(files: ReadonlyMap<string, string | Buffer>, blobs: readonly SnapshotBlob[] = []): { revision?: string } {
    const text = files.get(storyDocumentPath(STORY)) as string | undefined;
    const others = new Map([...files].filter(([path]) => path !== storyDocumentPath(STORY)));
    const sameOthers = JSON.stringify([...others]) === JSON.stringify([...(this.others.at(-1) ?? new Map())]);
    if (text === undefined || (text === this.revisions.at(-1)?.text && sameOthers && blobs.length === 0)) {
      return {};
    }
    this.others.push(others);
    this.blobs.push([...blobs]);
    this.commits += 1;
    const id = `r${this.revisions.length}`;
    this.revisions.push({ id, text });
    return { revision: id };
  }
}

const opened: DatabaseSync[] = [];
afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.close();
  }
});

async function database(): Promise<DatabaseSync> {
  const db = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  opened.push(db);
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ('u1', 'ada', 'Ada', 'x', 1)`,
  ).run();
  db.prepare(
    "INSERT INTO projects (id, name, description, created_by, created_at) VALUES (?, 'harbour', '', 'u1', 1)",
  ).run(PROJECT);
  return db;
}

function authorities(
  db: DatabaseSync,
  repository: FakeRepository,
  events: DocTopicEvent[] = [],
  clock = { now: 0 },
  bytes: { blobs?: Map<string, Buffer>; keeper?: OwedBytesKeeper } = {},
) {
  return new ProjectAuthorities({
    database: db,
    open: async () => repository.documentsAt(),
    openAt: async (_project, revision) => repository.documentsAt(revision),
    commit: async (_project, files, _message, blobs) => repository.commit(files, blobs),
    ...(bytes.blobs === undefined ? {} : { collectBytes: async (_project: string, transferId: string) => bytes.blobs?.get(transferId) }),
    ...(bytes.keeper === undefined ? {} : { keepBytes: bytes.keeper }),
    publish: (_project, event) => {
      events.push(event);
    },
    clock: () => clock.now,
    idleSnapshotMs: 1000,
    retainMs: 10_000,
  });
}

function insert(id: string, clientId = `c-${id}`) {
  return {
    clientId,
    accountId: "u1",
    by: "Ada",
    document: DOCUMENT,
    op: { op: "insert-block", sceneId: SCENE, block: narration(id, id), target: { parentId: null } },
  };
}

function rowsOf(repository: FakeRepository): string[] {
  const document = JSON.parse(repository.revisions.at(-1)!.text) as { scenes: Record<string, { rootBlockIds: string[] }> };
  return document.scenes[SCENE]!.rootBlockIds;
}

describe("the project authorities", () => {
  it("applies an edit, logs it, and tells every Studio on the project", async () => {
    const db = await database();
    const events: DocTopicEvent[] = [];
    const server = authorities(db, new FakeRepository(), events);

    const answer = await server.intent(PROJECT, insert("a"));
    expect(answer).toMatchObject({ kind: "effect", effect: { seq: 1, accountId: "u1", by: "Ada", document: DOCUMENT } });
    expect(events).toEqual([{ kind: "doc-effect", effect: (answer as { effect: unknown }).effect }]);
    expect(server.head(PROJECT).seq).toBe(1);
    expect(server.effects(PROJECT, 0, { limit: 10, limitBytes: 1 << 20 }).effects.map((e) => e.seq)).toEqual([1]);
  });

  it("refuses an operation on a document the project does not have", async () => {
    const server = authorities(await database(), new FakeRepository());
    const answer = await server.intent(PROJECT, { ...insert("a"), document: { doc: "story", storyId: "missing" } });
    expect(answer).toMatchObject({ kind: "refusal", reason: "rejected" });
  });

  it("comes back after a restart with every edit, and answers a resend with the first effect", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const first = authorities(db, repository);
    const applied = await first.intent(PROJECT, insert("a"));
    await first.intent(PROJECT, insert("b"));

    // A new process: nothing in memory, the same database and repository.
    const second = authorities(db, repository);
    expect(await second.intent(PROJECT, insert("a"))).toEqual(applied);
    await second.intent(PROJECT, insert("c"));
    await second.snapshot(PROJECT);
    expect(rowsOf(repository)).toEqual(["a", "b", "c"]);
    expect(second.head(PROJECT)).toMatchObject({ seq: 3, snapshot: { seq: 3, revision: "r1" } });
  });

  it("replays only what came after the last version when it reopens", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const first = authorities(db, repository);
    await first.intent(PROJECT, insert("a"));
    await first.snapshot(PROJECT, "First");
    await first.intent(PROJECT, insert("b"));

    const second = authorities(db, repository);
    await second.snapshot(PROJECT);
    // "a" came from the revision, "b" from the log - once each.
    expect(rowsOf(repository)).toEqual(["a", "b"]);
  });

  it("refuses an offline edit to a row changed after a restart since the author last saw it", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const first = authorities(db, repository);
    await first.intent(PROJECT, insert("a"));
    const seen = first.head(PROJECT).seq;
    await first.intent(PROJECT, {
      clientId: "edit-a",
      accountId: "u1",
      by: "Ada",
      document: DOCUMENT,
      op: { op: "update-block", sceneId: SCENE, blockId: "a", payload: narration("a", "newer").payload },
    });
    await first.snapshot(PROJECT);

    const second = authorities(db, repository);
    const late = await second.intent(PROJECT, {
      clientId: "offline-a",
      accountId: "u1",
      by: "Bob",
      document: DOCUMENT,
      basedOn: seen,
      op: { op: "update-block", sceneId: SCENE, blockId: "a", payload: narration("a", "offline").payload },
    });
    expect(late).toMatchObject({ kind: "refusal", reason: "conflict", conflicts: ["row:a"] });
  });

  it("saves a version once the project goes quiet, and not before", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const events: DocTopicEvent[] = [];
    const clock = { now: 0 };
    const server = authorities(db, repository, events, clock);
    await server.intent(PROJECT, insert("a"));

    clock.now = 500;
    await server.tick();
    expect(repository.commits).toBe(0);

    clock.now = 1500;
    await server.tick();
    expect(repository.commits).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "doc-snapshot", seq: 1, revision: "r1" });

    // Nothing new: the next quiet tick commits nothing.
    clock.now = 5000;
    await server.tick();
    expect(repository.commits).toBe(1);
  });

  it("restores an older version as a new one, and tells every Studio to reset", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const events: DocTopicEvent[] = [];
    const server = authorities(db, repository, events);
    await server.intent(PROJECT, insert("a"));
    await server.snapshot(PROJECT);
    await server.intent(PROJECT, insert("b"));
    await server.snapshot(PROJECT);
    expect(rowsOf(repository)).toEqual(["a", "b"]);

    const restored = await server.restore(PROJECT, "r1", { accountId: "u1", by: "Ada" });
    expect(rowsOf(repository)).toEqual(["a"]);
    expect(restored).toEqual({ seq: 3, revision: "r3" });
    expect(events.at(-1)).toEqual({ kind: "doc-reset", seq: 3, revision: "r3", by: "Ada" });

    // Editing carries on from the restored state, and a restart agrees.
    await server.intent(PROJECT, insert("c"));
    const again = authorities(db, repository);
    await again.snapshot(PROJECT);
    expect(rowsOf(repository)).toEqual(["a", "c"]);
  });

  it("hands a Studio the last saved version's files and the seq they stand at", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const server = authorities(db, repository);

    // Never saved here: the latest revision, at seq 0.
    const first = await server.base(PROJECT);
    expect(first).toMatchObject({ seq: 0, revision: "r0" });
    expect(first?.files.get(storyDocumentPath(STORY))).toBe(repository.revisions[0]!.text);

    await server.intent(PROJECT, insert("a"));
    await server.snapshot(PROJECT);
    await server.intent(PROJECT, insert("b"));
    const saved = await server.base(PROJECT);
    // The version, not the edits after it: a Studio follows the log from its seq.
    expect(saved).toMatchObject({ seq: 1, revision: "r1" });
    expect(saved?.files.get(storyDocumentPath(STORY))).toBe(repository.revisions[1]!.text);

    // And a restarted server agrees.
    const again = authorities(db, repository);
    expect(await again.base(PROJECT)).toMatchObject({ seq: 1, revision: "r1" });
  });

  it("clears the log once a saved version holds it and it is old, and refuses offline edits older than that", async () => {
    const db = await database();
    const repository = new FakeRepository();
    const clock = { now: 0 };
    const server = authorities(db, repository, [], clock);
    await server.intent(PROJECT, insert("a"));
    await server.snapshot(PROJECT);
    await server.intent(PROJECT, insert("b"));

    // Not old enough yet: nothing goes.
    clock.now = 5_000;
    await server.tick();
    expect(server.effects(PROJECT, 0, { limit: 10, limitBytes: 1 << 20 }).effects.map((e) => e.seq)).toEqual([1, 2]);

    // Old enough: what the version holds goes; what it does not (seq 2, unsaved until this tick) stays.
    clock.now = 20_000;
    await server.tick();
    await server.tick();
    const left = server.effects(PROJECT, 0, { limit: 10, limitBytes: 1 << 20 }).effects.map((e) => e.seq);
    expect(left).not.toContain(1);
    expect(server.head(PROJECT).prunedThrough).toBeGreaterThanOrEqual(1);
    expect(server.head(PROJECT).seq).toBe(2);

    const stale = await server.intent(PROJECT, { ...insert("c"), basedOn: 0 });
    expect(stale).toMatchObject({ kind: "refusal", reason: "conflict", conflicts: ["*"] });
  });

  describe("whole files", () => {
    const SCHEMA = "editor/save-schema.json";
    const CHARACTERS = "editor/services/character.json";
    const CAST = JSON.stringify({ version: 1, characters: [{ profile: { id: "alice", name: "Alice", appearance: { kind: "preset" } } }] });
    const DIGEST = "b".repeat(64);
    const put = (path: string, data: string | null, clientId: string, basedOn?: number) => ({
      clientId,
      accountId: "u1",
      by: "Ada",
      document: { doc: "file", path },
      op: { op: "put-file", content: data === null ? null : { encoding: "utf8", data } },
      ...(basedOn === undefined ? {} : { basedOn }),
    });

    it("applies a whole file, publishes it, and writes it into the next version", async () => {
      const db = await database();
      const repository = new FakeRepository();
      const events: DocTopicEvent[] = [];
      const server = authorities(db, repository, events);
      const answer = await server.intent(PROJECT, put(SCHEMA, "{\"a\":1}", "p1", 0));
      expect(answer).toMatchObject({ kind: "effect", effect: { seq: 1, document: { doc: "file", path: SCHEMA } } });
      expect((answer as { effect: object }).effect).not.toHaveProperty("touched");
      await server.snapshot(PROJECT);
      expect(repository.others.at(-1)?.get(SCHEMA)).toBe("{\"a\":1}");
      const base = await server.base(PROJECT);
      expect(base?.files.get(SCHEMA)).toBe("{\"a\":1}");
    });

    it("refuses a whole file sent from before somebody else wrote it", async () => {
      const db = await database();
      const server = authorities(db, new FakeRepository());
      await server.intent(PROJECT, put(SCHEMA, "{}", "p1", 0));
      const seen = server.head(PROJECT).seq;
      await server.intent(PROJECT, put(SCHEMA, "{\"b\":1}", "p2", seen));
      expect(await server.intent(PROJECT, put(SCHEMA, "{\"c\":1}", "p3", seen))).toMatchObject({
        kind: "refusal",
        reason: "conflict",
        conflicts: [`file:${SCHEMA}`],
      });
    });

    it("refuses a document sent whole from offline when a finer edit reached it meanwhile, even after a restart", async () => {
      const db = await database();
      const repository = new FakeRepository();
      const first = authorities(db, repository);
      await first.intent(PROJECT, put(CHARACTERS, CAST, "c0", 0));
      const seen = first.head(PROJECT).seq;
      await first.intent(PROJECT, {
        clientId: "c1",
        accountId: "u1",
        by: "Ada",
        document: { doc: "characters" },
        op: { op: "delete-character", characterId: "alice" },
      });
      expect(first.head(PROJECT).seq).toBe(seen + 1);
      await first.snapshot(PROJECT);

      const second = authorities(db, repository);
      const late = await second.intent(PROJECT, put(CHARACTERS, CAST, "c2", seen));
      expect(late).toMatchObject({ kind: "refusal", reason: "conflict", conflicts: [`file:${CHARACTERS}`] });
    });

    it("writes an asset's bytes where Studio reads them: under the asset's id, not its digest", async () => {
      const db = await database();
      const repository = new FakeRepository();
      const asset = "ab12cd34-0000-4000-8000-000000000001";
      const bundle = "cd34ef56-0000-4000-8000-000000000002";
      const blobs = new Map([
        ["a1", Buffer.from([1, 2, 3])],
        ["b1", Buffer.from([4, 5, 6])],
        ["bad", Buffer.from([7, 8, 9])],
      ]);
      const live = authorities(db, repository, [], { now: 0 }, { blobs });
      const answer = await live.intent(PROJECT, {
        clientId: "a1",
        accountId: "u1",
        by: "Ada",
        document: { doc: "assets", assetType: "image" },
        op: {
          op: "create-assets",
          assetType: "image",
          creates: [
            { record: { id: asset, name: "bg" }, bytes: { from: "transfer", parts: [{ path: null, transferId: "a1", size: 3, digest: DIGEST }] } },
            {
              record: { id: bundle, name: "model" },
              bytes: {
                from: "transfer",
                parts: [
                  { path: "textures/skin.png", transferId: "b1", size: 3, digest: DIGEST },
                  // Climbs out of the asset: never written anywhere.
                  { path: "../escape.png", transferId: "bad", size: 3, digest: DIGEST },
                ],
              },
            },
          ],
        },
        basedOn: 0,
      });
      expect(answer).toMatchObject({ kind: "effect" });
      for (const transfer of ["a1", "b1", "bad"]) await live.bytesArrived(PROJECT, transfer);
      await live.snapshot(PROJECT);
      const written = (repository.blobs.at(-1) ?? []).map((blob) => blob.path).sort();
      expect(written).toEqual([
        "assets/content/ab/12/cd34000040008000000000000001",
        "assets/content/cd/34/ef56000040008000000000000002/textures/skin.png",
      ]);
    });

    it("keeps a file's bytes once they arrive, so a restart before the next version does not lose them", async () => {
      const db = await database();
      const repository = new FakeRepository();
      const kept = new Map<string, Buffer>();
      const keeper: OwedBytesKeeper = {
        save: async (_project, transferId, bytes) => void kept.set(transferId, bytes),
        load: async (_project, transferId) => kept.get(transferId),
        drop: async (_project, transferId) => void kept.delete(transferId),
      };
      const blobs = new Map([["t1", Buffer.from([0, 2, 3])]]);
      const first = authorities(db, repository, [], { now: 0 }, { blobs, keeper });
      await first.intent(PROJECT, {
        clientId: "f1",
        accountId: "u1",
        by: "Ada",
        document: { doc: "file", path: "icon.png" },
        op: { op: "put-file", content: { blob: { transferId: "t1", digest: DIGEST, size: 3 } } },
        basedOn: 0,
      });
      await first.bytesArrived(PROJECT, "t1");
      expect(kept.get("t1")).toEqual(Buffer.from([0, 2, 3]));

      // A restart empties the blob store; the kept copy is what the version is written from.
      const second = authorities(db, repository, [], { now: 0 }, { blobs: new Map(), keeper });
      await second.snapshot(PROJECT);
      expect(repository.blobs.at(-1)).toEqual([{ path: "icon.png", bytes: Buffer.from([0, 2, 3]), replace: true }]);
      expect(kept.size).toBe(0);
      // And the version holds the bytes now, so a Studio starting from it gets them.
      expect((await second.base(PROJECT))?.files.get("icon.png")).toEqual(Buffer.from([0, 2, 3]));
    });
  });
});
