/**
 * The RSA keys Team signs tokens with, and the JWKS it publishes them as.
 *
 * RS256 is the algorithm, because it is the one loreserver 0.8.6 has been shown
 * to accept end to end. Nothing here is written to be algorithm-agnostic: a
 * signature scheme is not a preference, and a second one would arrive as a
 * second `alg` in the JWKS rather than as a setting.
 *
 * More than one key can exist at a time, which is what makes rotation possible
 * without a flag day. The newest key signs; every key that has not been retired
 * is published, so a token signed a minute before a rotation still verifies
 * against the JWKS a verifier fetches a minute after it.
 *
 * A key's `kid` is its RFC 7638 JWK thumbprint — a hash of the public key
 * itself. It is therefore not stored anywhere: it can be recomputed from the
 * key file, and two different keys cannot collide on one.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  type KeyObject,
} from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The modulus size of the keys Team generates. */
export const MODULUS_LENGTH = 2048;

/**
 * The shortest time between two re-reads of the keys directory.
 *
 * {@link KeyStore.reload} is reached from two doors anybody may knock on: the
 * JWKS document, which is served to whoever asks, and a token naming a `kid`
 * this process has not seen — and a `kid` is read out of a token's header
 * before its signature is, so a caller holding no credential at all can ask for
 * one. A re-read is a `readdir` and then, per key file, a read, a private key
 * parsed, a public half exported and a SHA-256 thumbprint taken, all on the
 * four threads libuv shares with every other file operation in the process.
 *
 * Five seconds is the whole of what that can cost. Long enough that a flood of
 * unknown `kid`s buys one scan rather than one scan each; short enough that a
 * `nlteam key rotate` in another terminal is picked up before the person who
 * ran it has finished typing the command that uses the new key.
 */
const RELOAD_INTERVAL_MS = 5000;

/** One public key, as a JWKS entry. */
export interface PublicJsonWebKey {
  readonly kty: "RSA";
  /** Modulus, base64url. */
  readonly n: string;
  /** Public exponent, base64url. */
  readonly e: string;
  readonly kid: string;
  readonly alg: "RS256";
  readonly use: "sig";
}

/** The document served at `/.well-known/jwks.json`. */
export interface JwksDocument {
  readonly keys: readonly PublicJsonWebKey[];
}

/** One key pair Team holds. */
export interface TeamKey {
  /** Position in the sequence of keys; the highest is the newest. */
  readonly serial: number;
  /** RFC 7638 thumbprint of the public key. */
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: PublicJsonWebKey;
  /** True for a key that is kept but no longer published or used. */
  readonly retired: boolean;
  /** The file the private key lives in. */
  readonly path: string;
}

/** Raised when a file in the keys directory is not a private key Team can use. */
export class UnusableKeyError extends Error {
  constructor(path: string, reason: string) {
    super(
      `${path} is not a usable signing key: ${reason}. Move it out of the keys directory; ` +
        "Team generates a new key when it finds none.",
    );
    this.name = "UnusableKeyError";
  }
}

/** Raised when every key Team holds has been retired, leaving nothing to sign with. */
export class NoSigningKeyError extends Error {
  constructor(readonly keysDir: string) {
    super(
      `every key in ${keysDir} is retired, so nothing can sign a token. ` +
        "Rotate to create a new one.",
    );
    this.name = "NoSigningKeyError";
  }
}

/** `<serial>.pem` is in use; `<serial>.retired.pem` is kept but not published. */
const ACTIVE_NAME = /^(\d{4})\.pem$/;
const RETIRED_NAME = /^(\d{4})\.retired\.pem$/;

function activeFileName(serial: number): string {
  return `${String(serial).padStart(4, "0")}.pem`;
}

function retiredFileName(serial: number): string {
  return `${String(serial).padStart(4, "0")}.retired.pem`;
}

/** Generate one RSA key pair. `generateKeyPair` has no promisified form here. */
function generateRsaKeyPair(): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    generateKeyPair("rsa", { modulusLength: MODULUS_LENGTH }, (error, publicKey, privateKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ publicKey, privateKey });
    });
  });
}

/** Base64url without padding, which is how JOSE writes every binary field. */
function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * The RFC 7638 thumbprint of an RSA public key.
 *
 * The rule is exact and worth stating, because a value computed any other way
 * would still look like a `kid` and would still be published: the SHA-256 of a
 * JSON object holding only the required members, in lexicographic order, with
 * no whitespace. For RSA that is `e`, `kty`, `n`.
 */
export function jwkThumbprint(n: string, e: string): string {
  const canonical = JSON.stringify({ e, kty: "RSA", n });
  return base64url(createHash("sha256").update(canonical, "utf8").digest());
}

/** Describe a public key the way a JWKS entry has to. */
function toPublicJwk(publicKey: KeyObject, path: string): PublicJsonWebKey {
  const jwk = publicKey.export({ format: "jwk" });
  const { n, e } = jwk;
  if (typeof n !== "string" || typeof e !== "string") {
    throw new UnusableKeyError(path, "it is not an RSA key");
  }
  return { kty: "RSA", n, e, kid: jwkThumbprint(n, e), alg: "RS256", use: "sig" };
}

async function readKey(keysDir: string, serial: number, retired: boolean): Promise<TeamKey> {
  const path = join(keysDir, retired ? retiredFileName(serial) : activeFileName(serial));
  const pem = await readFile(path, "utf8");

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new UnusableKeyError(path, error instanceof Error ? error.message : String(error));
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new UnusableKeyError(path, `it is a ${privateKey.asymmetricKeyType ?? "unknown"} key`);
  }

  const publicJwk = toPublicJwk(createPublicKey(privateKey), path);
  return { serial, kid: publicJwk.kid, privateKey, publicJwk, retired, path };
}

