// Reading a Studio project package (src/projects/package.ts): the file an empty
// team project takes its first version from.
//
// One package here was written with Studio's own MessagePack encoder in Studio's
// own layout, so the reader is checked against the writer it has to agree with
// and not only against the fixture encoder beside these tests.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isLeftOut, packagePath, ProjectPackageError, readProjectPackage } from "../src/projects/package.js";
import { encodeMsgpack } from "./msgpack-fixture.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-package-");

/**
 * Four files - a project file, a story index, an empty asset and a session lock - laid out as
 * Studio's `writeProjectPackage` writes them, the index encoded by `msgpack-lite`.
 */
const STUDIO_PACKAGE_BASE64 =
  "TkxTUEtHAAJwcm9qZWN0LWZpbGV7InN0b3JpZXMiOltdfXiHpmZvcm1hdNkgbmFycmFsZWFmLXN0dWRpby5wcm9qZWN0LXBhY2th" +
  "Z2WndmVyc2lvbgKpY3JlYXRlZEF0uDIwMjYtMTEtMjVUMDA6MDA6MDAuMDAwWqtwcm9qZWN0TmFtZaREZW1vsXByb2plY3RJZGVu" +
  "dGlmaWVysGNvbS5leGFtcGxlLmRlbW+rZGlyZWN0b3JpZXOSpmVkaXRvcqxlZGl0b3Ivc3RvcnmlZmlsZXOUgqRwYXRoq2dhbWUu" +
  "bmxwcm9qpHNpemUMgqRwYXRot2VkaXRvci9zdG9yeS9pbmRleC5qc29upHNpemUOgqRwYXRot2VkaXRvci9hc3NldHMvZW1wdHku" +
  "dHh0pHNpemUAgqRwYXRoti5ubHN0dWRpby9zZXNzaW9uLmxvY2ukc2l6ZQE1AQAA";

const MAGIC = Buffer.from([0x4e, 0x4c, 0x53, 0x50, 0x4b, 0x47, 0x00, 2]);

/** A package in the current layout, from files and an index that may be told to lie. */
function pack(files: Array<[string, Buffer]>, index: Record<string, unknown> = {}): Buffer {
  const encoded = encodeMsgpack({
    format: "narraleaf-studio.project-package",
    version: 2,
    createdAt: "2026-11-25T00:00:00.000Z",
    projectName: "Demo",
    directories: [],
    files: files.map(([path, bytes]) => ({ path, size: bytes.length })),
    ...index,
  });
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(encoded.length, 0);
  return Buffer.concat([MAGIC, ...files.map(([, bytes]) => bytes), encoded, trailer]);
}

async function onDisk(bytes: Buffer): Promise<string> {
  const path = join(await temporaryRoot(), "upload.nlspkg");
  await writeFile(path, bytes);
  return path;
}

describe("reading a project package", () => {
  it("reads a package Studio wrote, and says where each file's bytes are", async () => {
    const bytes = Buffer.from(STUDIO_PACKAGE_BASE64, "base64");
    const read = await readProjectPackage(await onDisk(bytes));

    expect(read.projectName).toBe("Demo");
    expect(read.projectIdentifier).toBe("com.example.demo");
    expect(read.files.map((file) => file.path)).toEqual(["game.nlproj", "editor/story/index.json", "editor/assets/empty.txt"]);
    // Studio's session lock is the one machine's, never the project's.
    expect(read.leftOut).toBe(1);
    const story = read.files[1]!;
    expect(bytes.subarray(story.offset, story.offset + story.size).toString("utf8")).toBe('{"stories":[]}');
    expect(read.files[2]).toMatchObject({ size: 0 });
  });

  it("refuses a file that is not a package", async () => {
    await expect(readProjectPackage(await onDisk(Buffer.from("PK\u0003\u0004 not a package at all")))).rejects.toThrow(ProjectPackageError);
  });

  it("refuses an old-format package with the remedy rather than reading it", async () => {
    const legacy = Buffer.concat([Buffer.from([0x4e, 0x4c, 0x53, 0x50, 0x4b, 0x47, 0x00, 1]), encodeMsgpack({ files: [] }), Buffer.alloc(4)]);
    await expect(readProjectPackage(await onDisk(legacy))).rejects.toThrow("export the project again");
  });

  it("refuses a package whose sizes do not add up to what it carries", async () => {
    const whole = pack([["game.nlproj", Buffer.from("p")], ["a.json", Buffer.from("{}")]]);
    const lying = pack([["game.nlproj", Buffer.from("p")], ["a.json", Buffer.from("{}")]], {
      files: [{ path: "game.nlproj", size: 1 }, { path: "a.json", size: 5 }],
    });
    await expect(readProjectPackage(await onDisk(whole))).resolves.toBeDefined();
    await expect(readProjectPackage(await onDisk(lying))).rejects.toThrow("damaged or incomplete");
  });

  it("refuses a package that holds no project file at its top", async () => {
    await expect(readProjectPackage(await onDisk(pack([["editor/game.nlproj", Buffer.from("p")]])))).rejects.toThrow(".nlproj");
  });

  it("refuses a file named outside the project, or named twice", async () => {
    await expect(readProjectPackage(await onDisk(pack([["game.nlproj", Buffer.from("p")], ["../escape.txt", Buffer.from("x")]]))))
      .rejects.toThrow("outside the project");
    await expect(readProjectPackage(await onDisk(pack([["game.nlproj", Buffer.from("p")], ["A.txt", Buffer.from("x")], ["a.txt", Buffer.from("y")]]))))
      .rejects.toThrow("twice");
  });

  it("never takes a repository, Studio's own folder or build output from a package", async () => {
    const read = await readProjectPackage(await onDisk(pack([
      ["game.nlproj", Buffer.from("p")],
      [".lore/config.toml", Buffer.from("x")],
      [".nlstudio/services/panels.json", Buffer.from("x")],
      ["dist/game.exe", Buffer.from("x")],
      ["scripts/node_modules/x/index.js", Buffer.from("x")],
      [".loreignore", Buffer.from("x")],
    ])));
    // `.loreignore` is a policy file about this project, and it travels.
    expect(read.files.map((file) => file.path)).toEqual(["game.nlproj", ".loreignore"]);
    expect(read.leftOut).toBe(4);
  });
});

describe("package paths", () => {
  it("are relative, forward-slashed and never climb", () => {
    expect(packagePath("editor\\story\\index.json")).toBe("editor/story/index.json");
    for (const bad of ["/etc/passwd", "C:/x", "a/../b", "a//b", "./a", ""]) {
      expect(() => packagePath(bad)).toThrow(ProjectPackageError);
    }
  });

  it("leave out what Studio leaves out of an export", () => {
    expect(isLeftOut("editor/cache/x.bin")).toBe(true);
    expect(isLeftOut("editor/assets/remote/x.png")).toBe(true);
    expect(isLeftOut("editor/assets/local/x.png")).toBe(false);
  });
});
