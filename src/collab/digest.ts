/**
 * The digest: what a person missed, gathered into one message a day or a week.
 *
 * It holds the notifications still unread since the last digest whose category has the `email`
 * switch on, and goes two ways, whichever the person set up:
 *
 *  - **by email**, when the account has an address and the operator configured a relay;
 *  - **to the person's own incoming-webhook address** (Feishu, Lark, Slack or Discord), posted
 *    under the same rules as the server's webhooks: no private addresses unless allowed, no
 *    redirects, five seconds.
 *
 * The housekeeping tick sends whatever is due. Nothing unread means nothing is sent, but the
 * window still moves on, so a quiet week does not make the next digest a fortnight long.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { findProjectById } from "../projects/registry.js";
import { readPolicy, PUBLIC_URL } from "../identity/policy.js";
import type { TeamNotificationKind } from "../team/protocol.js";
import { categoriesOn, digestSettings, hookFormatOf, kindsOf } from "./prefs.js";
import { plainAddress, sendMail, smtpSettings } from "./smtp.js";
import { webhookAddressRefusal, webhookFetch, WEBHOOK_TIMEOUT_MS } from "./webhooks.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A tick an hour, so a digest a few minutes early is still the one that is due. */
const EARLY_MS = 60 * 60 * 1000;
/** The most lines one digest lists; past that it says how many more. */
const DIGEST_LINES = 50;

const PHRASE: Record<TeamNotificationKind, string> = {
  mention: "提到了你",
  reply: "回复了你参与的讨论",
  assigned: "把一项待办交给了你",
  "review-requested": "请你评审",
  "review-answered": "回应了你的评审",
  "access-requested": "申请了访问权限",
  "access-decided": "处理了你的权限申请",
  watch: "更新了你关注的内容",
};

export interface DigestLine {
  readonly kind: TeamNotificationKind;
  readonly project: string | undefined;
  readonly actor: string | undefined;
  readonly summary: string | undefined;
  readonly at: number;
}

export interface Digest {
  readonly count: number;
  readonly subject: string;
  readonly text: string;
}

/** The period one frequency stands for. */
function periodOf(frequency: "daily" | "weekly"): number {
  return frequency === "daily" ? DAY_MS : 7 * DAY_MS;
}

/** The unread notifications since `since` a digest would hold, oldest first. */
export function digestLines(database: DatabaseSync, accountId: string, since: number): { lines: DigestLine[]; total: number } {
  const kinds = categoriesOn(database, accountId, "email").flatMap(kindsOf);
  if (kinds.length === 0) return { lines: [], total: 0 };
  const marks = kinds.map(() => "?").join(", ");
  const where = `account_id = ? AND read_at IS NULL AND at > ? AND kind IN (${marks})`;
  const total = integerColumn(database.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(accountId, since, ...kinds) as Row, "n");
  const rows = database
    .prepare(`SELECT kind, project_id, actor_id, summary, at FROM notifications WHERE ${where} ORDER BY at LIMIT ?`)
    .all(accountId, since, ...kinds, DIGEST_LINES) as Row[];
  const lines = rows.map((row) => {
    const projectId = row["project_id"];
    const actorId = row["actor_id"];
    const summary = row["summary"];
    return {
      kind: textColumn(row, "kind") as TeamNotificationKind,
      project: typeof projectId === "string" ? (findProjectById(database, projectId)?.name ?? undefined) : undefined,
      actor: typeof actorId === "string" ? findUserById(database, actorId)?.username : undefined,
      summary: typeof summary === "string" ? summary : undefined,
      at: integerColumn(row, "at"),
    };
  });
  return { lines, total };
}

function lineText(line: DigestLine): string {
  const who = line.actor === undefined ? "有人" : `@${line.actor}`;
  const where = line.project === undefined ? "" : `［${line.project}］`;
  const what = line.summary === undefined ? "" : `：${line.summary}`;
  return `${where}${who} ${PHRASE[line.kind]}${what}`;
}

