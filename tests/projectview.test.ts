import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assetContentPath,
  BLUEPRINT_DOCUMENT_MAX_SCHEMA,
  STORY_LIBRARY_MAX_SCHEMA,
  UI_GRAPHS_MAX_SCHEMA,
  readAssetRegister,
  readCharacters,
  readStoryDocument,
  readStoryLibrary,
  STORY_DOCUMENT_MAX_SCHEMA,
} from "../project-view/src/index.js";

/** A story document in Studio's shape, small enough to read at a glance. */
const DOCUMENT = {
  schemaVersion: 31,
  id: "s1",
  name: "主线",
  chapters: [{ id: "c1", name: "第一章", sceneIds: ["sc1"] }],
  unassignedSceneIds: ["sc2"],
  scenes: {
    sc1: {
      id: "sc1",
      name: "港口",
      rootBlockIds: ["b1", "b2", "b3"],
      blocks: {
        b1: { id: "b1", kind: "nodeAction", parentId: null, childrenIds: [], payload: { action: "narration", text: { textId: "t1", value: "海风很冷。", role: "narration" } } },
        b2: { id: "b2", kind: "nodeAction", parentId: null, childrenIds: [], payload: { action: "dialogue", characterId: "ch1", text: { textId: "t2", value: "你来了。", role: "dialogue" } } },
        b3: { id: "b3", kind: "nodeAction", parentId: null, childrenIds: ["b4"], payload: { action: "choice", prompt: { textId: "t3", value: "怎么回答？", role: "choicePrompt" } } },
        b4: { id: "b4", kind: "nodeAction", parentId: "b3", childrenIds: ["b5"], payload: { action: "choiceOption", text: { textId: "t4", value: "嗯。", role: "choiceText" } } },
        b5: { id: "b5", kind: "action", parentId: "b4", childrenIds: [], disabled: true, payload: { action: "setBackground", assetId: "a" } },
      },
    },
    sc2: { id: "sc2", name: "番外", rootBlockIds: [], blocks: {} },
    sc3: { id: "sc3", name: "孤儿", rootBlockIds: [], blocks: {} },
  },
};

describe("the story readers", () => {
  it("reads a library, and refuses a newer one rather than guessing", () => {
    expect(readStoryLibrary({ schemaVersion: 2, stories: [{ id: "s1", name: "主线", documentPath: "./editor/story/s1.json" }] })).toEqual({
      supported: true,
      stories: [{ id: "s1", name: "主线", documentPath: "editor/story/s1.json" }],
    });
    expect(readStoryLibrary({ schemaVersion: 99, stories: [] })).toEqual({ supported: false, schemaVersion: 99, reason: "newer" });
  });

  it("reads a document into scenes in reading order, rows indented by depth", () => {
    const view = readStoryDocument(DOCUMENT);
    if (!view.supported) throw new Error("not supported");
    expect(view.order).toEqual(["sc1", "sc2", "sc3"]);
    expect(view.scenes["sc1"]?.rows).toEqual([
      { id: "b1", depth: 0, disabled: false, kind: "narration", text: "海风很冷。" },
      { id: "b2", depth: 0, disabled: false, kind: "dialogue", speaker: { characterId: "ch1" }, text: "你来了。" },
      { id: "b3", depth: 0, disabled: false, kind: "choice", text: "怎么回答？" },
      { id: "b4", depth: 1, disabled: false, kind: "option", text: "嗯。" },
      { id: "b5", depth: 2, disabled: true, kind: "command", command: "setBackground" },
    ]);
  });

  it("refuses a document newer than it knows", () => {
    expect(readStoryDocument({ ...DOCUMENT, schemaVersion: STORY_DOCUMENT_MAX_SCHEMA + 1 })).toMatchObject({ supported: false, reason: "newer" });
    expect(readStoryDocument("nonsense")).toMatchObject({ supported: false, reason: "malformed" });
  });

  it("survives a block that names itself as its own child", () => {
    const looped = {
      ...DOCUMENT,
      scenes: { x: { id: "x", name: "x", rootBlockIds: ["a"], blocks: { a: { id: "a", kind: "empty", childrenIds: ["a"], payload: {} } } } },
    };
    const view = readStoryDocument(looped);
    if (!view.supported) throw new Error("not supported");
    expect(view.scenes["x"]?.rows).toHaveLength(1);
  });
});

