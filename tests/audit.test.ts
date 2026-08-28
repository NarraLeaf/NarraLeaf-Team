// The decisions Team keeps: what one row holds, and what stops the table
// growing for ever on a Team server that answers a permission question on every
// repository access.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  countDecisions,
  DECISION_LIMIT,
  DECISION_TRIM_SLACK,
  forLog,
  listDecisions,
  pageDecisions,
  recordDecision,
  trimDecisions,
  type DecisionPage,
} from "../src/identity/audit.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-audit-");

const open: DatabaseSync[] = [];

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

/** A moment far enough back that every row written after it sorts later. */
const EARLY = Date.parse("2026-01-01T00:00:00Z");

/** Write `count` allowances, each a millisecond after the one before. */
function fillWithAllowances(connection: DatabaseSync, count: number, from = EARLY): void {
  for (let index = 0; index < count; index += 1) {
    recordDecision(connection, {
      at: from + index,
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });
  }
}

/** How many of the rows on record are refusals. */
function refusals(connection: DatabaseSync): number {
  return listDecisions(connection, DECISION_LIMIT + DECISION_TRIM_SLACK).filter(
    (decision) => !decision.allowed,
  ).length;
}

describe("recordDecision", () => {
  it("keeps every part of a decision, and reads it back unchanged", async () => {
    const connection = await database();

    recordDecision(connection, {
      at: EARLY,
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });

    expect(listDecisions(connection)).toEqual([
      {
        at: EARLY,
        username: "cleo",
        resource: "lighthouse",
        allowed: false,
        detail: "no grant",
      },
    ]);
  });

  it("hands them back newest first, which is the order a refusal is looked for in", async () => {
    const connection = await database();
    recordDecision(connection, {
      at: EARLY,
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });
    recordDecision(connection, {
      at: EARLY + 60_000,
      username: "bob",
      resource: "harbour",
      allowed: true,
      detail: "write",
    });

    expect(listDecisions(connection).map((decision) => decision.username)).toEqual(["bob", "ada"]);
  });

  it("writes at the durability the file was opened at, and leaves it there", async () => {
    const connection = await database();

    recordDecision(connection, {
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });

    // How durable a decision is, is decided once where the file is opened —
    // `synchronous = NORMAL`, which SQLite numbers 1 — and this path neither
    // relaxes it for its own sake nor leaves it changed for the account,
    // project or setting written next. A write path that reached for the pragma
    // itself would be doing both, quietly.
    expect(connection.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  });

  it("takes the moment from the clock when nobody names one", async () => {
    const connection = await database();
    const before = Date.now();

    recordDecision(connection, {
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });

    const [only] = listDecisions(connection);
    expect(only?.at).toBeGreaterThanOrEqual(before);
    expect(only?.at).toBeLessThanOrEqual(Date.now());
  });
});

describe("the bound on how many are kept", () => {
  it("holds the table inside the limit and its slack, however many are made", async () => {
    const connection = await database();

    fillWithAllowances(connection, DECISION_LIMIT + DECISION_TRIM_SLACK + 10);

    expect(countDecisions(connection)).toBeLessThanOrEqual(DECISION_LIMIT + DECISION_TRIM_SLACK);
  });

  it("lets the table run past the limit rather than deleting on every decision", async () => {
    const connection = await database();

    fillWithAllowances(connection, DECISION_LIMIT + 100);

    // A Team server that trimmed on every decision would sit exactly on the limit, and
    // would be paying for a DELETE on the path that answers every repository
    // access. Standing above it is what the slack buys.
    expect(countDecisions(connection)).toBeGreaterThan(DECISION_LIMIT);
  });

  it("drops the routine allowances before it drops a refusal", async () => {
    const connection = await database();
    // The oldest row in the table, and the one worth keeping. Everything after
    // it is an ordinary allowance, and there are enough of them to force the
    // bound to choose.
    recordDecision(connection, {
      at: EARLY,
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });

    fillWithAllowances(connection, DECISION_LIMIT + DECISION_TRIM_SLACK + 10, EARLY + 1);

    expect(refusals(connection)).toBe(1);
    expect(
      listDecisions(connection, DECISION_LIMIT + DECISION_TRIM_SLACK).find(
        (decision) => !decision.allowed,
      ),
    ).toMatchObject({ username: "cleo", resource: "lighthouse" });
  });
});

describe("trimDecisions", () => {
  it("removes nothing from a table that is inside its bound", async () => {
    const connection = await database();
    fillWithAllowances(connection, 10);

    expect(trimDecisions(connection)).toBe(0);
    expect(countDecisions(connection)).toBe(10);
  });

  it("brings a table that is over the bound back to it", async () => {
    const connection = await database();
    fillWithAllowances(connection, DECISION_LIMIT + 40);

    trimDecisions(connection);

    expect(countDecisions(connection)).toBe(DECISION_LIMIT);
  });
});

describe("pageDecisions", () => {
  /** Every decision a cursor walks to, in the order the pages handed them over. */
  function walk(connection: DatabaseSync, limit: number): string[] {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: DecisionPage = pageDecisions(connection, {
        limit,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      seen.push(...page.decisions.map((decision) => decision.detail));
      if (page.cursor === undefined) {
        return seen;
      }
      cursor = page.cursor;
    }
  }

  it("hands back a page at a time, newest first, and says where to carry on", async () => {
    const connection = await database();
    for (let index = 0; index < 5; index += 1) {
      recordDecision(connection, {
        at: EARLY + index,
        username: "ada",
        resource: "harbour",
        allowed: true,
        detail: `decision ${index}`,
      });
    }

    const first = pageDecisions(connection, { limit: 2 });

    expect(first.decisions.map((decision) => decision.detail)).toEqual([
      "decision 4",
      "decision 3",
    ]);
    expect(first.cursor).toBeDefined();
  });

  it("walks the whole log without repeating a row or skipping one", async () => {
    const connection = await database();
    for (let index = 0; index < 7; index += 1) {
      recordDecision(connection, {
        at: EARLY + index,
        username: "ada",
        resource: "harbour",
        allowed: true,
        detail: `decision ${index}`,
      });
    }

    expect(walk(connection, 3)).toEqual([
      "decision 6",
      "decision 5",
      "decision 4",
      "decision 3",
      "decision 2",
      "decision 1",
      "decision 0",
    ]);
  });

  it("separates decisions taken in the same millisecond, which is the ordinary case", async () => {
    // A busy server answers a permission question on every repository access,
    // so several land on the same clock reading. A cursor that was only a time
    // would either hand one of them over twice or lose it.
    const connection = await database();
    for (let index = 0; index < 6; index += 1) {
      recordDecision(connection, {
        at: EARLY,
        username: "ada",
        resource: "harbour",
        allowed: true,
        detail: `decision ${index}`,
      });
    }

    expect(walk(connection, 2).sort()).toEqual([
      "decision 0",
      "decision 1",
      "decision 2",
      "decision 3",
      "decision 4",
      "decision 5",
    ]);
  });

  it("says nothing follows the last page", async () => {
    const connection = await database();
    fillWithAllowances(connection, 3);

    const page = pageDecisions(connection, { limit: 3 });

    expect(page.decisions).toHaveLength(3);
    expect(page.cursor).toBeUndefined();
  });

  it("starts again from the top for a cursor it cannot read", async () => {
    // The cursor came from this server, so one that does not parse is a caller
    // that lost its place - and the first page is where somebody who has lost
    // their place is.
    const connection = await database();
    fillWithAllowances(connection, 3);

    expect(pageDecisions(connection, { limit: 3, before: "not a cursor" }).decisions).toHaveLength(
      3,
    );
  });
});

describe("text somebody else chose, on its way into a line", () => {
  it("leaves what a person would write exactly as it was", () => {
    // Every language, every punctuation mark, every backslash: the one class
    // this touches is the one that is an instruction rather than a character.
    for (const text of ["harbour", "urc-0123456789abcdef", "灯台 / phare — 3", "a\\path\\here"]) {
      expect(forLog(text)).toBe(text);
    }
  });

  it("escapes what would otherwise write a line of the log itself", () => {
    // A newline is a second line of this server's own log, and an escape moves
    // the cursor of the terminal somebody is reading it in. DEL and the C1
    // range go with them, because a terminal acts on those too.
    expect(forLog("harbour\nauth: check ada urc-aa: allowed")).toBe(
      "harbour\\u000aauth: check ada urc-aa: allowed",
    );
    expect(forLog("\u001b[2J\u001b[H")).toBe("\\u001b[2J\\u001b[H");
    expect(forLog("a\u0000b\u007fc\u009bd")).toBe("a\\u0000b\\u007fc\\u009bd");
  });

  it("keeps what arrived rather than dropping it", () => {
    // What came in is the whole of what a log is for. Text with the awkward
    // bytes quietly removed is a record of something that did not arrive, and
    // it would read as one id where two were sent.
    const rendered = forLog("urc-aa\rurc-bb");
    expect(rendered).toContain("urc-aa");
    expect(rendered).toContain("urc-bb");
    expect(rendered).not.toBe(forLog("urc-aaurc-bb"));
  });
});
