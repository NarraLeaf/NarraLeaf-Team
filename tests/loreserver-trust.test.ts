import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LORESERVER_TRUST_FILE,
  certificateBlocks,
  loreserverTrustFile,
  trustBundle,
} from "../src/loreserver/trust.js";

const block = (body: string): string =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

const AUTHORITY = `${block("QVVUSE9SSVRZ")}\n`;
const LEAF = block("TEVBRg==");
const INTERMEDIATE = block("SU5URVJNRURJQVRF");

/**
 * loreserver reaches Team by the public name now, and is shown the operator's
 * certificate where one covers it, so what it trusts has to include that chain.
 */
describe("the certificates loreserver trusts", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads every certificate block in a chain, in order", () => {
    expect(certificateBlocks(`${LEAF}\n${INTERMEDIATE}\n`)).toEqual([LEAF, INTERMEDIATE]);
    expect(certificateBlocks("no certificates here")).toEqual([]);
  });

  it("holds Team's authority, then the supplied chain, each once", () => {
    const bundle = trustBundle(AUTHORITY, `${LEAF}\n${INTERMEDIATE}\n${LEAF}\n`);

    expect(certificateBlocks(bundle)).toEqual([block("QVVUSE9SSVRZ"), LEAF, INTERMEDIATE]);
  });

  it("names Team's authority file as it stands when nothing was supplied", async () => {
    dir = await mkdtemp(join(tmpdir(), "nlteam-trust-"));
    const authorityPath = join(dir, "ca.crt");

    await expect(loreserverTrustFile(dir, authorityPath, AUTHORITY, undefined)).resolves.toBe(authorityPath);
  });

  it("writes the bundle beside it when a certificate was supplied", async () => {
    dir = await mkdtemp(join(tmpdir(), "nlteam-trust-"));

    const path = await loreserverTrustFile(dir, join(dir, "ca.crt"), AUTHORITY, `${LEAF}\n${INTERMEDIATE}\n`);

    expect(path).toBe(join(dir, LORESERVER_TRUST_FILE));
    expect(certificateBlocks(await readFile(path, "utf8"))).toEqual([block("QVVUSE9SSVRZ"), LEAF, INTERMEDIATE]);
  });
});
