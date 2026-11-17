/**
 * Reading a NarraLeaf Studio project, read-only, in a browser.
 *
 * The Team server hands over a revision's files as bytes and never interprets
 * them (docs/architecture.md, D2); this package is what interprets them, in the
 * web console. It is zero-dependency and does no I/O: every reader takes parsed
 * JSON and answers a plain view model, so it runs anywhere and is tested
 * without a repository.
 *
 * **Tolerant downward, refusing upward.** Every document carries a schema
 * number. A number this build knows, or an older one, is read for the fields
 * it has; a newer one is reported as `{ supported: false }` and not read at
 * all, because a field whose meaning changed is worse than a field left out —
 * the same rule Team's own project-file reader follows. The ceilings below
 * are the schema versions of the Studio this was written against
 * (`STORY_DOCUMENT_SCHEMA_VERSION`, `STORY_LIBRARY_INDEX_SCHEMA_VERSION`).
 *
 * The paths are Studio's layout:
 *
 *     editor/story/index.json                the story library
 *     <documentPath from the library>        one story document
 *     editor/services/character.json         the characters
 *     assets/assets.metadata.<type>.json     one asset register per type
 *     assets/content/<2>/<2>/<rest of hex>   one asset's bytes
 */

/** The newest story library schema this reads. */
export const STORY_LIBRARY_MAX_SCHEMA = 2;
/** The newest story document schema this reads. */
export const STORY_DOCUMENT_MAX_SCHEMA = 31;

export const STORY_INDEX_PATH = "editor/story/index.json";
export const CHARACTER_STORE_PATH = "editor/services/character.json";
export const ASSET_REGISTER_PATTERN = /^assets\/assets\.metadata\.([A-Za-z0-9_-]+)\.json$/;

type Json = unknown;

function record(value: Json): Record<string, Json> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function text(value: Json): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function list(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}

/** A document this build will not read, and why. */
export interface Unsupported {
  readonly supported: false;
  readonly schemaVersion: number | undefined;
  readonly reason: "newer" | "malformed";
}

function unsupported(schemaVersion: number | undefined, reason: Unsupported["reason"]): Unsupported {
  return { supported: false, schemaVersion, reason };
}

/* --------------------------------------------------------------- library */

export interface StoryEntry {
  readonly id: string;
  readonly name: string;
  readonly documentPath: string;
  readonly dlcId?: string;
}

export interface StoryLibrary {
  readonly supported: true;
  readonly stories: readonly StoryEntry[];
  readonly defaultStoryId?: string;
}

export function readStoryLibrary(json: Json): StoryLibrary | Unsupported {
  const root = record(json);
  if (root === undefined) return unsupported(undefined, "malformed");
  const version = typeof root["schemaVersion"] === "number" ? root["schemaVersion"] : undefined;
  if (version !== undefined && version > STORY_LIBRARY_MAX_SCHEMA) return unsupported(version, "newer");
  const stories: StoryEntry[] = [];
  for (const entry of list(root["stories"])) {
    const story = record(entry);
    const id = text(story?.["id"]);
    const documentPath = text(story?.["documentPath"]);
    if (story === undefined || id === undefined || documentPath === undefined) continue;
    const dlcId = text(story["dlcId"]);
    stories.push({ id, name: text(story["name"]) ?? id, documentPath: normalisePath(documentPath), ...(dlcId === undefined ? {} : { dlcId }) });
  }
  const defaultStoryId = text(root["defaultStoryId"]);
  return { supported: true, stories, ...(defaultStoryId === undefined ? {} : { defaultStoryId }) };
}

/** A repository-relative path as the tree lists it: forward slashes, no leading slash or `./`. */
export function normalisePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\/+/, "");
}

/* -------------------------------------------------------------- document */

