/**
 * What a revision of a project says about itself.
 *
 * This is the whole of what Team understands about Studio's files, and it is
 * deliberately shallow: the project file, the names and sizes in the directory
 * tree, the asset registers and the list of scenes in a story. Nothing here
 * looks inside a scene. What a scene means is Studio's, and a Team server that had to
 * know it would be a Team server that had to be upgraded whenever Studio was — which
 * is the one thing it was built not to be.
 *
 * The degradation rule, which every function below obeys
 * ------------------------------------------------------
 * Team reads as far as it understands and says nothing about the rest. A file
 * from a newer Studio, a file that was half written, a file that is not what
 * its name says, a project with no file at all: each of them leaves
 * `readable` false and a sentence somebody can act on. **None of them is an
 * error, a crash, an empty panel or a stack trace on screen.** The counts Team
 * did work out survive; the ones it did not are absent, and absent draws as
 * unknown.
 *
 * Nothing in this file knows about Lore, the network, or the file system. It
 * is given a list of entries and something that can fetch one, which is what
 * lets it be driven by a repository, and by a test, in the same way.
 */
import { decodeMsgpack, MsgpackError } from "./msgpack.js";

import type { ProjectFileView } from "../teamview.js";

/** One file in a revision, as the directory tree reports it. */
export interface RevisionFile {
  /** Repository-relative, with forward slashes, no leading slash. */
  readonly path: string;
  readonly size: number;
}

/**
 * A revision Team can look at.
 *
 * `read` is expected to be expensive — over a sparse checkout it is a fetch
 * from the remote — so everything below reads as few files as it can and
 * counts from the tree wherever counting from the tree is enough.
 */
export interface RevisionSource {
  readonly files: readonly RevisionFile[];
  read(file: RevisionFile): Promise<Buffer>;
}

/**
 * The project file schema Team reads.
 *
 * A file that declares a higher number is not read at all, rather than read
 * for the fields that happen to still be in the same place: a schema is raised
 * when a meaning changes, and a title that now means something else is worse
 * than no title. A file that declares nothing is the shape that predates the
 * field, which is what Studio writes today, and is read.
 */
export const PROJECT_FILE_SCHEMA = 1;

/**
 * The largest project file Team will fetch, in bytes.
 *
 * A ceiling on the read rather than on the decode, and checked against the size
 * the tree reports before anything is asked for: the pass in ./refresh.ts reads
 * every project on the server once a minute, so a file committed at the path
 * Team looks at is a file this server allocates once a minute, for as long as
 * it runs, whatever somebody made it. A limit that only stopped the decoder
 * would already have the bytes in memory by the time it fired.
 *
 * Four mebibytes, and the number comes from what a project file is rather than
 * from what a host can spare. It holds a project's settings — a name, an
 * identifier, a stage size, icon specifications, the locales the game is
 * written in — and none of those grow with the project's content: the scenes,
 * the assets and the stories are all elsewhere in the repository. A real one
 * Studio writes is well under a kilobyte, and a wildly elaborate one is still
 * kilobytes. This is thousands of times either, so no honest file meets it,
 * which is what makes refusing anything past it safe to do without asking.
 */
export const MAX_PROJECT_FILE_BYTES = 4 * 1024 * 1024;

/** The newer spelling of a project file, whose name is the project's own. */
const PROJECT_FILE_EXTENSION = ".nlproj";

/** The older spelling, which is plain JSON and still opened by Studio. */
const LEGACY_PROJECT_FILE = "project.json";

/** Where the bytes behind every asset are kept, whatever kind they are. */
const ASSET_CONTENT_PREFIX = "assets/content/";

/** One register per kind of asset, named for the kind it registers. */
const ASSET_REGISTER = /^assets\/assets\.metadata\.([A-Za-z0-9_-]+)\.json$/;

/** The list of stories, which is what says where the scenes are. */
const STORY_INDEX = "editor/story/index.json";

/**
 * How many bytes of the story index and its documents one read will fetch.
 *
 * A scene count is worth having and not worth any price. Past this the count
 * is absent — which draws as unknown — rather than being a partial count that
 * looks exactly like a real one.
 *
 * The index is spent from the same budget as the documents it names, because
 * it is the same kind of thing: a file at a known path in somebody else's
 * repository, fetched by the pass in ./refresh.ts once a minute for as long as
 * this server runs. Nothing on that path may read a file without first knowing
 * how big it is.
 */
const STORY_READ_BUDGET = 16 * 1024 * 1024;

/** Everything a revision's tree adds up to, whatever else could be read. */
export interface RevisionSizes {
  /** Every file in the revision. */
  readonly totalBytes: number;
}

