// What Team says about a project file, including every way it can fail to read
// one.
//
// These drive the reader itself rather than a copy of it. What they stand in
// for is the transport: a revision arrives here as a list of entries and
// something that hands back bytes, which is exactly what a walked repository
// hands it, so everything about how a file is understood is under test and
// nothing about how it travelled is.
//
// The rule every one of them is about: Team reads as far as it understands and
// says unknown for the rest. Not an error, not an empty panel, not a refusal.
import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_FILE_BYTES,
  PROJECT_FILE_SCHEMA,
  readProjectFile,
  revisionSizes,
  type RevisionFile,
  type RevisionSource,
} from "../src/projects/content.js";
import { encodeMsgpack, realProjectFile } from "./msgpack-fixture.js";

/** A revision, and the paths that have been fetched from it. */
type TestRevision = RevisionSource & { readonly fetched: readonly string[] };

/**
 * A revision made of named files, each with the bytes it should answer with.
 *
 * A number in place of bytes is a size the tree reports for a file nothing
 * will hand over, and `fetched` says which paths were asked for. Both are here
 * for the limits that are checked against the tree rather than against a
 * buffer: the only way to say a file was refused before it was read is to
 * watch whether it was read.
 */
function revision(entries: Record<string, Buffer | string | number>): TestRevision {
  const bytes = new Map<string, Buffer>();
  const files: RevisionFile[] = [];
  const fetched: string[] = [];

  for (const [path, value] of Object.entries(entries)) {
    if (typeof value === "number") {
      files.push({ path, size: value });
      continue;
    }
    const held = typeof value === "string" ? Buffer.from(value, "utf-8") : value;
    bytes.set(path, held);
    files.push({ path, size: held.length });
  }

  return {
    files,
    fetched,
    async read(file) {
      fetched.push(file.path);
      const found = bytes.get(file.path);
      if (found === undefined) {
        throw new Error(`${file.path} is not in this revision`);
      }
      return found;
    },
  };
}

/** The shape Studio writes: MessagePack, named for the project. */
function projectFile(extra: Record<string, unknown> = {}): Buffer {
  return encodeMsgpack({
    name: "A Harbour Tale",
    identifier: "harbour",
    metadata: { description: "", resolution: { width: 1920, height: 1080 } },
    ...extra,
  });
}