/** How a line of the script reads, which is all a viewer needs to draw it. */
export type StoryRow =
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "narration"; readonly text: string; readonly textId?: string }
  | {
      readonly id: string;
      readonly depth: number;
      readonly disabled: boolean;
      readonly kind: "dialogue";
      /** A Studio character, resolved through {@link readCharacters}, or a bare name. */
      readonly speaker: { readonly characterId: string } | { readonly name: string } | undefined;
      readonly text: string;
      /** The line's translation unit and voice id: one key for text, translation and voice. */
      readonly textId?: string;
      /** The clip the line plays, as an asset id. */
      readonly voiceAssetId?: string;
    }
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "choice"; readonly text: string; readonly textId?: string }
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "option"; readonly text: string; readonly textId?: string }
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "note"; readonly text: string }
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "invalid"; readonly text: string }
  | { readonly id: string; readonly depth: number; readonly disabled: boolean; readonly kind: "empty" }
  /**
   * Everything that is a step rather than a line — a background, a character
   * entering, a jump, a condition, a variable — as the command it is, with the
   * one word that says what it acts on. Folded by default in a viewer.
   */
  | {
      readonly id: string;
      readonly depth: number;
      readonly disabled: boolean;
      readonly kind: "command";
      readonly command: string;
      readonly detail?: string;
      /** The block's own kind (`action`, `control`, `jump`, `declaration`, `nodeAction`…). */
      readonly block: string;
      /** Everything the block says, for a viewer that names what the step acts on. */
      readonly payload: Readonly<Record<string, Json>>;
    };

export interface StoryScene {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** The image the scene opens on, as an asset id. */
  readonly backgroundAssetId?: string;
  readonly rows: readonly StoryRow[];
}

export interface StoryChapter {
  readonly id: string;
  readonly name: string;
  readonly sceneIds: readonly string[];
}

export interface StoryDocumentView {
  readonly supported: true;
  readonly schemaVersion: number | undefined;
  readonly id: string;
  readonly name: string;
  readonly chapters: readonly StoryChapter[];
  /** Scenes no chapter claims, in authoring order. */
  readonly unassignedSceneIds: readonly string[];
  readonly scenes: Readonly<Record<string, StoryScene>>;
  /** Every scene in reading order: chapters first, then the unassigned. */
  readonly order: readonly string[];
}

/** The plain text of a text segment (`{ value, rich? }`). */
function segmentText(segment: Json): string {
  const value = record(segment);
  return text(value?.["value"]) ?? "";
}

/** A text segment's unit id (`{ textId, value }`), as a `textId` field to spread into a row. */
function segmentId(segment: Json): { textId?: string } {
  const textId = text(record(segment)?.["textId"]);
  return textId === undefined || textId === "" ? {} : { textId };
}

/** A command's name and the one detail worth showing, from an `action` / `control` / `jump` payload. */
function commandOf(kind: string, payload: Record<string, Json>): { command: string; detail?: string } {
  const command = text(payload["action"]) ?? text(payload["control"]) ?? text(payload["operation"]) ?? kind;
  const detail =
    text(payload["operation"]) && command !== payload["operation"]
      ? text(payload["operation"])
      : text(payload["targetSceneName"]) ?? text(payload["name"]) ?? text(payload["label"]) ?? undefined;
  return detail === undefined ? { command } : { command, detail };
}

function rowOf(block: Record<string, Json>, depth: number): StoryRow | undefined {
  const id = text(block["id"]);
  const kind = text(block["kind"]);
  if (id === undefined || kind === undefined) return undefined;
  const disabled = block["disabled"] === true;
  const payload = record(block["payload"]) ?? {};
  const base = { id, depth, disabled };
  switch (kind) {
    case "nodeAction": {
      const action = text(payload["action"]);
      if (action === "narration") return { ...base, kind: "narration", text: segmentText(payload["text"]), ...segmentId(payload["text"]) };
      if (action === "dialogue") {
        const characterId = text(payload["characterId"]);
        const name = text(payload["speakerName"]);
        const voiceAssetId = text(payload["voiceAssetId"]);
        return {
          ...base,
          kind: "dialogue",
          speaker: characterId !== undefined ? { characterId } : name !== undefined ? { name } : undefined,
          text: segmentText(payload["text"]),
          ...segmentId(payload["text"]),
          ...(voiceAssetId === undefined || voiceAssetId === "" ? {} : { voiceAssetId }),
        };
      }
      if (action === "choice") return { ...base, kind: "choice", text: segmentText(payload["prompt"]), ...segmentId(payload["prompt"]) };
      if (action === "choiceOption") return { ...base, kind: "option", text: segmentText(payload["text"]), ...segmentId(payload["text"]) };
      return { ...base, kind: "command", command: action ?? kind, block: kind, payload };
    }
    case "note":
      return { ...base, kind: "note", text: segmentText(payload["text"]) || (text(payload["text"]) ?? "") };
    case "invalid":
      return { ...base, kind: "invalid", text: text(payload["source"]) ?? "" };
    case "empty":
      return { ...base, kind: "empty" };
    case "declaration":
      return { ...base, kind: "command", command: "declare", detail: text(payload["name"]) ?? "", block: kind, payload };
    default:
      return { ...base, kind: "command", ...commandOf(kind, payload), block: kind, payload };
  }
}