export function revisionSizes(source: RevisionSource): RevisionSizes {
  let totalBytes = 0;
  for (const file of source.files) {
    totalBytes += file.size;
  }
  return { totalBytes };
}

/** Read a project file view out of one revision. Never throws. */
export async function readProjectFile(source: RevisionSource): Promise<ProjectFileView> {
  const configFile = findProjectFile(source.files);
  if (configFile === undefined) {
    return {
      readable: false,
      reason:
        "this revision has no project file at its root, so it was not made by Studio or was made by a newer one that keeps it elsewhere",
    };
  }

  if (configFile.size > MAX_PROJECT_FILE_BYTES) {
    // Refused from the tree, without the bytes ever being asked for. It goes
    // down the same road as a file Team could not make sense of, because to
    // whoever is looking it is the same thing: this project cannot be read,
    // and here is the sentence saying why.
    return {
      readable: false,
      reason:
        `${configFile.path} is ${configFile.size.toLocaleString("en-US")} bytes, and Team reads a project file ` +
        `up to ${MAX_PROJECT_FILE_BYTES.toLocaleString("en-US")}. A project file holds a project's settings rather ` +
        "than its content, so something this large is not one.",
    };
  }

  let config: Record<string, unknown>;
  try {
    config = await readConfig(source, configFile);
  } catch (error) {
    return { readable: false, reason: describeUnreadable(configFile.path, error) };
  }

  const schema = numberAt(config, "schemaVersion");
  if (schema !== undefined && schema > PROJECT_FILE_SCHEMA) {
    return {
      readable: false,
      reason: `${configFile.path} is schema ${schema}; Team reads up to ${PROJECT_FILE_SCHEMA}. A newer Studio wrote this project.`,
    };
  }

  const resolution = objectAt(objectAt(config, "metadata"), "resolution");
  const title = stringAt(config, "name");
  const stageWidth = numberAt(resolution, "width");
  const stageHeight = numberAt(resolution, "height");

  const assets = await readAssets(source);
  const scenes = await countScenes(source);

  return {
    readable: true,
    ...(title === undefined ? {} : { title }),
    ...(stageWidth === undefined ? {} : { stageWidth }),
    ...(stageHeight === undefined ? {} : { stageHeight }),
    ...(scenes === undefined ? {} : { scenes }),
    ...assets,
  };
}

/**
 * The project file at the root of a revision.
 *
 * Its name is the project's own, transliterated, so it cannot be asked for by
 * name in advance — which is why the checkout does not try to and why this
 * looks for the extension instead. The older spelling is a fixed name and is
 * accepted where there is no newer one.
 */
function findProjectFile(files: readonly RevisionFile[]): RevisionFile | undefined {
  const atRoot = files.filter((file) => !file.path.includes("/"));
  return (
    atRoot.find((file) => file.path.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)) ??
    atRoot.find((file) => file.path === LEGACY_PROJECT_FILE)
  );
}

/**
 * Read the project file, whichever of the two spellings it is.
 *
 * The newer one is MessagePack and the older one is JSON, and the difference
 * is the extension rather than a sniff of the first byte: a JSON file that
 * happened to start with a byte MessagePack recognises would otherwise be read
 * as a map with rubbish in it instead of being reported as the wrong shape.
 */
async function readConfig(
  source: RevisionSource,
  file: RevisionFile,
): Promise<Record<string, unknown>> {
  const bytes = await source.read(file);
  const value = file.path.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? decodeMsgpack(bytes)
    : (JSON.parse(bytes.toString("utf-8")) as unknown);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("it holds something other than a set of settings");
  }
  return value as Record<string, unknown>;
}

