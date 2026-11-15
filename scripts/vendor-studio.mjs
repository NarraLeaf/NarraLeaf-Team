// Writes studio-kernel/vendor/kernel.js from a NarraLeaf Studio checkout.
//
// Team is the authority over a team project: it applies every edit itself. For
// the document it holds to be the one every Studio holds, it applies them with
// Studio's own code - the pure appliers Studio exports from
// src/shared/authority/kernel.ts. This bundles that one entry, with everything
// it imports, into a single ES module and writes it next to a stamp naming the
// Studio commit it came from.
//
// The bundle is generated and checked in, the way protocol/contract.json is:
// the server builds and tests without a Studio checkout, and a change to what
// the kernel does arrives as a reviewable diff. Run it whenever Studio's kernel
// changes:
//
//     node scripts/vendor-studio.mjs [--studio <path to NarraLeaf-Studio>]
//
// The Studio path defaults to ../NarraLeaf-Studio, then $NARRALEAF_STUDIO.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flag = process.argv.indexOf("--studio");
const studio = resolve(
  flag !== -1 && process.argv[flag + 1]
    ? process.argv[flag + 1]
    : (process.env.NARRALEAF_STUDIO ?? join(root, "..", "NarraLeaf-Studio")),
);
const entry = join(studio, "src", "shared", "authority", "kernel.ts");
if (!existsSync(entry)) {
  console.error(`no Studio kernel at ${entry}; pass --studio <path to a NarraLeaf-Studio checkout>`);
  process.exit(1);
}

const outdir = join(root, "studio-kernel", "vendor");
await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile: join(outdir, "kernel.js"),
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2023",
  // Studio's own alias for its shared tree.
  alias: { "@shared": join(studio, "src", "shared") },
  // Nothing outside Studio's shared tree may be reached. A kernel that needed
  // a package would need it installed on every server, and a kernel that
  // reached the renderer would not be pure; both fail here rather than later.
  packages: "bundle",
  legalComments: "none",
  banner: {
    js: "// Generated from NarraLeaf Studio's src/shared/authority/kernel.ts by scripts/vendor-studio.mjs. Do not edit it by hand.",
  },
  logLevel: "warning",
});

