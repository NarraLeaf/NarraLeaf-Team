/**
 * Which notifications one person wants, and where.
 *
 * A switch is (category, channel): `mention` × `push`, `review` × `email` and so on. A switch never
 * stored is on, so a new account hears everything in the list and nothing goes anywhere it did not
 * ask for (a push needs a browser to have subscribed; an email needs the digest switched on).
 *
 * Also kept on the account: how often the digest goes (`off`, `daily`, `weekly`) and a Feishu or
 * Slack incoming-webhook address it is also posted to.
 */
import type { DatabaseSync } from "node:sqlite";

import { booleanColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import type { UserRecord } from "../identity/users.js";
import {
  TEAM_DIGEST_FREQUENCIES,
  TEAM_NOTIFICATION_CATEGORIES,
  TEAM_NOTIFICATION_CHANNELS,
  type TeamDigestFrequency,
  type TeamNotificationCategory,
  type TeamNotificationChannel,
  type TeamNotificationKind,
  type TeamNotificationPrefs,
} from "../team/protocol.js";
import { subscriptionCount } from "./push.js";
import { mailConfigured, plainAddress } from "./smtp.js";
import { checkWebhookUrl } from "./webhooks.js";

/** The category one kind of notification is switched by. */
export function categoryOf(kind: TeamNotificationKind): TeamNotificationCategory {
  switch (kind) {
    case "mention":
      return "mention";
    case "reply":
      return "reply";
    case "assigned":
      return "assign";
    case "review-requested":
    case "review-answered":
      return "review";
    case "watch":
      return "watch";
    case "access-requested":
    case "access-decided":
      return "access";
  }
}

/** The kinds one category covers, for a query over the notifications table. */
export function kindsOf(category: TeamNotificationCategory): TeamNotificationKind[] {
  const all: TeamNotificationKind[] = ["mention", "reply", "assigned", "review-requested", "review-answered", "watch", "access-requested", "access-decided"];
  return all.filter((kind) => categoryOf(kind) === category);
}

/** Whether one switch is on. Never stored means on. */
export function switchOn(database: DatabaseSync, accountId: string, category: TeamNotificationCategory, channel: TeamNotificationChannel): boolean {
  const row = database
    .prepare("SELECT enabled FROM notification_prefs WHERE account_id = ? AND category = ? AND channel = ?")
    .get(accountId, category, channel) as Row | undefined;
  return row === undefined ? true : booleanColumn(row, "enabled");
}

/** The categories one channel is switched on for. */
export function categoriesOn(database: DatabaseSync, accountId: string, channel: TeamNotificationChannel): TeamNotificationCategory[] {
  return TEAM_NOTIFICATION_CATEGORIES.filter((category) => switchOn(database, accountId, category, channel));
}

/** What the account settings around the digest hold: frequency, last sent, own hook. */
export interface DigestSettings {
  readonly digest: TeamDigestFrequency;
  readonly lastDigestAt: number | undefined;
  readonly hook: string | undefined;
}

export function digestSettings(database: DatabaseSync, accountId: string): DigestSettings {
  const row = database.prepare("SELECT digest, last_digest_at, notify_hook FROM users WHERE id = ?").get(accountId) as Row | undefined;
  if (row === undefined) return { digest: "off", lastDigestAt: undefined, hook: undefined };
  const digest = textColumn(row, "digest");
  const last = row["last_digest_at"];
  return {
    digest: (TEAM_DIGEST_FREQUENCIES as readonly string[]).includes(digest) ? (digest as TeamDigestFrequency) : "off",
    lastDigestAt: typeof last === "number" || typeof last === "bigint" ? Number(last) : undefined,
    hook: optionalTextColumn(row, "notify_hook"),
  };
}

/** Everything the settings page shows. */
export function readPrefs(database: DatabaseSync, user: UserRecord): TeamNotificationPrefs {
  const switches = TEAM_NOTIFICATION_CATEGORIES.flatMap((category) =>
    TEAM_NOTIFICATION_CHANNELS.map((channel) => ({ category, channel, enabled: switchOn(database, user.id, category, channel) })),
  );
  const settings = digestSettings(database, user.id);
  const email = user.email === undefined ? undefined : plainAddress(user.email);
  return {
    switches,
    digest: settings.digest,
    ...(settings.hook === undefined ? {} : { hook: settings.hook }),
    ...(email === undefined ? {} : { email }),
    mail: mailConfigured(database),
    pushSubscriptions: subscriptionCount(database, user.id),
  };
}

export class PrefsRefusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** A Feishu, Lark, Slack or Discord incoming-webhook address, checked; the empty string clears it. */
export function checkPersonalHook(raw: string): string {
  const url = checkWebhookUrl(raw);
  return url;
}

/** How a personal hook's host wants its body. */
export function hookFormatOf(url: string): "feishu" | "discord" | "slack" {
  const host = new URL(url).hostname.toLowerCase();
  if (/(^|\.)(feishu\.cn|larksuite\.com|feishu-pre\.cn)$/.test(host)) return "feishu";
  if (/(^|\.)(discord\.com|discordapp\.com)$/.test(host)) return "discord";
  return "slack";
}

export interface PrefsChange {
  readonly switches?: readonly { readonly category: TeamNotificationCategory; readonly channel: TeamNotificationChannel; readonly enabled: boolean }[];
  readonly digest?: TeamDigestFrequency;
  /** A new address; `null` takes it away. */
  readonly hook?: string | null;
}

/** Store a change. Every part is optional; what is not named stays as it was. */
export function writePrefs(database: DatabaseSync, accountId: string, change: PrefsChange): void {
  for (const entry of change.switches ?? []) {
    database
      .prepare(
        `INSERT INTO notification_prefs (account_id, category, channel, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, category, channel) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(accountId, entry.category, entry.channel, entry.enabled ? 1 : 0);
  }
  if (change.digest !== undefined) {
    database.prepare("UPDATE users SET digest = ? WHERE id = ?").run(change.digest, accountId);
  }
  if (change.hook !== undefined) {
    database.prepare("UPDATE users SET notify_hook = ? WHERE id = ?").run(change.hook === null ? null : checkPersonalHook(change.hook), accountId);
  }
}