/** A sentence about a file that could not be read, with no jargon in it. */
function describeUnreadable(path: string, error: unknown): string {
  if (error instanceof MsgpackError) {
    return `${path} could not be read: ${error.message}. It may have been written by a newer Studio, or only partly written.`;
  }
  if (error instanceof SyntaxError) {
    return `${path} is not the JSON it is named as: ${error.message}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `${path} could not be read: ${detail}`;
}

/** What the asset registers and the content directory add up to. */
type AssetCounts = Pick<ProjectFileView, "assets" | "assetBytes" | "assetsByKind">;

/**
 * Count the assets, and say how big they are.
 *
 * Two sources, and only one of them has to work. The size comes from the tree:
 * every asset's bytes live under one directory, so their total is a sum of
 * sizes that needs no file read and no understanding of anything. The count
 * and the breakdown come from the registers, one per kind, which are small
 * JSON files.
 *
 * A register keys its entries by asset id, and the bytes for an id live at a
 * path derived from it. That derivation is the one piece of Studio's layout
 * this depends on, so it is checked rather than assumed: if no id in any
 * register matches a file that is there, the breakdown is dropped instead of
 * being reported as a table of zeroes.
 */
async function readAssets(source: RevisionSource): Promise<AssetCounts> {
  const content = new Map<string, number>();
  let assetBytes = 0;
  for (const file of source.files) {
    if (file.path.startsWith(ASSET_CONTENT_PREFIX)) {
      content.set(file.path, file.size);
      assetBytes += file.size;
    }
  }

  const kinds: Array<{ kind: string; count: number; bytes: number }> = [];
  let total = 0;
  let matched = 0;
  let registersRead = 0;

  for (const file of source.files) {
    const match = ASSET_REGISTER.exec(file.path);
    if (match === null) {
      continue;
    }
    const kind = match[1] ?? "";
    let register: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse((await source.read(file)).toString("utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      register = parsed as Record<string, unknown>;
    } catch {
      // One unreadable register does not cost the others theirs. The kind it
      // held is simply not in the breakdown.
      continue;
    }
    registersRead += 1;

    const ids = Object.keys(register);
    if (ids.length === 0) {
      continue;
    }
    let bytes = 0;
    for (const id of ids) {
      const size = content.get(contentPathOf(id));
      if (size !== undefined) {
        bytes += size;
        matched += 1;
      }
    }
    total += ids.length;
    kinds.push({ kind, count: ids.length, bytes });
  }

  if (registersRead === 0) {
    // Nothing said how many assets there are. The size is still true.
    return assetBytes === 0 ? {} : { assetBytes };
  }

  const breakdown = kinds
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);

  // Every id in every register missed the content directory, so the layout is
  // not the one this reads. Saying so by leaving the breakdown out is better
  // than a table where every kind weighs nothing.
  const layoutHeld = matched > 0 || content.size === 0;

  return {
    assets: total,
    assetBytes,
    ...(layoutHeld && breakdown.length > 0 ? { assetsByKind: breakdown } : {}),
  };
}

/**
 * Where the bytes behind one asset id live.
 *
 * The id is a UUID, and its content sits under two levels named for the first
 * four of its hex digits. Anything that is not shaped like one gets a path
 * nothing matches, which is what {@link readAssets} watches for.
 */
function contentPathOf(id: string): string {
  const hex = id.replaceAll("-", "");
  return `${ASSET_CONTENT_PREFIX}${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
}

/**
 * How many scenes there are across every story in the project.
 *
 * The list of stories names its documents, and a document holds its scenes in
 * a set keyed by id. Counting those keys is as far as this goes: it never
 * looks at what a scene contains, which is the line between a fact about a
 * project and an understanding of one.
 *
 * Undefined where it could not be counted — no index, an index that is not
 * what it claims, an index or a document too big to be worth fetching. A
 * partial count is never returned, because it is indistinguishable on screen
 * from a real one.
 */
async function countScenes(source: RevisionSource): Promise<number | undefined> {
  const indexFile = source.files.find((file) => file.path === STORY_INDEX);
  if (indexFile === undefined) {
    return undefined;
  }

  let budget = STORY_READ_BUDGET;
  if (indexFile.size > budget) {
    return undefined;
  }
  budget -= indexFile.size;

  let index: unknown;
  try {
    index = JSON.parse((await source.read(indexFile)).toString("utf-8"));
  } catch {
    return undefined;
  }
  const stories = (index as { stories?: unknown } | null)?.stories;
  if (!Array.isArray(stories)) {
    return undefined;
  }

  const byPath = new Map(source.files.map((file) => [file.path, file]));
  let scenes = 0;

  for (const story of stories) {
    const documentPath = stringAt(story as Record<string, unknown>, "documentPath");
    if (documentPath === undefined) {
      return undefined;
    }
    const documentFile = byPath.get(documentPath);
    if (documentFile === undefined) {
      return undefined;
    }
    if (documentFile.size > budget) {
      return undefined;
    }
    budget -= documentFile.size;

    let document: unknown;
    try {
      document = JSON.parse((await source.read(documentFile)).toString("utf-8"));
    } catch {
      return undefined;
    }
    const set = (document as { scenes?: unknown } | null)?.scenes;
    if (typeof set !== "object" || set === null || Array.isArray(set)) {
      return undefined;
    }
    scenes += Object.keys(set).length;
  }

  return scenes;
}

function objectAt(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const found = value?.[key];
  return typeof found === "object" && found !== null && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === "string" && found !== "" ? found : undefined;
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key];
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}
