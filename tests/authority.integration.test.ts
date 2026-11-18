// The project authority against a loreserver that is running: a team project's
// current state lives in the authority, and its history versions are ordinary
// revisions the authority commits.
//
// The round trip under test: an empty project takes its first revision from
// the authority, the authority opens from that revision, applies an edit with
// Studio's own appliers, snapshots it, and a fresh working copy reads the edit
// back out of the repository. And loreserver keeps serving throughout - the
// working copy is Team's own clone, never the store the server holds.
//
// Skipped unless NLTEAM_TEST_LORESERVER_ROOT names a directory it may write
// to. Unlike the other integration tests this one leaves the binary cache
// alone, so a machine that has already run Team uses the loreserver it has.
//
//   NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it node node_modules/vitest/vitest.mjs run tests/authority.integration.test.ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openProjectAuthority, snapshotProject } from "../src/authority/project.js";
import { dataRemoteUrl } from "../src/identity/config.js";
import { checkHealth, waitForHealth } from "../src/loreserver/health.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout, writeInstance } from "../src/loreserver/layout.js";
import { resolveArtifact } from "../src/loreserver/pin.js";
import { Supervisor } from "../src/loreserver/supervisor.js";
import { authorityWorkingCopyPath } from "../src/projects/cache.js";
import { newProjectId } from "../src/projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../src/projects/repository.js";
import { commitSnapshot, discardWorkingCopy, type WorkingCopyOptions } from "../src/projects/workingCopy.js";
import { storyDocumentPath, STORY_LIBRARY_PATH } from "../studio-kernel/vendor/kernel.js";
import { storageRootOf } from "../src/view.js";

const configuredRoot = process.env["NLTEAM_TEST_LORESERVER_ROOT"] ?? "";

/** Away from the defaults and from the other integration tests' pairs. */
const PORTS = { dataPort: 41457, healthPort: 41459 };
const UNCHECKED_TOKEN = "unchecked";

const STORY = "00000000-0000-4000-8000-000000000001";
const SCENE = "00000000-0000-4000-8000-000000000102";
const NOW = "2026-11-14T00:00:00.000Z";

const started: Supervisor[] = [];
afterAll(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

async function serving(): Promise<{ root: string; remote: string }> {
  await mkdir(configuredRoot, { recursive: true });
  const root = await mkdtemp(join(configuredRoot, "authority-"));
  const artifact = resolveArtifact();
  const layout = instanceLayout(root, artifact.binaryName);
  await ensureInstalled(layout, artifact);
  await writeInstance(layout, PORTS);
  const supervisor = new Supervisor({
    name: "loreserver",
    command: layout.binaryPath,
    args: ["--config", layout.configDir],
    logPath: layout.logPath,
  });
  started.push(supervisor);
  await supervisor.start();
  await waitForHealth(PORTS.healthPort, { timeoutMs: 60_000 });
  return { root, remote: dataRemoteUrl("127.0.0.1", PORTS.dataPort) };
}

/** A repository on that server, registered the way `project create` registers one. */
async function repository(name: string): Promise<string> {
  const id = newProjectId();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await repositoryCreate({ url: loreserverUrl(PORTS.dataPort), token: UNCHECKED_TOKEN, id, name });
      return id;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** A project's story files as Studio writes a new one. */
function publishedFiles(): Map<string, string> {
  const library = {
    schemaVersion: 2,
    stories: [{ id: STORY, name: "Story", documentPath: storyDocumentPath(STORY), createdAt: NOW, updatedAt: NOW }],
    defaultStoryId: STORY,
    meta: { createdAt: NOW, updatedAt: NOW },
  };
  const story = {
    schemaVersion: 31,
    id: STORY,
    name: "Story",
    entrySceneId: SCENE,
    chapters: [
      { id: "00000000-0000-4000-8000-000000000101", name: "Chapter 1", sceneIds: [SCENE], meta: { createdAt: NOW, updatedAt: NOW } },
    ],
    scenes: {
      [SCENE]: {
        id: SCENE,
        name: "Scene 1",
        runtimeName: "scene_1",
        description: "",
        rootBlockIds: [],
        blocks: {},
        meta: { createdAt: NOW, updatedAt: NOW },
      },
    },
    meta: { createdAt: NOW, updatedAt: NOW },
  };
  return new Map([
    [STORY_LIBRARY_PATH, JSON.stringify(library, null, 2)],
    [storyDocumentPath(STORY), JSON.stringify(story, null, 2)],
  ]);
}

describe.skipIf(configuredRoot === "")("the project authority and the repository", () => {
  it("takes a first revision, opens from it, snapshots an edit, and reads it back", async () => {
    const { root, remote } = await serving();
    const projectName = `authority-${Date.now().toString(36)}`;
    const projectId = await repository(projectName);
    const options: WorkingCopyOptions = { root, projectId, projectName, remote };

    // The project's first revision, as the Studio that publishes it would make it.
    const first = await commitSnapshot(options, publishedFiles(), "Publish");
    expect(first.revision).toMatch(/^[0-9a-f]+$/);
    expect(first.changed).toHaveLength(2);

    // Opened from the repository, the authority holds the story.
    const opened = await openProjectAuthority(options, { clock: () => NOW });
    expect(opened.unreadable).toEqual([]);
    expect([...opened.authority.paths()].sort()).toEqual([STORY_LIBRARY_PATH, storyDocumentPath(STORY)].sort());

    const effect = opened.authority.submit({
      clientId: "a1",
      by: "alice",
      document: { doc: "story", storyId: STORY },
      op: {
        op: "insert-block",
        sceneId: SCENE,
        block: {
          id: "row-1",
          kind: "nodeAction",
          parentId: null,
          childrenIds: [],
          payload: { action: "narration", text: { textId: "t-1", role: "narration", value: "Rain on the harbour." } },
        },
        target: { parentId: null },
      },
    });
    expect(effect).toMatchObject({ kind: "effect", seq: 1 });
    opened.authority.submit({ clientId: "a2", by: "alice", document: { doc: "story", storyId: STORY }, op: { op: "rename-story", name: "Harbour" } });

    const snapshot = await snapshotProject(options, opened.authority, "First draft");
    expect(snapshot.revision).toMatch(/^[0-9a-f]+$/);
    expect([...snapshot.changed].sort()).toEqual([STORY_LIBRARY_PATH, storyDocumentPath(STORY)].sort());

    // Nothing changed since: a periodic snapshot commits nothing.
    const idle = await snapshotProject(options, opened.authority);
    expect(idle.revision).toBeUndefined();
    expect(idle.changed).toEqual([]);

    // A fresh clone reads the edit back out of the repository.
    await discardWorkingCopy(root, projectId);
    const reopened = await openProjectAuthority(options);
    const story = reopened.authority.file(storyDocumentPath(STORY)) as {
      name: string;
      scenes: Record<string, { rootBlockIds: string[] }>;
    };
    expect(story.name).toBe("Harbour");
    expect(story.scenes[SCENE]!.rootBlockIds).toEqual(["row-1"]);
    expect((reopened.authority.file(STORY_LIBRARY_PATH) as { stories: Array<{ name: string }> }).stories[0]?.name).toBe("Harbour");

    // And the server kept serving, from a store the working copy never touched.
    expect(await checkHealth(PORTS.healthPort)).toBe(true);
    expect(authorityWorkingCopyPath(root, projectId).startsWith(storageRootOf(root))).toBe(false);
  }, 600_000);
});
