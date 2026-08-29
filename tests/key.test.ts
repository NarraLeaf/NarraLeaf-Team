/**
 * What an operator sees when they look at, add to, or end the life of a signing
 * key.
 *
 * `KeyStore` itself is covered in ./keys.test.ts, and thoroughly. What was not
 * covered at all is this layer: the sentences a person reads on their terminal
 * and the exit code their shell sees. Those are the whole of what the command
 * is, and retiring a key is the one action here that refuses every token
 * somebody is holding - so what it says about that, and whether it says it
 * every time, is not a detail.
 *
 * The `--root` path only. The `--server` path prints the same sentences from
 * the same functions, over `admin.keys.*`, and the session those need is stood
 * up in ./team.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { WriteText } from "../src/cli.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { keyList, keyRetire, keyRotate } from "../src/key.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-key-");

/** Run one command against a storage root, collecting both streams. */
async function invoke(
  command: (
    options: { readonly root: string; readonly kid: string },
    stdout: WriteText,
    stderr: WriteText,
  ) => Promise<number>,
  root: string,
  kid = "",
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await command(
    { root, kid },
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

/** The kid of the key a fresh root generated. */
async function firstKid(root: string): Promise<string> {
  const keys = await KeyStore.open(identityLayout(root).keysDir);
  return keys.signingKey.kid;
}

describe("nlteam key list", () => {
  it("makes the first key rather than reporting that there is none", async () => {
    // A server with no signing key cannot mint a token, so there is no useful
    // state in which this prints nothing.
    const root = await temporaryRoot();

    const { code, out, err } = await invoke(keyList, root);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toMatch(/^signing {4}\S+\n$/);
  });

  it("says which of three things each key is", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);
    await invoke(keyRotate, root);

    const { out } = await invoke(keyList, root);

    // The one that used to sign goes on verifying the tokens it signed. That is
    // the whole difference between rotating and retiring.
    expect(out).toContain(`verifying  ${first}`);
    expect(out.split("\n").filter((line) => line.startsWith("signing"))).toHaveLength(1);
  });
});

describe("nlteam key rotate", () => {
  it("names the key that signs from now on, and says nothing was invalidated", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);

    const { code, out, err } = await invoke(keyRotate, root);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("signing with ");
    expect(out).not.toContain(`signing with ${first}`);
    // The sentence that stops somebody rotating in a panic and then wondering
    // why nobody was signed out.
    expect(out).toContain("2 key(s) are published");
    expect(out).toContain("still verify");
  });
});

describe("nlteam key retire", () => {
  it("says what it cost, without having asked whether it was meant", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);
    await invoke(keyRotate, root);

    const { code, out, err } = await invoke(keyRetire, root, first);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(`retired ${first}`);
    // The cost, every time: this is the one verb that refuses tokens already
    // issued, and it takes a kid copied off a list, so nobody reaches it by
    // accident and a confirmation would only train somebody to answer it.
    expect(out).toContain(`every token ${first} signed is refused from now on`);
    expect(out).toContain("signs in again");
  });

  it("says so when the retired key was the last one still verifying", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);
    await invoke(keyRotate, root);

    const { out } = await invoke(keyRetire, root, first);

    // "every token issued before the latest rotation" is a larger sentence than
    // "1 key(s) are published" looks like, so it is said in words.
    expect(out).toContain("1 key(s) are published");
    expect(out).toContain("It was the last key still verifying");
  });

  it("does not say that while another key is still verifying", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);
    await invoke(keyRotate, root);
    await invoke(keyRotate, root);

    const { out } = await invoke(keyRetire, root, first);

    expect(out).toContain("2 key(s) are published");
    expect(out).not.toContain("last key still verifying");
  });

  it("refuses the key that is signing, and names what has to happen first", async () => {
    const root = await temporaryRoot();
    const signing = await firstKid(root);

    const { code, out, err } = await invoke(keyRetire, root, signing);

    // Retiring what signs would refuse the tokens just issued and leave nothing
    // able to sign their replacements.
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("nlteam: ");
    expect(err).toContain("Rotate first, then retire this key.");
  });

  it("says it has no such key rather than reporting a retirement that did not happen", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke(keyRetire, root, "not-a-kid-this-server-has");

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("not-a-kid-this-server-has");
  });

  it("leaves the retired key in the list, as retired", async () => {
    const root = await temporaryRoot();
    const first = await firstKid(root);
    await invoke(keyRotate, root);
    await invoke(keyRetire, root, first);

    const { out } = await invoke(keyList, root);

    // The file is kept: a key that is gone from the JWKS and gone from the disk
    // is a key nobody can explain a refusal with afterwards.
    expect(out).toContain(`retired    ${first}`);
  });
});
