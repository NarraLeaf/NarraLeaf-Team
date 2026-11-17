import { describe, expect, it } from "vitest";

import type { AssetView, CharacterView, StoryRow, StoryScene, VariableView } from "../project-view/src/index.js";
import { assetUses, mergeOrder, rowRefs, runChecks, sameFile, tokens, wordDiff, type ProjectData } from "../web/src/projectData.js";

const command = (id: string, block: string, payload: Record<string, unknown>): StoryRow =>
  ({ id, depth: 0, disabled: false, kind: "command", command: block, block, payload }) as StoryRow;
const line = (id: string, text: string, characterId?: string): StoryRow =>
  characterId === undefined
    ? { id, depth: 0, disabled: false, kind: "narration", text }
    : { id, depth: 0, disabled: false, kind: "dialogue", speaker: { characterId }, text };

function project(scenes: StoryScene[], extra: Partial<Pick<ProjectData, "assets" | "characters" | "variables" | "present">> = {}): ProjectData {
  return {
    tree: { revision: "r1", files: [], total: 0 },
    stories: [
      {
        entry: { id: "s", name: "Story", documentPath: "story.json" },
        document: {
          supported: true,
          schemaVersion: 1,
          id: "s",
          name: "Story",
          chapters: [],
          unassignedSceneIds: scenes.map((scene) => scene.id),
          scenes: Object.fromEntries(scenes.map((scene) => [scene.id, scene])),
          order: scenes.map((scene) => scene.id),
        } as ProjectData["stories"][number]["document"],
      },
    ],
    characters: extra.characters ?? new Map<string, CharacterView>(),
    variables: extra.variables ?? new Map<string, VariableView>(),
    assets: extra.assets ?? new Map<string, AssetView>(),
    blueprints: undefined,
    present: extra.present ?? new Set<string>(),
  };
}

const asset = (id: string, name: string): AssetView => ({ id, type: "image", name, description: "", tags: [], contentPath: `assets/content/${id}` });

describe("rowRefs", () => {
  it("finds assets, characters, variables and scenes anywhere in a payload", () => {
    const refs = rowRefs(
      command("r", "action", {
        backgroundAssetId: "bg",
        nested: [{ assetId: "sfx" }, { characterId: "amy", variableId: "v1" }],
        target: "scene:two",
        targetSceneId: "three",
      }),
    );
    expect(refs.assets.sort()).toEqual(["bg", "sfx"]);
    expect(refs.characters).toEqual(["amy"]);
    expect(refs.variables).toEqual(["v1"]);
    expect(refs.scenes.sort()).toEqual(["three", "two"]);
  });

  it("reads labels, gotos and a dialogue's speaker", () => {
    expect(rowRefs(command("a", "control", { control: "label", name: "top" })).label).toBe("top");
    expect(rowRefs(command("b", "control", { control: "goto", targetLabel: "top" })).goto).toBe("top");
    expect(rowRefs(line("c", "hi", "amy")).characters).toEqual(["amy"]);
  });
});

