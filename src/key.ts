/**
 * The `key` commands: see the signing keys, add one, and end one's life.
 *
 * Rotating is safe at any moment. The new key signs from then on, the old one
 * stays published and keeps verifying the tokens it signed, and no client is
 * asked to do anything.
 *
 * **Retiring is the opposite of safe, and it is meant to be.** It takes a key
 * out of the JWKS, so every token that key signed is refused from that moment
 * by this server and by anything else verifying against the same document, and
 * the people holding them sign in again. That is what it is for: it is the one
 * thing that ends the life of a token already issued, and the reason it is a
 * separate verb from rotating is that doing it as part of a rotation would
 * invalidate everybody's tokens by accident. So the command says what it cost,
 * every time, rather than asking whether it was meant.
 *
 * The key that is signing is refused, and that is the only retirement refused
 * here: it would refuse the tokens this server has just issued and leave
 * nothing able to sign their replacements. Rotate first, then retire the key
 * that used to sign.
 *
 * Every verb has two paths and one output. Given `--root` they open the keys
 * directory beside the server; given `--server` they call `admin.keys.list`,
 * `admin.keys.rotate` or `admin.keys.retire` on a session. Nothing is lost
 * between them: what either path prints of a key is its `kid` and which of
 * three things it is, and the answer carries both.
 *
 * A change made over the protocol reaches the store the running server holds,
 * so the next token it mints is signed by the right key with nothing restarted.
 * One made off the disk moves a file that server has not seen, and it re-reads
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

/** What retiring is told beyond where to do it: which key, by its `kid`. */
export interface KeyRetireOptions extends KeyOptions {
  readonly kid: string;
}

export interface KeyRetireOnServerOptions extends KeyOnServerOptions {
  readonly kid: string;
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

/**
 * What a retirement cost, said the same way whichever path did it.
 *
 * The cost is printed rather than asked about beforehand. Nobody retires a key
 * by accident — it takes a `kid` copied off a list — and what is worth telling
 * the person who did it is what has just happened to everybody else, which is
 * that every token that key signed is refused from now on.
 *
 * The second sentence appears when nothing but the signing key is left
 * published, which is the state somebody reaches deliberately when they believe
 * a key has got out: rotate, then retire what is left. It is not a warning and
 * there is nothing to undo, since the file is kept and a key put back would go
 * on verifying tokens somebody is thought to have. It is said because "every
 * token this server issued before its latest rotation" is a larger sentence
 * than the count above it looks like.
 */
function renderRetirement(kid: string, keys: readonly ListedKey[], stdout: WriteText): void {
  const published = keys.filter((key) => !key.retired);
  stdout(`retired ${kid}\n`);
  stdout(
    `${published.length} key(s) are published; every token ${kid} signed is refused from now ` +
      "on, and whoever held one signs in again.\n",
  );
  if (published.length === 1) {
    stdout(
      "It was the last key still verifying, so every token issued before the rotation that " +
        "made the signing key is refused too.\n",
    );
  }
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

/**
 * Take a key out of the JWKS, refusing every token it signed.
 *
 * Off the disk, which is where a server nobody can sign in to has to be
 * repaired from — including a server left that way by this very command, since
 * retiring the key that signed an operator's token refuses that token too.
 * Returns the process exit code.
 */
export async function keyRetire(
  options: KeyRetireOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const keys = await KeyStore.open(layout.keysDir);
    await keys.retire(options.kid);
    renderRetirement(options.kid, rowsOf(keys), stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * The same, on a running server, over a session.
 *
 * The session this call travels on may be one of the ones it ends: an operator
 * whose own token was signed by the key being retired is refused on whatever it
 * asks next. The answer to this call is composed before any of that, so the
 * command still prints what it did — and the next one against that server says
 * to log in again, which is the truth.
 */
export async function keyRetireOverProtocol(
  options: KeyRetireOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const keys = await withSession(options.server, async (session) =>
      readKeys(
        TEAM_METHODS.adminKeysRetire,
        await session.call(TEAM_METHODS.adminKeysRetire, { kid: options.kid }),
      ),
    );
    renderRetirement(options.kid, keys, stdout);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
