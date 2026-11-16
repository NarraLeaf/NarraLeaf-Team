/**
 * Webhooks: this server posting its events to a chat room or another service.
 *
 * Operators alone make them, because a webhook is this server making requests
 * to an address somebody typed — the one place Team reaches out rather than
 * being reached. What it sends is bounded the same way:
 *
 *  - **http and https only**, no redirects followed, five seconds and done.
 *    A delivery that fails is recorded (`last_status`, 0 for no answer) and not
 *    retried; the next event is the next attempt.
 *  - **Signed.** A `json` body carries `X-NLTeam-Signature: sha256=<hex>`, the
 *    HMAC-SHA256 of the body under the secret shown once when the webhook was
 *    made. The chat formats (`slack`, `discord`, `feishu`) are those services'
 *    incoming-webhook shapes, one line of text, and carry the header too.
 *  - **Nothing a member could not see.** A project's event goes only to webhooks
 *    for that project or for every project, and says what the project's own
 *    activity feed would.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { findProjectById } from "../projects/registry.js";
import { isPrivateAddress, parseIp, policySwitch, WEBHOOKS_ALLOW_PRIVATE } from "../identity/policy.js";
import {
  TEAM_WEBHOOK_EVENTS,
  TEAM_WEBHOOK_FORMATS,
  type TeamWebhook,
  type TeamWebhookDelivery,
  type TeamWebhookEvent,
  type TeamWebhookFormat,
} from "../team/protocol.js";

export const WEBHOOK_TIMEOUT_MS = 5_000;
const URL_LIMIT = 2048;

export interface WebhookRecord {
  readonly id: string;
  readonly projectId: string | undefined;
  readonly url: string;
  readonly format: TeamWebhookFormat;
  readonly events: readonly TeamWebhookEvent[];
  readonly secret: string;
  readonly createdBy: string | undefined;
  readonly createdAt: number;
  readonly lastStatus: number | undefined;
  readonly lastAt: number | undefined;
}

export class WebhookRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

/** Something that happened, as a webhook is told it. */
export interface WebhookEvent {
  readonly type: TeamWebhookEvent;
  readonly projectId: string;
  /** One line a person can read: "ada committed: tidy chapter 3". */
  readonly summary: string;
  /** Who did it, by username, where somebody did. */
  readonly actor?: string;
  /** Whatever else identifies it — a revision, a thread, a to-do — by id. Never text. */
  readonly ref?: string;
}

function toRecord(row: Row): WebhookRecord {
  let events: TeamWebhookEvent[] = [];
  try {
    const parsed = JSON.parse(textColumn(row, "events")) as unknown;
    if (Array.isArray(parsed)) events = parsed.filter((e): e is TeamWebhookEvent => (TEAM_WEBHOOK_EVENTS as readonly unknown[]).includes(e));
  } catch {
    events = [];
  }
  const format = textColumn(row, "format");
  return {
    id: textColumn(row, "id"),
    projectId: optionalTextColumn(row, "project_id"),
    url: textColumn(row, "url"),
    format: (TEAM_WEBHOOK_FORMATS as readonly string[]).includes(format) ? (format as TeamWebhookFormat) : "json",
    events,
    secret: textColumn(row, "secret"),
    createdBy: optionalTextColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
    lastStatus: optionalIntegerColumn(row, "last_status"),
    lastAt: optionalIntegerColumn(row, "last_at"),
  };
}

export function webhookView(database: DatabaseSync, hook: WebhookRecord): TeamWebhook {
  const by = hook.createdBy === undefined ? undefined : findUserById(database, hook.createdBy)?.username;
  return {
    id: hook.id,
    ...(hook.projectId === undefined ? {} : { project: hook.projectId }),
    url: hook.url,
    format: hook.format,
    events: hook.events,
    ...(by === undefined ? {} : { createdBy: by }),
    createdAt: hook.createdAt,
    ...(hook.lastStatus === undefined ? {} : { lastStatus: hook.lastStatus }),
    ...(hook.lastAt === undefined ? {} : { lastAt: hook.lastAt }),
  };
}

export function listWebhooks(database: DatabaseSync): WebhookRecord[] {
  return (database.prepare("SELECT * FROM webhooks ORDER BY created_at").all() as Row[]).map(toRecord);
}

