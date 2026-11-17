/**
 * What an operator decided about an account's own settings.
 *
 * An account's settings page is the account's: its name, its picture, where its notifications go,
 * whether it signs in with a second step, whether it makes API tokens. A team that hands out
 * accounts sometimes wants some of that fixed - every account behind two-step sign-in, nobody
 * making tokens that write, the display name the HR system knows. A policy says which settings are
 * fixed and, where it has one, to what.
 *
 * Two shapes: a **template**, named and shared, so "外包" can be one decision applied to twenty
 * accounts and changed once for all of them; and **settings of the account's own**, for the one
 * account that is different. An account follows one or the other, never both.
 *
 * A fixed value is written onto the account when the policy is applied, so everything that reads
 * a display name or a digest frequency goes on reading the same columns it always did; the policy
 * only adds the refusal when the account asks to change it. Nothing here is consulted to *read*.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { checkPersonalHook, writePrefs } from "../collab/prefs.js";
import {
  TEAM_DIGEST_FREQUENCIES,
  TEAM_NOTIFICATION_CATEGORIES,
  TEAM_NOTIFICATION_CHANNELS,
  type TeamAccountPolicy,
  type TeamAccountPolicyView,
  type TeamDigestFrequency,
  type TeamNotificationCategory,
  type TeamNotificationChannel,
  type TeamPolicyAccess,
  type TeamPolicyTemplate,
} from "../team/protocol.js";
import { inTransaction, integerColumn, optionalTextColumn, textColumn, type Row } from "./database.js";
import { policySwitch, REQUIRE_TWO_FACTOR } from "./policy.js";

export const POLICY_NAME_LIMIT = 64;
export const POLICY_DESCRIPTION_LIMIT = 400;
const DISPLAY_NAME_LIMIT = 128;
const BIO_LIMIT = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS: readonly TeamPolicyAccess[] = ["on", "read", "off"];

/** A policy that cannot be stored or applied, in a sentence for whoever wrote it. */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Said to an account that asks to change what an operator fixed. */
export const FIXED_BY_ADMIN = "an admin has fixed this setting for your account, so it cannot be changed here";

/* ------------------------------------------------------------------ reading a policy */

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PolicyRefusal(`${what} has to be an object`);
  return value as Record<string, unknown>;
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A `{ value? }` lock, with its value checked by `check`. Undefined when the field is not fixed. */
function lock<T>(raw: unknown, what: string, check: (value: unknown) => T): { value?: T } | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const read = record(raw, what);
  return read["value"] === undefined ? {} : { value: check(read["value"]) };
}

function text(limit: number, what: string): (value: unknown) => string {
  return (value) => {
    if (typeof value !== "string" || value.length > limit) throw new PolicyRefusal(`${what} has to be text of at most ${limit} characters`);
    return value.trim();
  };
}

function switchesOf(value: unknown): { category: TeamNotificationCategory; channel: TeamNotificationChannel; enabled: boolean }[] {
  if (!Array.isArray(value) || value.length > TEAM_NOTIFICATION_CATEGORIES.length * TEAM_NOTIFICATION_CHANNELS.length) {
    throw new PolicyRefusal("notification switches are a list of { category, channel, enabled }");
  }
  return value.map((entry: unknown) => {
    const read = record(entry, "a notification switch");
    const category = read["category"];
    const channel = read["channel"];
    if (typeof category !== "string" || !(TEAM_NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
      throw new PolicyRefusal(`category is one of ${TEAM_NOTIFICATION_CATEGORIES.join(", ")}`);
    }
    if (typeof channel !== "string" || !(TEAM_NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
      throw new PolicyRefusal(`channel is one of ${TEAM_NOTIFICATION_CHANNELS.join(", ")}`);
    }
    if (typeof read["enabled"] !== "boolean") throw new PolicyRefusal("enabled is true or false");
    return { category: category as TeamNotificationCategory, channel: channel as TeamNotificationChannel, enabled: read["enabled"] };
  });
}

function access(raw: unknown, what: string): TeamPolicyAccess | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !(ACCESS as readonly string[]).includes(raw)) throw new PolicyRefusal(`${what} is one of on, read, off`);
  return raw as TeamPolicyAccess;
}

