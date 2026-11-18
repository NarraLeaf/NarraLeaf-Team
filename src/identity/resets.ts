/**
 * Password-reset links an operator makes for somebody who forgot theirs.
 *
 * There is no "forgot password" form anyone can fill in, because there is no
 * mail this server can be sure reaches the right person. An operator makes a
 * link, hands it over however they hand things over, and the link sets one new
 * password within a day and is then spent. Only its hash is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PasswordHasher } from "./passwords.js";
import { MINIMUM_PASSWORD_LENGTH, findUserById, type UserRecord } from "./users.js";

export const RESET_LIFETIME_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Make a link token for this account. Any earlier unused one is spent first. */
export function createPasswordReset(
  database: DatabaseSync,
  userId: string,
  createdBy: string | undefined,
  now = Date.now(),
): { readonly token: string; readonly expiresAt: number } {
  database
    .prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
    .run(now, userId);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = now + RESET_LIFETIME_MS;
  database
    .prepare(
      "INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(hashToken(token), userId, createdBy ?? null, now, expiresAt);
  return { token, expiresAt };
}

/** The account a link is for, if it is still good. */
export function resetTarget(database: DatabaseSync, token: string, now = Date.now()): UserRecord | undefined {
  const row = database
    .prepare("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(hashToken(token));
  if (row === undefined || row["used_at"] !== null || Number(row["expires_at"]) <= now) {
    return undefined;
  }
  const user = findUserById(database, String(row["user_id"]));
  return user === undefined || user.disabledAt !== undefined || user.isServiceAccount ? undefined : user;
}

export type ResetOutcome =
  | { readonly kind: "done"; readonly user: UserRecord }
  | { readonly kind: "gone" }
  | { readonly kind: "weak" };

/**
 * Spend a link on a new password.
 *
 * Every token the account holds is revoked as well, by moving its epoch on: a
 * reset is often because somebody else had the old password.
 */
export async function usePasswordReset(
  database: DatabaseSync,
  hasher: PasswordHasher,
  token: string,
  password: string,
  now = Date.now(),
): Promise<ResetOutcome> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { kind: "weak" };
  }
  const user = resetTarget(database, token, now);
  if (user === undefined) {
    return { kind: "gone" };
  }
  const hash = await hasher.hash(password);
  // Checked again after the hash, which takes a while: a link spent twice at
  // once sets one password, not two.
  const spent = database
    .prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .run(now, hashToken(token));
  if (Number(spent.changes) !== 1) {
    return { kind: "gone" };
  }
  database
    .prepare("UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1, tokens_invalidated_at = ? WHERE id = ?")
    .run(hash, now, user.id);
  database.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(user.id);
  return { kind: "done", user };
}
