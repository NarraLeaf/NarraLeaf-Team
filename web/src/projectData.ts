/**
 * Everything a revision says about its project, read once and shared by the
 * pages that look across it: comparing two revisions, which scenes use an
 * asset, and the checks. The server only hands over files; reading them is
 * here, with @narraleaf/project-view.
 */
import { useEffect, useState } from "react";
import {
  assetRegisterType,
  CHARACTER_STORE_PATH,
  readAssetRegister,
  readBlueprints,
  readCharacters,
  readStoryDocument,
  readStoryLibrary,
  readVariables,
  STORY_INDEX_PATH,
  UI_GRAPHS_PATH,
  VARIABLE_STORE_PATH,
  type AssetView,
  type BlueprintsView,
  type CharacterView,
  type StoryDocumentView,
  type StoryEntry,
  type StoryRow,
  type StoryScene,
  type VariableView,
} from "@narraleaf/project-view";

import { fetchJson, fetchTree, type Tree } from "./files";

export interface StoryData {
  readonly entry: StoryEntry;
  readonly document: StoryDocumentView;
}

export interface ProjectData {
  readonly tree: Tree;
  readonly stories: readonly StoryData[];
  readonly characters: ReadonlyMap<string, CharacterView>;
  readonly variables: ReadonlyMap<string, VariableView>;
  readonly assets: ReadonlyMap<string, AssetView>;
  readonly blueprints: BlueprintsView | undefined;
  /** Every path the revision holds. */
  readonly present: ReadonlySet<string>;
}

async function readOr<T>(projectId: string, tree: Tree, path: string, read: (json: unknown) => T, fallback: T): Promise<T> {
  if (!tree.files.some((file) => file.path === path)) return fallback;
  try {
    return read(await fetchJson(projectId, tree.revision, path));
  } catch {
    return fallback;
  }
}

export async function loadProjectData(projectId: string, tree: Tree): Promise<ProjectData> {
  const present = new Set(tree.files.map((file) => file.path));
  const library = await readOr(projectId, tree, STORY_INDEX_PATH, readStoryLibrary, undefined);
  const stories = await Promise.all(
    (library?.supported ? library.stories : []).map(async (entry) => {
      const document = await readOr(projectId, tree, entry.documentPath, readStoryDocument, undefined);
      return document?.supported ? { entry, document } : undefined;
    }),
  );
  const registers = tree.files.flatMap((file) => {
    const type = assetRegisterType(file.path);
    return type === undefined ? [] : [{ type, path: file.path }];
  });
  const [characters, variables, lists, blueprints] = await Promise.all([
    readOr(projectId, tree, CHARACTER_STORE_PATH, readCharacters, new Map<string, CharacterView>()),
    readOr(projectId, tree, VARIABLE_STORE_PATH, readVariables, new Map<string, VariableView>()),
    Promise.all(registers.map((register) => readOr(projectId, tree, register.path, (json) => readAssetRegister(register.type, json), []))),
    readOr(projectId, tree, UI_GRAPHS_PATH, readBlueprints, undefined),
  ]);
  return {
    tree,
    stories: stories.filter((story): story is StoryData => story !== undefined),
    characters,
    variables,
    assets: new Map(lists.flat().map((asset) => [asset.id, asset])),
    blueprints: blueprints?.supported ? blueprints : undefined,
    present,
  };
}

/** A saved revision never changes, so what was read of it is kept for the page's life. */
const saved = new Map<string, Promise<ProjectData>>();

export function projectDataAt(projectId: string, revision: string): Promise<ProjectData> {
  const key = `${projectId}\u0000${revision}`;
  const cached = saved.get(key);
  if (cached !== undefined) return cached;
  const loading = fetchTree(projectId, revision).then((tree) => loadProjectData(projectId, tree));
  if (revision !== "current") {
    saved.set(key, loading);
    loading.catch(() => saved.delete(key));
  }
  return loading;
}

/** The project as one tree has it; `undefined` while reading, an Error when it could not be read. */
export function useProjectData(projectId: string, tree: Tree | undefined): ProjectData | Error | undefined {
  const [data, setData] = useState<ProjectData | Error | undefined>(undefined);
  useEffect(() => {
    if (tree === undefined) return undefined;
    let live = true;
    loadProjectData(projectId, tree)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((caught: unknown) => {
        if (live) setData(caught instanceof Error ? caught : new Error(String(caught)));
      });
    return () => {
      live = false;
    };
  }, [projectId, tree]);
  return data;
}

/* ------------------------------------------------------------ references */

/** Where something is in the story: a scene, and the row in it when it is a row. */
export interface Place {
  readonly storyId: string;
  readonly storyName: string;
  readonly sceneId: string;
  readonly sceneName: string;
  readonly rowId?: string;
  /** 1-based, as the story view numbers its lines. */
  readonly line?: number;
}

/** What one row points at. */
export interface RowRefs {
  readonly assets: string[];
  readonly characters: string[];
  readonly variables: string[];
  readonly scenes: string[];
  /** A `label` row's name. */
  readonly label?: string;
  /** A `goto` row's target. */
  readonly goto?: string;
}