/**
 * A policy as it came over the wire, checked, with what it does not fix left out.
 *
 * Unknown fields are dropped rather than refused: an older console sending a policy it read
 * from a newer server should not have every save refused for a field it never drew.
 */
export function parsePolicy(raw: unknown): TeamAccountPolicy {
  const read = record(raw ?? {}, "a policy");
  const displayName = lock(read["displayName"], "displayName", text(DISPLAY_NAME_LIMIT, "a display name"));
  if (displayName?.value === "") throw new PolicyRefusal("a fixed display name cannot be empty");
  const bio = lock(read["bio"], "bio", text(BIO_LIMIT, "a bio"));
  const timezone = lock(read["timezone"], "timezone", (value) => {
    const zone = text(64, "a time zone")(value);
    if (zone !== "" && !isTimeZone(zone)) throw new PolicyRefusal("a time zone is an IANA name such as Asia/Shanghai");
    return zone;
  });
  const switches = lock(read["notificationSwitches"], "notificationSwitches", switchesOf);
  const digest = lock(read["digest"], "digest", (value) => {
    if (typeof value !== "string" || !(TEAM_DIGEST_FREQUENCIES as readonly string[]).includes(value)) {
      throw new PolicyRefusal(`digest is one of ${TEAM_DIGEST_FREQUENCIES.join(", ")}`);
    }
    return value as TeamDigestFrequency;
  });
  const hook = lock(read["hook"], "hook", (value) => {
    const address = text(2048, "a notification address")(value);
    if (address === "") return "";
    try {
      return checkPersonalHook(address);
    } catch (error) {
      throw new PolicyRefusal(error instanceof Error ? error.message : String(error));
    }
  });
  const days = read["apiTokenMaxDays"];
  if (days !== undefined && days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) {
    throw new PolicyRefusal("apiTokenMaxDays is a whole number of days from 1 to 3650");
  }
  const apiTokens = access(read["apiTokens"], "apiTokens");
  const studioConfig = access(read["studioConfig"], "studioConfig");
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(bio === undefined ? {} : { bio }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(read["lockAvatar"] === true ? { lockAvatar: true } : {}),
    ...(switches === undefined ? {} : { notificationSwitches: switches }),
    ...(digest === undefined ? {} : { digest }),
    ...(hook === undefined ? {} : { hook }),
    ...(read["requireTwoFactor"] === true ? { requireTwoFactor: true } : {}),
    ...(apiTokens === undefined || apiTokens === "on" ? {} : { apiTokens }),
    ...(typeof days === "number" ? { apiTokenMaxDays: days } : {}),
    ...(studioConfig === undefined || studioConfig === "on" ? {} : { studioConfig }),
  };
}

