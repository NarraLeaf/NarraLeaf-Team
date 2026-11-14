/**
 * Turning an `authorization: Bearer <jwt>` header into an account.
 *
 * loreserver does not tell Team who is calling. It forwards the header the
 * client sent it, unread, and asks what that caller may reach — so identifying
 * the caller is Team's job, from a token Team itself signed a few minutes
 * earlier.
 *
 * Two questions are answered here, and both have to be:
 *
 *   - Is the token one of ours, unaltered and not expired? That is
 *     {@link verifyToken}, which reads nothing but the token.
 *   - Is the account it names still allowed anything? That needs the database:
 *     an account can be disabled, and its `token_epoch` can be bumped, after a
 *     token was signed and before it expires. Either makes the token worthless
 *     here without changing a byte of it.
 */
import type { DatabaseSync } from "node:sqlite";

import type { IdentityConfig } from "./config.js";
import type { KeyStore } from "./keys.js";
import {
  TOKEN_REFUSAL_REASONS,
  verifyToken,
  type TokenClaims,
  type TokenRefusal,
  type VerifyOptions,
} from "./tokens.js";
import { findUserById, type UserRecord } from "./users.js";
import { grantIsLive } from "./oauth.js";

/** Why a caller was not identified. */
export type CallerRefusal =
  | TokenRefusal
  /** No `authorization: Bearer` header arrived at all. */
  | "no-token"
  /** The token names an account that is no longer in the database. */
  | "unknown-account"
  | "disabled"
  /** The account's tokens were revoked after this one was signed. */
  | "stale-epoch"
  /** The device this token was issued to through the browser sign-in was signed out. */
  | "revoked-grant";

/** Who is calling, or why nobody is. */
export type CallerIdentification =
  | { readonly kind: "identified"; readonly user: UserRecord; readonly claims: TokenClaims }
  | { readonly kind: "refused"; readonly reason: CallerRefusal };

/** One sentence for each way identifying a caller can fail. */
const REFUSAL_REASONS: Readonly<Record<CallerRefusal, string>> = {
  ...TOKEN_REFUSAL_REASONS,
  "no-token": "the call carried no bearer token",
  "unknown-account": "the token names an account this server does not have",
  disabled: "the account is disabled",
  "stale-epoch": "the token was issued before the account's access was revoked",
  "revoked-grant": "the device this token was issued to has been signed out; sign in again",
};

/**
 * Say why a caller was refused, for the audit line.
 *
 * The distinctions are kept here, unlike a sign-in, which reports every failure
 * with one sentence. Nobody is enumerating accounts through this: the caller
 * already holds a signed token, and the only readers are the operator's log and
 * loreserver, which is told none of it.
 */
export function describeRefusal(reason: CallerRefusal): string {
  return REFUSAL_REASONS[reason];
}

/**
 * The token out of an `authorization` header, or undefined.
 *
 * The scheme is compared case-insensitively, as HTTP requires, and anything
 * that is not `Bearer` is treated as no token rather than as an error: it is
 * not a token this can use either way.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Identify the caller who presented `token`. */
export function identifyToken(
  database: DatabaseSync,
  keys: KeyStore,
  config: IdentityConfig,
  token: string | undefined,
  options: VerifyOptions = {},
): CallerIdentification {
  if (token === undefined) {
    return { kind: "refused", reason: "no-token" };
  }

  const verification = verifyToken(token, keys, config, options);
  if (verification.kind === "refused") {
    return { kind: "refused", reason: verification.reason };
  }

  const user = findUserById(database, verification.claims.sub);
  if (user === undefined) {
    return { kind: "refused", reason: "unknown-account" };
  }
  if (user.disabledAt !== undefined) {
    return { kind: "refused", reason: "disabled" };
  }
  // Older, not different: a token from a future epoch cannot exist, and one
  // from a lower epoch was signed before somebody revoked this account's
  // access. src/identity/tokens.ts sets out what that does and does not undo.
  if (verification.claims.token_epoch < user.tokenEpoch) {
    return { kind: "refused", reason: "stale-epoch" };
  }
  if (verification.claims.grant !== undefined && !grantIsLive(database, verification.claims.grant, user.id)) {
    return { kind: "refused", reason: "revoked-grant" };
  }

  return { kind: "identified", user, claims: verification.claims };
}

/** Identify the caller behind one `authorization` header. */
export function identifyCaller(
  database: DatabaseSync,
  keys: KeyStore,
  config: IdentityConfig,
  header: string | undefined,
  options: VerifyOptions = {},
): CallerIdentification {
  return identifyToken(database, keys, config, bearerToken(header), options);
}
