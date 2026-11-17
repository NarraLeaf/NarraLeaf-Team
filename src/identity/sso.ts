/**
 * Turning somebody a directory or an identity provider vouched for into an
 * account here.
 *
 * Matched, in order, by the provider's subject (once an account has signed in
 * that way), by email, and by username. When none matches, an account is made
 * only if `sso.oidc_create_accounts` is on; it gets a random password nobody
 * knows and no groups, so it is a member of nothing until somebody adds it.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { OIDC_CREATE, policySwitch } from "./policy.js";
import { defaultPasswordHasher } from "./passwords.js";
import { findUser, findUserById, insertUser, normaliseUsername, prepareUser, type UserRecord } from "./users.js";

export interface ExternalIdentity {
  readonly provider: "oidc" | "ldap";
  /** The provider's stable id for the person; for LDAP, the username. */
  readonly subject: string;
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
}

/** A username this server accepts, made from whatever the provider called the person. */
export function usernameFrom(raw: string): string | undefined {
  const cleaned = normaliseUsername(raw)
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(cleaned) ? cleaned : undefined;
}

function byEmail(database: DatabaseSync, email: string): UserRecord | undefined {
  const rows = database
    .prepare("SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 2")
    .all(email);
  // Two accounts with one address is ambiguous, and an ambiguous match is no match.
  if (rows.length !== 1) return undefined;
  return findUserById(database, String(rows[0]?.["id"]));
}

export type ExternalOutcome =
  | { readonly kind: "matched"; readonly user: UserRecord; readonly created: boolean }
  | { readonly kind: "unknown" }
  | { readonly kind: "disabled" };

export async function externalAccount(
  database: DatabaseSync,
  identity: ExternalIdentity,
): Promise<ExternalOutcome> {
  const linked = database
    .prepare("SELECT user_id FROM sso_subjects WHERE provider = ? AND subject = ?")
    .get(identity.provider, identity.subject);
  let user = linked === undefined ? undefined : findUserById(database, String(linked["user_id"]));
  if (user === undefined && identity.email !== undefined && identity.email !== "") {
    user = byEmail(database, identity.email);
  }
  if (user === undefined && identity.username !== undefined) {
    user = findUser(database, identity.username);
  }
  let created = false;
  if (user === undefined) {
    if (!policySwitch(database, OIDC_CREATE)) {
      return { kind: "unknown" };
    }
    const username = usernameFrom(identity.username ?? identity.email ?? "");
    if (username === undefined || findUser(database, username) !== undefined) {
      return { kind: "unknown" };
    }
    const prepared = await prepareUser(defaultPasswordHasher(), {
      username,
      password: randomBytes(24).toString("base64url"),
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName.slice(0, 40) }),
      ...(identity.email === undefined ? {} : { email: identity.email }),
    });
    insertUser(database, prepared);
    user = findUserById(database, prepared.id);
    created = true;
    if (user === undefined) return { kind: "unknown" };
  }
  if (user.disabledAt !== undefined || user.isServiceAccount) {
    return { kind: "disabled" };
  }
  database
    .prepare("INSERT OR IGNORE INTO sso_subjects (provider, subject, user_id) VALUES (?, ?, ?)")
    .run(identity.provider, identity.subject, user.id);
  return { kind: "matched", user, created };
}
