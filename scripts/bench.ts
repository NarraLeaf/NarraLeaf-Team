/**
 * The numbers in docs/internals.md, so that they can be taken again.
 *
 * Every performance claim that file makes came from here. A figure written down
 * once is a figure nobody can check on their own hardware, on their own disk,
 * or after the change that invalidated it - and this server's three costs are
 * all the kind that move: a disk, a threadpool, and a signature.
 *
 * Not part of the build and not shipped, in the same way and for the same
 * reason as ./socket-endpoint.ts beside it:
 *
 *     npx esbuild scripts/bench.ts --bundle --platform=node --format=cjs \
 *       --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-bench\" --outfile=bench.cjs
 *     node bench.cjs
 *
 * It writes to a temporary directory and takes about half a minute. Nothing it
 * does touches a storage root, so it is safe to run beside a live server -
 * though the figures will be that server's as much as this one's if you do.
 */
import { randomBytes, scrypt } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identifyToken } from "../src/identity/bearer.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import {
  OWASP_SCRYPT_PARAMETERS,
  ScryptPasswordHasher,
  type ScryptParameters,
} from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { createUser, findUser, findUserById } from "../src/identity/users.js";

/** Accounts to put in the database, so a lookup is not a lookup in a table of one. */
const ACCOUNTS = 40;

/** Rows to insert when timing a write. Enough that the timer is not the measurement. */
const ROWS = 2000;

/**
 * Cheap parameters for the accounts this needs to exist.
 *
 * The real cost of a derivation is measured on its own further down, at the
 * parameters this server actually uses. Making forty accounts at those would
 * add ten seconds to say nothing new.
 */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };

function say(label: string, each: number): void {
  const microseconds = (each * 1000).toFixed(1).padStart(9);
  const rate = each === 0 ? "-" : (1000 / each).toFixed(0);
  console.log(`  ${label.padEnd(44)}${microseconds} us${rate.padStart(10)}/s`);
}

/** Run `work` `rounds` times, after once to let it warm, and report the mean. */
function time(label: string, rounds: number, work: () => void): void {
  work();
  const at = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    work();
  }
  say(label, (performance.now() - at) / rounds);
}

/** What a commit costs at one `synchronous` setting: the fsync, or the lack of one. */
function writeCost(database: DatabaseSync, setting: string): number {
  database.exec(`PRAGMA synchronous = ${setting}`);
  const insert = database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  const at = performance.now();
  for (let row = 0; row < ROWS; row += 1) {
    insert.run(`${setting}-${row}`, "x", Date.now());
  }
  const took = performance.now() - at;
  database.exec(`DELETE FROM settings WHERE key LIKE '${setting}-%'`);
  return took;
}

/** One scrypt derivation at the parameters this server signs up to. */
function derive(parameters: ScryptParameters = OWASP_SCRYPT_PARAMETERS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      "a password nobody guesses",
      randomBytes(16),
      parameters.keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelism,
        maxmem: 128 * parameters.cost * parameters.blockSize * 2,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * How long an ordinary file read waits while `many` derivations run.
 *
 * Eight reads are kept in flight throughout, because one at a time cannot see a
 * pool of four run out - it only ever asks for one thread, and four derivations
 * still leave it one. Asking for more file work than the free threads can serve
 * is the only shape under which a pool size is visible at all.
 */
async function readsBesideDerivations(
  file: string,
  many: number,
): Promise<{ worst: number; peakRss: number }> {
  const waits: number[] = [];
  let stop = false;
  let peakRss = 0;
  const watch = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const readers = Array.from({ length: 8 }, async () => {
    while (!stop) {
      const at = performance.now();
      await readFile(file);
      waits.push(performance.now() - at);
    }
  });

  // Nothing to derive is still a measurement: it is what a read costs when the
  // pool is this process's alone, and every other row is read against it.
  await (many === 0
    ? new Promise((resolve) => setTimeout(resolve, 400))
    : Promise.all(Array.from({ length: many }, () => derive())));

  stop = true;
  clearInterval(watch);
  await Promise.all(readers);
  // The worst read, not a percentile of them. How many reads get stuck behind a
  // derivation is bounded - one per reader per round - while how many sail past
  // grows with however long the derivations take, so any percentile improves as
  // the stall gets longer. The question is how long a read can be made to wait,
  // and only the maximum answers it.
  return { worst: Math.max(...waits, 0), peakRss };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "nlteam-bench-"));
  // Something on a real disk for the readers below to ask for, rather than this
  // file: the bundle they run from is one file with no path of its own.
  const readable = path.join(root, "something-to-read");
  await writeFile(readable, randomBytes(16 * 1024));
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  const hasher = new ScryptPasswordHasher(CHEAP);
  for (let account = 0; account < ACCOUNTS; account += 1) {
    await createUser(database, hasher, {
      username: `person${account}`,
      password: "a password nobody guesses",
    });
  }
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig();
  const user = findUser(database, `person${ACCOUNTS >> 1}`);
  if (user === undefined) {
    throw new Error("the account this was about to measure is not there");
  }
  const { token } = mintToken(user, keys.signingKey, config, {});

  console.log(`\nwhat a write costs (${ROWS} single-row inserts, no transaction)\n`);
  for (const setting of ["FULL", "NORMAL", "OFF"]) {
    say(`synchronous = ${setting}`, writeCost(database, setting) / ROWS);
  }

  console.log(`\nwhat a call costs before a method runs (${ACCOUNTS} accounts in the database)\n`);
  time("findUserById, one row and its groups", 20_000, () => {
    findUserById(database, user.id);
  });
  time("identifyToken, what every call does", 5_000, () => {
    identifyToken(database, keys, config, token);
  });
  time("mintToken, signing one", 5_000, () => {
    mintToken(user, keys.signingKey, config, {});
  });
  database.close();

  const pool = process.env["UV_THREADPOOL_SIZE"] ?? "4, node's default";
  console.log(`\nwhat a password costs everything else (UV_THREADPOOL_SIZE=${pool})\n`);
  console.log("  derivations at once   worst file read beside them   peak RSS");
  for (const many of [0, 1, 2, 4, 8]) {
    // The worst of three rounds rather than one: where a read lands in libuv's
    // queue is not this program's to decide, and a single round can miss the
    // stall entirely and report a pool that never ran out.
    let worst = 0;
    let peakRss = 0;
    for (let round = 0; round < 3; round += 1) {
      const measured = await readsBesideDerivations(readable, many);
      worst = Math.max(worst, measured.worst);
      peakRss = Math.max(peakRss, measured.peakRss);
    }
    console.log(
      `  ${String(many).padStart(13)}` +
        `${`${worst.toFixed(2)} ms`.padStart(28)}` +
        `${`${(peakRss / 1024 / 1024).toFixed(0)} MiB`.padStart(13)}`,
    );
  }
  console.log("");
}

void main();
