/**
 * Where a project's voiced lines stand: recorded, needing a retake, or (with no record) not
 * recorded yet, per language. Lines are named by the textId Studio gives them, which this server
 * never reads; the voice files themselves are Studio's and stay in the project.
 *
 * Whoever may edit the project's localization keeps it; everybody who can see the project reads it.
 */
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { mayEditArea, maySeeProject } from "../projects/members.js";
import { TEAM_VOICE_STATUSES, type TeamVoiceLine, type TeamVoiceStatus } from "../team/protocol.js";

/** How many lines one `voice.set` changes. */
export const VOICE_SET_LIMIT = 2000;
const LOCALE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

export class VoiceRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

function toView(database: DatabaseSync, row: Row, names: Map<string, string | undefined>): TeamVoiceLine {
  const status = textColumn(row, "status");
  const take = optionalIntegerColumn(row, "take");
  const note = optionalTextColumn(row, "note");
  const byId = optionalTextColumn(row, "updated_by");
  let by: string | undefined;
  if (byId !== undefined) {
    if (!names.has(byId)) names.set(byId, findUserById(database, byId)?.username);
    by = names.get(byId);
  }
  return {
    project: textColumn(row, "project_id"),
    locale: textColumn(row, "locale"),
    line: textColumn(row, "line"),
    // Unknown reads as needing a retake: a status a newer Team wrote is not a finished line here.
    status: (TEAM_VOICE_STATUSES as readonly string[]).includes(status) ? (status as TeamVoiceStatus) : "retake",
    ...(take === undefined ? {} : { take }),
    ...(note === undefined ? {} : { note }),
    updatedAt: integerColumn(row, "updated_at"),
    ...(by === undefined ? {} : { updatedBy: by }),
  };
}

export function isLocaleTag(value: string): boolean {
  return value.length <= 35 && LOCALE_TAG.test(value);
}

export function listVoice(database: DatabaseSync, viewer: UserRecord, projectId: string, locale?: string): TeamVoiceLine[] {
  if (!maySeeProject(database, projectId, viewer)) throw new VoiceRefusal("not-found", "there is no project of that id on this server");
  const rows = (
    locale === undefined
      ? database.prepare("SELECT * FROM voice_lines WHERE project_id = ? LIMIT 100000").all(projectId)
      : database.prepare("SELECT * FROM voice_lines WHERE project_id = ? AND locale = ? LIMIT 100000").all(projectId, locale)
  ) as Row[];
  const names = new Map<string, string | undefined>();
  return rows.map((row) => toView(database, row, names));
}

/** Mark lines of one language; `status: "none"` takes the record away (not recorded). */
export function setVoice(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; locale: string; lines: readonly string[]; status: TeamVoiceStatus | "none"; take?: number | null; note?: string | null },
  now = Date.now(),
): TeamVoiceLine[] {
  if (!maySeeProject(database, input.projectId, actor)) throw new VoiceRefusal("not-found", "there is no project of that id on this server");
  if (!mayEditArea(database, input.projectId, actor, "localization")) {
    throw new VoiceRefusal("refused", "whoever may edit this project's localization keeps its recording status");
  }
  if (!isLocaleTag(input.locale)) throw new VoiceRefusal("bad-params", "locale is a locale tag");
  if (input.lines.length === 0 || input.lines.length > VOICE_SET_LIMIT) throw new VoiceRefusal("bad-params", `name 1 to ${VOICE_SET_LIMIT} lines`);
  if (input.status === "none") {
    const drop = database.prepare("DELETE FROM voice_lines WHERE project_id = ? AND locale = ? AND line = ?");
    for (const line of input.lines) drop.run(input.projectId, input.locale, line);
    return [];
  }
  const write = database.prepare(
    `INSERT INTO voice_lines (project_id, locale, line, status, take, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, locale, line) DO UPDATE SET
       status = excluded.status,
       take = CASE WHEN ? THEN excluded.take ELSE voice_lines.take END,
       note = CASE WHEN ? THEN excluded.note ELSE voice_lines.note END,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  const read = database.prepare("SELECT * FROM voice_lines WHERE project_id = ? AND locale = ? AND line = ?");
  const names = new Map<string, string | undefined>();
  const out: TeamVoiceLine[] = [];
  database.exec("BEGIN");
  try {
    for (const line of input.lines) {
      write.run(
        input.projectId,
        input.locale,
        line,
        input.status,
        input.take ?? null,
        input.note ?? null,
        actor.id,
        now,
        input.take === undefined ? 0 : 1,
        input.note === undefined ? 0 : 1,
      );
      out.push(toView(database, read.get(input.projectId, input.locale, line) as Row, names));
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return out;
}