describe("characters and assets", () => {
  it("reads characters by id", () => {
    const characters = readCharacters({ characters: [{ profile: { id: "ch1", name: "小林", description: "", nicknames: ["林"] } }] });
    expect(characters.get("ch1")?.name).toBe("小林");
  });

  it("reads a register and derives where each asset's bytes are", () => {
    expect(assetContentPath("ab12cd34-0000-0000-0000-000000000000")).toBe("assets/content/ab/12/cd34000000000000000000000000");
    expect(readAssetRegister("image", { "ab12cd34-0000-0000-0000-000000000000": { name: "海", ext: ".PNG", tags: ["bg"], description: "" } })).toEqual([
      {
        id: "ab12cd34-0000-0000-0000-000000000000",
        type: "image",
        name: "海",
        ext: "png",
        description: "",
        tags: ["bg"],
        contentPath: "assets/content/ab/12/cd34000000000000000000000000",
      },
    ]);
  });
});

describe("the blueprint reader", () => {
  it("reads blueprints into graphs of placed nodes and their edges", async () => {
    const { readBlueprints } = await import("../project-view/src/index.js");
    const view = readBlueprints({
      schemaVersion: 2,
      blueprintDocument: {
        schemaVersion: 14,
        ownerRecords: {},
        blueprints: {
          bp1: {
            id: "bp1",
            name: "Title screen",
            owner: { kind: "surfaceMain", surfaceId: "title" },
            graphs: {
              eventIds: ["e1"],
              events: {
                e1: {
                  id: "e1",
                  name: "On start",
                  graph: {
                    nodes: {
                      n1: { id: "n1", type: "event.onStart", ports: { exec: { kind: "output" } }, meta: { editorLayout: { x: 80, y: 40 } } },
                      n2: { id: "n2", type: "flow.playSound", ports: { exec: { kind: "input" } }, params: { asset: "a1" } },
                    },
                    edges: [{ from: { nodeId: "n1", port: "exec" }, to: { nodeId: "n2", port: "exec" } }],
                  },
                },
              },
              functions: {},
            },
          },
        },
      },
    });
    if (!view.supported) throw new Error("not supported");
    const graph = view.blueprints[0]?.graphs[0];
    expect(view.blueprints[0]?.owner).toBe("surfaceMain:title");
    expect(graph?.nodes.map((node) => [node.type, node.x, node.inputs, node.outputs])).toEqual([
      ["event.onStart", 80, [], ["exec"]],
      ["flow.playSound", undefined, ["exec"], []],
    ]);
    expect(graph?.edges).toHaveLength(1);
    expect(readBlueprints({ schemaVersion: 2, blueprintDocument: { schemaVersion: 99 } })).toMatchObject({ supported: false });
  });
});

describe("the Studio the readers follow", () => {
  // project-view/studio-schemas.json is a copy of Studio's src/shared/types/projectSchemas.json.
  // When Studio raises a schema, the copy brought across fails this until the reader for that
  // document has been looked at and its ceiling raised with it.
  it("reads up to the schema versions Studio writes, and no further", () => {
    const studio = JSON.parse(readFileSync(new URL("../project-view/studio-schemas.json", import.meta.url), "utf8")) as Record<string, number>;
    expect({
      storyLibrary: STORY_LIBRARY_MAX_SCHEMA,
      storyDocument: STORY_DOCUMENT_MAX_SCHEMA,
      uiGraphs: UI_GRAPHS_MAX_SCHEMA,
      blueprintDocument: BLUEPRINT_DOCUMENT_MAX_SCHEMA,
    }).toEqual(studio);
  });
});
