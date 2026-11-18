import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ProjectAuthority, type ProjectEffect } from "../src/authority/projectAuthority.js";
import { applyProjectOp, type KernelProjectView } from "../studio-kernel/vendor/kernel.js";

const STORY = "00000000-0000-4000-8000-000000000001";
const SCENE = "00000000-0000-4000-8000-000000000102";
const NOW = "2026-11-14T00:00:00.000Z";
const STORY_PATH = `editor/story/stories/${STORY}/storydoc.json`;
const LIBRARY = "editor/story/index.json";
const CAST = "editor/services/character.json";
const DOC = { doc: "story", storyId: STORY };

function story(rows: Record<string, unknown> = {}): object {
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
        rootBlockIds: Object.keys(rows),
        blocks: rows,
        meta: { createdAt: NOW, updatedAt: NOW },
      },
    },
    meta: { createdAt: NOW, updatedAt: NOW },
  };
}

function library(): object {
  return {
    schemaVersion: 2,
    stories: [{ id: STORY, name: "Story", documentPath: STORY_PATH, createdAt: NOW, updatedAt: NOW }],
    meta: { createdAt: NOW, updatedAt: NOW },
  };
}

function narration(id: string, value: string) {
  return { id, kind: "nodeAction", parentId: null, childrenIds: [], payload: { action: "narration", text: { textId: `t-${id}`, role: "narration", value } } };
}

function project(): ProjectAuthority {
  return new ProjectAuthority({
    files: new Map<string, unknown>([[LIBRARY, library()], [STORY_PATH, story()]]),
    clock: () => NOW,
  });
}

const insert = (id: string, value = id) => ({ op: "insert-block", sceneId: SCENE, block: narration(id, value), target: { parentId: null } });
const update = (id: string, value: string) => ({ op: "update-block", sceneId: SCENE, blockId: id, payload: narration(id, value).payload });

type Scene = { rootBlockIds: string[]; blocks: Record<string, { payload: unknown }> };
const sceneOf = (server: ProjectAuthority): Scene => (server.file(STORY_PATH) as { scenes: Record<string, Scene> }).scenes[SCENE]!;

