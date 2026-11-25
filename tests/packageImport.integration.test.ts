// A team project made from a Studio project package, against a loreserver that
// is running: the package's files become the empty repository's first revision,
// a fresh clone reads them back byte for byte, and a repository that already
// has a revision is refused before anything is written.
//
// Skipped unless NLTEAM_TEST_LORESERVER_ROOT names a directory it may write to,
// like tests/authority.integration.test.ts, whose harness this follows.
//
//   NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it node node_modules/vitest/vitest.mjs run tests/packageImport.integration.test.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openProjectFiles } from "../src/authority/project.js";
import { dataRemoteUrl } from "../src/identity/config.js";
import { waitForHealth } from "../src/loreserver/health.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout, writeInstance } from "../src/loreserver/layout.js";
import { resolveArtifact } from "../src/loreserver/pin.js";
import { Supervisor } from "../src/loreserver/supervisor.js";
import { copyPackageFiles, readProjectPackage } from "../src/projects/package.js";
import { newProjectId } from "../src/projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../src/projects/repository.js";
import {
  discardWorkingCopy,
  ensureWorkingCopy,
  readWorkingBytes,
  RepositoryNotEmptyError,
  seedWorkingCopy,
  type WorkingCopyOptions,
} from "../src/projects/workingCopy.js";
import { storyDocumentPath, STORY_LIBRARY_PATH } from "../studio-kernel/vendor/kernel.js";
import { encodeMsgpack } from "./msgpack-fixture.js";

const configuredRoot = process.env["NLTEAM_TEST_LORESERVER_ROOT"] ?? "";
/** Away from the defaults and from the other integration tests' pairs. */
const PORTS = { dataPort: 41467, healthPort: 41469 };
const UNCHECKED_TOKEN = "unchecked";
const STORY = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-11-25T00:00:00.000Z";

const started: Supervisor[] = [];
afterAll(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

async function serving(): Promise<{ root: string; remote: string }> {
  await mkdir(configuredRoot, { recursive: true });
  const root = await mkdtemp(join(configuredRoot, "package-"));
  const artifact = resolveArtifact();
  const layout = instanceLayout(root, artifact.binaryName);
  await ensureInstalled(layout, artifact);
  await writeInstance(layout, PORTS);
  const supervisor = new Supervisor({ name: "loreserver", command: layout.binaryPath, args: ["--config", layout.configDir], logPath: layout.logPath });
  started.push(supervisor);
  await supervisor.start();
  await waitForHealth(PORTS.healthPort, { timeoutMs: 60_000 });
  return { root, remote: dataRemoteUrl("127.0.0.1", PORTS.dataPort) };
}

async function repository(name: string): Promise<string> {
  const id = newProjectId();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await repositoryCreate({ url: loreserverUrl(PORTS.dataPort), token: UNCHECKED_TOKEN, id, name });
      return id;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** A small project as Studio exports it: a project file, a story library and story, and a picture. */
function projectFiles(): Array<[string, Buffer]> {
  const library = {
    schemaVersion: 2,
    stories: [{ id: STORY, name: "Story", documentPath: storyDocumentPath(STORY), createdAt: NOW, updatedAt: NOW }],
    defaultStoryId: STORY,
    meta: { createdAt: NOW, updatedAt: NOW },
  };
  const story = { schemaVersion: 31, id: STORY, name: "Story", entrySceneId: null, chapters: [], scenes: {}, meta: { createdAt: NOW, updatedAt: NOW } };
  const picture = Buffer.alloc(70_000);
  for (let index = 0; index < picture.length; index += 1) picture[index] = (index * 31) % 251;
  return [
    ["harbour.nlproj", encodeMsgpack({ name: "Harbour", identifier: "com.example.harbour" })],
    [STORY_LIBRARY_PATH, Buffer.from(JSON.stringify(library, null, 2))],
    [storyDocumentPath(STORY), Buffer.from(JSON.stringify(story, null, 2))],
    ["editor/assets/local/backgrounds/harbour.bin", picture],
    [".nlstudio/session.lock", Buffer.from("this machine's")],
  ];
}

async function packageOnDisk(root: string, files: Array<[string, Buffer]>): Promise<string> {
  const index = encodeMsgpack({
    format: "narraleaf-studio.project-package",
    version: 2,
    createdAt: NOW,
    projectName: "Harbour",
    directories: [],
    files: files.map(([path, bytes]) => ({ path, size: bytes.length })),
  });
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(index.length, 0);
  const path = join(root, "harbour.nlspkg");
  await writeFile(path, Buffer.concat([Buffer.from([0x4e, 0x4c, 0x53, 0x50, 0x4b, 0x47, 0x00, 2]), ...files.map(([, bytes]) => bytes), index, trailer]));
  return path;
}

describe.skipIf(configuredRoot === "")("a team project made from a project package", () => {
  it("becomes the empty repository's first revision, and a fresh clone reads it back", async () => {
    const { root, remote } = await serving();
    const projectName = `package-${Date.now().toString(36)}`;
    const projectId = await repository(projectName);
    const options: WorkingCopyOptions = { root, projectId, projectName, remote };
    const files = projectFiles();
    const source = await packageOnDisk(root, files);
    const read = await readProjectPackage(source);

    const seeded = await seedWorkingCopy(options, (place) => copyPackageFiles(source, read.files, place), "Imported from a project package (Harbour)");
    expect(seeded.revision).toMatch(/^[0-9a-f]+$/);
    expect([...seeded.changed].sort()).toEqual(files.slice(0, 4).map(([path]) => path).sort());

    // Thrown away and cloned again: what comes back is the repository's, not the copy's.
    await discardWorkingCopy(root, projectId);
    const copy = await ensureWorkingCopy(options);
    for (const [path, bytes] of files.slice(0, 4)) {
      expect((await readWorkingBytes(copy, path))?.equals(bytes)).toBe(true);
    }
    expect(await readWorkingBytes(copy, ".nlstudio/session.lock")).toBeUndefined();

    // And the authority opens the project from that revision.
    const opened = await openProjectFiles(options);
    expect(opened.revision).toBe(seeded.revision);
    expect([...opened.files.keys()]).toEqual(expect.arrayContaining([STORY_LIBRARY_PATH, storyDocumentPath(STORY)]));

    // A second package into the same project is refused, and the first version stands.
    await expect(seedWorkingCopy(options, (place) => copyPackageFiles(source, read.files, place), "Again")).rejects.toThrow(RepositoryNotEmptyError);
    expect((await openProjectFiles(options)).revision).toBe(seeded.revision);
  }, 600_000);
});
