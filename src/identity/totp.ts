/**
 * A second factor: time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * Kept in tables of their own rather than on the account, so an account that
 * never turns it on carries nothing, and turning it off is deleting two rows.
 *
 * The secret is stored as it is shown, base32, because an authenticator app is
 * handed exactly that and the server has to compute the same codes from it. A
 * recovery code is stored only as a hash: it is a password somebody wrote on
 * paper, used once.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { accountRequiresTwoFactor } from "./accountPolicy.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Thirty seconds, the period every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
/** One step either side, so a phone a little fast or slow still signs in. */
const WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error("that is not a base32 secret");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226: the code for one counter value. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpStep(now: number): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code an authenticator shows at this moment. */
export function totpCode(secret: string, now = Date.now()): string {
  return hotp(base32Decode(secret), totpStep(now));
}

/**
 * The step a code belongs to, within one step either side, or undefined.
 *
 * Compared in constant time so how many digits matched cannot be timed.
 */
export function matchTotp(secret: string, code: string, now = Date.now()): number | undefined {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) {
    return undefined;
  }
  const key = base32Decode(secret);
  const step = totpStep(now);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const expected = hotp(key, step + offset);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) {
      return step + offset;
    }
  }
  return undefined;
}

/** A fresh secret: 160 bits, the size RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** What an authenticator app scans or is pasted. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.toLowerCase().replace(/[\s-]/g, "")).digest("hex");
}

export interface TotpState {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly recoveryLeft: number;
}

/** Whether this account has a second factor, half set up, and how many recovery codes are left. */
export function totpState(database: DatabaseSync, userId: string): TotpState {
  const row = database.prepare("SELECT enabled_at FROM user_totp WHERE user_id = ?").get(userId);
  const left = database
    .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId);
  return {
    enabled: row !== undefined && row["enabled_at"] !== null,
    pending: row !== undefined && row["enabled_at"] === null,
    recoveryLeft: Number(left?.["n"] ?? 0),
  };
}

export function totpEnabled(database: DatabaseSync, userId: string): boolean {
  return totpState(database, userId).enabled;
}

/**
 * Start setting a second factor up: a new secret, not yet in force.
 *
 * Replaces any half-finished one. An enabled one is not replaced here — turning
 * it off comes first, and that asks for a code.
 */
export function beginTotp(database: DatabaseSync, userId: string): string {
  if (totpEnabled(database, userId)) {
    throw new Error("two-step sign-in is already on for this account");
  }
  const secret = newTotpSecret();
  database
    .prepare(
      `INSERT INTO user_totp (user_id, secret, enabled_at, last_step) VALUES (?, ?, NULL, 0)
       ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled_at = NULL, last_step = 0`,
    )
    .run(userId, secret);
  return secret;
}

/**
 * Put a half-set-up factor in force, once the person shows a code from it.
 *
 * Answers the recovery codes, which exist in plain text only in this answer.
 */
export function confirmTotp(
  database: DatabaseSync,
  userId: string,
  code: string,
  now = Date.now(),
): readonly string[] | undefined {
  const row = database
    .prepare("SELECT secret, enabled_at FROM user_totp WHERE user_id = ?")
    .get(userId);
  if (row === undefined || row["enabled_at"] !== null) {
    return undefined;
  }
  const step = matchTotp(String(row["secret"]), code, now);
  if (step === undefined) {
    return undefined;
  }
  database
    .prepare("UPDATE user_totp SET enabled_at = ?, last_step = ? WHERE user_id = ?")
    .run(now, step, userId);
  return replaceRecoveryCodes(database, userId, now);
}

/** Ten new recovery codes, the old ones gone. */
export function replaceRecoveryCodes(
  database: DatabaseSync,
  userId: string,
  _now = Date.now(),
): readonly string[] {
  database.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  const codes: string[] = [];
  const insert = database.prepare(
    "INSERT OR IGNORE INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)",
  );
  while (codes.length < RECOVERY_CODE_COUNT) {
    const raw = randomBytes(5).toString("hex");
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    if (codes.includes(code)) continue;
    codes.push(code);
    insert.run(userId, hashCode(code));
  }
  return codes;
}

/**
 * Check a second-factor code: an authenticator code, or one unused recovery code.
 *
 * An authenticator code is refused if its step is not later than the last one
 * accepted, so a code somebody watched being typed cannot be typed again.
 */
export function verifySecondFactor(
  database: DatabaseSync,
  userId: string,
  code: string,
  now = Date.now(),
): boolean {
  const row = database
    .prepare("SELECT secret, enabled_at, last_step FROM user_totp WHERE user_id = ?")
    .get(userId);
  if (row === undefined || row["enabled_at"] === null) {
    return false;
  }
  const step = matchTotp(String(row["secret"]), code, now);
  if (step !== undefined) {
    if (step <= Number(row["last_step"])) {
      return false;
    }
    database.prepare("UPDATE user_totp SET last_step = ? WHERE user_id = ?").run(step, userId);
    return true;
  }
  const used = database
    .prepare(
      "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    )
    .run(now, userId, hashCode(code));
  return Number(used.changes) === 1;
}

/** Turn a second factor off. */
export function removeTotp(database: DatabaseSync, userId: string): void {
  database.prepare("DELETE FROM user_totp WHERE user_id = ?").run(userId);
  database.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
}

/** Whether this account is asked for a second factor: by the server-wide switch, or by its own policy. */
export function twoFactorRequired(database: DatabaseSync, userId: string): boolean {
  return accountRequiresTwoFactor(database, userId);
}