function collect(value: unknown, refs: { assets: Set<string>; characters: Set<string>; variables: Set<string>; scenes: Set<string> }, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === "string") {
    if (value.startsWith("scene:") && value.length > 6) refs.scenes.add(value.slice(6));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, refs, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item !== "") {
      if (key === "assetId" || key.endsWith("AssetId")) refs.assets.add(item);
      else if (key === "characterId") refs.characters.add(item);
      else if (key === "variableId") refs.variables.add(item);
      else if (key === "targetSceneId") refs.scenes.add(item);
    }
    collect(item, refs, depth + 1);
  }
}

export function rowRefs(row: StoryRow): RowRefs {
  const refs = { assets: new Set<string>(), characters: new Set<string>(), variables: new Set<string>(), scenes: new Set<string>() };
  let label: string | undefined;
  let goto: string | undefined;
  if (row.kind === "dialogue" && row.speaker !== undefined && "characterId" in row.speaker) refs.characters.add(row.speaker.characterId);
  if (row.kind === "command") {
    collect(row.payload, refs);
    if (row.block === "control" && row.payload["control"] === "label" && typeof row.payload["name"] === "string") label = row.payload["name"];
    if (row.block === "control" && row.payload["control"] === "goto" && typeof row.payload["targetLabel"] === "string") goto = row.payload["targetLabel"];
  }
  return {
    assets: [...refs.assets],
    characters: [...refs.characters],
    variables: [...refs.variables],
    scenes: [...refs.scenes],
    ...(label === undefined ? {} : { label }),
    ...(goto === undefined ? {} : { goto }),
  };
}

/** Every scene of every story, in reading order, with where it is. */
export function eachScene(data: ProjectData): { story: StoryData; scene: StoryScene; place: Place }[] {
  return data.stories.flatMap((story) =>
    story.document.order.flatMap((sceneId) => {
      const scene = story.document.scenes[sceneId];
      return scene === undefined
        ? []
        : [{ story, scene, place: { storyId: story.entry.id, storyName: story.entry.name, sceneId, sceneName: scene.name } }];
    }),
  );
}

/** Which scenes and rows use each asset; a scene's background counts as its own use. */
export function assetUses(data: ProjectData): ReadonlyMap<string, readonly Place[]> {
  const uses = new Map<string, Place[]>();
  const add = (id: string, place: Place) => {
    const list = uses.get(id) ?? [];
    list.push(place);
    uses.set(id, list);
  };
  for (const { scene, place } of eachScene(data)) {
    if (scene.backgroundAssetId !== undefined) add(scene.backgroundAssetId, place);
    scene.rows.forEach((row, index) => {
      for (const id of rowRefs(row).assets) add(id, { ...place, rowId: row.id, line: index + 1 });
    });
  }
  return uses;
}

/* ---------------------------------------------------------------- checks */

export type CheckKind =
  | "missingAsset"
  | "unsyncedAsset"
  | "missingScene"
  | "missingLabel"
  | "duplicateLabel"
  | "undeclaredVariable"
  | "missingCharacter"
  | "noPortrait"
  | "invalidRow";

export interface Finding {
  readonly kind: CheckKind;
  readonly severity: "error" | "warning";
  /** What it is about, in words: an asset's name, a label, an id. */
  readonly subject: string;
  readonly place: Place;
}

export const CHECK_SEVERITY: Readonly<Record<CheckKind, "error" | "warning">> = {
  missingAsset: "error",
  unsyncedAsset: "warning",
  missingScene: "error",
  missingLabel: "error",
  duplicateLabel: "error",
  undeclaredVariable: "error",
  missingCharacter: "error",
  noPortrait: "warning",
  invalidRow: "warning",
};

/**
 * What would break or look wrong when the story runs, found from the files
 * alone. Variables follow Studio's rule: a declaration row's id is the
 * variable's id; one scoped to a scene declares it in that scene only, others
 * across the whole story; the project's own variable store counts everywhere.
 */
