/**
 * The certificates the Lore clients on a Team server's own machine trust:
 * loreserver while Team runs it, and Team's own reader of its repositories.
 *
 * Both connect to the address clients sign in at (see `callbackUrl` in
 * src/identity/config.ts), and are shown whichever certificate that name gets:
 * Team's own, or — where an operator supplied one with `--tls-cert` and it
 * covers the name — that one. Their TLS client reads `SSL_CERT_FILE` instead of
 * the platform's store, so the file has to hold an anchor for both.
 *
 * Team's authority always. With a supplied certificate, every certificate in
 * the file the operator gave as well: a `fullchain.pem` carries the issuing
 * intermediate, which verifies the chain as an anchor without the public roots
 * being restored, and a file holding the leaf alone is still pinned exactly.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the bundle is written when there is more than Team's authority to trust. */
export const LORESERVER_TRUST_FILE = "loreserver-trust.pem";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every certificate block in a PEM text, in order. */
export function certificateBlocks(pem: string): string[] {
  return pem.match(PEM_BLOCK) ?? [];
}

/** The text of the bundle: Team's authority, then each supplied certificate, once each. */
export function trustBundle(authorityPem: string, suppliedPem?: string): string {
  const blocks = [...certificateBlocks(authorityPem), ...certificateBlocks(suppliedPem ?? "")];
  return `${[...new Set(blocks)].join("\n")}\n`;
}

/**
 * The file to name in loreserver's `SSL_CERT_FILE`.
 *
 * With nothing supplied that is Team's authority file as it stands, so nothing
 * is written. Otherwise the bundle is written beside it, on every start, so a
 * renewed certificate is picked up by the restart that serves it.
 */
export async function loreserverTrustFile(
  tlsDir: string,
  authorityPath: string,
  authorityPem: string,
  suppliedPem: string | undefined,
): Promise<string> {
  if (suppliedPem === undefined) {
    return authorityPath;
  }
  const path = join(tlsDir, LORESERVER_TRUST_FILE);
  await writeFile(path, trustBundle(authorityPem, suppliedPem), { mode: 0o644 });
  return path;
}
