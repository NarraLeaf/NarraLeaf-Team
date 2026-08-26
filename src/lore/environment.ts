/**
 * The two environment variables the version control library reads, decided
 * once, before anything asks it for anything.
 *
 * Both are process-wide and both are read by native code Team does not
 * control, so neither can be decided lazily by whichever code path happens to
 * reach Lore first. They are settled here, from one function, called once by
 * whichever command reads a repository, and nothing below this layer touches
 * `process.env` again.
 *
 * ## The credential store, and why Team needs one of its own
 *
 * Lore keeps the sessions a client has signed in with in **one store per
 * machine and per user** — on Windows `%LOCALAPPDATA%\Epic Games\lore\`, and
 * the equivalent elsewhere. Every Lore client that account runs shares it: a
 * Studio installation, the `lore` command, and Team.
 *
 * That store would be merely untidy if a session were looked up by the server
 * it belongs to. It is not. Measured against lorelib 0.8.6, the client selects
 * a session **by the host of the remote it is dialling** and says so:
 *
 *     [lore_transport::auth::exchange] Selected identity 6ef48853-…,
 *                                      authenticated for 127.0.0.1
 *
 * — where `6ef48853-…` was an account of an entirely different Team server that
 * had run on that machine earlier, and the caller had just signed in as
 * somebody else. It is not the port, not the auth endpoint, and not the
 * identity in the call's own globals: those were all set to this server, and
 * the stale session was chosen anyway.
 *
 * What follows is not a permission failure and does not read like one.
 * `loreserver` cannot find a signing key for a token this Team server never
 * issued, refuses the lookup with `Not allowed (KeyNotFound(NotFound))`, and
 * the client reports **"Not authorized to access repository"** — before Team is
 * asked whether the caller may have it, which is why a server whose every read
 * fails this way has nothing at all in its authorization log.
 *
 * On a machine that has run one Team server this never happens. On the machine
 * of anybody who has run two — a second port, a fresh storage root, a test
 * server beside the real one — every read fails, for ever, and the sentence
 * blames the operator's permissions.
 *
 * So Team is given a store of its own under the storage root. It holds exactly
 * one identity, the one Team just signed in as, so there is nothing else to
 * select. It also stops Team writing into the store an operator's own Studio is
 * using, which it had no business being in.
 *
 * ## The trust anchor
 *
 * A `loreserver` told to demand a token sends its clients to Team's https
 * endpoint to exchange one, and Team is one of those clients. Lore's TLS is
 * rustls, which verifies that endpoint against `rustls-native-certs` — and a
 * Team server's authority is one it generated for itself, which no store on
 * earth holds. Without this the exchange fails with "failed to connect to auth
 * endpoint: transport error" and every clone that follows is refused.
 *
 * `SSL_CERT_FILE` is the channel because it is the one `rustls-native-certs`
 * offers, and it is what `up` already hands `loreserver` for the same reason.
 * It replaces the trust store rather than adding to it, which is right here:
 * everything this library talks to is this Team server. Node's own outbound TLS
 * — the release downloads — does not read it.
 *
 * An operator who set either variable themselves is left alone, in both cases.
 * Somebody who has pointed Lore at a shared credential store or a trust bundle
 * of their own has a reason, and Team quietly replacing it would be the same
 * class of surprise this file exists to remove.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { tlsLayout } from "../tls/authority.js";

/** What rustls-native-certs reads instead of the platform's own trust store. */
export const TRUST_ANCHOR_VARIABLE = "SSL_CERT_FILE";

/**
 * The directory Lore keeps its sessions in.
 *
 * Measured: given this, lorelib writes `tokens.toml` and `tokens.toml.lock`
 * into it and reads nothing from the machine-wide store. `LORE_AUTH_STORE`,
 * which reads like the same thing, was given a directory and had no effect.
 */
export const CREDENTIALS_VARIABLE = "LORE_AUTH_PATH";

/** Where one storage root keeps the sessions Team has signed in with. */
export function credentialsDir(root: string): string {
  return join(resolve(root), "credentials");
}

/** What was decided, for a caller that says what it did. */
export interface LoreEnvironment {
  /** The trust anchor Team set, or undefined where it left one alone. */
  readonly trustAnchor: string | undefined;
  /** The credential store Team set, or undefined where it left one alone. */
  readonly credentials: string | undefined;
  /**
   * Why the trust anchor could not be set, or undefined if it was.
   *
   * One case: a storage root `up` has never run against has no authority to
   * point at. It is worth a sentence rather than an exception — the interface
   * opens on such a root on purpose — and the next `up` settles it.
   */
  readonly withoutAuthority: string | undefined;
}

/**
 * Settle both variables for this process.
 *
 * Idempotent, and safe to call from more than one command: a value already in
 * the environment — Team's own from an earlier call, or an operator's — is
 * kept.
 */
export function prepareLoreEnvironment(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): LoreEnvironment {
  return {
    ...trust(root, env),
    credentials: store(root, env),
  };
}

function named(env: NodeJS.ProcessEnv, variable: string): boolean {
  const value = env[variable];
  return value !== undefined && value !== "";
}

function trust(
  root: string,
  env: NodeJS.ProcessEnv,
): Pick<LoreEnvironment, "trustAnchor" | "withoutAuthority"> {
  if (named(env, TRUST_ANCHOR_VARIABLE)) {
    return { trustAnchor: undefined, withoutAuthority: undefined };
  }
  const { caCertPath, tlsDir } = tlsLayout(root);
  // Checked rather than assumed: rustls reads the file on every connection, so
  // naming one that is not there is not an error now — it is a handshake that
  // fails much later with a sentence about permissions. The whole point of
  // this file is that such a failure is never silent again.
  if (!existsSync(caCertPath)) {
    return {
      trustAnchor: undefined,
      withoutAuthority:
        `this server has no certificate authority in ${tlsDir} yet, so its own ` +
        "repositories cannot be read until up has run once against this root",
    };
  }
  env[TRUST_ANCHOR_VARIABLE] = caCertPath;
  return { trustAnchor: caCertPath, withoutAuthority: undefined };
}

function store(root: string, env: NodeJS.ProcessEnv): string | undefined {
  if (named(env, CREDENTIALS_VARIABLE)) {
    return undefined;
  }
  const directory = credentialsDir(root);
  // 0700, for the reason the keys directory is: what lands in here is a live
  // session on every repository this server holds.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  env[CREDENTIALS_VARIABLE] = directory;
  return directory;
}
