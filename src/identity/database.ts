/**
 * The file that holds the accounts and the projects: `<root>/team.db`.
 *
 * Storage is node's built-in SQLite, which is why Team can keep a database
 * without gaining a dependency. There is exactly one writer — the Team server process
 * — so nothing here worries about connection pools.
 *
 * The schema is versioned and only ever moves forward. Every change is a new
 * migration appended to the list below; an already-released migration is never
 * edited, because the file it has already run against is the one holding the
 * user accounts, and rewriting history here means two installations disagreeing
 * about what version 1 means.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Type-only, and therefore erased: the module itself is loaded on demand, for
// the reason set out above `loadSqlite`.
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** One row as node:sqlite hands it over. */
export type Row = Record<string, SQLOutputValue>;

/** Raised when a value in the database is not of the type its column implies. */
export class ColumnTypeError extends Error {
  constructor(
    readonly column: string,
    readonly expected: string,
  ) {
    super(
      `team.db holds a ${column} that is not ${expected}. The file was written by ` +
        "something other than this version of Team.",
    );
    this.name = "ColumnTypeError";
  }
}

/** Read a text column, insisting that it really is text. */
export function textColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new ColumnTypeError(column, "text");
  }
  return value;
}

/** Read a text column that is allowed to be NULL. */
export function optionalTextColumn(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ColumnTypeError(column, "text or null");
  }
  return value;
}

/**
 * Read an integer column.
 *
 * node:sqlite hands back a `bigint` only for values outside the range a double
 * represents exactly. Nothing Team stores is that large — the biggest numbers
 * here are millisecond timestamps — so one is narrowed rather than propagated.
 */
export function integerColumn(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number") {
    throw new ColumnTypeError(column, "an integer");
  }
  return value;
}

/** Read an integer column that is allowed to be NULL. */
export function optionalIntegerColumn(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return integerColumn(row, column);
}

/** Read an integer column that stands for a boolean, SQLite's 0 or 1. */
export function booleanColumn(row: Row, column: string): boolean {
  return integerColumn(row, column) !== 0;
}

/** One step forward from the previous schema version. */
interface Migration {
  readonly version: number;
  /** What this migration is for, in one line. */
  readonly description: string;
  readonly statements: readonly string[];
}

