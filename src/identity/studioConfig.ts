/**
 * Studio's preferences, kept for one account so another computer can put them back.
 *
 * Bytes, as Studio sent them. This server does not read them, check them against a schema or
 * know what a preference is: Studio wrote the document and Studio reads it back, and the version
 * inside it is Studio's business. What this keeps beside the bytes is what a person needs to tell
 * two backups apart - when, how large, and which Studio sent it.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { TeamStudioConfigStatus } from "../team/protocol.js";
import { studioConfigAccess } from "./accountPolicy.js";
import { integerColumn, optionalTextColumn, textColumn, type Row } from "./database.js";

export interface StoredStudioConfig {
  readonly body: Buffer;
  readonly sha256: string;
  readonly updatedAt: number;
}

export function studioConfigStatus(database: DatabaseSync, userId: string): TeamStudioConfigStatus {
  const row = database.prepare("SELECT size, sha256, studio_version, updated_at FROM studio_configs WHERE user_id = ?").get(userId) as Row | undefined;
  const studioVersion = row === undefined ? undefined : optionalTextColumn(row, "studio_version");
  return {
    access: studioConfigAccess(database, userId),
    ...(row === undefined
      ? {}
      : {
          stored: {
            size: integerColumn(row, "size"),
            updatedAt: integerColumn(row, "updated_at"),
            sha256: textColumn(row, "sha256"),
            ...(studioVersion === undefined ? {} : { studioVersion }),
          },
        }),
  };
}

export function readStudioConfig(database: DatabaseSync, userId: string): StoredStudioConfig | undefined {
  const row = database.prepare("SELECT body, sha256, updated_at FROM studio_configs WHERE user_id = ?").get(userId) as Row | undefined;
  if (row === undefined) return undefined;
  const body = row["body"];
  return {
    body: body instanceof Uint8Array ? Buffer.from(body) : Buffer.alloc(0),
    sha256: textColumn(row, "sha256"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

/** Keep a new document, in place of the last one. */
export function writeStudioConfig(database: DatabaseSync, userId: string, body: Buffer, studioVersion: string | undefined): StoredStudioConfig {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const updatedAt = Date.now();
  database
    .prepare(
      `INSERT INTO studio_configs (user_id, body, size, sha256, studio_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, size = excluded.size, sha256 = excluded.sha256,
         studio_version = excluded.studio_version, updated_at = excluded.updated_at`,
    )
    .run(userId, body, body.length, sha256, studioVersion ?? null, updatedAt);
  return { body, sha256, updatedAt };
}

export function deleteStudioConfig(database: DatabaseSync, userId: string): boolean {
  return Number(database.prepare("DELETE FROM studio_configs WHERE user_id = ?").run(userId).changes) > 0;
}