// What the server sees of the kernel. Deliberately opaque: Team does not model
// Studio's documents or operations, it hands them through, so a document is an
// object and an operation is anything with a verb. Written from here rather
// than generated from Studio's types, which would pull Studio's whole type
// graph into this repository's checker.
const declarations = `// Written by scripts/vendor-studio.mjs. Do not edit it by hand.
/** An operation, as Studio's live vocabulary states one. Opaque to Team beyond its verb. */
export type KernelOp = { readonly op: string; readonly [field: string]: unknown };
/** Which behaviour of the appliers this is. Compared with a connecting Studio's. */
export declare const KERNEL_VERSION: number;
/**
 * Apply one story operation to one story document, in place. Takes ownership of \`op\`.
 * Throws when the operation is malformed against the document (a scene that is not there).
 */
export declare function applyStoryOpToDocument(document: object, op: KernelOp, context: { now: string }): { changed: boolean };
/** The scenes a story operation reaches, or undefined for the whole document. */
export declare function storyOpSceneReach(op: KernelOp): readonly string[] | undefined;
/** The scene an entry pointer falls back to. */
export declare function firstSceneId(document: object): string | undefined;
/** The records an operation writes, as claim keys (\`row:<blockId>\`, \`character:<id>\`, ...). */
export declare function opClaimKeys(op: KernelOp): readonly string[];
/** Where the story library is, project-relative: \`editor/story/index.json\`. */
export declare const STORY_LIBRARY_PATH: string;
/** Where one story document is, project-relative. */
export declare function storyDocumentPath(storyId: string): string;
/** The story library's entries, as much of them as Team reads. */
export type KernelStoryLibrary = { stories: Array<{ readonly id: string; readonly name: string }> };
/** Read the story library from its file's text. Throws when it does not parse or a newer Studio wrote it. */
export declare function parseStoryLibrary(text: string): KernelStoryLibrary;
/** Read one story document from its file's text, migrated. Throws as {@link parseStoryLibrary} does. */
export declare function parseStoryDocument(storyId: string, text: string): object;
/** A story document or the library, as the editor writes it. */
export declare function serializeStoryFile(value: object): string;
/** The library half of a story operation, in place. True when the library changed. */
export declare function applyStoryOpToLibrary(library: KernelStoryLibrary, storyId: string, op: KernelOp, context: { now: string }): boolean;
/** A document address, as Studio's live vocabulary states one: \`{ doc: "story", storyId }\`, \`{ doc: "characters" }\`, ... */
export type KernelDocument = { readonly doc: string; readonly [field: string]: unknown };
/** The files of a project, by project-relative path, each as the JSON it is held as. */
export interface KernelProjectView {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  delete(path: string): void;
}
/** The story library's path. */
export declare const STORY_LIBRARY_FILE: string;
/** Whether a project-relative path is a document the authority holds. */
export declare function isProjectDocumentPath(path: string): boolean;
/** Where a document lives, project-relative. Throws for an address that names no document kind. */
export declare function projectDocumentPath(document: KernelDocument): string;
/** The parts of a project a team grants editing of separately. */
export declare const PROJECT_AREAS: readonly ["story", "characters", "assets", "ui", "localization", "config"];
export type ProjectArea = (typeof PROJECT_AREAS)[number];
/** Which area a project-relative path belongs to; anything unnamed is the game's configuration. */
export declare function projectAreaOf(path: string): ProjectArea;
/** Read one project file (stories migrated, the rest as stored). Throws when it does not parse or a newer Studio wrote it. */
export declare function parseProjectFile(path: string, text: string): unknown;
/** One project file as text, the way the editor writes it. */
export declare function serializeProjectFile(path: string, value: unknown): string;
/** The records an operation writes, for offline conflicts. */
export declare function projectOpClaimKeys(document: KernelDocument, op: KernelOp): readonly string[];
/**
 * Apply one operation to the project, in place; takes ownership of \`op\` and \`derived\`.
 * Throws when it does not apply. Answers which files it wrote.
 */
export declare function applyProjectOp(view: KernelProjectView, document: KernelDocument, op: KernelOp, context: { now: string }, derived?: unknown): { changed: boolean; touched: string[] };
/** The file transfers an asset operation brings with it. */
export declare function assetBytesOf(op: KernelOp): Array<{ assetType: string; assetId: string; transferId: string; path: string | null; size: number; digest: string }>;
/** Where an asset's bytes live: \`assets/content\`. */
export declare const ASSET_CONTENT_ROOT: string;
/** Whether a whole-file put may address a path (documents edited offline included). */
export declare function isTeamFilePath(path: string): boolean;
/** Whether a path only ever travels whole - held by the authority beside its documents. */
export declare function isWholeFilePath(path: string): boolean;
/** The claim a whole file carries; the authority marks it on every file an operation touches. */
export declare function fileClaimKey(path: string): string;
/** How the authority holds a file that is not one of its documents. */
export type HeldFile =
  | { $file: 1; encoding: "utf8" | "base64"; data: string }
  | { $file: 1; blob: { transferId: string; digest: string; size: number } }
  | { $file: 1; stored: { digest: string; size: number } };
export declare function isHeldFile(value: unknown): value is HeldFile;
/** A whole file's transfer, when a put sends its bytes through the blob store. */
export declare function fileBytesOf(document: KernelDocument, op: KernelOp): { path: string; transferId: string; digest: string; size: number } | undefined;
`;
await writeFile(join(outdir, "kernel.d.ts"), declarations, "utf8");

function git(...args) {
  try {
    return execFileSync("git", ["-C", studio, ...args], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const dirty = git("status", "--porcelain", "--", "src/shared");
const stamp = {
  _generated: "Written by scripts/vendor-studio.mjs. Do not edit it by hand.",
  studioCommit: git("rev-parse", "HEAD"),
  // The kernel was bundled from changes not yet committed in Studio. Fine
  // while the two are being developed together; a release is cut from a
  // stamp where this is false.
  studioDirty: dirty === null ? null : dirty.length > 0,
};
await writeFile(join(outdir, "stamp.json"), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
console.log(`wrote ${join(outdir, "kernel.js")} from ${studio}`);