/**
 * Every migration, in order, oldest first.
 *
 * Appending is the only edit this list ever takes.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "users, their groups, and invite codes",
    statements: [
      // `id` is a random identifier rather than a row number: it becomes the
      // `sub` claim of every token, and a rename or a re-import must not turn
      // one person into another. `disabled_at` NULL means the account may sign
      // in. `token_epoch` is the counter that invalidates outstanding tokens —
      // src/identity/tokens.ts states exactly what that does and does not do.
      `CREATE TABLE users (
         id                 TEXT    NOT NULL PRIMARY KEY,
         username           TEXT    NOT NULL UNIQUE,
         display_name       TEXT    NOT NULL,
         email              TEXT,
         password_hash      TEXT    NOT NULL,
         is_service_account INTEGER NOT NULL DEFAULT 0,
         created_at         INTEGER NOT NULL,
         disabled_at        INTEGER,
         token_epoch        INTEGER NOT NULL DEFAULT 1
       ) STRICT`,
      // Group membership is a table rather than a column so that a person can
      // be in none, one or several; the `groups` claim is read straight from
      // it. Deleting a user takes their memberships with them.
      `CREATE TABLE user_groups (
         user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         group_name TEXT NOT NULL,
         PRIMARY KEY (user_id, group_name)
       ) STRICT`,
      // Only the hash of an invite code is kept, for the same reason only the
      // hash of a password is: whoever reads this file must not come away able
      // to redeem an invite. `is_bootstrap` marks the code `up` prints when no
      // account exists yet, so that a later run can withdraw an unused one
      // instead of leaving a second live code behind.
      `CREATE TABLE invites (
         code_hash    TEXT    NOT NULL PRIMARY KEY,
         role         TEXT    NOT NULL,
         is_bootstrap INTEGER NOT NULL DEFAULT 0,
         created_at   INTEGER NOT NULL,
         expires_at   INTEGER NOT NULL,
         used_at      INTEGER,
         used_by      TEXT REFERENCES users(id)
       ) STRICT`,
    ],
  },
  {
    version: 2,
    description: "projects, and who may reach them",
    statements: [
      // `id` is the repository's own id as loreserver holds it: sixteen bytes,
      // written here as thirty-two lower-case hex characters. It is not a
      // second identifier that has to be mapped to that one — a resource id in
      // a permission question is this string with `urc-` in front of it, and
      // src/projects/registry.ts is where that is spelled out.
      //
      // `created_by` is the account that asked for the repository. It survives
      // that account being deleted only in the sense that the row does not:
      // there is no such thing as a project nobody made.
      `CREATE TABLE projects (
         id          TEXT    NOT NULL PRIMARY KEY,
         name        TEXT    NOT NULL UNIQUE,
         description TEXT    NOT NULL,
         created_by  TEXT    NOT NULL REFERENCES users(id),
         created_at  INTEGER NOT NULL
       ) STRICT`,
      // One row per person per project, and no row for somebody with no access:
      // this table is the whole of the answer to "may this caller touch this
      // repository", so an absent row is a refusal rather than a default.
      //
      // `level` is `read`, `write` or `owner`. Three words, ordered, with no
      // table of verbs behind them — loreserver does not read the verbs, and a
      // permission system nobody consults is a place for bugs to hide.
      `CREATE TABLE project_grants (
         project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         level      TEXT    NOT NULL,
         granted_by TEXT    REFERENCES users(id),
         granted_at INTEGER NOT NULL,
         PRIMARY KEY (project_id, user_id)
       ) STRICT`,
      // Every permission question names a person and asks about their projects,
      // so that is the direction the index runs in.
      "CREATE INDEX project_grants_by_user ON project_grants (user_id)",
    ],
  },
  {
    version: 3,
    description: "settings an operator can change without a new build of Team",
    statements: [
      // One row per setting somebody has chosen, and no row for one left alone.
      // An absent row is not a missing value: it means the default in
      // src/identity/config.ts answers for that setting, so a later version of
      // Team that changes a default reaches every installation that never
      // touched it. Writing the defaults in here as the migration ran would
      // freeze them at whatever this build thinks, and nothing would say so.
      //
      // `value` is text whatever the setting means, because a column per type
      // is a schema change every time a setting of a new type appears.
      // src/identity/settings.ts is where each key is turned back into the
      // thing it stands for, and where a value that will not turn back is
      // refused rather than quietly defaulted around.
      `CREATE TABLE settings (
         key        TEXT    NOT NULL PRIMARY KEY,
         value      TEXT    NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`,
    ],
  },
  {
    version: 4,
    description: "when an account's tokens were last made unrenewable",
    statements: [
      // Beside `token_epoch` rather than instead of it. The counter is what a
      // token is checked against; this is only the moment it last moved, and
      // nothing decides anything from it.
      //
      // Rows that already exist keep NULL, and that is deliberate. There is no
      // honest timestamp for a bump that happened before this column existed,
      // and the obvious invention — the moment this migration ran — would read
      // as every account on the Team server having had its tokens refused on the day
      // Team was upgraded. Absent is drawn as "unknown", which is true.
      "ALTER TABLE users ADD COLUMN tokens_invalidated_at INTEGER",
    ],
  },
  {
    version: 5,
    description: "the authorization decisions Team has made",
    statements: [
      // One row per decision. Before this table there was none: every decision
      // went to the log of the `up` process that made it and nowhere else, so a
      // Team that had been running for a month could not say who had reached
      // what, and the screen that shows the last few decisions had nothing to
      // show.
      //
      // `username` is text rather than a reference to `users`, and it is the
      // one column that must not be a foreign key. A row that cascaded away
      // with the account would delete exactly the record somebody deleted an
      // account over. The same goes for `resource`: it holds the project's name
      // as it stood when the decision was made, so the row still says which
      // project it was about after that project has been forgotten.
      //
      // There is no index. src/identity/audit.ts keeps the table to a bounded
      // number of rows, and an index would be a write on the path that answers
      // every repository access in order to speed up a query a person makes
      // when they open a screen.
      `CREATE TABLE decisions (
         id       INTEGER NOT NULL PRIMARY KEY,
         at       INTEGER NOT NULL,
         username TEXT    NOT NULL,
         resource TEXT    NOT NULL,
         allowed  INTEGER NOT NULL,
         detail   TEXT    NOT NULL
       ) STRICT`,
    ],
  },
  {
    version: 6,
    description: "accounts are made by an operator, so invite codes are gone",
    statements: [
      // Migration 1 is left as it was, per the rule at the top of this file: it
      // is what version 1 meant, and a server that stopped there has to be able
      // to arrive here by the same steps as everybody else. Dropping the table
      // takes the used codes with it, which is the whole of what it held —
      // who was made from which code is not something any screen ever showed,
      // and the accounts themselves are in `users`.
      "DROP TABLE invites",
    ],
  },
  {
    version: 7,
    description: "every account of a server reaches every project on it",
    statements: [
      // Per-project access is gone, so the table that held it is too. What is
      // left of who-did-what is `projects.created_by`, which is shown and is
      // not consulted: the rule is now one sentence, and it is in
      // src/projects/registry.ts.
      "DROP TABLE project_grants",
    ],
  },
  {
    version: 8,
    description: "conversations attached to places inside a project",
    statements: [
      // The first thing this server stores that an author wrote. Everything
      // before it was either an account or a fact about a repository, and both
      // of those have somewhere else they really live.
      //
      // `document` is null on a thread about the project itself, which is the
      // first thing anybody says about one; a path invented to stand for that
      // would be a string every reader had to learn to hide.
      //
      // `document`, `element` and `revision` are **an anchor, and this server
      // does not read one**. They are strings Studio writes and Studio
      // interprets: a path inside the project, an id for something inside that
      // path, and what the repository was at when somebody wrote this. Stored,
      // indexed and compared for equality; never parsed, never checked against
      // a repository, and never a reason this server has to be upgraded in step
      // with the one it serves. That bargain is set out in src/team/protocol.ts
      // and it is the reason a comment can be attached to a kind of thing this
      // build has never heard of.
      //
      // `created_by` is a user id with no foreign key, for the reason the
      // decisions table gives: a row that cascaded away with an account would
      // delete exactly the record somebody deleted an account over.
      //
      // `client_id` is what the client called this when it asked for it, and it
      // is how a reply that was sent twice over a socket that dropped becomes
      // one thread rather than two.
      `CREATE TABLE threads (
         id          TEXT    NOT NULL PRIMARY KEY,
         project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         document    TEXT,
         element     TEXT,
         revision    TEXT,
         kind        TEXT    NOT NULL,
         status      TEXT    NOT NULL,
         created_by  TEXT    NOT NULL,
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL,
         resolved_by TEXT,
         resolved_at INTEGER,
         client_id   TEXT
       ) STRICT`,
      // Studio asks two questions of this table and they run in different
      // directions: everything anchored at one place, when a row is on screen,
      // and everything in one project by what changed last, when a panel is
      // opened. Two indexes because one of them cannot answer the other.
      "CREATE INDEX threads_by_anchor ON threads (project_id, document, element)",
      "CREATE INDEX threads_by_project ON threads (project_id, updated_at)",
      // Partial, because most rows have no client id and NULLs are not equal to
      // one another in SQLite - a plain unique index would let one client
      // repeat itself as often as it liked.
      `CREATE UNIQUE INDEX threads_by_client ON threads (created_by, client_id)
         WHERE client_id IS NOT NULL`,
      // `suggestion` is the other opaque column: what this comment proposes to
      // put in place of what it is anchored to, encoded by Studio. A comment
      // that proposes nothing has none.
      //
      // `deleted_at` rather than a deleted row. The shape of a conversation is
      // part of what the remaining comments mean, so a withdrawn comment keeps
      // its place and loses its body.
      `CREATE TABLE comments (
         id         TEXT    NOT NULL PRIMARY KEY,
         thread_id  TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
         author_id  TEXT    NOT NULL,
         body       TEXT    NOT NULL,
         suggestion TEXT,
         created_at INTEGER NOT NULL,
         edited_at  INTEGER,
         deleted_at INTEGER,
         client_id  TEXT
       ) STRICT`,
      "CREATE INDEX comments_by_thread ON comments (thread_id, created_at)",
      `CREATE UNIQUE INDEX comments_by_client ON comments (author_id, client_id)
         WHERE client_id IS NOT NULL`,
    ],
  },
  {
    version: 9,
    description: "data attached to a project at a revision, outside its repository",
    statements: [
      // The third place a project's content can live, and the only one that is
      // neither the repository nor a version of it. A revision is what an author
      // recorded; a thread is a conversation about one; a row here is anything
      // else a client wants kept beside a place in a project without changing
      // what that project is — a review mark, a translator's flag, a playtest
      // note. **Nothing here is ever written to a repository.**
      //
      // `revision` is NOT NULL where a thread's is nullable, and that is the
      // difference between the two tables rather than an oversight. A thread is
      // about a place; a row here is about a place **at a version**, which is
      // what asks for one, and a record that did not say which version could
      // never be told from a stale one.
      //
      // `kind` is a word Studio chooses and this server groups by. It is not an
      // enumeration here and must not become one: the moment this build has an
      // opinion about which kinds exist, a Studio that invents a new one needs a
      // server upgrade — which is the bargain src/team/protocol.ts spends every
      // opaque column avoiding.
      //
      // `instance` is the client installation that wrote it, as that client
      // named itself. A plain string with nothing behind it: instances live in
      // memory and only while connected (see src/team/presence.ts), so this is a
      // note of who was at the keyboard rather than a reference to a row.
      //
      // `author_id` carries no foreign key, for the reason the threads table
      // gives: a row that cascaded away with an account would delete exactly the
      // record somebody deleted an account over.
      `CREATE TABLE overlay (
         id         TEXT    NOT NULL PRIMARY KEY,
         project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         revision   TEXT    NOT NULL,
         document   TEXT,
         element    TEXT,
         kind       TEXT    NOT NULL,
         body       TEXT    NOT NULL,
         author_id  TEXT    NOT NULL,
         instance   TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         client_id  TEXT
       ) STRICT`,
      // Two reads, in two directions, exactly as the threads table has: what is
      // attached at one place, when a row is on screen, and everything in one
      // project, when a window opens and pulls the lot.
      "CREATE INDEX overlay_by_anchor ON overlay (project_id, document, element)",
      "CREATE INDEX overlay_by_project ON overlay (project_id, updated_at)",
      // Partial, because most rows have no client id and NULLs are not equal to
      // one another in SQLite — a plain unique index would let one client repeat
      // itself as often as it liked.
      `CREATE UNIQUE INDEX overlay_by_client ON overlay (author_id, client_id)
         WHERE client_id IS NOT NULL`,
    ],
  },
  {
    version: 10,
    description: "a project create names itself, so a repeat is not a second project",
    statements: [
      // `client_id` is what the client called a create, and it is how a request
      // that was sent twice over a session that dropped between asking and
      // hearing back becomes one project rather than two. Null on every row
      // written any other way — the command line, an adoption of a repository
      // that already exists, loreserver — which is why the index below is
      // partial. The stored value carries the method it was scoped by, for the
      // reason the threads table's does: one client id used for two different
      // writes must not be handed the wrong row.
      "ALTER TABLE projects ADD COLUMN client_id TEXT",
      // Partial, because most rows have no client id and NULLs are not equal to
      // one another in SQLite — a plain unique index would let one client repeat
      // itself as often as it liked.
      `CREATE UNIQUE INDEX projects_by_client ON projects (created_by, client_id)
         WHERE client_id IS NOT NULL`,
    ],
  },
  {
    version: 11,
    description: "a write a client named, where there is no row to hang its name on",
    statements: [
      // Every repeatable write before this one carried its client id on the row
      // it made — a thread, a comment, an overlay record, a project. The writes
      // an operator makes have no such row: disabling an account creates
      // nothing, changing a setting replaces a value, and rotating a key writes
      // a file. So the note lives apart from the effect, and this table is it.
      //
      // The primary key is all three columns, which is the `(account, method,
      // client id)` rule the four above are keyed by, written out as a table of
      // its own. The method is in it because one client id reused across two
      // different writes must not be handed the answer to the wrong one.
      //
      // `account` is a user id with no foreign key, for the reason the threads
      // and decisions tables give: a row that cascaded away with an account
      // would be a record deleted by exactly the thing it records.
      //
      // `answer` is what the write produced that cannot be worked out again,
      // as JSON, and it is NULL on almost every row — a repeat is normally
      // answered by re-reading the record, which is fresher than any copy could
      // be. src/identity/writes.ts says which write is not like that and why.
      //
      // A row does not outlive the retry it protects. src/identity/writes.ts
      // chooses the window and says why one is needed at all — briefly, the
      // point is not the size of the table but that an id remembered for ever
      // is an id nobody can ever use again. Rows past the window are dropped on
      // the write path, once in every so many writes, never on a timer.
      //
      // There is no index on `at`, and the prune is a scan. That is the right
      // trade here rather than a corner cut: the prune is what keeps the table
      // to a day of management actions, which is the handful of rows a scan
      // walks.
      `CREATE TABLE client_writes (
         account   TEXT    NOT NULL,
         method    TEXT    NOT NULL,
         client_id TEXT    NOT NULL,
         at        INTEGER NOT NULL,
         answer    TEXT,
         PRIMARY KEY (account, method, client_id)
       ) STRICT`,
    ],
  },
];

/** The schema version this build of Team writes and expects. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/** Raised when the database on disk is newer than this build understands. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `${path} is at schema version ${found}, and this version of Team understands ${supported}. ` +
        "It was written by a newer Team. Upgrade Team rather than downgrading the file.",
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * node:sqlite announces itself as experimental the first time it is used, on
 * stderr, through the ordinary process warning channel. Team is a program an
 * operator leaves running, and a line about node internals on every start is
 * noise they cannot act on.
 *
 * Only that one warning is dropped. Every other warning — a deprecation, an
 * unhandled rejection, a `MaxListenersExceededWarning` — is handed to the
 * listeners that were already there, so nothing else is hidden by this.
 */
