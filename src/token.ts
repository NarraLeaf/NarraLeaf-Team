/**
 * The `token mint` command: sign a token for somebody who has proved who they
 * are.
 *
 * The password is checked first, through the same path a sign-in would take,
 * rather than the command minting for any name it is given. Whoever runs this
 * already has the storage root and could sign anything they liked with the key
 * in it, so this is not a barrier — it is the only exercise the sign-in path
 * gets until there is an endpoint in front of it, and a command that skipped it
 * would let that path rot unnoticed.
 *
 * The token goes to standard output on its own, so a script can capture it. The
 * description of what was minted goes to standard error, where it does not end
 * up inside an Authorization header.
 *
 * This is the only mint that writes the authority's fingerprint into the token,
 * and the reason is where the token goes next: out of this machine, to somebody
 * whose computer has never heard of this Team server. Carrying the fingerprint means
 * the person pasting it is not also asked to obtain one, compare it by eye, and
 * run a command against a file that only exists on the server.
 */
import type { WriteText } from "./cli.js";
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

    stdout(`${minted.token}\n`);
    stderr(`header ${JSON.stringify(minted.header, null, 2)}\n`);
    stderr(`claims ${JSON.stringify(minted.claims, null, 2)}\n`);
    stderr(`expires ${new Date(minted.claims.exp * 1000).toISOString()}\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
