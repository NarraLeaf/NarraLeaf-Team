/**
 * A certificate an operator already has, used instead of the one Team issues.
 *
 * Team is its own certificate authority because a Team server is usually
 * reached by a name no public authority will certify, and the trust step that
 * costs is the price of that. An operator who does have a certificate for the
 * name people use - from a public authority, or from one their organisation
 * already runs - should not be paying it: their collaborators' machines trust
 * that issuer already, and nobody has to compare a fingerprint or install
 * anything.
 *
 * **This does not replace Team's own authority, and cannot.** loreserver asks
 * Team who a caller is over the loopback, at `https://127.0.0.1`, and verifies
 * what it is shown against Team's certificate as its only anchor - see
 * `callbackUrl` in src/identity/config.ts for why that journey is local. No
 * public certificate names `127.0.0.1`, so presenting one to loreserver would
 * end every repository access with an unknown authority. So both are served:
 * the supplied certificate to a client that asks for a name it covers, and
 * Team's own to everything else, which is what the loopback gets because a
 * connection to an address sends no server name at all. src/grpc/server.ts is
 * where the choice is made, one connection at a time.
 *
 * What is checked here is what fails silently otherwise. A key that does not
 * belong to the certificate is not an error at startup; it is a handshake that
 * fails on somebody else's machine, reported as a certificate problem with no
 * mention of a key.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Raised when a supplied certificate cannot be used, saying which and why. */
export class SuppliedCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuppliedCertificateError";
  }
}

/** A certificate and key an operator gave, read and checked. */
export interface SuppliedCertificate {
  readonly certPath: string;
  readonly keyPath: string;
  /** The file as given, chain and all: what is presented on the wire. */
  readonly certPem: string;
  readonly keyPem: string;
  /** The first certificate in the file, which is the one that names the server. */
  readonly certificate: X509Certificate;
  /** The names it covers, for the line `up` prints. */
  readonly names: readonly string[];
  /** True when the moment given is past the certificate's expiry. */
  readonly expired: boolean;
}

/** The DNS names and addresses a certificate carries, as an operator would read them. */
function namesOf(certificate: X509Certificate): string[] {
  const alt = certificate.subjectAltName;
  if (alt === undefined) {
    return [];
  }
  return alt
    .split(", ")
    .map((entry) => entry.replace(/^DNS:/, "").replace(/^IP Address:/, ""))
    .filter((name) => name !== "");
}

async function slurp(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new SuppliedCertificateError(
      `${path} could not be read as ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read the pair, refusing anything that would fail later and elsewhere.
 *
 * `now` is the moment expiry is judged from, supplied by tests. An expired
 * certificate is reported rather than refused: the clock on a server is not
 * always right, an operator may be mid-renewal, and a server that will not
 * start is worse than one that says what is wrong with what it is serving.
 */
export async function readSuppliedCertificate(
  certPath: string,
  keyPath: string,
  now: Date = new Date(),
): Promise<SuppliedCertificate> {
  const certPem = await slurp(certPath, "a certificate");
  const keyPem = await slurp(keyPath, "a private key");

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
  } catch (error) {
    throw new SuppliedCertificateError(
      `${certPath} is not a certificate this can read: ${
        error instanceof Error ? error.message : String(error)
      }. It has to be PEM, and the server's own certificate has to come first if others follow it.`,
    );
  }

  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch (error) {
    throw new SuppliedCertificateError(
      `${keyPath} is not a private key this can read: ${
        error instanceof Error ? error.message : String(error)
      }. It has to be PEM, and it must not be one with a passphrase on it.`,
    );
  }

  // The check worth doing here rather than anywhere else. A mismatched pair
  // starts a server that cannot complete a single handshake, and what the other
  // machine reports is a certificate error that says nothing about a key.
  if (!certificate.checkPrivateKey(key)) {
    throw new SuppliedCertificateError(
      `${keyPath} is not the private key of the certificate in ${certPath}. ` +
        "Check that both came from the same issue rather than from two.",
    );
  }

  const notAfter = Date.parse(certificate.validTo);
  return {
    certPath,
    keyPath,
    certPem,
    keyPem,
    certificate,
    names: namesOf(certificate),
    expired: !Number.isNaN(notAfter) && notAfter < now.getTime(),
  };
}