let warningFilterInstalled = false;

function suppressSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) {
    return;
  }
  warningFilterInstalled = true;

  type WarningListener = (warning: Error) => void;
  const existing = process.listeners("warning") as WarningListener[];
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) {
      return;
    }
    for (const listener of existing) {
      listener(warning);
    }
  });
}

let sqlite: Promise<typeof import("node:sqlite")> | undefined;

/**
 * Load `node:sqlite`, with the filter above in place first.
 *
 * The warning is emitted as the module loads, not as it is used, and a static
 * import is evaluated before any code in this file could install a filter. So
 * the module is imported on demand instead — which is also why opening a
 * database is asynchronous, and why running `nlteam --version` neither loads
 * SQLite nor says anything about it.
 */
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  suppressSqliteExperimentalWarning();
  sqlite ??= import("node:sqlite");
  return sqlite;
}

/**
 * The mode `team.db` and the two files WAL mode keeps beside it are held at.
 *
 * 0600, which is what the signing keys next door are written at: this file
 * holds the users table, and that table holds a password hash per account. An
 * account on the same machine that can read it can take every hash away and
 * attack them at leisure, with nothing on this server ever hearing about it.
 */
const OWNER_ONLY = 0o600;

/**
 * Restrict `path` and the two files WAL mode writes beside it to their owner.
 *
 * A chmod after the fact rather than a mode passed at creation, because the
 * file is created by the SQLite binding rather than by this code and there is
 * nowhere to pass one. Doing it on every open is also what tightens a file an
 * older Team left behind: a server that has been running since before this
 * existed is fixed by being restarted rather than by anybody noticing.
 *
 * The `-wal` and `-shm` files are named here because a locked-down database
 * beside a world-readable write-ahead log protects nothing — the log holds the
 * rows that have not been checkpointed yet, which is exactly what was written
 * most recently. SQLite gives a pair it creates the mode of the main database
 * file, so tightening that one keeps every later pair restricted; these two are
 * chmod'd as well because the pair that switching to WAL has just made was
 * created before this ran.
 *
 * **What this is and is not.** It is a POSIX protection: it keeps other
 * accounts on the same host out of the file. Windows has no such mode bits and
 * a chmod there is close to a no-op — what guards the file on that platform is
 * the ACL of the directory somebody chose as the storage root, which is not
 * Team's to set. Nothing here protects the file from whoever holds the root
 * directory, and nothing is meant to: that is the rescue plane, and it is
 * guarded by access to the disk on purpose.
 */
