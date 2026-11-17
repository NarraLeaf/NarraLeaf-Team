/**
 * The operator's policies: settings that are a number of days, a switch, a list
 * of networks or a line of text, kept in the same `settings` table as the rest.
 *
 * The settings in src/identity/settings.ts each have their own type, their own
 * error and their own branch on every surface, because each of them changes what
 * the server *is*. These change how long it remembers things and whom it lets
 * in, and there are enough of them that a branch each would be the code: so they
 * are one table, read and written by one pair of functions, and shown on the
 * settings surface under the label they are written by.
 */
import type { DatabaseSync } from "node:sqlite";
import { readSetting, writeSetting } from "./settings.js";

export type PolicyKind = "days" | "switch" | "number" | "text" | "secret" | "networks";

export interface PolicyDefinition {
  readonly key: string;
  /** The row's label on the settings surface, which is also what writes it. */
  readonly label: string;
  readonly group: string;
  readonly kind: PolicyKind;
  readonly fallback: string;
  /** For `days` and `number`: the inclusive range. `days` allows 0 for "for ever". */
  readonly min?: number;
  readonly max?: number;
}

export const RETAIN_NOTIFICATIONS = "retention.notifications_days";
export const RETAIN_ACTIVITY = "retention.activity_days";
export const RETAIN_CHAT = "retention.chat_days";
export const RETAIN_AUDIT = "retention.audit_days";
export const RETAIN_DELIVERIES = "retention.webhook_deliveries_days";
export const WEBHOOKS_ALLOW_PRIVATE = "webhooks.allow_private";
export const STUDIO_ACCESS_HOURS = "token.studio_access_hours";
export const REQUIRE_TWO_FACTOR = "security.require_two_factor";
export const ALLOWED_NETWORKS = "security.allowed_networks";
export const LOCKOUT_ATTEMPTS = "security.lockout_attempts";
export const LOCKOUT_MINUTES = "security.lockout_minutes";
export const STORAGE_QUOTA_MB = "storage.project_quota_mb";
export const BUILD_LIMIT_MB = "storage.build_limit_mb";
export const BACKUP_EVERY_HOURS = "backup.every_hours";
export const BACKUP_KEEP = "backup.keep";
export const SMTP_HOST = "email.smtp_host";
export const SMTP_PORT = "email.smtp_port";
export const SMTP_SECURE = "email.smtp_tls";
export const SMTP_USER = "email.smtp_user";
export const SMTP_PASSWORD = "email.smtp_password";
export const SMTP_FROM = "email.from";
export const PUBLIC_URL = "server.public_url";
export const OIDC_ISSUER = "sso.oidc_issuer";
export const OIDC_CLIENT_ID = "sso.oidc_client_id";
export const OIDC_CLIENT_SECRET = "sso.oidc_client_secret";
export const OIDC_CREATE = "sso.oidc_create_accounts";
export const OIDC_LABEL = "sso.oidc_button";
export const LDAP_URL = "sso.ldap_url";
export const LDAP_BIND = "sso.ldap_bind_dn";