/** A scene's blocks as rows in reading order: depth-first from its roots, children indented. */
function rowsOf(scene: Record<string, Json>): StoryRow[] {
  const blocks = record(scene["blocks"]) ?? {};
  const rows: StoryRow[] = [];
  const seen = new Set<string>();
  const walk = (ids: Json[], depth: number): void => {
    for (const raw of ids) {
      const id = text(raw);
      if (id === undefined || seen.has(id) || rows.length > 50_000) continue;
      seen.add(id);
      const block = record(blocks[id]);
      if (block === undefined) continue;
      const row = rowOf(block, depth);
      if (row !== undefined) rows.push(row);
      walk(list(block["childrenIds"]), depth + 1);
    }
  };
  walk(list(scene["rootBlockIds"]), 0);
  return rows;
}

export function readStoryDocument(json: Json): StoryDocumentView | Unsupported {
  const root = record(json);
  if (root === undefined) return unsupported(undefined, "malformed");
  const version = typeof root["schemaVersion"] === "number" ? root["schemaVersion"] : undefined;
  if (version !== undefined && version > STORY_DOCUMENT_MAX_SCHEMA) return unsupported(version, "newer");

  const scenes: Record<string, StoryScene> = {};
  for (const [key, value] of Object.entries(record(root["scenes"]) ?? {})) {
    const scene = record(value);
    if (scene === undefined) continue;
    const description = text(scene["description"]);
    const backgroundAssetId = text(scene["defaultBackgroundAssetId"]);
    scenes[key] = {
      id: text(scene["id"]) ?? key,
      name: text(scene["name"]) ?? key,
      ...(description === undefined || description === "" ? {} : { description }),
      ...(backgroundAssetId === undefined || backgroundAssetId === "" ? {} : { backgroundAssetId }),
      rows: rowsOf(scene),
    };
  }
  const chapters: StoryChapter[] = list(root["chapters"]).flatMap((entry) => {
    const chapter = record(entry);
    const id = text(chapter?.["id"]);
    if (chapter === undefined || id === undefined) return [];
    return [{ id, name: text(chapter["name"]) ?? id, sceneIds: list(chapter["sceneIds"]).flatMap((s) => (typeof s === "string" && s in scenes ? [s] : [])) }];
  });
  const claimed = new Set(chapters.flatMap((chapter) => chapter.sceneIds));
  const declared = list(root["unassignedSceneIds"]).flatMap((s) => (typeof s === "string" && s in scenes && !claimed.has(s) ? [s] : []));
  // A scene neither claimed nor listed still exists; it goes last, in key order.
  const rest = Object.keys(scenes).filter((id) => !claimed.has(id) && !declared.includes(id));
  const unassignedSceneIds = [...declared, ...rest];
  return {
    supported: true,
    schemaVersion: version,
    id: text(root["id"]) ?? "",
    name: text(root["name"]) ?? "",
    chapters,
    unassignedSceneIds,
    scenes,
    order: [...chapters.flatMap((chapter) => chapter.sceneIds), ...unassignedSceneIds],
  };
}

/* ------------------------------------------------------------ characters */

export interface CharacterView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly nicknames: readonly string[];
  /** Where its default face is drawn, when Studio has baked one. */
  readonly avatarPath?: string;
}

/** The characters, by id. A store this cannot read is an empty map: lines then show their bare ids. */
export function readCharacters(json: Json): ReadonlyMap<string, CharacterView> {
  const root = record(json);
  const characters = new Map<string, CharacterView>();
  for (const entry of list(root?.["characters"])) {
    const profile = record(record(entry)?.["profile"]);
    const id = text(profile?.["id"]);
    if (profile === undefined || id === undefined) continue;
    const appearance = record(profile["appearance"]);
    const pose = text(appearance?.["defaultPoseId"]);
    const baked = pose !== undefined && record(record(appearance?.["avatars"])?.[pose]) !== undefined;
    characters.set(id, {
      id,
      ...(baked ? { avatarPath: `resources/characters/avatars/${id}/${pose}.png` } : {}),
      name: text(profile["name"]) ?? id,
      description: text(profile["description"]) ?? "",
      nicknames: list(profile["nicknames"]).flatMap((n) => (typeof n === "string" ? [n] : [])),
    });
  }
  return characters;
}