/** A stored policy. A row written by hand that no longer parses fixes nothing rather than failing every read. */
function storedPolicy(json: string | undefined): TeamAccountPolicy {
  if (json === undefined) return {};
  try {
    return parsePolicy(JSON.parse(json));
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ templates */

function templateOf(database: DatabaseSync, row: Row): TeamPolicyTemplate {
  const id = textColumn(row, "id");
  const description = optionalTextColumn(row, "description");
  const counted = database.prepare("SELECT COUNT(*) AS n FROM account_policies WHERE template_id = ?").get(id) as Row;
  return {
    id,
    name: textColumn(row, "name"),
    ...(description === undefined ? {} : { description }),
    policy: storedPolicy(textColumn(row, "policy")),
    accounts: integerColumn(counted, "n"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

export function listPolicyTemplates(database: DatabaseSync): TeamPolicyTemplate[] {
  const rows = database.prepare("SELECT * FROM policy_templates ORDER BY name").all() as Row[];
  return rows.map((row) => templateOf(database, row));
}

export function findPolicyTemplate(database: DatabaseSync, id: string): TeamPolicyTemplate | undefined {
  const row = database.prepare("SELECT * FROM policy_templates WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : templateOf(database, row);
}

/**
 * Make a template, or change one - and with it every account that follows it, whose fixed values
 * are written again from the new policy.
 */
export function savePolicyTemplate(
  database: DatabaseSync,
  input: { id?: string; name: string; description?: string; policy: TeamAccountPolicy },
): TeamPolicyTemplate {
  const name = input.name.trim();
  if (name === "" || name.length > POLICY_NAME_LIMIT) throw new PolicyRefusal(`a template needs a name of at most ${POLICY_NAME_LIMIT} characters`);
  const clash = database.prepare("SELECT id FROM policy_templates WHERE name = ?").get(name) as Row | undefined;
  if (clash !== undefined && textColumn(clash, "id") !== input.id) throw new PolicyRefusal("there is already a template of that name");
  const now = Date.now();
  const description = input.description?.trim() === "" ? null : (input.description?.trim() ?? null);
  const json = JSON.stringify(input.policy);
  const id = input.id ?? randomUUID();
  inTransaction(database, () => {
    if (input.id === undefined) {
      database
        .prepare("INSERT INTO policy_templates (id, name, description, policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, description, json, now, now);
      return;
    }
    const changed = database
      .prepare("UPDATE policy_templates SET name = ?, description = ?, policy = ?, updated_at = ? WHERE id = ?")
      .run(name, description, json, now, id);
    if (Number(changed.changes) === 0) throw new PolicyRefusal("there is no template of that id");
    const followers = database.prepare("SELECT user_id FROM account_policies WHERE template_id = ?").all(id) as Row[];
    for (const row of followers) applyPolicyValues(database, textColumn(row, "user_id"), input.policy);
  });
  const saved = findPolicyTemplate(database, id);
  if (saved === undefined) throw new PolicyRefusal("there is no template of that id");
  return saved;
}

/**
 * Remove a template. The accounts that followed it keep what it fixed, as settings of their own:
 * taking a template away is not a decision to free twenty accounts at once.
 */
export function deletePolicyTemplate(database: DatabaseSync, id: string): boolean {
  return inTransaction(database, () => {
    const row = database.prepare("SELECT policy FROM policy_templates WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) return false;
    database
      .prepare("UPDATE account_policies SET policy = ?, template_id = NULL, updated_at = ? WHERE template_id = ?")
      .run(textColumn(row, "policy"), Date.now(), id);
    database.prepare("DELETE FROM policy_templates WHERE id = ?").run(id);
    return true;
  });
}

/* ------------------------------------------------------------------ one account */

export interface StoredAccountPolicy {
  readonly policy: TeamAccountPolicy;
  readonly template?: { readonly id: string; readonly name: string };
  readonly custom: boolean;
}

/** The policy an account is under, as stored: the template's, its own, or nothing. */
export function accountPolicy(database: DatabaseSync, userId: string): StoredAccountPolicy {
  const row = database
    .prepare(
      `SELECT a.template_id, a.policy AS own, t.name, t.policy AS shared
         FROM account_policies a LEFT JOIN policy_templates t ON t.id = a.template_id
        WHERE a.user_id = ?`,
    )
    .get(userId) as Row | undefined;
  if (row === undefined) return { policy: {}, custom: false };
  const templateId = optionalTextColumn(row, "template_id");
  const name = optionalTextColumn(row, "name");
  if (templateId !== undefined && name !== undefined) {
    return { policy: storedPolicy(optionalTextColumn(row, "shared")), template: { id: templateId, name }, custom: false };
  }
  return { policy: storedPolicy(optionalTextColumn(row, "own")), custom: true };
}

/** What `account.policy` answers: the stored policy with the server-wide two-step switch folded in. */
export function accountPolicyView(database: DatabaseSync, userId: string): TeamAccountPolicyView {
  const stored = accountPolicy(database, userId);
  const serverRequiresTwoFactor = policySwitch(database, REQUIRE_TWO_FACTOR);
  return {
    policy: serverRequiresTwoFactor ? { ...stored.policy, requireTwoFactor: true } : stored.policy,
    ...(stored.template === undefined ? {} : { template: stored.template }),
    custom: stored.custom,
    serverRequiresTwoFactor,
  };
}

/** Whether two-step sign-in is asked of this account: by the server-wide switch or by its own policy. */
export function accountRequiresTwoFactor(database: DatabaseSync, userId: string): boolean {
  return policySwitch(database, REQUIRE_TWO_FACTOR) || accountPolicy(database, userId).policy.requireTwoFactor === true;
}

/** What an account under a policy may do with personal API tokens. */
export function apiTokenAccess(database: DatabaseSync, userId: string): { access: TeamPolicyAccess; maxDays?: number } {
  const policy = accountPolicy(database, userId).policy;
  return { access: policy.apiTokens ?? "on", ...(policy.apiTokenMaxDays === undefined ? {} : { maxDays: policy.apiTokenMaxDays }) };
}

/** What an account may do with the Studio preferences kept here. */
export function studioConfigAccess(database: DatabaseSync, userId: string): TeamPolicyAccess {
  return accountPolicy(database, userId).policy.studioConfig ?? "on";
}

/**
 * Write what a policy fixes onto the account, and take away what it no longer allows.
 *
 * API tokens are revoked, not merely refused at their next use: "this account makes no tokens"
 * that left yesterday's token working would be a policy that says one thing and does another.
 */
export function applyPolicyValues(database: DatabaseSync, userId: string, policy: TeamAccountPolicy): void {
  if (policy.displayName?.value !== undefined) database.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(policy.displayName.value, userId);
  if (policy.bio?.value !== undefined) database.prepare("UPDATE users SET bio = ? WHERE id = ?").run(policy.bio.value === "" ? null : policy.bio.value, userId);
  if (policy.timezone?.value !== undefined) {
    database.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(policy.timezone.value === "" ? null : policy.timezone.value, userId);
  }
  writePrefs(database, userId, {
    ...(policy.notificationSwitches?.value === undefined ? {} : { switches: policy.notificationSwitches.value }),
    ...(policy.digest?.value === undefined ? {} : { digest: policy.digest.value }),
    ...(policy.hook?.value === undefined ? {} : { hook: policy.hook.value === "" ? null : policy.hook.value }),
  });
  if (policy.apiTokens === "off") {
    database.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
  } else if (policy.apiTokens === "read") {
    database.prepare("DELETE FROM api_tokens WHERE user_id = ? AND can_write = 1").run(userId);
  }
  if (policy.apiTokenMaxDays !== undefined) {
    database
      .prepare("DELETE FROM api_tokens WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .run(userId, Date.now() + policy.apiTokenMaxDays * DAY_MS);
  }
  if (policy.studioConfig === "off") database.prepare("DELETE FROM studio_configs WHERE user_id = ?").run(userId);
}

/** What one account is put under: a template, settings of its own, or nothing. */
export type PolicyAssignment = { readonly template: string } | { readonly policy: TeamAccountPolicy } | null;

/** Put an account under a policy and write what it fixes. */
export function setAccountPolicy(database: DatabaseSync, userId: string, assignment: PolicyAssignment, by: string): void {
  inTransaction(database, () => {
    if (assignment === null) {
      database.prepare("DELETE FROM account_policies WHERE user_id = ?").run(userId);
      return;
    }
    let policy: TeamAccountPolicy;
    if ("template" in assignment) {
      const template = database.prepare("SELECT policy FROM policy_templates WHERE id = ?").get(assignment.template) as Row | undefined;
      if (template === undefined) throw new PolicyRefusal("there is no template of that id");
      policy = storedPolicy(textColumn(template, "policy"));
    } else {
      policy = assignment.policy;
    }
    database
      .prepare(
        `INSERT INTO account_policies (user_id, template_id, policy, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET template_id = excluded.template_id, policy = excluded.policy,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(userId, "template" in assignment ? assignment.template : null, "template" in assignment ? null : JSON.stringify(policy), Date.now(), by);
    applyPolicyValues(database, userId, policy);
  });
}

/** Which accounts follow a template or have settings of their own, by id, for the account list. */
export function policyLabels(database: DatabaseSync): Map<string, { templateId?: string; templateName?: string }> {
  const rows = database
    .prepare("SELECT a.user_id, a.template_id, t.name FROM account_policies a LEFT JOIN policy_templates t ON t.id = a.template_id")
    .all() as Row[];
  const labels = new Map<string, { templateId?: string; templateName?: string }>();
  for (const row of rows) {
    const templateId = optionalTextColumn(row, "template_id");
    const templateName = optionalTextColumn(row, "name");
    labels.set(textColumn(row, "user_id"), templateId === undefined || templateName === undefined ? {} : { templateId, templateName });
  }
  return labels;
}
