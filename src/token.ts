/**
 * The `token mint` command: sign a token for somebody who has proved who they
 * are.
 *
 * **This is the one command whose two paths ask for different things, and the
 * difference is the point of the second one.** Given `--root`, the password is
 * checked first, through the same path a sign-in would take, rather than the
 * command minting for any name it is given. Whoever runs that already has the
 * storage root and could sign anything they liked with the key in it, so it is
 * not a barrier — it is the only exercise the sign-in path gets until there is
 * an endpoint in front of it, and a command that skipped it would let that path
 * rot unnoticed. It is also, locally, the only way the operator has of showing
 * the account is theirs to mint for.
 *
 * Given `--server`, no password is read at all. The caller has already proved
 * who they are by holding an operator's session, and closing that gap is the
 * whole of what `admin.tokens.mint` is for: an operator mints a token for
 * somebody whose password they do not know and have no business knowing. A
 * command that demanded one here would be demanding something the operator may
 * not have, in order to check something already checked.
 *
 * The token goes to standard output on its own, so a script can capture it. The
 * description of what was minted goes to standard error, where it does not end
 * up inside an Authorization header.
 *
 * The local mint is the only one that writes the authority's fingerprint into
 * the token, and the reason is where the token goes next: out of this machine,
 * to somebody whose computer has never heard of this Team server. Carrying the
 * fingerprint means the person pasting it is not also asked to obtain one,
 * compare it by eye, and run a command against a file that only exists on the
 * server. The server's own mint writes it too, from the authority it is serving.
 */
import { TEAM_METHODS } from "@narraleaf/team-protocol";

import type { WriteText } from "./cli.js";
import { readMintedToken } from "./client/answers.js";
import { withSession } from "./client/server.js";
import { identityConfig, type IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import { storedIdentity, storedTokenLifetimes } from "./identity/settings.js";
import { mintToken } from "./identity/tokens.js";
import { authenticate, SIGN_IN_REFUSED_MESSAGE } from "./identity/users.js";
import { readPassword } from "./stdin.js";
import { readAuthority } from "./tls/authority.js";

export interface TokenMintOptions {
  readonly root: string;
  readonly username: string;
  readonly overrides: Partial<IdentityConfig>;
}

export interface TokenMintOnServerOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
  readonly username: string;
}

/**
 * The token, and what a person needs to know about it, written once for both paths.
 *
 * `describe` is the header and the claims, and it is present only where this
 * program minted the token itself. `admin.tokens.mint` answers with a
 * credential, an account and an expiry, and says nothing about which key signed
 * it or what it claims — so those lines are left out rather than worked out from
 * the token. A client that took a credential apart in order to describe it would
 * be printing its own reading of the bytes, which is not the same fact as what
 * the server did with them.
 */
function renderMintedToken(
  minted: { readonly token: string; readonly expiresAt: number },
  describe: readonly string[],
  stdout: WriteText,
  stderr: WriteText,
): void {
  stdout(`${minted.token}\n`);
  for (const line of describe) {
    stderr(line);
  }
  stderr(`expires ${new Date(minted.expiresAt).toISOString()}\n`);
}

/** Mint one token. Returns the process exit code. */
export async function tokenMint(
  options: TokenMintOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);

  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const database = await openMigratedDatabase(layout.databasePath);
  try {
    // Defaults, then what this server was brought up as and has stored, then
    // what the command line or the environment named. That order is what makes a
    // token minted here name the same audience the running server does — the
    // stored identity is where the host names and the ports come from — while a
    // flag still overrides it for the run.
    const config = identityConfig({
      ...storedIdentity(database),
      ...storedTokenLifetimes(database),
      ...options.overrides,
    });
    const result = await authenticate(
      database,
      defaultPasswordHasher(),
      options.username,
      password,
    );
    if (result.kind === "refused") {
      // One sentence for every way it can fail. The reason is in the result
      // for a caller that logs it; the person at the keyboard is told nothing
      // they could use to find out which accounts exist.
      stderr(`nlteam: ${SIGN_IN_REFUSED_MESSAGE}\n`);
      return 1;
    }

    const keys = await KeyStore.open(layout.keysDir);
    // A Team server that has never been brought up has no authority to name. That is
    // not a reason to refuse a token: the claim is a convenience for whoever
    // pastes it, not something the token is invalid without, and the sign-in
    // it is for would fail on a certificate long before the claim mattered.
    const authority = await readAuthority(options.root).catch(() => undefined);
    const minted = mintToken(
      result.user,
      keys.signingKey,
      config,
      authority === undefined ? {} : { authorityFingerprint: authority.fingerprint256 },
    );

    renderMintedToken(
      // Milliseconds, as every moment this program prints is; a token's own
      // `exp` is seconds, because that is what a JWT says.
      { token: minted.token, expiresAt: minted.claims.exp * 1000 },
      [
        `header ${JSON.stringify(minted.header, null, 2)}\n`,
        `claims ${JSON.stringify(minted.claims, null, 2)}\n`,
      ],
      stdout,
      stderr,
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Mint a token on a server this account administers. Returns the exit code.
 *
 * Nothing is read from standard input; see the note at the top of this file for
 * why that is the difference rather than an omission. The token this prints is
 * the same credential the other path prints, minted by the same function on the
 * far side and signed by the key that server is actually publishing.
 */
export async function tokenMintOverProtocol(
  options: TokenMintOnServerOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  try {
    const answer = await withSession(
      options.server,
      async (session) =>
        await session.call(TEAM_METHODS.adminTokensMint, { username: options.username }),
    );
    const minted = readMintedToken(answer);
    if (minted.token === undefined) {
      // A mint answers without a token in exactly one case: it is a repeat of
      // one already made under the same client id, and the server kept nothing
      // of what it produced the first time. This command sends no client id —
      // see src/client/admin.ts — so nothing here can have asked for a repeat,
      // and printing an expiry with no credential would look like success.
      throw new Error(
        `that server answered ${TEAM_METHODS.adminTokensMint} with no token, which is what it ` +
          "answers a mint that has already happened. Nothing here asked for one.",
      );
    }
    renderMintedToken({ token: minted.token, expiresAt: minted.expiresAt }, [], stdout, stderr);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
