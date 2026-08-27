/**
 * Deciding which certificate authority this program is prepared to believe.
 *
 * A Team server's certificate chains to an authority it generated for itself on
 * first start. There is nothing in any public trust store to check it against
 * and there never will be, so the question "is this the machine I mean?" has to
 * be answered once, deliberately, by a person — and then never again.
 *
 * Studio answers it by keeping the certificates it has been shown beside its own
 * data and passing them as `ca:` with `rejectUnauthorized: true`. This does the
 * same thing with the same bytes. What is here is the first half: taking the
 * authority off the chain a server presents, and deciding whether it is the one
 * that was expected.
 *
 * **The probe sends nothing.** It opens a TLS connection with verification off,
 * reads the chain, and closes without a byte of application data crossing it —
 * because at that instant there is nothing to verify against, so anything sent
 * would be sent to whoever answered. The password, the token and every request
 * after them travel on a second connection, made afterwards, with the authority
 * this settled on as `ca:` and `rejectUnauthorized: true`.
 *
 * Two ways the answer can be known in advance, and they are not the same:
 *
 *  - A fingerprint given on the command line. That is a deployment being told
 *    what to trust, and it trusts nothing else — no first use, no prompt, no
 *    receipt beyond the sign-in itself.
 *  - A fingerprint already stored from a previous sign-in. A server presenting a
 *    different one is refused loudly, naming both, because a reissued authority
 *    and somebody else answering look exactly alike from here.
 */
import { connect, type PeerCertificate, type DetailedPeerCertificate } from "node:tls";

import { fingerprintOf, toPem } from "../tls/x509.js";
import { hostAndPortOf } from "./config.js";

/** How long the probe waits for a handshake before saying the server is not answering. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** The authority at the top of the chain a server presented. */
export interface PresentedAuthority {
  /** SHA-256 over its DER, colon-separated upper-case hex — what `nlteam trust` prints. */
  readonly sha256: string;
  /** The certificate itself, which every connection after this is verified against. */
  readonly pem: string;
  /** Who it says it is, for a line a person reads rather than for a decision. */
  readonly subject: string;
}

/** Raised when a server presents an authority other than the one already trusted. */
export class AuthorityChangedError extends Error {
  constructor(address: string, trusted: string, presented: string) {
    super(
      `${address} presented a different certificate authority from the one this account ` +
        `already trusts.\n` +
        `  trusted    ${trusted}\n` +
        `  presented  ${presented}\n` +
        "That is either an authority the operator reissued or somebody else answering at " +
        "that address, and nothing here can tell which. If it was reissued, compare the " +
        `fingerprint above against nlteam trust run on the server itself, then run ` +
        `nlteam logout ${address} and sign in again.`,
    );
    this.name = "AuthorityChangedError";
  }
}

/** Raised when what was presented is not the fingerprint the command line named. */
export class FingerprintMismatchError extends Error {
  constructor(address: string, expected: string, presented: string) {
    super(
      `${address} presented a certificate authority that is not the one --fingerprint ` +
        "named.\n" +
        `  expected   ${displayFingerprint(expected)}\n` +
        `  presented  ${displayFingerprint(presented)}\n` +
        "Nothing was sent to it.",
    );
    this.name = "FingerprintMismatchError";
  }
}

/**
 * A fingerprint as this program compares them, from however it was written.
 *
 * Colons are what `nlteam trust` prints and what a person pastes; the same
 * digest with them stripped is what a script that has been through `sha256sum`
 * holds. Both are the same fingerprint, and refusing one of them would be
 * refusing whichever half of the audience wrote it the other way.
 */
export function normaliseFingerprint(text: string): string {
  const bare = text.trim().replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(bare)) {
    throw new Error(
      `${JSON.stringify(text)} is not a SHA-256 fingerprint. One is sixty-four hexadecimal ` +
        "digits, with or without the colons nlteam trust prints between them.",
    );
  }
  return bare;
}

/** Whether two fingerprints name the same certificate, however each was written. */
export function sameFingerprint(one: string, other: string): boolean {
  return normaliseFingerprint(one) === normaliseFingerprint(other);
}

/**
 * One fingerprint in the form a person compares, whichever form it arrived in.
 *
 * Two fingerprints shown side by side have to be shown the same way, or the
 * difference a reader is being asked to spot is buried under a difference in
 * punctuation.
 */
export function displayFingerprint(text: string): string {
  try {
    return normaliseFingerprint(text).replace(/..(?!$)/g, "$&:");
  } catch {
    // Whatever it was, said as it was given. A refusal must be printable even
    // where the thing it is refusing is not a fingerprint at all.
    return text;
  }
}

/**
 * The certificate at the top of a presented chain.
 *
 * Node links a chain through `issuerCertificate` and points the last one at
 * itself, so the walk ends where a certificate is its own issuer. A chain that
 * loops or runs out is not something to follow forever: the bound is small
 * because a Team server presents exactly two certificates.
 */
function topOfChain(peer: DetailedPeerCertificate): PeerCertificate {
  let certificate: DetailedPeerCertificate = peer;
  for (let depth = 0; depth < 8; depth += 1) {
    const issuer: DetailedPeerCertificate | undefined = certificate.issuerCertificate;
    if (issuer === undefined || issuer === null || issuer === certificate) {
      return certificate;
    }
    if (issuer.raw?.equals(certificate.raw) === true) {
      return certificate;
    }
    certificate = issuer;
  }
  return certificate;
}

/**
 * Open a TLS connection, take the authority off the chain, and close.
 *
 * Verification is off here and only here, and nothing is written to the socket
 * while it is: see the note at the top of this file. What comes back is a
 * fingerprint to compare and a certificate to verify everything else against.
 */
export function presentedAuthority(
  address: string,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<PresentedAuthority> {
  const { host, port } = hostAndPortOf(address);
  return new Promise((settle, fail) => {
    const socket = connect({
      host,
      port,
      // Off deliberately. There is nothing to verify against yet — that is the
      // whole reason this connection exists — so it carries no application data.
      rejectUnauthorized: false,
      // The same protocol the discovery document and the socket upgrade are
      // served over, so this is the listener that answers rather than another.
      ALPNProtocols: ["http/1.1"],
      // An IP address is not a name to send, and a server that keys on SNI would
      // rightly have nothing to answer with.
      ...(host === "" || /^[\d.]+$/.test(host) || host.includes(":") ? {} : { servername: host }),
    });

    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`${address} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    timer.unref?.();

    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
    };

    socket.once("error", (error: Error) => {
      done();
      fail(new Error(`${address} could not be reached: ${error.message}`));
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      const authority = peer.raw === undefined ? undefined : topOfChain(peer);
      done();
      if (authority?.raw === undefined) {
        fail(new Error(`${address} presented no certificate at all`));
        return;
      }
      const der = Buffer.from(authority.raw);
      settle({
        sha256: fingerprintOf(der),
        pem: toPem(der, "CERTIFICATE"),
        subject: authority.subject === undefined ? "" : describeSubject(authority.subject),
      });
    });
  });
}

/** A subject as one line, however node handed it over. */
function describeSubject(subject: PeerCertificate["subject"]): string {
  if (typeof subject === "string") {
    return subject;
  }
  return Object.entries(subject)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(", ");
}
