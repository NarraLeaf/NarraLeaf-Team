/**
 * A project's files at a revision, over the routes in src/web/files.ts. The
 * page interprets them with @narraleaf/project-view; the server never does.
 */
export interface TreeFile {
  readonly path: string;
  readonly size: number;
}

export interface Tree {
  readonly revision: string;
  readonly files: readonly TreeFile[];
  readonly total: number;
}

function base(project: string): string {
  return `/api/team/v1/projects/${encodeURIComponent(project)}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string };
    return new Error(body.error ?? response.statusText);
  } catch {
    return new Error(response.statusText);
  }
}

export async function fetchTree(project: string, revision: string): Promise<Tree> {
  const response = await fetch(`${base(project)}/tree/${encodeURIComponent(revision)}`, { credentials: "same-origin" });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as Tree;
}

export async function fetchJson(project: string, revision: string, path: string): Promise<unknown> {
  const response = await fetch(rawUrl(project, revision, path), { credentials: "same-origin" });
  if (!response.ok) throw await readError(response);
  return JSON.parse(await response.text()) as unknown;
}

/** The address of one file's bytes, for an <img>, an <audio> or a download link. */
export function rawUrl(project: string, revision: string, path: string, as?: string): string {
  const query = as === undefined ? "" : `?as=${encodeURIComponent(as)}`;
  return `${base(project)}/raw/${encodeURIComponent(revision)}/${encodePath(path)}${query}`;
}