export const POLICIES: readonly PolicyDefinition[] = [
  { key: RETAIN_NOTIFICATIONS, label: "notifications kept (days)", group: "retention", kind: "days", fallback: "90", min: 0, max: 3650 },
  { key: RETAIN_ACTIVITY, label: "activity kept (days)", group: "retention", kind: "days", fallback: "365", min: 0, max: 3650 },
  { key: RETAIN_CHAT, label: "chat kept (days)", group: "retention", kind: "days", fallback: "0", min: 0, max: 3650 },
  { key: RETAIN_AUDIT, label: "audit kept (days)", group: "retention", kind: "days", fallback: "0", min: 0, max: 3650 },
  { key: RETAIN_DELIVERIES, label: "webhook deliveries kept (days)", group: "retention", kind: "days", fallback: "30", min: 0, max: 3650 },
  { key: WEBHOOKS_ALLOW_PRIVATE, label: "webhooks to private addresses", group: "security", kind: "switch", fallback: "off" },
  { key: STUDIO_ACCESS_HOURS, label: "studio access token (hours)", group: "tokens", kind: "number", fallback: "24", min: 1, max: 720 },
  { key: REQUIRE_TWO_FACTOR, label: "two-factor required", group: "security", kind: "switch", fallback: "off" },
  { key: ALLOWED_NETWORKS, label: "allowed networks", group: "security", kind: "networks", fallback: "" },
  // Wrong passwords (or second steps) in a row before an account is locked; 0 never locks one.
  { key: LOCKOUT_ATTEMPTS, label: "lock after wrong passwords", group: "security", kind: "number", fallback: "10", min: 0, max: 100 },
  { key: LOCKOUT_MINUTES, label: "lock lasts (minutes)", group: "security", kind: "number", fallback: "15", min: 1, max: 1440 },
  { key: STORAGE_QUOTA_MB, label: "project storage quota (MB)", group: "storage", kind: "number", fallback: "0", min: 0, max: 10_000_000 },
  { key: BUILD_LIMIT_MB, label: "largest play build (MB)", group: "storage", kind: "number", fallback: "1024", min: 1, max: 100_000 },
  { key: BACKUP_EVERY_HOURS, label: "backup every (hours)", group: "backup", kind: "number", fallback: "0", min: 0, max: 24 * 30 },
  { key: BACKUP_KEEP, label: "backups kept", group: "backup", kind: "number", fallback: "7", min: 1, max: 365 },
  { key: PUBLIC_URL, label: "public address", group: "server", kind: "text", fallback: "" },
  { key: SMTP_HOST, label: "smtp host", group: "email", kind: "text", fallback: "" },
  { key: SMTP_PORT, label: "smtp port", group: "email", kind: "number", fallback: "587", min: 1, max: 65535 },
  { key: SMTP_SECURE, label: "smtp implicit tls", group: "email", kind: "switch", fallback: "off" },
  { key: SMTP_USER, label: "smtp user", group: "email", kind: "text", fallback: "" },
  { key: SMTP_PASSWORD, label: "smtp password", group: "email", kind: "secret", fallback: "" },
  { key: SMTP_FROM, label: "mail from", group: "email", kind: "text", fallback: "" },
  { key: OIDC_ISSUER, label: "oidc issuer", group: "sso", kind: "text", fallback: "" },
  { key: OIDC_CLIENT_ID, label: "oidc client id", group: "sso", kind: "text", fallback: "" },
  { key: OIDC_CLIENT_SECRET, label: "oidc client secret", group: "sso", kind: "secret", fallback: "" },
  { key: OIDC_CREATE, label: "oidc creates accounts", group: "sso", kind: "switch", fallback: "off" },
  { key: OIDC_LABEL, label: "oidc button text", group: "sso", kind: "text", fallback: "" },
  { key: LDAP_URL, label: "ldap url", group: "sso", kind: "text", fallback: "" },
  { key: LDAP_BIND, label: "ldap bind dn", group: "sso", kind: "text", fallback: "" },
];

export class InvalidPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicyError";
  }
}

const SWITCH_ON = new Set(["on", "yes", "true", "1", "enabled"]);
const SWITCH_OFF = new Set(["off", "no", "false", "0", "disabled", ""]);
const TEXT_LIMIT = 1024;

export function policyNamed(keyOrLabel: string): PolicyDefinition | undefined {
  return POLICIES.find((policy) => policy.key === keyOrLabel || policy.label === keyOrLabel);
}

function definition(key: string): PolicyDefinition {
  const found = policyNamed(key);
  if (found === undefined) throw new Error(`there is no policy called ${key}`);
  return found;
}

/** A value checked and put in its stored form, or a refusal saying why not. */
export function normalisePolicy(policy: PolicyDefinition, raw: string): string {
  const value = raw.trim();
  switch (policy.kind) {
    case "switch": {
      const lower = value.toLowerCase();
      if (SWITCH_ON.has(lower)) return "on";
      if (SWITCH_OFF.has(lower)) return "off";
      throw new InvalidPolicyError(`${policy.label} is on or off, not "${raw}"`);
    }
    case "days":
    case "number": {
      const text = policy.kind === "days" ? value.replace(/d$/i, "") : value;
      if (!/^\d+$/.test(text)) throw new InvalidPolicyError(`${policy.label} is a whole number, not "${raw}"`);
      const number = Number(text);
      if ((policy.min !== undefined && number < policy.min) || (policy.max !== undefined && number > policy.max)) {
        throw new InvalidPolicyError(`${policy.label} is from ${policy.min ?? 0} to ${policy.max ?? "any"}, not ${number}`);
      }
      return String(number);
    }
    case "networks": {
      const parts = value.split(/[\s,]+/).filter((part) => part !== "");
      for (const part of parts) {
        if (parseCidr(part) === undefined) throw new InvalidPolicyError(`${part} is not an address or a network like 10.0.0.0/8`);
      }
      return parts.join(", ");
    }
    case "text":
    case "secret":
      if (value.length > TEXT_LIMIT) throw new InvalidPolicyError(`${policy.label} is at most ${TEXT_LIMIT} characters`);
      if ([...value].some((char) => char.charCodeAt(0) < 0x20)) throw new InvalidPolicyError(`${policy.label} cannot hold control characters`);
      return value;
  }
}

