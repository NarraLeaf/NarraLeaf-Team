/**
 * The `audit` command: the decisions this server has made, newest first.
 *
 * Every repository access loreserver serves is a question put to Team — may
 * this account touch this resource — and every answer is kept, with the short
 * reason the log line carries. The two questions this command is for are "who
 * reached this project" and, far more often, "who was refused and why".
 *
 * Both paths produce the same rows and hand them to one writer. Given `--server`
 * it pages `admin.audit.list`; given `--root` it reads the same table beside the
 * server with the same query. The second is the one that matters most here: a
 * refusal is exactly what somebody is looking for when the thing refusing may be
 * broken, and a log readable only over the protocol would be unreadable on the
 * morning it is wanted.
 *
 * ## Why this does not page to the end, when `user list` does
 *
 * `user list` prints every account, because the size of that list is the size of
 * the team: it is small, it is meaningful, and somebody piping it into `grep`
 * has nowhere to keep a cursor between one run and the next.
 *
 * A decision log is not that. Its size is how busy the server has been — an
 * afternoon of one team working is thousands of rows — and it is bounded by the
 * server rather than by anything a person did, at the couple of thousand rows
 * DECISION_LIMIT in src/identity/audit.ts sets out. So "the audit" is not a
 * thing anybody wants printed: what they want is the last screenful, and
 * {@link DEFAULT_AUDIT_LIMIT} is a screenful. A larger number is asked for with
 * `--limit`, and nothing caps that but the table's own bound.
 *
 * **`--limit` is how many rows are printed**, on both paths and with or without
 * a filter, which is the one rule that makes the two agree. It has to be said
 * that way round rather than as "how many rows are read", because the method
 * will not answer with more than a couple of hundred at a time while the table
 * beside the server will: a limit meaning rows read would quietly become two
 * different numbers the moment somebody asked for three hundred. So the reader
 * below pages until it has printed what was asked for, however many rows that
 * took, and stops there rather than at the end of the log.
 *
 * ## Why `--refused` is worth a flag
 *
 * Because a refusal is the rare outcome and the reason anybody opens this at
 * all. The protocol makes the same judgement in the same words: refusals have a
 * topic of their own, `admin/refusals`, and allowances are published nowhere,
 * because an allowance is what every working access produces. The table makes
 * it too, dropping the oldest allowances before any refusal when the bound
 * forces a choice.
 *
 * It is not a nicety on top of `--limit`; without it the flag is close to
 * useless for the question people have. On a server doing ordinary work the
 * last fifty decisions are fifty allowances, and a screenful with no refusal in
 * it reads like a server with nothing wrong. With the flag, the reader keeps
 * paging until it has the refusals asked for or the log ends — so an empty
 * listing means nothing on record was refused, which is a fact rather than an
 * absence of evidence. The method carries no such filter and is not being given
 * one: the rows are read and the allowances dropped here, which costs a bounded
 * walk of a bounded table and leaves the contract where it is.
 */
import { TEAM_METHODS, type TeamAdminDecision } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readDecisionPage } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { pageDecisions } from "./identity/audit.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";

import type { DatabaseSync } from "node:sqlite";

/**
 * How many decisions are printed when nobody said.
 *
 * A screenful. It is the same number the method pages by, which is not a
 * coincidence and is not read from there either: this command sends a limit on
 * every call, including the first, so that what it prints is decided here and
 * never by whatever a particular server happens to default to. Two servers of
 * different ages answer `nlteam audit` with the same number of rows.
 */
export const DEFAULT_AUDIT_LIMIT = 50;

/**
 * How many rows are asked for at a time while looking for something.
 *
 * The most any server will answer with in one go. Named here rather than
 * imported from the method table because it is what this command asks for
 * rather than what a server allows: one that allows fewer answers with fewer,
 * and the loop below asks again.
 */
const AUDIT_PAGE = 200;

export interface AuditOptions {
  readonly root: string;
  /** How many rows to print. */
  readonly limit: number;
  /** Print only the refusals. */
  readonly refused: boolean;
}

export interface AuditOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
  readonly limit: number;
  readonly refused: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One page of the log, as either path reads one. */
interface DecisionPage {
  readonly decisions: readonly TeamAdminDecision[];
  /** Opaque, and absent when this page is the end of the log. */
  readonly cursor: string | undefined;
}

