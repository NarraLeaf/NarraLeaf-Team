/**
 * Personal API tokens: a long-lived credential an account makes for a script.
 *
 * Narrower than a sign-in on purpose. A token reaches the projects it names
 * (or every project the account may reach, when it names none), is read-only
 * unless it was made to write, never reaches the management plane, and never
 * makes or revokes tokens itself. It is stored as a SHA-256 hash only: the
 * token is shown once, when it is made, and a database somebody copied holds
 * nothing that can be presented.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { findUserById, type UserRecord } from "./users.js";

/** Every API token starts with this, so a bearer can be told from a signed token at a glance. */
export const API_TOKEN_PREFIX = "nlt_";
export const API_TOKEN_NAME_LIMIT = 80;
export const API_TOKENS_PER_ACCOUNT = 50;

export interface ApiTokenLimits {
  /** The project ids this token reaches, or undefined for all the account reaches. */
  readonly projects?: readonly string[];
  readonly write: boolean;
}

export interface ApiTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly projects?: readonly string[];
  readonly write: boolean;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toRecord(row: Record<string, unknown>): ApiTokenRecord {
  const projects = row["projects"] === null ? undefined : (JSON.parse(String(row["projects"])) as string[]);
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    ...(projects === undefined ? {} : { projects }),
    write: Number(row["can_write"]) === 1,
    ...(row["expires_at"] === null ? {} : { expiresAt: Number(row["expires_at"]) }),
    createdAt: Number(row["created_at"]),
    ...(row["last_used_at"] === null ? {} : { lastUsedAt: Number(row["last_used_at"]) }),
  };
}

export function listApiTokens(database: DatabaseSync, userId: string): ApiTokenRecord[] {
  return database
    .prepare(
      "SELECT id, name, projects, can_write, expires_at, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId)
    .map((row) => toRecord(row as Record<string, unknown>));
}

export interface NewApiToken {
  readonly name: string;
  readonly projects?: readonly string[];
  readonly write: boolean;
  readonly expiresAt?: number;
}

/** Make a token. The token itself is in this answer and nowhere else. */
export function createApiToken(
  database: DatabaseSync,
  userId: string,
  input: NewApiToken,
  now = Date.now(),
): { readonly token: string; readonly record: ApiTokenRecord } {
  const count = database.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?").get(userId);
  if (Number(count?.["n"] ?? 0) >= API_TOKENS_PER_ACCOUNT) {
    throw new Error(`an account holds at most ${API_TOKENS_PER_ACCOUNT} API tokens`);
  }
  const id = randomUUID();
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  database
    .prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, projects, can_write, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      input.name,
      hashToken(token),
      input.projects === undefined ? null : JSON.stringify(input.projects),
      input.write ? 1 : 0,
      input.expiresAt ?? null,
      now,
    );
  return {
    token,
    record: {
      id,
      name: input.name,
      ...(input.projects === undefined ? {} : { projects: input.projects }),
      write: input.write,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: now,
    },
  };
}

export function revokeApiToken(database: DatabaseSync, userId: string, id: string): boolean {
  const result = database.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(result.changes) === 1;
}

export type ApiTokenIdentity =
  | { readonly kind: "identified"; readonly user: UserRecord; readonly limits: ApiTokenLimits }
  | { readonly kind: "refused"; readonly detail: string };

/** Who an API token belongs to, and what it may do, asked again on every call. */
export function identifyApiToken(
  database: DatabaseSync,
  token: string,
  now = Date.now(),
): ApiTokenIdentity {
  const row = database
    .prepare("SELECT id, user_id, projects, can_write, expires_at, last_used_at FROM api_tokens WHERE token_hash = ?")
    .get(hashToken(token));
  if (row === undefined) {
    return { kind: "refused", detail: "that API token is not one this server knows, or it was revoked" };
  }
  if (row["expires_at"] !== null && Number(row["expires_at"]) <= now) {
    return { kind: "refused", detail: "that API token has expired" };
  }
  const user = findUserById(database, String(row["user_id"]));
  if (user === undefined || user.disabledAt !== undefined) {
    return { kind: "refused", detail: "the account that API token belongs to cannot sign in" };
  }
  // Written at most once a minute, so a script calling in a loop is not a write per call.
  const last = row["last_used_at"] === null ? 0 : Number(row["last_used_at"]);
  if (now - last > 60_000) {
    database.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, String(row["id"]));
  }
  const projects = row["projects"] === null ? undefined : (JSON.parse(String(row["projects"])) as string[]);
  return {
    kind: "identified",
    user,
    limits: { ...(projects === undefined ? {} : { projects }), write: Number(row["can_write"]) === 1 },
  };
}
