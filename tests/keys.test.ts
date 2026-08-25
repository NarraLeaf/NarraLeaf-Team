import { readdir, stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { identityLayout } from "../src/identity/layout.js";
import { jwkThumbprint, KeyStore, MODULUS_LENGTH } from "../src/identity/keys.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-keys-");

async function store(): Promise<KeyStore> {
  return await KeyStore.open(identityLayout(await temporaryRoot()).keysDir);
}

describe("KeyStore", () => {
  it("generates a key the first time, because a Team server without one cannot work", async () => {
    const keys = await store();

    expect(keys.all).toHaveLength(1);
    expect(keys.signingKey.privateKey.asymmetricKeyType).toBe("rsa");
    expect(keys.signingKey.privateKey.asymmetricKeyDetails?.modulusLength).toBe(MODULUS_LENGTH);
  });

  it("names each key by the thumbprint of its own public half", async () => {
    const keys = await store();
    const { kid, n, e } = keys.signingKey.publicJwk;

    // RFC 7638: the kid is derived, so it never has to be stored and two keys
    // cannot be given one name by accident.
    expect(kid).toBe(jwkThumbprint(n, e));
    expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("publishes each key the way a verifier expects to read it", async () => {
    const keys = await store();
    const [published] = keys.jwks().keys;

    expect(published).toEqual({
      kty: "RSA",
      n: expect.any(String),
      e: expect.any(String),
      kid: keys.signingKey.kid,
      alg: "RS256",
      use: "sig",
    });
  });

  it("signs with the newest key and publishes them all", async () => {
    const keys = await store();
    const first = keys.signingKey;

    const second = await keys.rotate();

    expect(second.kid).not.toBe(first.kid);
    expect(keys.signingKey.kid).toBe(second.kid);
    expect(keys.jwks().keys.map((key) => key.kid)).toEqual([second.kid, first.kid]);
  });

  it("stops publishing a retired key, and keeps its file", async () => {
    const keys = await store();
    const first = keys.signingKey;
    const second = await keys.rotate();

    await keys.retire(first.kid);

    expect(keys.jwks().keys.map((key) => key.kid)).toEqual([second.kid]);
    expect(keys.all.map((key) => key.kid)).toEqual([second.kid, first.kid]);
    expect(keys.signingKey.kid).toBe(second.kid);
  });

  it("finds the same keys again when it is reopened", async () => {
    const root = await temporaryRoot();
    const keysDir = identityLayout(root).keysDir;
    const first = await KeyStore.open(keysDir);
    await first.rotate();
    const expected = first.all.map((key) => key.kid);

    const second = await KeyStore.open(keysDir);

    expect(second.all.map((key) => key.kid)).toEqual(expected);
    // Nothing was generated on the way: reopening an existing directory is not
    // a rotation.
    expect(second.all).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "writes the private keys so that only their owner can read them",
    async () => {
      const root = await temporaryRoot();
      const keysDir = identityLayout(root).keysDir;
      const keys = await KeyStore.open(keysDir);

      for (const name of await readdir(keysDir)) {
        expect((await stat(`${keysDir}/${name}`)).mode & 0o777).toBe(0o600);
      }
      expect(keys.all).toHaveLength(1);
    },
  );
});

describe("KeyStore.reload", () => {
  it("picks up a key another process added, and generates nothing", async () => {
    const root = await temporaryRoot();
    const keysDir = identityLayout(root).keysDir;
    const serving = await KeyStore.open(keysDir);
    const rotating = await KeyStore.open(keysDir);

    // Two handles on one directory is the ordinary case: `up` is serving the
    // JWKS while `nlteam key rotate` runs in another terminal.
    const added = await rotating.rotate();
    expect(serving.jwks().keys).toHaveLength(1);

    await serving.reload();

    expect(serving.jwks().keys.map((key) => key.kid)).toEqual([added.kid, rotating.all[1]?.kid]);
  });

  it("re-reads the directory once in an interval, however often it is asked", async () => {
    const keysDir = identityLayout(await temporaryRoot()).keysDir;
    const serving = await KeyStore.open(keysDir);
    const rotating = await KeyStore.open(keysDir);

    // A reload is a readdir and then, per key file, a read, a private key
    // parsed, a public half exported and a thumbprint taken — all on the four
    // threads libuv shares with every other file operation in the process. It
    // is reached from doors anybody may knock on, so what it costs has to be
    // what one caller can spend rather than what every caller can.
    await serving.reload();
    const added = await rotating.rotate();
    await serving.reload();

    // A reload that was skipped says what a reload finding nothing new says.
    expect(serving.find(added.kid)).toBeUndefined();
  });

  it("picks up a rotation once the interval has passed", async () => {
    const keysDir = identityLayout(await temporaryRoot()).keysDir;
    const serving = await KeyStore.open(keysDir);
    const rotating = await KeyStore.open(keysDir);
    await serving.reload();
    const added = await rotating.rotate();

    // Only the clock is faked; what this reads is a real directory. A minute is
    // well past any interval a rotation should have to wait out.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      await serving.reload();
    } finally {
      vi.useRealTimers();
    }

    expect(serving.find(added.kid)?.kid).toBe(added.kid);
  });
});
