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
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { findProjectById } from "../projects/registry.js";
import {
  TEAM_WEBHOOK_EVENTS,
  TEAM_WEBHOOK_FORMATS,
  type TeamWebhook,
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

/** Post to one webhook; answers the status, 0 for no answer. Records it either way. */
export async function deliverOne(
  database: DatabaseSync,
  hook: WebhookRecord,
  event: WebhookEvent,
  fetchImpl: WebhookFetch = fetch as unknown as WebhookFetch,
  now = Date.now(),
): Promise<number> {
  const project = findProjectById(database, event.projectId);
  const { body, signature } = webhookBody(hook, event, project?.name ?? event.projectId, now);
  let status = 0;
  try {
    const answer = await fetchImpl(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "nlteam-webhook", "x-nlteam-event": event.type, "x-nlteam-signature": signature },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = answer.status;
  } catch {
    status = 0;
  }
  try {
    database.prepare("UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?").run(status, now, hook.id);
  } catch {
    // The database closed while the request was out (a server shutting down): nothing to record into.
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

/** Tell every webhook that wants it. Fire and forget: nothing waits on a chat room. */
export function emitWebhookEvent(database: DatabaseSync, event: WebhookEvent): void {
  let hooks: WebhookRecord[];
  try {
    hooks = webhooksFor(database, event);
  } catch {
    return;
  }
  for (const hook of hooks) void deliverOne(database, hook, event, fetchForEvents);
}
