/**
 * The `key` commands: see the signing keys, and add one.
 *
 * Rotating is safe at any moment. The new key signs from then on, the old one
 * stays published and keeps verifying the tokens it signed, and no client is
 * asked to do anything. Taking a key out of the JWKS is a separate act, because
 * doing it too soon invalidates tokens that have not expired yet.
 *
 * Both verbs have two paths and one output. Given `--root` they open the keys
 * directory beside the server; given `--server` they call `admin.keys.list` or
 * `admin.keys.rotate` on a session. Nothing is lost between them: what either
 * command prints of a key is its `kid` and which of three things it is, and the
 * answer carries both.
 *
 * A rotation over the protocol reaches the store the running server holds, so
 * the next token it mints is signed by the new key with nothing restarted. A
 * rotation off the disk writes a file that server has not seen, and it re-reads
 * the directory before it answers about keys for exactly that reason — see
 * src/team/methods/admin.ts. The two cannot come to disagree about which keys
 * this server has.
 */
import { TEAM_METHODS } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readKeys, type ListedKey } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";

export interface KeyOptions {
  readonly root: string;
}

export interface KeyOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The store's keys as rows.
 *
 * The same three fields the protocol carries, worked out here the way the
 * server works them out for an answer: the newest key that has not been retired
 * signs, and every key that has not been retired is published.
 */
function rowsOf(keys: KeyStore): readonly ListedKey[] {
  const signing = keys.signingKey;
  return keys.all.map((key) => ({
    kid: key.kid,
    retired: key.retired,
    signing: key.kid === signing.kid,
  }));
}

/** The keys, laid out the same way whichever path read them. */
function renderKeys(keys: readonly ListedKey[], stdout: WriteText): void {
  for (const key of keys) {
    const state = key.retired ? "retired" : key.signing ? "signing" : "verifying";
    stdout(`${state.padEnd(9)}  ${key.kid}\n`);
  }
}

/** What a rotation did, said the same way whichever path did it. */
function renderRotation(keys: readonly ListedKey[], stdout: WriteText): void {
  const signing = keys.find((key) => key.signing);
  if (signing === undefined) {
    // Unreachable on a server that has just rotated: the key it made is the one
    // it goes on to sign with. It is a sentence rather than an assertion because
    // on one of the two paths this is reading an answer from somewhere else.
    throw new Error("nothing is signing tokens on that server after the rotation");
  }
  stdout(`signing with ${signing.kid}\n`);
  stdout(
    `${keys.filter((key) => !key.retired).length} key(s) are published; tokens signed by ` +
      "any of them still verify.\n",
  );
}

/** Print every key Team holds. Returns the process exit code. */
export async function keyList(
  options: KeyOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const keys = await KeyStore.open(layout.keysDir);
    renderKeys(rowsOf(keys), stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Print every key a server holds, over a session. */
export async function keyListOverProtocol(
  options: KeyOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const keys = await withSession(options.server, async (session) =>
      readKeys(TEAM_METHODS.adminKeysList, await session.call(TEAM_METHODS.adminKeysList)),
    );
    renderKeys(keys, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Generate a key and sign with it from now on. Returns the process exit code. */
export async function keyRotate(
  options: KeyOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const keys = await KeyStore.open(layout.keysDir);
    await keys.rotate();
    renderRotation(rowsOf(keys), stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Generate a key on a server and have it sign from now on, over a session. */
export async function keyRotateOverProtocol(
  options: KeyOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const keys = await withSession(options.server, async (session) =>
      readKeys(TEAM_METHODS.adminKeysRotate, await session.call(TEAM_METHODS.adminKeysRotate)),
    );
    renderRotation(keys, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
