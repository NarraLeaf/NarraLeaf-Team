/**
 * Opening a project from its working copy keeps a picture's bytes as they are: a file that is not
 * text is held as base64, never decoded as UTF-8 on the way in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-project-files-");
let checkedOut = "";

vi.mock("../src/projects/workingCopy.js", async (actual) => ({
  ...(await actual<typeof import("../src/projects/workingCopy.js")>()),
  ensureWorkingCopy: async () => ({ path: checkedOut }),
  workingCopyHead: async () => undefined,
}));

const { openProjectFiles } = await import("../src/authority/project.js");

describe("opening a project's files", () => {
  it("holds a picture as its bytes", async () => {
    checkedOut = await temporaryRoot();
    const path = "resources/characters/avatars/aoi/smile.png";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
    await mkdir(join(checkedOut, "resources/characters/avatars/aoi"), { recursive: true });
    await writeFile(join(checkedOut, path), png);

    const loaded = await openProjectFiles({} as Parameters<typeof openProjectFiles>[0]);

    const held = loaded.files.get(path) as { encoding: string; data: string };
    expect(held.encoding).toBe("base64");
    expect(Buffer.from(held.data, "base64").equals(png)).toBe(true);
  });
});