export function findWebhook(database: DatabaseSync, id: string): WebhookRecord | undefined {
  const row = database.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

/** The address, checked: http or https, no credentials in it, not too long. */
export function checkWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookRefusal("bad-params", "that is not an address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebhookRefusal("bad-params", "a webhook posts to http or https");
  if (url.username !== "" || url.password !== "") throw new WebhookRefusal("bad-params", "put a token in the path or query, not as a username and password");
  if (raw.length > URL_LIMIT) throw new WebhookRefusal("bad-params", "that address is too long");
  return url.toString();
}

export function createWebhook(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId?: string; url: string; format: TeamWebhookFormat; events: readonly TeamWebhookEvent[] },
  now = Date.now(),
): WebhookRecord {
  if (input.projectId !== undefined && findProjectById(database, input.projectId) === undefined) {
    throw new WebhookRefusal("not-found", "there is no project of that id on this server");
  }
  if (input.events.length === 0) throw new WebhookRefusal("bad-params", "name at least one event");
  const id = randomUUID();
  const secret = randomBytes(24).toString("base64url");
  database
    .prepare(
      "INSERT INTO webhooks (id, project_id, url, format, events, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.projectId ?? null, checkWebhookUrl(input.url), input.format, JSON.stringify([...new Set(input.events)]), secret, actor.id, now);
  return findWebhook(database, id) as WebhookRecord;
}

export function deleteWebhook(database: DatabaseSync, id: string): boolean {
  return Number(database.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes) > 0;
}

/** The body for one webhook, and its signature. */
export function webhookBody(hook: Pick<WebhookRecord, "format" | "secret">, event: WebhookEvent, projectName: string, at: number): { body: string; signature: string } {
  const line = `[${projectName}] ${event.summary}`;
  const payload =
    hook.format === "slack"
      ? { text: line }
      : hook.format === "discord"
        ? { content: line.slice(0, 2000) }
        : hook.format === "feishu"
          ? { msg_type: "text", content: { text: line } }
          : { event: event.type, project: { id: event.projectId, name: projectName }, summary: event.summary, actor: event.actor, ref: event.ref, at };
  const body = JSON.stringify(payload);
  return { body, signature: `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}` };
}

export type WebhookFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal }) => Promise<{ status: number }>;

/** Waits before each retry, in seconds: five more tries over about thirteen minutes. */
export const WEBHOOK_RETRY_SECONDS: readonly number[] = [1, 5, 30, 120, 600];
/** Deliveries kept per webhook; older ones go when a new one is written. */
export const WEBHOOK_DELIVERIES_KEPT = 200;

/** Answers worth trying again: nothing at all, too many requests, or the far end failing. */
export function worthRetrying(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export type WebhookResolver = (host: string) => Promise<readonly string[]>;

const resolveHost: WebhookResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Refuse an address on this machine or its network, unless the operator allows them.
 * Answers the reason, or undefined to go ahead. A name is looked up and every address it has is
 * checked, so a public name pointing inside does not get through.
 *
 * ⚠ There is a gap between this lookup and the one fetch makes. A name that answers differently
 * the second time could still reach inside; the guard is for mistakes and casual misuse, and the
 * operator's firewall is still the boundary.
 */
export async function webhookAddressRefusal(database: DatabaseSync, raw: string, resolver: WebhookResolver = resolveHost): Promise<string | undefined> {
  if (policySwitch(database, WEBHOOKS_ALLOW_PRIVATE)) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "that is not an address";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "this server does not post to addresses on its own network";
  let addresses: readonly string[];
  if (parseIp(host) !== undefined) {
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      return "no address found for that host";
    }
  }
  if (addresses.length === 0) return "no address found for that host";
  if (addresses.some(isPrivateAddress)) return "this server does not post to addresses on its own network";
  return undefined;
}

export interface WebhookDeliveryRecord {
  readonly id: number;
  readonly webhookId: string;
  readonly event: TeamWebhookEvent;
  readonly projectId: string | undefined;
  readonly summary: string;
  readonly body: string;
  readonly signature: string;
  readonly attempts: number;
  readonly status: number;
  readonly error: string | undefined;
  readonly at: number;
  readonly lastAt: number | undefined;
  readonly nextAt: number | undefined;
}

