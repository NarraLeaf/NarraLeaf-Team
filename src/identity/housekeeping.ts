/**
 * Housekeeping: what a running server does on its own, on the hour.
 *
 * Each table that only ever grows - notifications, the activity feed, chat, the audit trail, the
 * webhook delivery log - is cut back to what the operator's retention settings keep. A setting of
 * 0 days keeps a table for ever. Other periodic jobs (scheduled backups) hang off the same tick.
 */
import type { DatabaseSync } from "node:sqlite";

import { resumeWebhookDeliveries, stopWebhookDeliveries } from "../collab/webhooks.js";
import { policyNumber, RETAIN_ACTIVITY, RETAIN_AUDIT, RETAIN_CHAT, RETAIN_DELIVERIES, RETAIN_NOTIFICATIONS } from "./policy.js";

export const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Which table each retention setting cuts, and by which column. */
const RETENTION: readonly { readonly policy: string; readonly table: string; readonly column: string; readonly also?: string }[] = [
  // Read or not: a notification that old has done whatever it was going to.
  { policy: RETAIN_NOTIFICATIONS, table: "notifications", column: "at" },
  { policy: RETAIN_ACTIVITY, table: "activity", column: "at" },
  { policy: RETAIN_CHAT, table: "chat_messages", column: "at" },
  { policy: RETAIN_AUDIT, table: "decisions", column: "at" },
  // Never one still waiting for a retry.
  { policy: RETAIN_DELIVERIES, table: "webhook_deliveries", column: "at", also: "next_at IS NULL" },
];

export interface SweepResult {
  readonly [table: string]: number;
}

/** Cut every table back to its retention setting. Answers how many rows went from each. */
export function sweepRetention(database: DatabaseSync, now = Date.now()): SweepResult {
  const removed: Record<string, number> = {};
  for (const rule of RETENTION) {
    const days = policyNumber(database, rule.policy);
    if (!(days > 0)) continue;
    const cutoff = now - days * DAY_MS;
    const where = `${rule.column} < ?${rule.also === undefined ? "" : ` AND ${rule.also}`}`;
    const changes = Number(database.prepare(`DELETE FROM ${rule.table} WHERE ${where}`).run(cutoff).changes);
    if (changes > 0) removed[rule.table] = changes;
  }
  return removed;
}

export type HousekeepingJob = (database: DatabaseSync, now: number) => void | Promise<void>;

/** The hourly tick, and the retries a previous run left waiting. */
export class Housekeeping {
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private readonly jobs: HousekeepingJob[] = [];

  public constructor(private readonly database: DatabaseSync) {}

  /** Add something to run on every tick, after the retention sweep. */
  public add(job: HousekeepingJob): void {
    this.jobs.push(job);
  }

  public start(): void {
    if (this.timer !== undefined) return;
    try {
      resumeWebhookDeliveries(this.database);
    } catch {
      // A database too old for the table, or closing: the next start picks them up.
    }
    // The first pass shortly after starting, not during it.
    this.first = setTimeout(() => void this.tick(), 30_000);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), HOUSEKEEPING_INTERVAL_MS);
    this.timer.unref();
  }

  public async tick(now = Date.now()): Promise<void> {
    try {
      sweepRetention(this.database, now);
    } catch {
      // Closed under us; nothing to do.
    }
    for (const job of this.jobs) {
      try {
        await job(this.database, now);
      } catch {
        // One job failing is no reason to skip the next.
      }
    }
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    clearTimeout(this.first);
    this.timer = undefined;
    stopWebhookDeliveries();
  }
}