/**
 * Read pages until `limit` rows have been kept, or the log runs out.
 *
 * Shared by both paths rather than written beside each, because it is where the
 * rule that makes them agree lives — see the note at the top of this file about
 * what `--limit` counts. Two loops would be two readings of that rule, and they
 * would part company the first time either was touched.
 *
 * How much is asked for depends on whether anything is being dropped. With no
 * filter every row read is a row printed, so asking for exactly what is left is
 * one round trip and nothing wasted. With one, how many rows hold the next few
 * refusals is not knowable in advance, so a whole page is asked for and this
 * loop decides when it has enough.
 *
 * `keep` is undefined for "all of them" rather than a function that answers
 * true, so that the difference is one the code can read.
 */
async function collect(
  limit: number,
  keep: ((decision: TeamAdminDecision) => boolean) | undefined,
  readPage: (want: number, cursor: string | undefined) => Promise<DecisionPage>,
): Promise<TeamAdminDecision[]> {
  const kept: TeamAdminDecision[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await readPage(keep === undefined ? limit - kept.length : AUDIT_PAGE, cursor);
    for (const decision of page.decisions) {
      if (keep === undefined || keep(decision)) {
        kept.push(decision);
      }
      if (kept.length === limit) {
        return kept;
      }
    }
    cursor = page.cursor;
    if (cursor !== undefined && seen.has(cursor)) {
      // A cursor is opaque and nothing here looks inside one, so the only check
      // this can make is that the log is going somewhere. A server handing back
      // a cursor it had already given would spin this for ever, and a command
      // that never returns is worse than one that says what it could not do.
      throw new Error(
        `that server answered ${TEAM_METHODS.adminAuditList} with a cursor it had already ` +
          "given, so the log does not end",
      );
    }
    if (cursor !== undefined) {
      seen.add(cursor);
    }
  } while (cursor !== undefined);

  return kept;
}

/**
 * The sentence an empty listing stands behind, written once for both paths.
 *
 * Two of them, because they mean different things and a reader has to be able
 * to tell which they are looking at. An empty log is a server nobody has asked
 * anything of yet. An empty listing under `--refused` is the stronger statement:
 * the reader walked to the end of what is kept and found no refusal in it.
 */
function nothingToShow(onlyRefusals: boolean): string {
  return onlyRefusals
    ? "nothing on record was refused."
    : "no decisions yet. One is recorded every time loreserver asks whether somebody may " +
        "reach a repository.";
}

/**
 * The decisions, laid out the same way whichever path read them.
 *
 * The moment first, because these are read as a sequence and the reader is
 * looking for when. The outcome next, because it is the column somebody scans
 * down, and both words are the same length so there is nothing to pad. Then who
 * asked, what about, and the short reason as the log line words it — `owner`,
 * `no grant`, `expired`.
 */
function renderDecisions(
  rows: readonly TeamAdminDecision[],
  empty: string,
  stdout: WriteText,
): void {
  if (rows.length === 0) {
    stdout(`${empty}\n`);
    return;
  }
  const username = Math.max(...rows.map((row) => row.username.length));
  const resource = Math.max(...rows.map((row) => row.resource.length));
  for (const row of rows) {
    const line =
      `${new Date(row.at).toISOString()}  ${row.allowed ? "allowed" : "refused"}  ` +
      `${row.username.padEnd(username)}  ${row.resource.padEnd(resource)}  ${row.detail}`;
    stdout(`${line.trimEnd()}\n`);
  }
}

/** Whether a listing drops anything, and what it drops. */
function refusalsOnly(
  refused: boolean,
): ((decision: TeamAdminDecision) => boolean) | undefined {
  return refused ? (decision) => !decision.allowed : undefined;
}

/** Print the decisions recorded under a storage root. Returns the exit code. */
export async function audit(
  options: AuditOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let database: DatabaseSync | undefined;
  try {
    database = await openMigratedDatabase(layout.databasePath);
    const open = database;
    const rows = await collect(options.limit, refusalsOnly(options.refused), (want, cursor) => {
      // The same query the method runs, cursor and all, so that a page boundary
      // falls in the same place on both paths. Answered with a resolved promise
      // because this half has nothing to wait for: the table is a file beside
      // this process.
      const page = pageDecisions(open, {
        limit: want,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      return Promise.resolve({ decisions: page.decisions, cursor: page.cursor });
    });
    renderDecisions(rows, nothingToShow(options.refused), stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database?.close();
  }
}

/** Print the decisions a server has recorded, over a session. */
export async function auditOverProtocol(
  options: AuditOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const rows = await withSession(options.server, async (session) =>
      collect(options.limit, refusalsOnly(options.refused), async (want, cursor) =>
        readDecisionPage(
          await session.call(TEAM_METHODS.adminAuditList, {
            limit: want,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
    );
    renderDecisions(rows, nothingToShow(options.refused), stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
