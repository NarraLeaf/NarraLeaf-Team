/**
 * A team project's authority, started from its repository and put back into it.
 *
 * The two ends of the authority's life with Lore: open it from the latest revision, and snapshot
 * what it holds as a new revision - a history version. Between the two everything happens in the
 * authority, and nothing is written to the repository except by a snapshot.
 */
import { commitSnapshot, ensureWorkingCopy, readWorkingFile, workingCopyHead, type SnapshotResult, type WorkingCopyOptions } from "../projects/workingCopy.js";
import { listCheckedOutFiles, loadProjectFiles, type LoadedProject } from "./projectFiles.js";
import { ProjectAuthority } from "./projectAuthority.js";

/** The project's documents at the latest revision of its repository. */
export async function openProjectFiles(options: WorkingCopyOptions): Promise<LoadedProject> {
  const copy = await ensureWorkingCopy(options);
  const revision = await workingCopyHead(copy, options);
  const loaded = await loadProjectFiles(await listCheckedOutFiles(copy.path), (path) => readWorkingFile(copy, path));
  return { ...loaded, ...(revision === undefined ? {} : { revision }) };
}

/** Start a project's authority from the latest revision of its repository. */
export async function openProjectAuthority(
  options: WorkingCopyOptions,
  settings: { clock?: () => string } = {},
): Promise<{ authority: ProjectAuthority; unreadable: LoadedProject["unreadable"] }> {
  const loaded = await openProjectFiles(options);
  return {
    authority: new ProjectAuthority({ files: loaded.files, ...(settings.clock === undefined ? {} : { clock: settings.clock }) }),
    unreadable: loaded.unreadable,
  };
}

/** Put what the authority holds into the repository as one revision; nothing when nothing changed. */
export async function snapshotProject(
  options: WorkingCopyOptions,
  authority: ProjectAuthority,
  label?: string,
): Promise<SnapshotResult> {
  const message = label === undefined || label.trim() === ""
    ? `Team snapshot at seq ${authority.seq}`
    : `${label.trim()}\n\nTeam snapshot at seq ${authority.seq}`;
  return commitSnapshot({ ...options, removeMissing: true }, authority.serialize(), message);
}