export function runChecks(data: ProjectData): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: CheckKind, subject: string, place: Place) => findings.push({ kind, severity: CHECK_SEVERITY[kind], subject, place });
  const portraitless = new Set<string>();
  for (const story of data.stories) {
    const documentWide = new Set<string>();
    const sceneScoped = new Map<string, Set<string>>();
    for (const sceneId of story.document.order) {
      const scene = story.document.scenes[sceneId];
      for (const row of scene?.rows ?? []) {
        if (row.kind !== "command" || row.block !== "declaration") continue;
        if (row.payload["scope"] === "scene") {
          const set = sceneScoped.get(sceneId) ?? new Set<string>();
          set.add(row.id);
          sceneScoped.set(sceneId, set);
        } else documentWide.add(row.id);
      }
    }
    for (const sceneId of story.document.order) {
      const scene = story.document.scenes[sceneId];
      if (scene === undefined) continue;
      const base: Place = { storyId: story.entry.id, storyName: story.entry.name, sceneId, sceneName: scene.name };
      if (scene.backgroundAssetId !== undefined) {
        const asset = data.assets.get(scene.backgroundAssetId);
        if (asset === undefined) add("missingAsset", scene.backgroundAssetId, base);
        else if (!data.present.has(asset.contentPath)) add("unsyncedAsset", asset.name, base);
      }
      const labels = new Map<string, number>();
      for (const row of scene.rows) {
        const label = row.kind === "command" ? rowRefs(row).label : undefined;
        if (label !== undefined) labels.set(label, (labels.get(label) ?? 0) + 1);
      }
      const reported = new Set<string>();
      scene.rows.forEach((row, index) => {
        const place: Place = { ...base, rowId: row.id, line: index + 1 };
        if (row.kind === "invalid") add("invalidRow", row.text, place);
        const refs = rowRefs(row);
        for (const id of refs.assets) {
          const asset = data.assets.get(id);
          if (asset === undefined) add("missingAsset", id, place);
          else if (!data.present.has(asset.contentPath)) add("unsyncedAsset", asset.name, place);
        }
        for (const id of refs.scenes) {
          if (story.document.scenes[id] === undefined) add("missingScene", id, place);
        }
        for (const id of refs.variables) {
          if (!data.variables.has(id) && !documentWide.has(id) && sceneScoped.get(sceneId)?.has(id) !== true) add("undeclaredVariable", id, place);
        }
        for (const id of refs.characters) {
          const character = data.characters.get(id);
          if (character === undefined) add("missingCharacter", id, place);
          else if (character.avatarPath === undefined && row.kind === "dialogue" && !portraitless.has(id)) {
            portraitless.add(id);
            add("noPortrait", character.name, place);
          }
        }
        if (refs.goto !== undefined && !labels.has(refs.goto)) add("missingLabel", refs.goto, place);
        if (refs.label !== undefined && (labels.get(refs.label) ?? 0) > 1 && !reported.has(refs.label)) {
          reported.add(refs.label);
          add("duplicateLabel", refs.label, place);
        }
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ diff */

/** Equal hashes are equal bytes; without both, different sizes are different bytes; otherwise it cannot say. */
export function sameFile(a: { size: number; hash?: string }, b: { size: number; hash?: string }): boolean | undefined {
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash;
  if (a.size !== b.size) return false;
  return undefined;
}

export type Piece = { readonly kind: "same" | "added" | "removed"; readonly text: string };

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/u;

/** Words for Latin text, single characters for Chinese and Japanese, so a changed word shows as one. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const char of text) {
    if (CJK.test(char) || /\s|[.,!?;:"'()[\]{}…—-]/u.test(char)) {
      if (word !== "") out.push(word);
      word = "";
      out.push(char);
    } else word += char;
  }
  if (word !== "") out.push(word);
  return out;
}

/** Longest common subsequence of two lists, as which items of each are kept. */
export function lcsKeep<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean = (x, y) => x === y): { a: boolean[]; b: boolean[] } | undefined {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return undefined;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as Uint32Array;
    const below = table[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = equal(a[i] as T, b[j] as T) ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const keepA = Array<boolean>(n).fill(false);
  const keepB = Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i] as T, b[j] as T)) {
      keepA[i] = true;
      keepB[j] = true;
      i++;
      j++;
    } else if (((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)) i++;
    else j++;
  }
  return { a: keepA, b: keepB };
}

/** How one line became another, word by word. */
export function wordDiff(before: string, after: string): Piece[] {
  const a = tokens(before);
  const b = tokens(after);
  const keep = lcsKeep(a, b);
  if (keep === undefined) return [{ kind: "removed", text: before }, { kind: "added", text: after }];
  const pieces: Piece[] = [];
  const push = (kind: Piece["kind"], text: string) => {
    const last = pieces[pieces.length - 1];
    if (last !== undefined && last.kind === kind) pieces[pieces.length - 1] = { kind, text: last.text + text };
    else pieces.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && !keep.a[i]) push("removed", a[i++] as string);
    else if (j < b.length && !keep.b[j]) push("added", b[j++] as string);
    else {
      push("same", a[i] as string);
      i++;
      j++;
    }
  }
  return pieces;
}

/** Two orderings of ids merged into one, each marked kept, added or removed. */
export function mergeOrder(before: readonly string[], after: readonly string[]): { id: string; kind: "same" | "added" | "removed" }[] {
  const keep = lcsKeep(before, after);
  if (keep === undefined) {
    const old = new Set(before);
    const now = new Set(after);
    return [
      ...after.map((id) => ({ id, kind: old.has(id) ? ("same" as const) : ("added" as const) })),
      ...before.filter((id) => !now.has(id)).map((id) => ({ id, kind: "removed" as const })),
    ];
  }
  const out: { id: string; kind: "same" | "added" | "removed" }[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && !keep.a[i]) out.push({ id: before[i++] as string, kind: "removed" });
    else if (j < after.length && !keep.b[j]) out.push({ id: after[j++] as string, kind: "added" });
    else {
      out.push({ id: after[j] as string, kind: "same" });
      i++;
      j++;
    }
  }
  return out;
}