function restrictToOwner(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, OWNER_ONLY);
    } catch {
      // Not there, which is the ordinary case rather than a failure: WAL mode
      // writes its pair on demand and removes them again on a clean close. A
      // chmod that cannot be done at all is not a reason to refuse to open the
      // database — the server would then not start on a platform that has no
      // such thing as a mode.
    }
  }
}

/**
 * What every commit on this connection waits for.
 *
 * SQLite's default is `FULL`, which fsyncs the write-ahead log on every commit,
 * and outside a transaction every statement is its own commit. Measured on a
 * Windows workstation with an NVMe disk, two thousand single-row inserts into a
 * WAL database opened by {@link openDatabase}:
 *
 * ```
 * synchronous = FULL     3999 ms   (2.000 ms a row)
 * synchronous = NORMAL     38 ms   (0.019 ms a row)
 * synchronous = OFF        20 ms   (0.010 ms a row)
 * ```
 *
 * Nearly all of the difference between the first two is the fsync, and it is
 * the same difference on every real write path here — each of these through the
 * function this server actually calls, at `FULL` and then at `NORMAL`:
 *
 * ```
 * recordDecision   1.750 ms   0.020 ms
 * putOverlay       1.766 ms   0.079 ms
 * addComment       1.824 ms   0.068 ms
 * createProject    1.785 ms   0.065 ms
 * ```
 *
 * Which is to say the disk is nearly the whole of what writing anything costs.
 * It would be paid most often on the one path nobody asked for: a decision row
 * is written on every repository access, so at `FULL` opening a project in
 * Studio waits on a platter for a line of a log.
 *
 * **`NORMAL` cannot corrupt the file.** That is worth saying first because it is
 * the thing this setting is assumed to risk, and in WAL mode it is a guarantee
 * rather than a hope: a commit appends frames to the log, the log is replayed
 * only as far as its last complete and checksummed frame, and `NORMAL` still
 * syncs the log before a checkpoint copies any of it into the database file. Nor
 * can a Team server process losing its footing lose a write — a crash, a kill, a
 * fatal exception — because the pages are already with the operating system by
 * the time the commit returned. What `NORMAL` gives up is the most recent
 * commits, and only to an operating-system crash or a power cut.
 *
 * So the question is what losing the last second or two of *this* server's
 * writes costs, and it is answered table by table rather than in general:
 *
 *  - **Decisions.** The largest table by far, and the cheapest to lose: a row is
 *    the record of an access that already happened and was already allowed, the
 *    log line beside it went out at the time, and the bound in
 *    src/identity/audit.ts throws the oldest of them away as a matter of course.
 *  - **Threads, comments and overlay records.** Whoever wrote one still has it
 *    on screen; the loss is visible to the one person able to write it again.
 *  - **Presence and rooms.** Not in this file at all — they are memory, and are
 *    meant to be lost on a restart.
 *  - **Accounts, settings and token revocations.** The ones worth thinking
 *    hardest about, and each of them fails loudly rather than quietly. An
 *    account that was created and lost cannot sign in, and the person holding
 *    the password says so. A setting that was changed and lost reads back as
 *    what it was, on the same screen it was set from. A revocation that was lost
 *    leaves the account working, which is the operator's own next observation —
 *    unlike the failure people fear here, which is a change that appears to have
 *    landed and has not.
 *
 * And all of that is only reached through an operating-system crash or a power
 * cut, on a server that has just lost whatever else was in flight.
 *
 * `OFF` is not on the table: it stops syncing the log before a checkpoint, so a
 * power cut part-way through one can leave the database file holding pages the
 * log never durably recorded. That is the ordering `NORMAL` keeps, and it is the
 * whole of what stands between this file and corruption.
 */