export function readPolicy(database: DatabaseSync, key: string): string {
  const policy = definition(key);
  const stored = readSetting(database, policy.key);
  if (stored === undefined) return policy.fallback;
  try {
    return normalisePolicy(policy, stored);
  } catch {
    return policy.fallback;
  }
}

export function policyNumber(database: DatabaseSync, key: string): number {
  return Number(readPolicy(database, key));
}

export function policySwitch(database: DatabaseSync, key: string): boolean {
  return readPolicy(database, key) === "on";
}

export function policyStored(database: DatabaseSync, key: string): boolean {
  return readSetting(database, definition(key).key) !== undefined;
}

export function setPolicy(database: DatabaseSync, key: string, raw: string): string {
  const policy = definition(key);
  const value = normalisePolicy(policy, raw);
  writeSetting(database, policy.key, value);
  return value;
}

/** What the settings surface shows for a policy: a secret is shown as set or not, never read back. */
export function shownPolicy(database: DatabaseSync, policy: PolicyDefinition): string {
  const value = readPolicy(database, policy.key);
  if (policy.kind === "secret") return value === "" ? "" : "••••••";
  return value;
}

/* ------------------------------------------------------------- networks */

export interface Cidr {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

export function parseIp(text: string): { family: 4 | 6; bytes: Uint8Array } | undefined {
  const bare = text.startsWith("::ffff:") && text.includes(".") ? text.slice(7) : text;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const parts = bare.split(".").map(Number);
    if (parts.some((part) => part > 255)) return undefined;
    return { family: 4, bytes: Uint8Array.from(parts) };
  }
  if (!bare.includes(":")) return undefined;
  const unzoned = bare.split("%")[0] as string;
  const halves = unzoned.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] as string;
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 255;
  }
  return { family: 6, bytes };
}

export function parseCidr(text: string): Cidr | undefined {
  const [address, prefixText] = text.split("/");
  const ip = parseIp(address ?? "");
  if (ip === undefined) return undefined;
  const width = ip.family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : /^\d+$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (!(prefix >= 0 && prefix <= width)) return undefined;
  return { ...ip, prefix };
}

export function inCidr(address: string, cidr: Cidr): boolean {
  const ip = parseIp(address);
  if (ip === undefined || ip.family !== cidr.family) return false;
  let bits = cidr.prefix;
  for (let index = 0; bits > 0; index += 1, bits -= 8) {
    const mask = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
    if (((ip.bytes[index] as number) & mask) !== ((cidr.bytes[index] as number) & mask)) return false;
  }
  return true;
}

const PRIVATE_NETWORKS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
].map((text) => parseCidr(text) as Cidr);

/** Loopback, private, link-local, carrier-grade NAT, multicast or unspecified. */
export function isPrivateAddress(address: string): boolean {
  if (parseIp(address) === undefined) return true;
  return PRIVATE_NETWORKS.some((cidr) => inCidr(address, cidr));
}

/** Whether an address may reach this server under `security.allowed_networks`. Empty allows everybody. */
export function addressAllowed(database: DatabaseSync, address: string | undefined): boolean {
  const list = readPolicy(database, ALLOWED_NETWORKS);
  if (list === "") return true;
  if (address === undefined) return false;
  const ip = parseIp(address);
  if (ip === undefined) return false;
  // The machine itself is always let in: an operator who typed the wrong network
  // must still be able to reach the console from the server to put it right.
  if (isLoopback(address)) return true;
  return list.split(", ").some((part) => {
    const cidr = parseCidr(part);
    return cidr !== undefined && inCidr(address, cidr);
  });
}

function isLoopback(address: string): boolean {
  const ip = parseIp(address);
  if (ip === undefined) return false;
  return ip.family === 4 ? ip.bytes[0] === 127 : inCidr(address, parseCidr("::1/128") as Cidr);
}