/* ------------------------------------------------------------- variables */

export const VARIABLE_STORE_PATH = "editor/variables.json";

export interface VariableView {
  readonly id: string;
  readonly name: string;
  /** `saved`, `persistent`, or `scene`. */
  readonly scope: string;
  readonly valueType: string;
}

/** The project's variables, by id. A store this cannot read is an empty map. */
export function readVariables(json: Json): ReadonlyMap<string, VariableView> {
  const variables = new Map<string, VariableView>();
  for (const [key, value] of Object.entries(record(record(json)?.["entries"]) ?? {})) {
    const entry = record(value);
    if (entry === undefined) continue;
    const id = text(entry["id"]) ?? key;
    variables.set(id, { id, name: text(entry["name"]) ?? id, scope: text(entry["scope"]) ?? "", valueType: text(entry["valueType"]) ?? "" });
  }
  return variables;
}

/* ---------------------------------------------------------------- assets */

export interface AssetView {
  readonly id: string;
  /** The register it came from: image, audio, video, font, other… */
  readonly type: string;
  readonly name: string;
  readonly ext?: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Where its bytes are in the revision. */
  readonly contentPath: string;
}

/** Where an asset's bytes live, derived from its id the way Studio stores them. */
export function assetContentPath(id: string): string {
  const hex = id.replaceAll("-", "");
  return `assets/content/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
}

/** One register (`assets/assets.metadata.<type>.json`, keyed by asset id). */
export function readAssetRegister(type: string, json: Json): AssetView[] {
  const root = record(json) ?? {};
  return Object.entries(root).flatMap(([key, value]) => {
    const asset = record(value);
    if (asset === undefined) return [];
    const id = text(asset["id"]) ?? key;
    const ext = text(asset["ext"])?.replace(/^\./, "").toLowerCase();
    return [
      {
        id,
        type,
        name: text(asset["name"]) ?? id,
        ...(ext === undefined || ext === "" ? {} : { ext }),
        description: text(asset["description"]) ?? "",
        tags: list(asset["tags"]).flatMap((t) => (typeof t === "string" ? [t] : [])),
        contentPath: assetContentPath(id),
      },
    ];
  });
}

/** Which register a path is, or undefined. */
export function assetRegisterType(path: string): string | undefined {
  return ASSET_REGISTER_PATTERN.exec(path)?.[1];
}

/* ------------------------------------------------------------- blueprints */

/** Where the UI blueprints are: one graph document for the whole project. */
export const UI_GRAPHS_PATH = "editor/ui/uigraphs.json";
/** The newest UI graph document schema this reads (`UI_GRAPH_DOCUMENT_SCHEMA_VERSION`). */
export const UI_GRAPHS_MAX_SCHEMA = 2;
/** The newest blueprint document schema this reads (`BLUEPRINT_DOCUMENT_SCHEMA_VERSION`). */
export const BLUEPRINT_DOCUMENT_MAX_SCHEMA = 14;

export interface BlueprintNodeView {
  readonly id: string;
  /** The node's type id, e.g. `event.onClick`; Studio's registry gives it a label, this does not. */
  readonly type: string;
  /** Where the author put it, or undefined for a node never placed. */
  readonly x?: number;
  readonly y?: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Its parameters, as stored. Shown in a property panel; never interpreted. */
  readonly params: Readonly<Record<string, unknown>>;
}

export interface BlueprintEdgeView {
  readonly from: { readonly nodeId: string; readonly port: string };
  readonly to: { readonly nodeId: string; readonly port: string };
}

export interface BlueprintGraphView {
  readonly id: string;
  readonly name: string;
  readonly kind: "event" | "function" | "macro";
  /** A layer written as a script file rather than a graph has no nodes; this names the file. */
  readonly scriptRef?: string;
  readonly nodes: readonly BlueprintNodeView[];
  readonly edges: readonly BlueprintEdgeView[];
}

export interface BlueprintView {
  readonly id: string;
  readonly name: string;
  /** What it belongs to, as Studio keys it: `globalMain`, a surface, a widget… */
  readonly owner: string;
  readonly graphs: readonly BlueprintGraphView[];
}

export interface BlueprintsView {
  readonly supported: true;
  readonly blueprints: readonly BlueprintView[];
}

function portsOf(ports: Json, kind: "input" | "output"): string[] {
  return Object.entries(record(ports) ?? {}).flatMap(([name, port]) => (record(port)?.["kind"] === kind ? [name] : []));
}

function graphOf(id: string, kind: BlueprintGraphView["kind"], layer: Record<string, Json>): BlueprintGraphView {
  const graph = record(layer["graph"]) ?? {};
  const nodes: BlueprintNodeView[] = Object.entries(record(graph["nodes"]) ?? {}).flatMap(([key, value]) => {
    const node = record(value);
    if (node === undefined) return [];
    const layout = record(record(node["meta"])?.["editorLayout"]);
    const x = typeof layout?.["x"] === "number" ? layout["x"] : undefined;
    const y = typeof layout?.["y"] === "number" ? layout["y"] : undefined;
    return [
      {
        id: text(node["id"]) ?? key,
        type: text(node["type"]) ?? "?",
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        inputs: portsOf(node["ports"], "input"),
        outputs: portsOf(node["ports"], "output"),
        params: record(node["params"]) ?? {},
      },
    ];
  });
  const edges: BlueprintEdgeView[] = list(graph["edges"]).flatMap((value) => {
    const edge = record(value);
    const from = record(edge?.["from"]);
    const to = record(edge?.["to"]);
    const fromNode = text(from?.["nodeId"]);
    const toNode = text(to?.["nodeId"]);
    if (fromNode === undefined || toNode === undefined) return [];
    return [{ from: { nodeId: fromNode, port: text(from?.["port"]) ?? "" }, to: { nodeId: toNode, port: text(to?.["port"]) ?? "" } }];
  });
  const scriptRef = text(record(layer["script"])?.["scriptRef"]);
  return { id, name: text(layer["name"]) ?? id, kind, ...(scriptRef === undefined ? {} : { scriptRef }), nodes, edges };
}

function ownerLabel(owner: Json): string {
  const value = record(owner);
  if (value === undefined) return "";
  return [text(value["kind"]), text(value["surfaceId"]), text(value["elementId"])].filter((part) => part !== undefined).join(":");
}

/** The project's UI blueprints, out of `editor/ui/uigraphs.json`. */
export function readBlueprints(json: Json): BlueprintsView | Unsupported {
  const root = record(json);
  if (root === undefined) return unsupported(undefined, "malformed");
  const version = typeof root["schemaVersion"] === "number" ? root["schemaVersion"] : undefined;
  if (version !== undefined && version > UI_GRAPHS_MAX_SCHEMA) return unsupported(version, "newer");
  const document = record(root["blueprintDocument"]);
  if (document === undefined) return { supported: true, blueprints: [] };
  const inner = typeof document["schemaVersion"] === "number" ? document["schemaVersion"] : undefined;
  if (inner !== undefined && inner > BLUEPRINT_DOCUMENT_MAX_SCHEMA) return unsupported(inner, "newer");

  const blueprints: BlueprintView[] = Object.entries(record(document["blueprints"]) ?? {}).flatMap(([key, value]) => {
    const blueprint = record(value);
    if (blueprint === undefined) return [];
    const index = record(blueprint["graphs"]) ?? {};
    const graphs: BlueprintGraphView[] = [];
    const collect = (kind: BlueprintGraphView["kind"], field: string, orderField?: string) => {
      const layers = record(index[field]) ?? {};
      const order = orderField === undefined ? [] : list(index[orderField]).flatMap((id) => (typeof id === "string" ? [id] : []));
      const ids = [...order.filter((id) => id in layers), ...Object.keys(layers).filter((id) => !order.includes(id))];
      for (const id of ids) {
        const layer = record(layers[id]);
        if (layer !== undefined) graphs.push(graphOf(id, kind, layer));
      }
    };
    collect("event", "events", "eventIds");
    collect("function", "functions", "functionIds");
    collect("macro", "macros");
    return [{ id: text(blueprint["id"]) ?? key, name: text(blueprint["name"]) ?? key, owner: ownerLabel(blueprint["owner"]), graphs }];
  });
  return { supported: true, blueprints };
}