/** The digest for one account, or undefined when there is nothing to tell. */
export function composeDigest(database: DatabaseSync, user: UserRecord, since: number): Digest | undefined {
  const { lines, total } = digestLines(database, user.id, since);
  if (total === 0) return undefined;
  const site = readPolicy(database, PUBLIC_URL).replace(/\/+$/, "");
  const body = [
    `${user.displayName ?? user.username}，你好：`,
    "",
    `自上次摘要以来，你有 ${total} 条未读通知。`,
    "",
    ...lines.map((line) => `• ${lineText(line)}`),
    ...(total > lines.length ? [`……还有 ${total - lines.length} 条`] : []),
    "",
    ...(site === "" ? [] : [`在控制台查看全部：${site}/console/notifications`, ""]),
    "（可以在控制台的「通知设置」里改摘要的频率或关掉它。）",
  ];
  return { count: total, subject: `NarraLeaf Team：${total} 条未读通知`, text: body.join("\n") };
}

/** The body a personal hook is posted. */
function hookBody(url: string, text: string): string {
  switch (hookFormatOf(url)) {
    case "feishu":
      return JSON.stringify({ msg_type: "text", content: { text } });
    case "discord":
      return JSON.stringify({ content: text.slice(0, 1900) });
    case "slack":
      return JSON.stringify({ text });
  }
}

/** Post text to a personal hook. Answers the status, 0 for none; a refused address is 0 too. */
export async function postToHook(database: DatabaseSync, url: string, text: string): Promise<{ status: number; error?: string }> {
  const refusal = await webhookAddressRefusal(database, url);
  if (refusal !== undefined) return { status: 0, error: refusal };
  try {
    const answer = await webhookFetch()(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "NarraLeaf-Team" },
      body: hookBody(url, text),
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { status: answer.status };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface DigestOutcome {
  readonly count: number;
  /** Whether it was mailed; undefined when mailing was not tried. */
  readonly mailed?: boolean;
  /** The hook's answer; undefined when there is no hook. */
  readonly hookStatus?: number;
  readonly errors: string[];
}

/**
 * Send one account its digest now, of everything since its last one (or `since`), and move its
 * window on. What the tick does for each account that is due, and what "send me one now" does.
 */
export async function sendDigest(database: DatabaseSync, user: UserRecord, now = Date.now(), since?: number): Promise<DigestOutcome> {
  const settings = digestSettings(database, user.id);
  const from = since ?? settings.lastDigestAt ?? now - periodOf(settings.digest === "weekly" ? "weekly" : "daily");
  const digest = composeDigest(database, user, from);
  database.prepare("UPDATE users SET last_digest_at = ? WHERE id = ?").run(now, user.id);
  if (digest === undefined) return { count: 0, errors: [] };

  const errors: string[] = [];
  let mailed: boolean | undefined;
  const relay = smtpSettings(database);
  const to = user.email === undefined ? undefined : plainAddress(user.email);
  if (relay !== undefined && to !== undefined) {
    try {
      await sendMail(relay, { to, subject: digest.subject, text: digest.text });
      mailed = true;
    } catch (error) {
      mailed = false;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  let hookStatus: number | undefined;
  if (settings.hook !== undefined) {
    const answer = await postToHook(database, settings.hook, `${digest.subject}\n\n${digest.text}`);
    hookStatus = answer.status;
    if (answer.error !== undefined) errors.push(answer.error);
    else if (answer.status < 200 || answer.status >= 300) errors.push(`the address answered ${answer.status}`);
  }
  return { count: digest.count, ...(mailed === undefined ? {} : { mailed }), ...(hookStatus === undefined ? {} : { hookStatus }), errors };
}

/** Whether an account's digest is due. */
export function digestDue(frequency: string, lastDigestAt: number | undefined, now: number): boolean {
  if (frequency !== "daily" && frequency !== "weekly") return false;
  if (lastDigestAt === undefined) return true;
  return now - lastDigestAt >= periodOf(frequency) - EARLY_MS;
}

/** The housekeeping job: everybody whose digest is due gets it. */
export async function digestJob(database: DatabaseSync, now: number): Promise<void> {
  const rows = database
    .prepare("SELECT id, digest, last_digest_at FROM users WHERE digest IN ('daily', 'weekly') AND disabled_at IS NULL")
    .all() as Row[];
  for (const row of rows) {
    const last = row["last_digest_at"];
    if (!digestDue(textColumn(row, "digest"), typeof last === "number" || typeof last === "bigint" ? Number(last) : undefined, now)) continue;
    const user = findUserById(database, textColumn(row, "id"));
    if (user === undefined) continue;
    try {
      await sendDigest(database, user, now);
    } catch {
      // One account's relay trouble is no reason to skip the next.
    }
  }
}
