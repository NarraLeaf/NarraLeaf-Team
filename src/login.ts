/**
 * The `login` and `logout` commands: becoming a client of a server, and stopping.
 *
 * Until these existed, every administrative command opened a server's SQLite
 * database through `--root`, so a Team server could only be administered by
 * somebody logged into the machine it runs on. That is what this changes. What
 * it does not change is the division the two hosts of this system are built to:
 * Studio is the surface people use, and this is the surface programs and
 * emergencies use. `init`, `up` and `trust` stay exactly where they are, because
 * they are the commands that have to work when the protocol does not — and a
 * rescue that could only be performed over the thing being rescued would not be
 * one.
 *
 * What a sign-in settles, in order:
 *
 *  1. **Which machine this is.** A Team server's certificate chains to an
 *     authority it made for itself, so a fingerprint is compared once and the
 *     certificate is kept. Everything afterwards is `ca:` with
 *     `rejectUnauthorized: true` — the same thing Studio does with the same
 *     bytes.
 *  2. **What that machine is.** The discovery document turns an address into a
 *     server: what it calls itself, which version of the protocol it speaks, and
 *     what it serves. What it serves is read from that list rather than found out
 *     by asking and being refused.
 *  3. **Who is asking.** A username and a password, for a token — over the
 *     verified connection, never the one the fingerprint was read off.
 *
 * The password comes from standard input, the way `init`, `user create` and
 * `token mint` read one. An argument is visible to every process on the machine
 * through the process list and stays in the shell's history afterwards.
 */
import type { WriteText } from "./cli.js";
import {
  AuthorityChangedError,
  FingerprintMismatchError,
  normaliseFingerprint,
  presentedAuthority,
  sameFingerprint,
} from "./client/authority.js";
import {
  configDirectory,
  forgetServer,
  readCredentials,
  rememberServer,
} from "./client/config.js";
import { readDiscoveryDocument, signIn } from "./client/http.js";
import { ProtocolVersionError } from "./client/session.js";
import { readPassword } from "./stdin.js";
import { TEAM_PROTOCOL_VERSION } from "@narraleaf/team-protocol";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LoginOptions {
  /** The address, as src/client/config.ts writes one. */
  readonly server: string;
  readonly username: string;
  /**
   * The authority this deployment was told to expect, if it was told one.
   *
   * Present is an automated deployment being handed what to trust, and it
   * trusts nothing else. Absent is a person, who is shown what was pinned.
   */
  readonly fingerprint: string | undefined;
}

export interface LogoutOptions {
  readonly server: string;
}

/**
 * Sign in to a server and keep what it takes to reach it again.
 *
 * Returns the process exit code.
 */
export async function login(
  options: LoginOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  let expected: string | undefined;
  if (options.fingerprint !== undefined) {
    try {
      expected = normaliseFingerprint(options.fingerprint);
    } catch (error) {
      stderr(`nlteam: ${describeError(error)}\n`);
      return 2;
    }
  }

  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 2;
  }

  const directory = configDirectory();
  try {
    // Nothing is sent over this. It exists to find out what to verify against,
    // and until that is settled there is nothing to send anything to.
    const authority = await presentedAuthority(options.server);

    if (expected !== undefined && !sameFingerprint(expected, authority.sha256)) {
      throw new FingerprintMismatchError(options.server, options.fingerprint ?? "", authority.sha256);
    }

    // Whether or not a fingerprint was named. An authority that has changed is a
    // decision somebody has to take deliberately — a reissue and an impostor are
    // the same thing from here — and taking it means logging out first.
    const known = (await readCredentials(directory)).get(options.server);
    if (known !== undefined && !sameFingerprint(known.authority.sha256, authority.sha256)) {
      throw new AuthorityChangedError(options.server, known.authority.sha256, authority.sha256);
    }

    // From here on, every connection is verified against what was just pinned.
    const document = await readDiscoveryDocument(options.server, authority.pem);
    if (document.protocol !== TEAM_PROTOCOL_VERSION) {
      throw new ProtocolVersionError(options.server, document.protocol);
    }
    if (!sameFingerprint(document.authority.sha256, authority.sha256)) {
      throw new Error(
        `${options.server} presented one certificate authority and named another in its ` +
          "discovery document, so something between here and it is not what it says it is.\n" +
          `  presented  ${authority.sha256}\n` +
          `  named      ${document.authority.sha256}`,
      );
    }
    // Read off the list rather than found out by being refused. A server that
    // does not serve a password sign-in has no route to post to, and calling one
    // to discover that would report a missing address as a bad password.
    if (!document.capabilities.includes("password-sign-in")) {
      throw new Error(
        `${options.server} does not exchange a password for a token. Its operator mints ` +
          "tokens with nlteam token mint instead.",
      );
    }

    const signedIn = await signIn(options.server, authority.pem, options.username, password);
    await rememberServer(directory, {
      address: options.server,
      token: signedIn.token,
      account: signedIn.username,
      authority: { sha256: authority.sha256, pem: authority.pem },
      signedInAt: Date.now(),
    });

    stdout(`signed in to ${document.name} at ${options.server} as ${signedIn.username}\n`);
    if (expected !== undefined) {
      // The deployment was told what to trust and it was that. There is no
      // decision left for anybody to check, so there is nothing more to say.
      return 0;
    }
    // Trusting what was presented, because nothing said otherwise, is a
    // decision. It leaves a receipt rather than happening quietly.
    stdout("pinned the certificate authority it presented:\n");
    if (authority.subject !== "") {
      stdout(`  ${authority.subject}\n`);
    }
    stdout(`  SHA-256  ${authority.sha256}\n`);
    stdout(
      "Check that against nlteam trust run on the server itself, over something other\n" +
        "than the connection it just arrived over.\n",
    );
    stdout(`Credentials for this account are kept in ${directory}\n`);
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Forget one server. Returns the process exit code. */
export async function logout(
  options: LogoutOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const directory = configDirectory();
  try {
    const forgotten = await forgetServer(directory, options.server);
    if (!forgotten) {
      // Not an error. Logging out of something that was never logged in to is a
      // command that has already achieved what it asked for.
      stdout(`this account was not signed in to ${options.server}, so nothing was changed.\n`);
      return 0;
    }
    stdout(`forgot the token and the certificate authority for ${options.server}.\n`);
    stdout("The server was not told, and the token remains valid until it expires.\n");
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}
