import { existsSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  migrate,
  openDatabase,
  openMigratedDatabase,
  schemaVersion,
  SchemaTooNewError,
  SCHEMA_VERSION,
  textColumn,
} from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-database-");

/** The names of every table in an open database. */
function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => textColumn(row, "name"));
}

/** The names of every column of one table. */
function columnNames(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => textColumn(row, "name"));
}

describe("migrate", () => {
  it("takes a file that does not exist yet to the current version", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    expect(existsSync(path)).toBe(false);

    const database = await openDatabase(path);
    try {
      expect(schemaVersion(database)).toBe(0);
      expect(migrate(database, path)).toBe(SCHEMA_VERSION);
      expect(tableNames(database)).toEqual(
        expect.arrayContaining([
          "decisions",
          "schema_version",
          "settings",
          "user_groups",
          "users",
        ]),
      );
    } finally {
      database.close();
    }
    expect(existsSync(path)).toBe(true);
  });

  it("adds a later migration to a file that already has accounts in it", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    const database = await openDatabase(path);
    try {
      migrate(database, path);
      database
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("9a1c0e2e", "ada", "Ada Lovelace", "scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==", 1);

      // Put the file back to the version before the newest migration. That one
      // adds the table a repeatable write with no row of its own is remembered
      // in, so undoing it means dropping that table.
      // ⚠ These lines track whichever migration is last: a new one appended to
      // the list is a new thing to undo here, and the failure when it is
      // forgotten is this test rather than a server in the field.
      database.exec("DROP TABLE client_writes");
      database.prepare("DELETE FROM schema_version WHERE version = ?").run(SCHEMA_VERSION);
      expect(schemaVersion(database)).toBe(SCHEMA_VERSION - 1);

      expect(migrate(database, path)).toBe(SCHEMA_VERSION);

      // The table is back, which is the newest migration having replayed.
      expect(tableNames(database)).toContain("client_writes");
      // Still there, from the migrations before that one, which is what says
      // this replayed the last one alone rather than the whole list.
      expect(columnNames(database, "projects")).toContain("client_id");
      expect(tableNames(database)).toContain("overlay");
      expect(tableNames(database)).toContain("threads");
      expect(tableNames(database)).toContain("comments");
      // Still gone, from a migration further back. A migration list that
      // replayed from the start would put it back.
      expect(tableNames(database)).not.toContain("project_grants");
      // The account is still there. A migration that took the file back to
      // something empty would pass every check about tables and lose a Team server.
      expect(database.prepare("SELECT username FROM users").all()).toEqual([{ username: "ada" }]);
    } finally {
      database.close();
    }
  });

  it("does nothing the second time, and nothing the third", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;

    const database = await openDatabase(path);
    try {
      migrate(database, path);
      const first = database.prepare("SELECT version, applied_at FROM schema_version").all();

      expect(migrate(database, path)).toBe(SCHEMA_VERSION);
      expect(migrate(database, path)).toBe(SCHEMA_VERSION);

      // Same rows, same timestamps: a migration that had run again would have
      // written another one, or failed on the table it was creating.
      expect(database.prepare("SELECT version, applied_at FROM schema_version").all()).toEqual(
        first,
      );
    } finally {
      database.close();
    }
  });

  it("records one row per migration, with when it was applied", async () => {
    const root = await temporaryRoot();
    const database = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      const rows = database.prepare("SELECT version, applied_at FROM schema_version").all();

      expect(rows).toHaveLength(SCHEMA_VERSION);
      for (const row of rows) {
        expect(typeof row["applied_at"]).toBe("number");
      }
    } finally {
      database.close();
    }
  });

  it("refuses a file written by a newer Team rather than working on it", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    const database = await openDatabase(path);
    try {
      migrate(database, path);
      database
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION + 1, Date.now());

      expect(() => migrate(database, path)).toThrow(SchemaTooNewError);
    } finally {
      database.close();
    }
  });

  it("keeps its file under the storage root, beside everything else Team writes", async () => {
    const root = await temporaryRoot();
    const layout = identityLayout(root);

    expect(layout.databasePath).toBe(join(layout.root, "team.db"));
    expect(layout.keysDir).toBe(join(layout.root, "keys"));
  });
});

// Windows has no POSIX mode bits and a chmod there does close to nothing, so
// there is nothing on that platform for these two to assert. They are skipped
// rather than weakened: an assertion that passes because it checked nothing is
// worse than one that says which hosts it speaks for.
describe.skipIf(process.platform === "win32")("the file the password hashes are in", () => {
  /** Every file the database is, and the mode each of them is at. */
  async function modes(path: string): Promise<Array<[string, number]>> {
    const found: Array<[string, number]> = [];
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) {
        found.push([suffix === "" ? "team.db" : `team.db${suffix}`, (await stat(file)).mode & 0o777]);
      }
    }
    return found;
  }

  it("is readable by nobody but its owner, write-ahead log and all", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    const database = await openMigratedDatabase(path);
    try {
      // The log is named on purpose. It holds the rows that have not been
      // checkpointed yet, so a readable one beside an unreadable database
      // hands over whatever was written most recently — which, on a server
      // somebody has just made an account on, is that account.
      const found = await modes(path);

      expect(found.map(([name]) => name)).toContain("team.db");
      for (const [, mode] of found) {
        expect(mode).toBe(0o600);
      }
    } finally {
      database.close();
    }
  });

  it("is tightened when it was left readable by an older Team", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;

    const first = await openMigratedDatabase(path);
    first.close();
    // What a server that predates this left on disk: a file created under
    // whatever the umask allowed. Upgrading Team has to fix it, because
    // nobody is going to be told to go and chmod it themselves.
    await chmod(path, 0o644);

    const second = await openDatabase(path);
    try {
      for (const [, mode] of await modes(path)) {
        expect(mode).toBe(0o600);
      }
    } finally {
      second.close();
    }
  });
});
