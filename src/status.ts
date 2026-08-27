/**
 * The `status` command: what this server is, said in one screenful.
 *
 * The versions it is running, whether the server beside it is answering, what
 * it holds and how much of it, the addresses somebody has to be told in order
 * to reach it, and the fingerprint they compare once. It is the question asked
 * first by whoever has just been handed a deployment, and the question asked at
 * three in the morning by whoever is being told that something is wrong.
 *
 * **The answer is not live and says so.** Two of its parts are expensive — the
 * health check is a request to another server, and measuring the store walks
 * and stats every file under it — so a server works one out when it is asked
 * and hands the same one to everybody who asks inside the next few seconds. The
 * two numbers that make that honest are printed: when it was gathered, and how
 * long one is kept. A line saying "as of" is worth more than a clock that would
 * be showing when the question was asked rather than when the answer was true.
 *
 * Both paths produce the same struct and hand it to one renderer. Given
 * `--server` it calls `admin.server.status` on a session; given `--root` it runs
 * the same collection against the database, the keys and the stored identity
 * beside a server. The second is not a convenience. The questions this command
 * answers are the ones somebody asks when the protocol may be the thing that is
 * broken, and a description of a server that could only be obtained through the
 * server would be no use on the morning it is needed.
 *
 * That collection takes a running server's own record of itself, which a command
 * line does not have; src/team/status.ts sets out what was narrowed so that this
 * could call it rather than write a second one. Nothing about what a status *is*
 * is decided here.
 */