describe("the project authority", () => {
  it("applies intents in order, numbers them, and says which files they wrote", () => {
    const server = project();
    const first = server.submit({ clientId: "a1", by: "alice", document: DOC, op: insert("r1") });
    const second = server.submit({ clientId: "b1", by: "bob", document: DOC, op: { op: "rename-story", name: "Harbour" } });
    expect(first).toMatchObject({ kind: "effect", seq: 1, touched: [STORY_PATH] });
    expect(second).toMatchObject({ kind: "effect", seq: 2, touched: [STORY_PATH, LIBRARY] });
    expect(sceneOf(server).rootBlockIds).toEqual(["r1"]);
    expect((server.file(LIBRARY) as { stories: Array<{ name: string }> }).stories[0]!.name).toBe("Harbour");
  });

  it("gives a resent intent its first answer and applies it once", () => {
    const server = project();
    const intent = { clientId: "a1", by: "alice", document: DOC, op: insert("r1") };
    const first = server.submit(intent);
    expect(server.submit(intent)).toBe(first);
    expect(server.seq).toBe(1);
  });

  it("leaves nothing behind of an operation that does not apply", () => {
    const server = project();
    const before = server.serialize();
    const answer = server.submit({ clientId: "a1", by: "alice", document: DOC, op: { op: "delete-block", sceneId: "nope", blockId: "r" } });
    expect(answer).toMatchObject({ kind: "refusal", reason: "rejected" });
    expect(server.serialize()).toEqual(before);
    expect(server.seq).toBe(0);
  });

  it("refuses a verb the kernel does not know, and a record that is gone", () => {
    const server = project();
    expect(server.submit({ clientId: "x", by: "a", document: DOC, op: { op: "teleport" } })).toMatchObject({ reason: "rejected" });
    expect(server.submit({ clientId: "y", by: "a", document: DOC, op: { op: "rename-chapter", chapterId: "gone", name: "N" } }))
      .toMatchObject({ reason: "nothing-there" });
  });

  it("makes and removes whole stories", () => {
    const server = project();
    const other = "00000000-0000-4000-8000-000000000009";
    const otherPath = `editor/story/stories/${other}/storydoc.json`;
    const made = server.submit({
      clientId: "s1",
      by: "alice",
      document: { doc: "story", storyId: other },
      op: {
        op: "create-story",
        entry: { id: other, name: "Side", documentPath: otherPath, createdAt: NOW, updatedAt: NOW },
        document: { ...story(), id: other, name: "Side" },
      },
    });
    expect(made).toMatchObject({ kind: "effect", touched: [otherPath, LIBRARY] });
    expect(server.paths()).toContain(otherPath);
    server.submit({ clientId: "s2", by: "alice", document: { doc: "story", storyId: other }, op: { op: "delete-story" } });
    expect(server.paths()).not.toContain(otherPath);
    expect(server.serialize().has(otherPath)).toBe(false);
  });

  it("takes a project's first story when it has no story library yet", () => {
    // A project nobody has written a story in has no editor/story/index.json.
    const server = new ProjectAuthority({ files: new Map<string, unknown>(), clock: () => NOW });
    const first = "00000000-0000-4000-8000-000000000010";
    const firstPath = `editor/story/stories/${first}/storydoc.json`;
    const made = server.submit({
      clientId: "f1",
      by: "alice",
      document: { doc: "story", storyId: first },
      op: {
        op: "create-story",
        entry: { id: first, name: "Main", documentPath: firstPath, createdAt: NOW, updatedAt: NOW },
        document: { ...story(), id: first, name: "Main" },
      },
    });
    expect(made).toMatchObject({ kind: "effect", touched: [firstPath, LIBRARY] });
    expect(server.paths()).toEqual(expect.arrayContaining([firstPath, LIBRARY]));
    expect(JSON.parse(String(server.serialize().get(LIBRARY))).stories.map((entry: { id: string }) => entry.id)).toEqual([first]);
  });

  it("applies an operation that reaches another document: a deleted character's rows", () => {
    const row = { id: "r1", kind: "nodeAction", parentId: null, childrenIds: [], payload: { action: "dialogue", characterId: "alice", text: { textId: "t1", role: "dialogue", value: "hi" } } };
    const server = new ProjectAuthority({
      files: new Map<string, unknown>([
        [LIBRARY, library()],
        [STORY_PATH, story({ r1: row })],
        [CAST, { version: 1, characters: [{ profile: { id: "alice", name: "Alice" } }] }],
      ]),
      clock: () => NOW,
    });
    const answer = server.submit({ clientId: "c1", by: "bob", document: { doc: "characters" }, op: { op: "delete-character", characterId: "alice" } });
    expect(answer).toMatchObject({ kind: "effect", touched: [CAST, STORY_PATH] });
    expect((sceneOf(server).blocks.r1!.payload as { speakerName?: string }).speakerName).toBe("Alice");
  });

  it("lands an offline edit nobody else touched, and refuses one to a row changed since", () => {
    const server = project();
    server.submit({ clientId: "s1", by: "alice", document: DOC, op: insert("r1") });
    server.submit({ clientId: "s2", by: "alice", document: DOC, op: insert("r2") });
    const seen = server.seq;
    server.submit({ clientId: "a", by: "alice", document: DOC, op: update("r1", "alice's") });
    expect(server.submit({ clientId: "b2", by: "bob", basedOn: seen, document: DOC, op: update("r2", "bob's") })).toMatchObject({ kind: "effect" });
    expect(server.submit({ clientId: "b1", by: "bob", basedOn: seen, document: DOC, op: update("r1", "bob's") }))
      .toMatchObject({ kind: "refusal", reason: "conflict", conflicts: ["row:r1"] });
  });

  it("hands a Studio that missed something what it needs to arrive at the same files", () => {
    const server = project();
    const studio = new Map<string, unknown>([[LIBRARY, library()], [STORY_PATH, story()]]);
    const view: KernelProjectView = {
      get: (path) => studio.get(path),
      set: (path, value) => void studio.set(path, value),
      delete: (path) => void studio.delete(path),
    };
    server.submit({ clientId: "a1", by: "alice", document: DOC, op: insert("r1") });
    server.submit({ clientId: "a2", by: "alice", document: DOC, op: { op: "rename-story", name: "Renamed" } });
    for (const effect of server.since(0) as ProjectEffect[]) {
      applyProjectOp(view, effect.document, structuredClone(effect.op), { now: effect.at });
    }
    expect(studio.get(STORY_PATH)).toEqual(server.file(STORY_PATH));
    expect(studio.get(LIBRARY)).toEqual(server.file(LIBRARY));
  });

  it("persists before it counts, and a refused persist changes nothing", () => {
    const written: number[] = [];
    let fail = false;
    const server = new ProjectAuthority({
      files: new Map<string, unknown>([[LIBRARY, library()], [STORY_PATH, story()]]),
      persist: (effect) => {
        if (fail) throw new Error("disk full");
        written.push(effect.seq);
      },
    });
    server.submit({ clientId: "a", by: "x", document: DOC, op: insert("r1") });
    fail = true;
    expect(() => server.submit({ clientId: "b", by: "x", document: DOC, op: insert("r2") })).toThrow("disk full");
    expect(written).toEqual([1]);
    expect(server.seq).toBe(1);
    expect(sceneOf(server).rootBlockIds).toEqual(["r1"]);
  });

  it("runs a kernel bundled from Studio, with a stamp saying which", () => {
    const stamp = JSON.parse(readFileSync(new URL("../studio-kernel/vendor/stamp.json", import.meta.url), "utf8"));
    expect(typeof stamp.studioCommit).toBe("string");
    expect(ProjectAuthority.kernelVersion).toBe(4);
  });
});