function toDelivery(row: Row): WebhookDeliveryRecord {
  return {
    id: integerColumn(row, "id"),
    webhookId: textColumn(row, "webhook_id"),
    event: textColumn(row, "event") as TeamWebhookEvent,
    projectId: optionalTextColumn(row, "project_id"),
    summary: textColumn(row, "summary"),
    body: textColumn(row, "body"),
    signature: textColumn(row, "signature"),
    attempts: integerColumn(row, "attempts"),
    status: integerColumn(row, "status"),
    error: optionalTextColumn(row, "error"),
    at: integerColumn(row, "at"),
    lastAt: optionalIntegerColumn(row, "last_at"),
    nextAt: optionalIntegerColumn(row, "next_at"),
  };
}

export function webhookDeliveryView(delivery: WebhookDeliveryRecord): TeamWebhookDelivery {
  return {
    id: delivery.id,
    webhook: delivery.webhookId,
    event: delivery.event,
    ...(delivery.projectId === undefined ? {} : { project: delivery.projectId }),
    summary: delivery.summary,
    attempts: delivery.attempts,
    status: delivery.status,
    ...(delivery.error === undefined ? {} : { error: delivery.error }),
    at: delivery.at,
    ...(delivery.lastAt === undefined ? {} : { lastAt: delivery.lastAt }),
    ...(delivery.nextAt === undefined ? {} : { nextAt: delivery.nextAt }),
  };
}