import { TEAM_METHODS, type TeamAdminStatus } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readServerStatus } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { describeDuration } from "./duration.js";
import { identityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { storedIdentity } from "./identity/settings.js";
import { serverStatus } from "./team/status.js";
import { readAuthority } from "./tls/authority.js";

import type { DatabaseSync } from "node:sqlite";

export interface StatusOptions {
  readonly root: string;
  /**
   * The port loreserver answers its health check on.
   *
   * Named on the line or left at the default, because it is not stored: it is
   * what `up` was told, and a storage root does not record it. The one thing
   * this command asks the network for is a request to this port, so a status
   * taken with the wrong one says loreserver is not answering when it is.
   */
  readonly healthPort: number;
}

export interface StatusOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The word for a store this server holds but could not add up. */
const UNMEASURED_STORE = "unknown";

/** The units a size is written in, largest first. */
const SIZE_UNITS: readonly (readonly [string, number])[] = [
  ["TiB", 1024 ** 4],
  ["GiB", 1024 ** 3],
  ["MiB", 1024 ** 2],
  ["KiB", 1024],
];

/**
 * A number of bytes in the largest unit it reaches, to one decimal place.
 *
 * The same bargain src/duration.ts strikes over a lifetime, for the same
 * reason: 4509715660 is correct and nobody can hold it up against the size of
 * the disk it is sitting on. Binary units, because that is what the filesystem
 * this was measured with counts in. One decimal rather than none, so that a
 * store which grew by a tenth shows that it did.
 */
function describeBytes(bytes: number): string {
  for (const [unit, size] of SIZE_UNITS) {
    if (bytes >= size) {
      return `${(bytes / size).toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} bytes`;
}

/**
 * How long an answer stands, in the words this program writes a duration in.
 *
 * Anything that is not a whole number of seconds is printed as the milliseconds
 * it is rather than rounded into a second it is not. This is the number an
 * operator reads in order to decide how stale the lines above it might be, and
 * rounding it would be rounding the one figure that is about the accuracy of
 * the rest.
 */
function describeFreshness(freshnessMs: number): string {
  return freshnessMs >= 1000 && freshnessMs % 1000 === 0
    ? describeDuration(freshnessMs / 1000)
    : `${freshnessMs}ms`;
}

/** One block of the description: a heading, and the rows underneath it. */
interface StatusBlock {
  readonly heading: string;
  readonly rows: readonly (readonly [string, string])[];
}

/**
 * What this server is, laid out the same way whichever path gathered it.
 *
 * Written once and called from both, which is what keeps an operator who
 * administers one server over ssh and another over the protocol reading the
 * same thing. The labels are padded to one width across every block rather than
 * per block, so the values line up down the whole screen instead of stepping in
 * and out at each heading.
 */
function renderStatus(status: TeamAdminStatus, stdout: WriteText): void {
  const { loreserver, reach } = status;
  stdout(`nlteam ${status.version} under ${status.root}\n`);
  stdout(
    `as of ${new Date(status.gatheredAt).toISOString()}, and an answer is kept for ` +
      `${describeFreshness(status.freshnessMs)}\n`,
  );

  const blocks: readonly StatusBlock[] = [
    {
      // Whether it answered is beside the version rather than in a row of its
      // own, because it is the one fact in this block somebody is looking for.
      heading: `loreserver ${loreserver.version}, ${
        loreserver.healthy ? "answering" : "not answering"
      }`,
      rows: [
        ["store", loreserver.storageRoot],
        [
          "size",
          // A store too large to walk, or one that is not there yet, has no
          // size rather than a size of nought. See directoryBytes in
          // src/view.ts: a partial total looks exactly like a real one.
          loreserver.storageBytes === undefined
            ? UNMEASURED_STORE
            : describeBytes(loreserver.storageBytes),
        ],
      ],
    },
    {
      heading: "reachable at",
      rows: [
        ["sign in", reach.signIn],
        ["data", reach.data],
        ["fingerprint", reach.fingerprint],
        // Nobody off this machine can reach these, and they are here for the
        // one question they answer: which of them this server is holding, for
        // somebody looking at a port that is already taken.
        ["loopback", reach.loopback.map((port) => `${port.port} ${port.what}`).join(", ")],
      ],
    },
    {
      heading: "on this server",
      rows: [
        ["accounts", String(status.accounts)],
        ["projects", String(status.projects)],
        // Bounded by this server rather than by how long it has been running —
        // see DECISION_LIMIT in src/identity/audit.ts — so this number stops
        // going up long before the disk notices. `nlteam audit` reads them.
        ["decisions", String(status.decisions)],
        ["signing keys", String(status.signingKeys)],
      ],
    },
  ];

  const width = Math.max(
    ...blocks.flatMap((block) => block.rows.map(([label]) => label.length)),
  );
  for (const block of blocks) {
    stdout(`\n${block.heading}\n`);
    for (const [label, value] of block.rows) {
      stdout(`  ${label.padEnd(width)}  ${value}\n`);
    }
  }
}

/**
 * Describe the server under a storage root. Returns the process exit code.
 *
 * Everything is read from the disk beside it — the accounts, the projects, the
 * decisions and the keys out of the database and the key directory, the
 * addresses out of the identity `up` wrote there when it started. The one thing
 * that leaves this machine is the health check, which is a request to the
 * loopback.
 */
export async function status(
  options: StatusOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let database: DatabaseSync | undefined;
  try {
    database = await openMigratedDatabase(layout.databasePath);
    const keys = await KeyStore.open(layout.keysDir);
    // What this deployment was brought up as, which `up` writes on every start
    // and `token mint` reads for the same reason: the ports and the host names
    // a token's audience is built from are the ports and host names this
    // command has to describe. Nothing is taken from the command line, because
    // a status is an account of the server that is there rather than of the one
    // whoever is typing would like.
    const config = identityConfig(storedIdentity(database));
    // A server that has never been brought up has no authority to name, and the
    // collection has a word for a fingerprint it has not got. Not a reason to
    // refuse: the question is what this server is, and one part of the answer
    // being absent is part of the answer.
    const authority = await readAuthority(options.root).catch(() => undefined);
    renderStatus(
      await serverStatus({
        database,
        keys,
        config,
        // As the layout resolved it rather than as it was typed, which is the
        // path `up` puts in the same field: what a server says about where it
        // keeps things should be the directory it is actually reading.
        root: layout.root,
        healthPort: options.healthPort,
        ...(authority === undefined ? {} : { fingerprint: authority.fingerprint256 }),
      }),
      stdout,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database?.close();
  }
}

/** Describe a server over a session. Returns the process exit code. */
export async function statusOverProtocol(
  options: StatusOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const answer = await withSession(options.server, async (session) =>
      readServerStatus(await session.call(TEAM_METHODS.adminServerStatus)),
    );
    renderStatus(answer, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