const SYNCHRONOUS = "NORMAL";

/**
 * Open `path`, creating it and its directory if they are not there.
 *
 * Foreign keys are switched on per connection — SQLite's default is off, and a
 * `REFERENCES` clause that nothing enforces is a comment. The write-ahead log
 * is what lets a reader run while the Team server process writes, and it is
 * also what {@link SYNCHRONOUS} depends on being set.
 *
 * The directory is made 0700 for the same reason the file is made 0600: it is
 * the storage root, and it holds the signing keys as well as the accounts. A
 * root that already exists keeps whatever mode it was made with, which is the
 * operator's choice about a directory they named.
 */
export async function openDatabase(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(path);
  // WAL first: `synchronous` means different things under the two journal
  // modes, and everything said above SYNCHRONOUS is a property of this one.
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`PRAGMA synchronous = ${SYNCHRONOUS}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  restrictToOwner(path);
  return database;
}

/**
 * Raised when a transaction is asked for inside one that is already open.
 *
 * See {@link inTransaction} for why this is refused rather than nested.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "a transaction is already open on this connection. Writes that belong " +
        "together are wrapped once, at the outermost of them.",
    );
    this.name = "NestedTransactionError";
  }
}

/**
 * Run `work` with every write it makes committed together, or not at all.
 *
 * The rows a method writes to answer one call belong in one commit for two
 * reasons, and the smaller of them is the cost. Outside a transaction SQLite
 * commits each statement on its own, so a method writing three rows pays three
 * commits — three fsyncs at `FULL`, three write barriers at the `NORMAL` this
 * file opens at. The larger reason is the shape: a call that writes half of what
 * it meant to leaves the server holding a state no reader has an opinion about,
 * and it can only be reached by a crash nobody will be there for.
 *
 * **`work` is synchronous, and that is the point rather than a limitation.** One
 * connection serves this whole process, so a transaction held open across an
 * `await` is a transaction that unrelated work runs inside: a write that had
 * nothing to do with this call would be committed by this call's commit, or
 * thrown away by its rollback. A synchronous callback cannot yield to the event
 * loop, so nothing else can reach the connection in the meantime. Work that has
 * to await — hashing a password, asking loreserver for a repository — is done
 * before the transaction opens or after it closes, never inside one.
 *
 * **It refuses to nest.** `node:sqlite` has no nested transactions; a second
 * `BEGIN` is an error from SQLite, and the rollback that error triggers would
 * throw away the outer transaction's writes as well. Refusing here names what
 * happened instead of leaving somebody to read SQLite's wording for it — and a
 * store function that has to be callable from inside a larger write should not
 * open one at all, on the arrangement `insertUser` and `createUser` already use
 * in ./users.ts.
 *
 * A throw rolls back and is passed on. That matters more than it looks: a
 * transaction left open by a throw is a connection holding a write lock for the
 * life of the process, which is a Team server that has stopped answering.
 */
export function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  if (database.isTransaction) {
    throw new NestedTransactionError();
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    // Asked of the connection rather than assumed: some failures — a constraint
    // SQLite could only check at the end of a statement — have already rolled
    // the transaction back, and a `ROLLBACK` with nothing to roll back is
    // itself an error, which would replace the failure worth reporting with a
    // meaningless one.
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

/** The version an open database is at; 0 for one nothing has been applied to. */
export function schemaVersion(database: DatabaseSync): number {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER NOT NULL PRIMARY KEY,
       applied_at INTEGER NOT NULL
     ) STRICT`,
  );
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_version").get();
  if (row === undefined || row["version"] === null || row["version"] === undefined) {
    return 0;
  }
  return integerColumn(row, "version");
}

/**
 * Bring an open database up to {@link SCHEMA_VERSION}, and return the version
 * it is now at.
 *
 * Applying nothing is a normal outcome: this runs on every start, and a
 * database already at the current version is left alone. Each migration is one
 * transaction, so a failure part-way leaves the file at the version before it
 * rather than half-way through.
 *
 * One row is recorded per migration rather than one row overwritten, so the
 * file says when each step was applied.
 */
export function migrate(database: DatabaseSync, path = "team.db"): number {
  let current = schemaVersion(database);
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(path, current, SCHEMA_VERSION);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    inTransaction(database, () => {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
    });
    current = migration.version;
  }

  return current;
}

/** Open the database at `path` and migrate it in one step. */
export async function openMigratedDatabase(path: string): Promise<DatabaseSync> {
  const database = await openDatabase(path);
  try {
    migrate(database, path);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
