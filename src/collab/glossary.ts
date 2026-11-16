/**
 * A project's glossary: the terms its story uses — names, places, made-up words — and the one
 * word each language has agreed on for them, so that two translators do not call the same
 * sword two things. Team's own record; nothing here reads or writes the project's files.
 *
 * Whoever may edit the project's localization keeps it; everybody who can see the project reads it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { mayEditArea, maySeeProject } from "../projects/members.js";
import type { TeamGlossaryEntry } from "../team/protocol.js";

/** How many terms one project keeps. */
export const GLOSSARY_LIMIT = 5000;
export const GLOSSARY_TERM_LIMIT = 200;
export const GLOSSARY_TRANSLATION_LIMIT = 1000;
export const GLOSSARY_LOCALES_LIMIT = 64;
const LOCALE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

export class GlossaryRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

interface GlossaryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly term: string;
  readonly translations: Readonly<Record<string, string>>;
  readonly note: string | undefined;
  readonly updatedBy: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function readTranslations(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function toRecord(row: Row): GlossaryRecord {
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    term: textColumn(row, "term"),
    translations: readTranslations(textColumn(row, "translations")),
    note: optionalTextColumn(row, "note"),
    updatedBy: optionalTextColumn(row, "updated_by"),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

export function glossaryView(database: DatabaseSync, entry: GlossaryRecord): TeamGlossaryEntry {
  const by = entry.updatedBy === undefined ? undefined : findUserById(database, entry.updatedBy)?.username;
  return {
    id: entry.id,
    project: entry.projectId,
    term: entry.term,
    translations: entry.translations,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(by === undefined ? {} : { updatedBy: by }),
  };
}

function findEntry(database: DatabaseSync, id: string): GlossaryRecord | undefined {
  const row = database.prepare("SELECT * FROM glossary WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listGlossary(database: DatabaseSync, viewer: UserRecord, projectId: string): GlossaryRecord[] {
  if (!maySeeProject(database, projectId, viewer)) throw new GlossaryRefusal("not-found", "there is no project of that id on this server");
  return (database.prepare("SELECT * FROM glossary WHERE project_id = ? ORDER BY term COLLATE NOCASE").all(projectId) as Row[]).map(toRecord);
}

function mayKeep(database: DatabaseSync, projectId: string, actor: UserRecord): void {
  if (!maySeeProject(database, projectId, actor)) throw new GlossaryRefusal("not-found", "there is no project of that id on this server");
  if (!mayEditArea(database, projectId, actor, "localization")) {
    throw new GlossaryRefusal("refused", "whoever may edit this project's localization keeps its glossary");
  }
}

/** Translations as given: locale tags to words, blanks dropped. */
export function checkTranslations(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GlossaryRefusal("bad-params", "translations is an object of locale tag to word");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > GLOSSARY_LOCALES_LIMIT) throw new GlossaryRefusal("bad-params", `a term has at most ${GLOSSARY_LOCALES_LIMIT} languages`);
  const out: Record<string, string> = {};
  for (const [locale, word] of entries) {
    if (!LOCALE_TAG.test(locale) || locale.length > 35) throw new GlossaryRefusal("bad-params", `“${locale.slice(0, 40)}” is not a locale tag`);
    if (typeof word !== "string" || word.length > GLOSSARY_TRANSLATION_LIMIT) {
      throw new GlossaryRefusal("bad-params", `a translation is text of at most ${GLOSSARY_TRANSLATION_LIMIT} characters`);
    }
    if (word.trim() !== "") out[locale] = word.trim();
  }
  return out;
}

/** Add a term, or change the one named by `id`. A term is unique in its project. */
export function setGlossaryEntry(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; id?: string; term: string; translations: Record<string, string>; note?: string | null },
  now = Date.now(),
): GlossaryRecord {
  mayKeep(database, input.projectId, actor);
  const term = input.term.trim();
  if (term === "" || term.length > GLOSSARY_TERM_LIMIT) throw new GlossaryRefusal("bad-params", `a term is 1 to ${GLOSSARY_TERM_LIMIT} characters`);
  const clash = database.prepare("SELECT id FROM glossary WHERE project_id = ? AND term = ?").get(input.projectId, term) as Row | undefined;
  if (input.id === undefined) {
    if (clash !== undefined) throw new GlossaryRefusal("conflict", "this glossary already has that term");
    const count = database.prepare("SELECT COUNT(*) AS n FROM glossary WHERE project_id = ?").get(input.projectId) as Row;
    if (integerColumn(count, "n") >= GLOSSARY_LIMIT) throw new GlossaryRefusal("refused", `a glossary keeps at most ${GLOSSARY_LIMIT} terms`);
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO glossary (id, project_id, term, translations, note, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.projectId, term, JSON.stringify(input.translations), input.note ?? null, actor.id, actor.id, now, now);
    return findEntry(database, id) as GlossaryRecord;
  }
  const current = findEntry(database, input.id);
  if (current === undefined || current.projectId !== input.projectId) throw new GlossaryRefusal("not-found", "there is no such term in that glossary");
  if (clash !== undefined && textColumn(clash, "id") !== current.id) throw new GlossaryRefusal("conflict", "this glossary already has that term");
  database
    .prepare("UPDATE glossary SET term = ?, translations = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .run(term, JSON.stringify(input.translations), input.note === undefined ? (current.note ?? null) : input.note, actor.id, now, current.id);
  return findEntry(database, current.id) as GlossaryRecord;
}

export function deleteGlossaryEntry(database: DatabaseSync, actor: UserRecord, projectId: string, id: string): void {
  mayKeep(database, projectId, actor);
  const result = database.prepare("DELETE FROM glossary WHERE id = ? AND project_id = ?").run(id, projectId);
  if (Number(result.changes) === 0) throw new GlossaryRefusal("not-found", "there is no such term in that glossary");
}