/**
 * The keys under one directory.
 *
 * Opening is the only way to get one, and opening an empty directory generates
 * the first key: a Team server with no key cannot do its job, and there is nothing an
 * operator would have to decide about it.
 */
export class KeyStore {
  readonly #keysDir: string;
  #keys: TeamKey[];
  /**
   * When the directory was last re-read, as a clock reading.
   *
   * Zero until something asks, so the first {@link KeyStore.reload} after
   * opening always looks: what was loaded at open may be minutes old by then.
   */
  #reloadedAt = 0;

  private constructor(keysDir: string, keys: TeamKey[]) {
    this.#keysDir = keysDir;
    this.#keys = keys;
  }

  /** Load every key under `keysDir`, generating one if there are none. */
  static async open(keysDir: string): Promise<KeyStore> {
    // 0700 keeps other accounts on the machine out of the directory holding
    // the private keys. Windows ignores the mode, and mkdir does not fail for
    // passing one there.
    await mkdir(keysDir, { recursive: true, mode: 0o700 });

    const store = new KeyStore(keysDir, await KeyStore.#load(keysDir));
    if (store.#keys.length === 0) {
      await store.rotate();
    }
    return store;
  }

  static async #load(keysDir: string): Promise<TeamKey[]> {
    const names = await readdir(keysDir);
    const keys: TeamKey[] = [];
    for (const name of names.sort()) {
      const active = ACTIVE_NAME.exec(name);
      if (active?.[1] !== undefined) {
        keys.push(await readKey(keysDir, Number(active[1]), false));
        continue;
      }
      const retired = RETIRED_NAME.exec(name);
      if (retired?.[1] !== undefined) {
        keys.push(await readKey(keysDir, Number(retired[1]), true));
      }
      // Anything else in the directory is left alone rather than reported: an
      // operator's backup copy beside the keys is not Team's business.
    }
    return keys.sort((left, right) => right.serial - left.serial);
  }

  /**
   * Re-read the directory.
   *
   * A rotation is a file appearing, and it is normal for it to appear from
   * another process — `nlteam key rotate` while `up` is running. Anything
   * serving the JWKS has to look again rather than answer from what was there
   * when it started, or it would publish everything except the key that is
   * currently signing.
   *
   * Nothing is generated here: an empty directory reloads as no keys, where
   * opening one would have made a key.
   *
   * At most one re-read every {@link RELOAD_INTERVAL_MS}. A caller inside that
   * window is answered without the directory being touched, which is what a
   * re-read that found nothing new would have done anyway — the store it is
   * asking about is left exactly as it was.
   */
  async reload(): Promise<void> {
    const now = Date.now();
    if (now - this.#reloadedAt < RELOAD_INTERVAL_MS) {
      return;
    }
    // Stamped before the read rather than after it, so that callers arriving
    // while this one is still reading are turned away rather than starting
    // scans of their own.
    this.#reloadedAt = now;
    this.#keys = await KeyStore.#load(this.#keysDir);
  }

  /** Every key Team holds, newest first, retired ones included. */
  get all(): readonly TeamKey[] {
    return this.#keys;
  }

  /** The keys that are published and may verify a token, newest first. */
  get published(): readonly TeamKey[] {
    return this.#keys.filter((key) => !key.retired);
  }

  /**
   * The key new tokens are signed with: the newest that is not retired.
   *
   * Signing with only the newest, while publishing all of them, is what makes
   * a rotation invisible to anyone holding a token — the old key keeps
   * verifying until it is retired.
   */
  get signingKey(): TeamKey {
    const key = this.published[0];
    if (key === undefined) {
      throw new NoSigningKeyError(this.#keysDir);
    }
    return key;
  }

  /** The JWKS document, exactly as it is served. */
  jwks(): JwksDocument {
    return { keys: this.published.map((key) => key.publicJwk) };
  }

  /** Find a key by its `kid`, published or not. */
  find(kid: string): TeamKey | undefined {
    return this.#keys.find((key) => key.kid === kid);
  }

  /**
   * Generate a key and make it the one that signs.
   *
   * The file is written with `wx`, so a serial that already exists is a failure
   * rather than a key silently replaced — losing a private key that has signed
   * tokens would invalidate every one of them at once.
   */
  async rotate(): Promise<TeamKey> {
    const { privateKey } = await generateRsaKeyPair();
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const serial = (this.#keys[0]?.serial ?? 0) + 1;
    const path = join(this.#keysDir, activeFileName(serial));

    // 0600: the file is the whole of Team's authority to issue tokens, and any
    // account that can read it can mint a token for anybody. Windows ignores
    // the mode — it has no such bits — which is a fact about that platform
    // rather than a reason to skip it elsewhere.
    await writeFile(path, pem, { mode: 0o600, flag: "wx" });

    const key = await readKey(this.#keysDir, serial, false);
    this.#keys = [key, ...this.#keys];
    return key;
  }

  /**
   * Stop publishing a key, keeping the file.
   *
   * Retiring is what ends a key's life, and it is separate from rotating on
   * purpose: tokens signed by it are still valid until they expire, so it has
   * to keep verifying for at least one token lifetime after it stops signing.
   */
  async retire(kid: string): Promise<TeamKey> {
    const key = this.find(kid);
    if (key === undefined) {
      throw new Error(`no key with kid ${kid} is in ${this.#keysDir}`);
    }
    if (key.retired) {
      return key;
    }
    const path = join(this.#keysDir, retiredFileName(key.serial));
    await rename(key.path, path);

    const retired: TeamKey = { ...key, retired: true, path };
    this.#keys = this.#keys.map((existing) => (existing.kid === kid ? retired : existing));
    return retired;
  }
}