describe("runChecks", () => {
  it("is quiet for a story whose references all resolve", () => {
    const data = project(
      [
        {
          id: "one",
          name: "One",
          backgroundAssetId: "bg",
          rows: [
            command("decl", "declaration", { scope: "saved" }),
            command("lab", "control", { control: "label", name: "top" }),
            command("set", "action", { variableId: "decl" }),
            command("go", "control", { control: "goto", targetLabel: "top" }),
            line("say", "hello", "amy"),
          ],
        },
      ],
      {
        assets: new Map([["bg", asset("bg", "Hall")]]),
        present: new Set(["assets/content/bg"]),
        characters: new Map([["amy", { id: "amy", name: "Amy", description: "", nicknames: [], avatarPath: "a.png" }]]),
      },
    );
    expect(runChecks(data)).toEqual([]);
  });

  it("names each kind of broken reference with the row it is on", () => {
    const data = project(
      [
        {
          id: "one",
          name: "One",
          rows: [
            command("img", "action", { assetId: "gone" }),
            command("unsynced", "action", { assetId: "far" }),
            command("jump", "jump", { targetSceneId: "nowhere" }),
            command("go", "control", { control: "goto", targetLabel: "missing" }),
            command("l1", "control", { control: "label", name: "twice" }),
            command("l2", "control", { control: "label", name: "twice" }),
            command("set", "action", { variableId: "elsewhere" }),
            line("who", "hi", "ghost"),
            line("bob1", "hi", "bob"),
            line("bob2", "again", "bob"),
            { id: "bad", depth: 0, disabled: false, kind: "invalid", text: "???" },
          ],
        },
        // A scene-scoped declaration in another scene doesn't declare it here.
        { id: "two", name: "Two", rows: [command("elsewhere", "declaration", { scope: "scene" })] },
      ],
      {
        assets: new Map([["far", asset("far", "Far")]]),
        characters: new Map([["bob", { id: "bob", name: "Bob", description: "", nicknames: [] }]]),
      },
    );
    const found = runChecks(data).map((finding) => [finding.kind, finding.subject, finding.place.line]);
    expect(found).toEqual([
      ["missingAsset", "gone", 1],
      ["unsyncedAsset", "Far", 2],
      ["missingScene", "nowhere", 3],
      ["missingLabel", "missing", 4],
      ["duplicateLabel", "twice", 5],
      ["undeclaredVariable", "elsewhere", 7],
      ["missingCharacter", "ghost", 8],
      ["noPortrait", "Bob", 9],
      ["invalidRow", "???", 11],
    ]);
  });

  it("lets the variable store and document-wide declarations count everywhere", () => {
    const data = project(
      [
        { id: "one", name: "One", rows: [command("use", "action", { variableId: "stored" }), command("use2", "action", { variableId: "wide" })] },
        { id: "two", name: "Two", rows: [command("wide", "declaration", { scope: "persistent" })] },
      ],
      { variables: new Map([["stored", { id: "stored", name: "Stored", scope: "saved", valueType: "number" }]]) },
    );
    expect(runChecks(data)).toEqual([]);
  });
});

describe("assetUses", () => {
  it("counts backgrounds and rows, with line numbers for rows", () => {
    const uses = assetUses(project([{ id: "one", name: "One", backgroundAssetId: "bg", rows: [line("n", "…"), command("c", "action", { assetId: "bg" })] }]));
    expect(uses.get("bg")?.map((place) => place.line)).toEqual([undefined, 2]);
  });
});

describe("diff helpers", () => {
  it("compares files by hash, then size", () => {
    expect(sameFile({ size: 1, hash: "a" }, { size: 2, hash: "a" })).toBe(true);
    expect(sameFile({ size: 1, hash: "a" }, { size: 1, hash: "b" })).toBe(false);
    expect(sameFile({ size: 1 }, { size: 2 })).toBe(false);
    expect(sameFile({ size: 1 }, { size: 1 })).toBeUndefined();
  });

  it("splits CJK text by character and other text by word", () => {
    expect(tokens("你好 world")).toEqual(["你", "好", " ", "world"]);
  });

  it("marks only the words that changed", () => {
    const pieces = wordDiff("the cat sat", "the dog sat");
    expect(pieces.filter((piece) => piece.kind !== "same").map((piece) => [piece.kind, piece.text])).toEqual([
      ["removed", "cat"],
      ["added", "dog"],
    ]);
    expect(
      wordDiff("今天下雨", "今天晴天")
        .filter((piece) => piece.kind === "same")
        .map((piece) => piece.text)
        .join(""),
    ).toBe("今天");
  });

  it("merges two orders, keeping removed rows where they were", () => {
    expect(mergeOrder(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { id: "a", kind: "same" },
      { id: "b", kind: "removed" },
      { id: "c", kind: "same" },
      { id: "d", kind: "added" },
    ]);
  });
});
