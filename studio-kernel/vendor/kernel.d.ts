// Written by scripts/vendor-studio.mjs. Do not edit it by hand.
/** An operation, as Studio's live vocabulary states one. Opaque to Team beyond its verb. */
export type KernelOp = { readonly op: string; readonly [field: string]: unknown };
/** Which behaviour of the appliers this is. Compared with a connecting Studio's. */
export declare const KERNEL_VERSION: number;
/**
 * Apply one story operation to one story document, in place. Takes ownership of `op`.
 * Throws when the operation is malformed against the document (a scene that is not there).
 */
export declare function applyStoryOpToDocument(document: object, op: KernelOp, context: { now: string }): { changed: boolean };
/** The scenes a story operation reaches, or undefined for the whole document. */
export declare function storyOpSceneReach(op: KernelOp): readonly string[] | undefined;
/** The scene an entry pointer falls back to. */
export declare function firstSceneId(document: object): string | undefined;
/** The records an operation writes, as claim keys (`row:<blockId>`, `character:<id>`, ...). */
export declare function opClaimKeys(op: KernelOp): readonly string[];
/** Where the story library is, project-relative: `editor/story/index.json`. */
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
/** A document address, as Studio's live vocabulary states one: `{ doc: "story", storyId }`, `{ doc: "characters" }`, ... */
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
 * Apply one operation to the project, in place; takes ownership of `op` and `derived`.
 * Throws when it does not apply. Answers which files it wrote.
 */
export declare function applyProjectOp(view: KernelProjectView, document: KernelDocument, op: KernelOp, context: { now: string }, derived?: unknown): { changed: boolean; touched: string[] };
/** The file transfers an asset operation brings with it. */
export declare function assetBytesOf(op: KernelOp): Array<{ assetType: string; assetId: string; transferId: string; path: string | null; size: number; digest: string }>;
/** Where an asset's bytes live: `assets/content`. */
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