export function listWebhookDeliveries(database: DatabaseSync, webhookId: string, limit = 50): WebhookDeliveryRecord[] {
  return (database.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?").all(webhookId, limit) as Row[]).map(toDelivery);
}

export function findWebhookDelivery(database: DatabaseSync, id: number): WebhookDeliveryRecord | undefined {
  const row = database.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toDelivery(row);
}

/** Write down that an event is going to a webhook, keeping the latest few hundred. */
export function recordWebhookDelivery(database: DatabaseSync, hook: WebhookRecord, event: WebhookEvent, now = Date.now()): WebhookDeliveryRecord {
  const project = findProjectById(database, event.projectId);
  const { body, signature } = webhookBody(hook, event, project?.name ?? event.projectId, now);
  const id = Number(
    database
      .prepare("INSERT INTO webhook_deliveries (webhook_id, event, project_id, summary, body, signature, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(hook.id, event.type, event.projectId, event.summary, body, signature, now).lastInsertRowid,
  );
  database
    .prepare(
      "DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .run(hook.id, hook.id, WEBHOOK_DELIVERIES_KEPT);
  return findWebhookDelivery(database, id) as WebhookDeliveryRecord;
}

export interface DeliveryOptions {
  readonly fetchImpl?: WebhookFetch;
  /** Skip the check for private addresses (a test posting to a fake fetch). */
  readonly resolver?: WebhookResolver;
  readonly now?: number;
}

/**
 * Post one recorded delivery, once. Writes down the answer and, when it is worth another go and
 * tries are left, when that is. Answers the status, 0 for no answer.
 */
export async function attemptDelivery(database: DatabaseSync, deliveryId: number, options: DeliveryOptions = {}): Promise<number> {
  const delivery = findWebhookDelivery(database, deliveryId);
  if (delivery === undefined) return 0;
  const hook = findWebhook(database, delivery.webhookId);
  if (hook === undefined) return 0;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as WebhookFetch);
  let status = 0;
  let error: string | undefined;
  const refusal = options.fetchImpl !== undefined && options.resolver === undefined ? undefined : await webhookAddressRefusal(database, hook.url, options.resolver);
  if (refusal !== undefined) {
    error = refusal;
  } else {
    try {
      const answer = await fetchImpl(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "nlteam-webhook", "x-nlteam-event": delivery.event, "x-nlteam-signature": delivery.signature, "x-nlteam-delivery": String(delivery.id) },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      status = answer.status;
      if (status >= 300) error = `answered ${status}`;
    } catch (failure) {
      error = failure instanceof Error && failure.name === "TimeoutError" ? "no answer in time" : "could not connect";
    }
  }
  const attempts = delivery.attempts + 1;
  // A refusal will refuse again; nothing else is worth more tries than the schedule has.
  const wait = refusal === undefined && worthRetrying(status) ? WEBHOOK_RETRY_SECONDS[attempts - 1] : undefined;
  const nextAt = wait === undefined ? null : now + wait * 1000;
  try {
    database
      .prepare("UPDATE webhook_deliveries SET attempts = ?, status = ?, error = ?, last_at = ?, next_at = ? WHERE id = ?")
      .run(attempts, status, error ?? null, now, nextAt, delivery.id);
    database.prepare("UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?").run(status, now, hook.id);
  } catch {
    // The database closed while the request was out (a server shutting down): nothing to record into.
  }
  return status;
}

/** Post to one webhook now, recording it; answers the status, 0 for no answer. No retries. */
export async function deliverOne(
  database: DatabaseSync,
  hook: WebhookRecord,
  event: WebhookEvent,
  fetchImpl?: WebhookFetch,
  now = Date.now(),
): Promise<number> {
  const delivery = recordWebhookDelivery(database, hook, event, now);
  const status = await attemptDelivery(database, delivery.id, { ...(fetchImpl === undefined ? {} : { fetchImpl }), now });
  try {
    database.prepare("UPDATE webhook_deliveries SET next_at = NULL WHERE id = ?").run(delivery.id);
  } catch {
    // closed under us
  }
  return status;
}

/** The webhooks one event goes to. */
export function webhooksFor(database: DatabaseSync, event: WebhookEvent): WebhookRecord[] {
  return listWebhooks(database).filter(
    (hook) => (hook.projectId === undefined || hook.projectId === event.projectId) && hook.events.includes(event.type),
  );
}

let fetchForEvents: WebhookFetch | undefined;
/** For tests: what posts events. Undefined puts the platform's fetch back. */
export function setWebhookFetch(next: WebhookFetch | undefined): void {
  fetchForEvents = next;
}

const retryTimers = new Map<number, NodeJS.Timeout>();

/** Try a delivery, and keep trying on the schedule while it fails. */
export function sendDelivery(database: DatabaseSync, deliveryId: number): void {
  void attemptDelivery(database, deliveryId, fetchForEvents === undefined ? {} : { fetchImpl: fetchForEvents }).then(() => {
    let next: WebhookDeliveryRecord | undefined;
    try {
      next = findWebhookDelivery(database, deliveryId);
    } catch {
      return;
    }
    if (next?.nextAt !== undefined) scheduleDelivery(database, next.id, next.nextAt);
  });
}

function scheduleDelivery(database: DatabaseSync, deliveryId: number, at: number): void {
  clearTimeout(retryTimers.get(deliveryId));
  const timer = setTimeout(() => {
    retryTimers.delete(deliveryId);
    sendDelivery(database, deliveryId);
  }, Math.max(0, at - Date.now()));
  // A retry is never a reason to keep the process alive.
  timer.unref();
  retryTimers.set(deliveryId, timer);
}

/** Pick up the retries a previous run left waiting. What starting the server does. */
export function resumeWebhookDeliveries(database: DatabaseSync): number {
  const due = database.prepare("SELECT id, next_at FROM webhook_deliveries WHERE next_at IS NOT NULL").all() as Row[];
  for (const row of due) scheduleDelivery(database, integerColumn(row, "id"), integerColumn(row, "next_at"));
  return due.length;
}

/** Forget every waiting retry. What stopping the server does. */
export function stopWebhookDeliveries(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}

/** Send a past delivery again, as a new delivery of the same body. Answers the new one. */
export function redeliver(database: DatabaseSync, deliveryId: number, now = Date.now()): WebhookDeliveryRecord | undefined {
  const past = findWebhookDelivery(database, deliveryId);
  if (past === undefined) return undefined;
  const id = Number(
    database
      .prepare("INSERT INTO webhook_deliveries (webhook_id, event, project_id, summary, body, signature, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(past.webhookId, past.event, past.projectId ?? null, past.summary, past.body, past.signature, now).lastInsertRowid,
  );
  sendDelivery(database, id);
  return findWebhookDelivery(database, id);
}

/** Tell every webhook that wants it. Fire and forget: nothing waits on a chat room. */
export function emitWebhookEvent(database: DatabaseSync, event: WebhookEvent): void {
  let deliveries: WebhookDeliveryRecord[];
  try {
    deliveries = webhooksFor(database, event).map((hook) => recordWebhookDelivery(database, hook, event));
  } catch {
    return;
  }
  for (const delivery of deliveries) sendDelivery(database, delivery.id);
}
