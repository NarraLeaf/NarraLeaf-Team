/**
 * Saved filters: a search one account named — "my open art tasks" — and keeps,
 * per list. The query is the page's own JSON; this server stores it and never
 * reads it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, textColumn, type Row } from "../identity/database.js";
import type { UserRecord } from "../identity/users.js";
import type { TeamSavedFilter } from "../team/protocol.js";

/** How many filters one account keeps for one list. */
export const FILTERS_PER_SCOPE = 50;

export class FilterRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function toView(row: Row): TeamSavedFilter {
  return {
    id: textColumn(row, "id"),
    scope: textColumn(row, "scope"),
    name: textColumn(row, "name"),
    query: textColumn(row, "query"),
    createdAt: integerColumn(row, "created_at"),
  };
}

export function listFilters(database: DatabaseSync, owner: UserRecord, scope?: string): TeamSavedFilter[] {
  const rows =
    scope === undefined
      ? database.prepare("SELECT * FROM saved_filters WHERE user_id = ? ORDER BY scope, name").all(owner.id)
      : database.prepare("SELECT * FROM saved_filters WHERE user_id = ? AND scope = ? ORDER BY name").all(owner.id, scope);
  return (rows as Row[]).map(toView);
}

/** Save under a name; a filter of that name for that list is replaced. */
export function saveFilter(
  database: DatabaseSync,
  owner: UserRecord,
  input: { scope: string; name: string; query: string },
  now = Date.now(),
): TeamSavedFilter {
  try {
    JSON.parse(input.query);
  } catch {
    throw new FilterRefusal("bad-params", "query has to be JSON");
  }
  const existing = database
    .prepare("SELECT id FROM saved_filters WHERE user_id = ? AND scope = ? AND name = ?")
    .get(owner.id, input.scope, input.name) as Row | undefined;
  if (existing !== undefined) {
    database.prepare("UPDATE saved_filters SET query = ? WHERE id = ?").run(input.query, textColumn(existing, "id"));
    return toView(database.prepare("SELECT * FROM saved_filters WHERE id = ?").get(textColumn(existing, "id")) as Row);
  }
  const count = database.prepare("SELECT COUNT(*) AS n FROM saved_filters WHERE user_id = ? AND scope = ?").get(owner.id, input.scope) as Row;
  if (integerColumn(count, "n") >= FILTERS_PER_SCOPE) {
    throw new FilterRefusal("conflict", `one list keeps at most ${FILTERS_PER_SCOPE} saved filters`);
  }
  const id = randomUUID();
  database
    .prepare("INSERT INTO saved_filters (id, user_id, scope, name, query, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, owner.id, input.scope, input.name, input.query, now);
  return toView(database.prepare("SELECT * FROM saved_filters WHERE id = ?").get(id) as Row);
}

export function deleteFilter(database: DatabaseSync, owner: UserRecord, id: string): void {
  const gone = database.prepare("DELETE FROM saved_filters WHERE id = ? AND user_id = ?").run(id, owner.id);
  if (gone.changes === 0) throw new FilterRefusal("not-found", "there is no saved filter of that id");
}