/** An asset id, and where its bytes live under the content directory. */
function asset(id: string): string {
  const hex = id.replaceAll("-", "");
  return `assets/content/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
}

const IMAGE_ID = "64ce569f-7104-4c57-9baf-20d14d1e0ddb";
const AUDIO_ID = "2c8f3d76-7a4c-4ba6-853e-253b10175394";

describe("a project Team can read", () => {
  it("says what it is and how big its stage is", async () => {
    const file = await readProjectFile(revision({ "Harbour.nlproj": projectFile() }));

    expect(file.readable).toBe(true);
    expect(file.title).toBe("A Harbour Tale");
    expect(file.stageWidth).toBe(1920);
    expect(file.stageHeight).toBe(1080);
  });

  it("reads the older spelling of the same file", async () => {
    const file = await readProjectFile(
      revision({
        "project.json": JSON.stringify({
          name: "Lighthouse",
          metadata: { resolution: { width: 1280, height: 720 } },
        }),
      }),
    );

    expect(file.readable).toBe(true);
    expect(file.title).toBe("Lighthouse");
    expect(file.stageWidth).toBe(1280);
  });

  it("counts the assets, sizes them, and breaks them down by kind", async () => {
    const source = revision({
      "Harbour.nlproj": projectFile(),
      "assets/assets.metadata.image.json": JSON.stringify({ [IMAGE_ID]: { type: "image" } }),
      "assets/assets.metadata.audio.json": JSON.stringify({ [AUDIO_ID]: { type: "audio" } }),
      "assets/assets.metadata.video.json": JSON.stringify({}),
      [asset(IMAGE_ID)]: Buffer.alloc(4096),
      [asset(AUDIO_ID)]: Buffer.alloc(1024),
    });

    const file = await readProjectFile(source);

    expect(file.assets).toBe(2);
    expect(file.assetBytes).toBe(4096 + 1024);
    expect(file.assetsByKind).toEqual([
      { kind: "image", count: 1, bytes: 4096 },
      { kind: "audio", count: 1, bytes: 1024 },
    ]);
  });

  it("counts the scenes across every story", async () => {
    const source = revision({
      "Harbour.nlproj": projectFile(),
      "editor/story/index.json": JSON.stringify({
        stories: [
          { documentPath: "editor/story/stories/one/storydoc.json" },
          { documentPath: "editor/story/stories/two/storydoc.json" },
        ],
      }),
      "editor/story/stories/one/storydoc.json": JSON.stringify({
        schemaVersion: 15,
        scenes: { a: {}, b: {}, c: {} },
      }),
      "editor/story/stories/two/storydoc.json": JSON.stringify({ scenes: { d: {} } }),
    });

    expect((await readProjectFile(source)).scenes).toBe(4);
  });

  it("adds up every file in the revision, not only the assets", () => {
    const source = revision({
      "Harbour.nlproj": Buffer.alloc(100),
      [asset(IMAGE_ID)]: Buffer.alloc(900),
    });

    expect(revisionSizes(source).totalBytes).toBe(1000);
  });

  it("reports a project with nothing in it as empty rather than as unknown", async () => {
    // Zero is a fact about a new project. Absent is a fact about Team. The
    // interface draws them differently and this is the row that keeps them
    // apart at the source.
    const file = await readProjectFile(revision({ "Harbour.nlproj": projectFile() }));

    expect(file.readable).toBe(true);
    expect(file.assets).toBeUndefined();
    expect(file.assetsByKind).toBeUndefined();
  });
});

describe("a project file Team cannot read", () => {
  /** Every refusal has to be a sentence, and no refusal may be a throw. */
  async function refusalFor(source: RevisionSource): Promise<string> {
    const file = await readProjectFile(source);
    expect(file.readable).toBe(false);
    expect(file.title).toBeUndefined();
    expect(typeof file.reason).toBe("string");
    return file.reason ?? "";
  }

  it("says which schema it is and which one Team reads", async () => {
    const reason = await refusalFor(
      revision({ "Harbour.nlproj": projectFile({ schemaVersion: PROJECT_FILE_SCHEMA + 3 }) }),
    );

    expect(reason).toContain(`schema ${PROJECT_FILE_SCHEMA + 3}`);
    expect(reason).toContain(`up to ${PROJECT_FILE_SCHEMA}`);
    expect(reason).toMatch(/newer Studio/i);
  });

  it("says a half-written file is a half-written file", async () => {
    const whole = projectFile();
    const reason = await refusalFor(
      revision({ "Harbour.nlproj": whole.subarray(0, Math.floor(whole.length / 2)) }),
    );

    expect(reason).toContain("Harbour.nlproj");
    expect(reason).toMatch(/ends after|partly written/i);
  });

  it("says so when the file is not the shape its name claims", async () => {
    const reason = await refusalFor(
      revision({ "project.json": "this is not JSON, it is an apology" }),
    );

    expect(reason).toContain("project.json");
    expect(reason).toMatch(/not the JSON/i);
  });

  it("says so when there is no project file at all", async () => {
    const reason = await refusalFor(revision({ "editor/story/index.json": "{}" }));

    expect(reason).toMatch(/no project file/i);
  });

  it("does not take a project file out of a subdirectory", async () => {
    // A file of that name deeper in the tree is somebody's example or backup,
    // not the project. Reading one would describe the wrong thing confidently.
    const reason = await refusalFor(revision({ "editor/samples/project.json": "{}" }));

    expect(reason).toMatch(/no project file/i);
  });

  it("keeps the parts it did understand when a later one is unreadable", async () => {
    // The point of the whole rule: an asset register Team cannot parse costs
    // the breakdown and nothing else.
    const file = await readProjectFile(
      revision({
        "Harbour.nlproj": projectFile(),
        "assets/assets.metadata.image.json": "{ truncated",
        [asset(IMAGE_ID)]: Buffer.alloc(512),
      }),
    );

    expect(file.readable).toBe(true);
    expect(file.title).toBe("A Harbour Tale");
    expect(file.assetBytes).toBe(512);
    expect(file.assets).toBeUndefined();
    expect(file.assetsByKind).toBeUndefined();
  });

  it("leaves the breakdown out rather than reporting every kind as weightless", async () => {
    // Ids that match nothing under the content directory mean the layout is
    // not the one this reads. A table of zeroes would look like a project made
    // of empty files.
    const file = await readProjectFile(
      revision({
        "Harbour.nlproj": projectFile(),
        "assets/assets.metadata.image.json": JSON.stringify({ "not-an-id": { type: "image" } }),
        [asset(IMAGE_ID)]: Buffer.alloc(512),
      }),
    );

    expect(file.readable).toBe(true);
    expect(file.assets).toBe(1);
    expect(file.assetBytes).toBe(512);
    expect(file.assetsByKind).toBeUndefined();
  });

  it("refuses a project file too large to be one, without fetching it", async () => {
    // What makes this worth a limit is not a corrupt file. It is a file
    // somebody committed at the path Team looks at, in a repository their
    // collaborators share, which the pass in src/projects/refresh.ts fetches
    // for every project on the server once a minute for as long as it runs.
    const source = revision({ "Harbour.nlproj": MAX_PROJECT_FILE_BYTES + 1 });

    const reason = await refusalFor(source);

    expect(reason).toContain("Harbour.nlproj");
    expect(reason).toContain(MAX_PROJECT_FILE_BYTES.toLocaleString("en-US"));
    // The assertion the whole fix is about: the bytes were never asked for. A
    // limit that fired after the read would have allocated the file first,
    // which is the cost it exists to refuse.
    expect(source.fetched).toEqual([]);
  });

  it("leaves room for a project file thousands of times the size of a real one", () => {
    // The reasoning behind the ceiling, put somewhere it can fail. This is a
    // project file a real Studio wrote, byte for byte, and the limit is three
    // orders of magnitude above it — so a file that meets the limit is not a
    // project file that grew, it is something else wearing the name.
    expect(realProjectFile().length * 1000).toBeLessThan(MAX_PROJECT_FILE_BYTES);
  });

  it("does not fetch a story index too large to be one", async () => {
    // The index is at a fixed path, so it is reachable by exactly the same
    // route as the project file. The degradation rule decides what happens
    // next: the count is absent, and everything else about the project is not.
    const source = revision({
      "Harbour.nlproj": projectFile(),
      "editor/story/index.json": 64 * 1024 * 1024,
    });

    const file = await readProjectFile(source);

    expect(file.readable).toBe(true);
    expect(file.title).toBe("A Harbour Tale");
    expect(file.scenes).toBeUndefined();
    expect(source.fetched).toEqual(["Harbour.nlproj"]);
  });

  it("does not count the scenes it could only count some of", async () => {
    const file = await readProjectFile(
      revision({
        "Harbour.nlproj": projectFile(),
        "editor/story/index.json": JSON.stringify({
          stories: [
            { documentPath: "editor/story/stories/one/storydoc.json" },
            { documentPath: "editor/story/stories/gone/storydoc.json" },
          ],
        }),
        "editor/story/stories/one/storydoc.json": JSON.stringify({ scenes: { a: {} } }),
      }),
    );

    expect(file.readable).toBe(true);
    expect(file.scenes).toBeUndefined();
  });
});
