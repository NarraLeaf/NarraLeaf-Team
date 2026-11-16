/**
 * Backups of a whole server, and exports of one project.
 *
 * A backup is a tar.gz of the storage root: the database copied with
 * `VACUUM INTO` (a consistent copy taken while the server runs), the signing
 * keys, the credentials, the TLS material and the repositories. The cache and
 * the logs are left out, since a server rebuilds the one and does not need the
 * other. Backups are written under `<root>/backups/`, and restored only by
 * `nlteam restore` with the server stopped.
 *
 * The repositories are copied file by file while loreserver may be writing,
 * so a backup taken during a push can hold half of that push. Loreserver's
 * store is content-addressed and the half is an object nothing points to yet;
 * the database copy is the part that has to be exact, and is.
 */
import { randomBytes } from "node:crypto";
import { readdir, rename, rm, stat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";

import { attachmentsDir, buildsDir } from "./collab/builds.js";
import type { HousekeepingJob } from "./identity/housekeeping.js";
import { BACKUP_EVERY_HOURS, BACKUP_KEEP, policyNumber } from "./identity/policy.js";
import { extractTarGz, fileBody, writeTarGz, writeTarGzFile, type TarEntry } from "./tar.js";
import { VERSION } from "./version.js";

export const BACKUP_DIR = "backups";
export const PID_FILE = "team.pid";
const DATABASE_FILE = "team.db";
const MANIFEST = "nlteam-backup.json";
/** Top-level names under the root a backup leaves out. */
const LEFT_OUT = new Set([BACKUP_DIR, "cache", "logs", DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, PID_FILE]);
const BACKUP_NAME = /^nlteam-backup-\d{8}-\d{6}\.tar\.gz$/;

export interface BackupInfo {
  readonly name: string;
  readonly size: number;
  readonly createdAt: number;
}

function stamp(at: number): string {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}

async function* walk(root: string, relative: string, top: boolean): AsyncGenerator<TarEntry> {
  let names: string[];
  try {
    names = (await readdir(join(root, relative))).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (top && LEFT_OUT.has(name)) continue;
    if (name.endsWith(".lock") || name.endsWith(".part")) continue;
    const path = relative === "" ? name : `${relative}/${name}`;
    let info;
    try {
      info = await stat(join(root, path));
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      yield { name: path, size: 0, directory: true, mtime: info.mtimeMs, mode: 0o700 };
      yield* walk(root, path, false);
    } else if (info.isFile()) {
      yield { name: path, size: info.size, mtime: info.mtimeMs, mode: info.mode & 0o777, body: fileBody(join(root, path)) };
    }
  }
}

/** A consistent copy of the open database, at this path. */
function copyDatabase(database: DatabaseSync, path: string): void {
  database.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}

/** Take a backup now. Answers what was written. */
export async function createBackup(root: string, database: DatabaseSync, now = Date.now()): Promise<BackupInfo> {
  const directory = join(root, BACKUP_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `nlteam-backup-${stamp(now)}.tar.gz`;
  const copy = join(directory, `.db-${randomBytes(6).toString("hex")}.part`);
  const partial = join(directory, `${name}.part`);
  try {
    copyDatabase(database, copy);
    const copied = await stat(copy);
    const manifest = Buffer.from(JSON.stringify({ format: "nlteam-backup", version: 1, createdAt: now, server: VERSION }, null, 2));
    async function* entries(): AsyncGenerator<TarEntry> {
      yield { name: MANIFEST, size: manifest.length, body: manifest, mtime: now };
      yield { name: DATABASE_FILE, size: copied.size, body: fileBody(copy), mtime: now, mode: 0o600 };
      yield* walk(root, "", true);
    }
    await writeTarGzFile(entries(), partial);
    await rename(partial, join(directory, name));
  } finally {
    await rm(copy, { force: true });
    await rm(partial, { force: true });
  }
  const info = await stat(join(directory, name));
  return { name, size: info.size, createdAt: now };
}

/** The backups under this root, newest first. */
export async function listBackups(root: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(join(root, BACKUP_DIR));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const info = await stat(join(root, BACKUP_DIR, name));
      out.push({ name, size: info.size, createdAt: info.mtimeMs });
    } catch {
      // Removed between the two reads.
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** The path of a named backup, if it is one of ours and exists. */
export function backupPath(root: string, name: string): string | undefined {
  return BACKUP_NAME.test(name) ? join(root, BACKUP_DIR, name) : undefined;
}

/** Remove all but the newest `keep` backups. Answers how many went. */
export async function pruneBackups(root: string, keep: number): Promise<number> {
  const backups = await listBackups(root);
  let removed = 0;
  for (const old of backups.slice(Math.max(1, keep))) {
    await rm(join(root, BACKUP_DIR, old.name), { force: true });
    removed += 1;
  }
  return removed;
}

/** The housekeeping job: a backup when `backup.every_hours` says one is due, then pruning. */
export function backupJob(root: string, log?: (line: string) => void): HousekeepingJob {
  let running = false;
  return async (database: DatabaseSync, now: number) => {
    const hours = policyNumber(database, BACKUP_EVERY_HOURS);
    if (!(hours > 0) || running) return;
    const newest = (await listBackups(root))[0];
    // A few minutes' slack, so an hourly tick that lands a little early still takes it.
    if (newest !== undefined && now - newest.createdAt < hours * 3_600_000 - 5 * 60_000) return;
    running = true;
    try {
      const made = await createBackup(root, database, now);
      const removed = await pruneBackups(root, policyNumber(database, BACKUP_KEEP));
      log?.(`team: scheduled backup ${made.name} (${made.size} bytes)${removed > 0 ? `, removed ${removed} old` : ""}`);
    } finally {
      running = false;
    }
  };
}

/* ------------------------------------------------------------- the pid file */

/** Note that a server is running under this root, for `nlteam restore` to see. */
export async function writePidFile(root: string): Promise<void> {
  await writeFile(join(root, PID_FILE), `${process.pid}\n`, { mode: 0o600 });
}

export async function removePidFile(root: string): Promise<void> {
  try {
    const text = await readFile(join(root, PID_FILE), "utf-8");
    if (Number(text.trim()) === process.pid) await rm(join(root, PID_FILE), { force: true });
  } catch {
    // Already gone.
  }
}

/** The pid of a server running under this root, if there is one. */
export async function runningServer(root: string): Promise<number | undefined> {
  let pid: number;
  try {
    pid = Number((await readFile(join(root, PID_FILE), "utf-8")).trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: it is there and belongs to somebody else, which is still running.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/* ----------------------------------------------------------------- restore */

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly files: number; readonly bytes: number; readonly movedAside?: string }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Put a backup back under a root.
 *
 * Refused while a server runs there. A root with files in it is refused too,
 * unless `force`, in which case what was there is moved aside rather than
 * deleted, to `<root>.before-restore-<time>`.
 */
export async function restoreBackup(archive: string, root: string, force: boolean, now = Date.now()): Promise<RestoreOutcome> {
  const target = resolve(root);
  const pid = await runningServer(target);
  if (pid !== undefined) {
    return { kind: "refused", reason: `a server is running under ${target} (pid ${pid}); stop it first` };
  }
  try {
    await stat(archive);
  } catch {
    return { kind: "refused", reason: `there is no file at ${archive}` };
  }
  let existing: string[] = [];
  try {
    existing = await readdir(target);
  } catch {
    // Not there yet, which is fine.
  }
  let movedAside: string | undefined;
  if (existing.length > 0) {
    if (!force) {
      return { kind: "refused", reason: `${target} is not empty; pass --force to move what is there aside first` };
    }
    movedAside = `${target}.before-restore-${stamp(now)}`;
    await rename(target, movedAside);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const result = await extractTarGz(archive, target);
  try {
    const manifest = JSON.parse(await readFile(join(target, MANIFEST), "utf-8")) as { format?: string };
    if (manifest.format !== "nlteam-backup") throw new Error("not a backup");
  } catch {
    return { kind: "refused", reason: "that archive is not an nlteam backup (no manifest); what it held was unpacked anyway" };
  }
  await rm(join(target, MANIFEST), { force: true });
  return { kind: "restored", files: result.files, bytes: result.bytes, ...(movedAside === undefined ? {} : { movedAside }) };
}

/* ---------------------------------------------------------- project export */

/** Columns never exported: hashes of tokens and anything named a secret. */
const HIDDEN_COLUMN = /hash|secret|password/i;

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  return value;
}

/** Every row this server keeps about a project, table by table. */
export function projectRows(database: DatabaseSync, projectId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = (database.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
    const key = name === "projects" ? "id" : columns.includes("project_id") ? "project_id" : undefined;
    if (key === undefined) continue;
    const shown = columns.filter((column) => !HIDDEN_COLUMN.test(column));
    const rows = database
      .prepare(`SELECT ${shown.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ")} FROM "${name.replace(/"/g, '""')}" WHERE "${key}" = ?`)
      .all(projectId) as Array<Record<string, unknown>>;
    if (rows.length === 0) continue;
    out[name] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonValue(v)])));
  }
  return out;
}

const EXPORT_README = `This is an export of one NarraLeaf Team project.

project.json   every row this server keeps about the project, table by table
               (members, comments, to-dos, milestones, reviews, chat, builds...).
               Token hashes and secrets are left out.
builds/        the play builds uploaded to the project
attachments/   the pictures put beside comments

The project's files themselves are in its repository: clone it with Studio
or lore from the address the project page shows, to have every revision.
`;

/** Stream a project's export as a tar.gz. */
export async function exportProject(root: string, database: DatabaseSync, projectId: string, destination: Writable, now = Date.now()): Promise<void> {
  const rows = Buffer.from(JSON.stringify({ format: "nlteam-project", version: 1, exportedAt: now, server: VERSION, tables: projectRows(database, projectId) }, null, 2));
  const readme = Buffer.from(EXPORT_README);
  async function* entries(): AsyncGenerator<TarEntry> {
    yield { name: "README.txt", size: readme.length, body: readme, mtime: now };
    yield { name: "project.json", size: rows.length, body: rows, mtime: now };
    for (const [folder, directory] of [["builds", buildsDir(root, projectId)], ["attachments", attachmentsDir(root, projectId)]] as const) {
      let names: string[] = [];
      try {
        names = (await readdir(directory)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".part")) continue;
        const path = join(directory, name);
        const info = await stat(path).catch(() => undefined);
        if (info === undefined || !info.isFile()) continue;
        yield { name: `${folder}/${name}`, size: info.size, mtime: info.mtimeMs, body: fileBody(path) };
      }
    }
  }
  await writeTarGz(entries(), destination);
}
