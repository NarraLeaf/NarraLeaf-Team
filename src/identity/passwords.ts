/**
 * Turning a password into something safe to store, and checking one against it.
 *
 * A stored hash carries its own algorithm and its own parameters:
 *
 *     scrypt$N=131072,r=8,p=1$<salt base64>$<hash base64>
 *
 * Nothing outside this file parses that string. Carrying the parameters means
 * the cost can be raised, or the algorithm replaced, without invalidating what
 * is already stored: an old hash still verifies under the parameters it was
 * made with, and {@link PasswordHasher.needsRehash} tells the caller it is
 * worth replacing. The replacement happens on the next successful sign-in,
 * where the plain password is in hand for the only moment it ever is.
 *
 * The cost is the point, and it is why this file also decides how many of these
 * may run at once — see {@link CONCURRENT_DERIVATIONS}. That limit lives here
 * rather than in front of any one door because the thing it protects is the
 * process, and a door that forgot to ask for it would take the whole server
 * down with it.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** `crypto.scrypt` as a promise. It has no promisified form of its own. */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/**
 * How many scrypt derivations may run in this process at once.
 *
 * Two, and the number is libuv's rather than a guess. scrypt runs on the
 * threadpool, which is four threads unless a deployment says otherwise, and
 * every file this server reads and every call it makes into lorelib wants the
 * same four. Measured on a default node with eight file reads in flight
 * throughout, at the parameters below:
 *
 *     derivations at once   p99 of a file read beside them
 *              1                       0.57 ms
 *              2                       0.46 ms
 *              4                     215.10 ms
 *              8                     407.91 ms
 *
 * The cliff is at four because four is the pool. A derivation holding the last
 * thread does not make a file read slower; it makes it wait for a whole
 * derivation to finish, and a fifth of a second is a long time to answer
 * nothing in.
 *
 * Raising `UV_THREADPOOL_SIZE` moves the cliff rather than removing the cost.
 * At sixteen threads eight derivations at once keep a read at 1.46 ms — and
 * take the process to 1.1 GiB resident, against 583 MiB when a pool of four
 * held four of them back. The pool was doing two jobs, badly. This takes over
 * the one that is properly a policy, so a deployment may size its pool for its
 * own I/O without deciding how much memory a flood of sign-ins may reach.
 *
 * A queue rather than a refusal: whoever is third waits, which is what the
 * limiter in ./signin.ts is for. What this stops is the memory and the threads,
 * which answering quickly would not give back.
 */
const CONCURRENT_DERIVATIONS = 2;

/** Whoever is waiting for a turn, in the order they asked. */
const waiting: Array<() => void> = [];
let running = 0;

/**
 * Take one of the turns, waiting for it if all of them are taken.
 *
 * A caller that waits is handed the turn of whoever released it rather than
 * taking one for itself. Counting it out and back in again would leave a gap
 * between a turn being released and the waiter waking, in which a third caller
 * could take it, and three would then be running.
 */
async function takeATurn(): Promise<void> {
  if (running < CONCURRENT_DERIVATIONS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

/** Give a turn back, to whoever is next for it or to nobody. */
function giveTheTurnBack(): void {
  const next = waiting.shift();
  if (next === undefined) {
    running -= 1;
    return;
  }
  next();
}

/**
 * Run one key derivation, once fewer than {@link CONCURRENT_DERIVATIONS} are
 * already running.
 *
 * {@link ScryptPasswordHasher} puts every derivation it performs through this,
 * so nothing that hashes or checks a password with it can spend more of this
 * process than the figure above allows. It is exported so that a second
 * algorithm added beside scrypt can be held to the same budget rather than to
 * one of its own — the budget belongs to the machine, not to the algorithm.
 *
 * Not re-entrant, and it does not need to be: what it wraps is a single call
 * into node's crypto, which asks for nothing else while it runs.
 */
export async function derivingAKey<T>(work: () => Promise<T>): Promise<T> {
  await takeATurn();
  try {
    return await work();
  } finally {
    giveTheTurnBack();
  }
}

/** Raised when a stored hash cannot be understood, and so cannot be checked. */
export class MalformedPasswordHashError extends Error {
  constructor(reason: string) {
    super(
      `a stored password hash could not be read: ${reason}. The account cannot be ` +
        "signed in to until its password is set again.",
    );
    this.name = "MalformedPasswordHashError";
  }
}

/**
 * What a password hasher has to be able to do.
 *
 * Kept to three methods so that a second algorithm is a second class rather
 * than a branch inside this one.
 */
export interface PasswordHasher {
  /** Hash `password` into a string that carries everything needed to check it. */
  hash(password: string): Promise<string>;
  /**
   * Whether `password` is the one `stored` was made from.
   *
   * Raises {@link MalformedPasswordHashError} if `stored` is not a hash this
   * implementation understands. That is deliberately not the same answer as
   * `false`: a damaged record and a wrong password are different problems, and
   * only one of them is the person typing. Callers must still report both to a
   * remote user with the same words — `authenticate` in ./users.ts is where
   * the two are flattened back into one answer.
   */
  verify(password: string, stored: string): Promise<boolean>;
  /** Whether `stored` was made by something other than the current settings. */
  needsRehash(stored: string): boolean;
}

/** The knobs scrypt takes. */
export interface ScryptParameters {
  /** CPU and memory cost. A power of two; the work is proportional to it. */
  readonly cost: number;
  /** Block size. Scales memory use alongside `cost`. */
  readonly blockSize: number;
  /** Parallelisation. */
  readonly parallelism: number;
  /** Length of the derived key, in bytes. */
  readonly keyLength: number;
}

/**
 * OWASP's recommended scrypt settings, as of 2026: N = 2^17, r = 8, p = 1.
 *
 * That is around 128 MiB of memory per hash and a few hundred milliseconds of
 * CPU, which is the point — it is what makes guessing a stolen hash expensive.
 * Raising these numbers later costs nothing: existing hashes keep verifying
 * under the parameters recorded in them, and are replaced as people sign in.
 */
export const OWASP_SCRYPT_PARAMETERS: ScryptParameters = {
  cost: 2 ** 17,
  blockSize: 8,
  parallelism: 1,
  keyLength: 32,
};

/** Bytes of salt. Long enough that no two users share one, ever. */
const SALT_BYTES = 16;

/** The name this implementation writes, and the only one it will read. */
const ALGORITHM = "scrypt";

/**
 * node's scrypt refuses to allocate more than 32 MiB unless told otherwise, and
 * these parameters need 128 * N * r bytes — about 128 MiB. Without a raised
 * `maxmem` it does not run slowly, it throws.
 */
function maximumMemory(parameters: ScryptParameters): number {
  return 128 * parameters.cost * parameters.blockSize * 2;
}

function encodeParameters(parameters: ScryptParameters): string {
  return `N=${parameters.cost},r=${parameters.blockSize},p=${parameters.parallelism}`;
}

/** Decode base64 and insist it was base64, rather than accepting near misses. */
function decodeBase64(text: string, what: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== text) {
    throw new MalformedPasswordHashError(`its ${what} is not base64`);
  }
  return bytes;
}

/** A stored hash, taken apart. */
interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/**
 * Take a stored string apart.
 *
 * Everything that is not exactly the expected shape is an error rather than a
 * best effort: a hash that is half-understood would be checked against the
 * wrong parameters and answer "no match" for the right password.
 */
function parse(stored: string): ParsedHash {
  const fields = stored.split("$");
  if (fields.length !== 4) {
    throw new MalformedPasswordHashError("it is not four $-separated fields");
  }
  const [algorithm, parameterText, saltText, hashText] = fields as [
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM) {
    throw new MalformedPasswordHashError(`its algorithm "${algorithm}" is not ${ALGORITHM}`);
  }

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parameterText);
  if (match === null) {
    throw new MalformedPasswordHashError(`its parameters "${parameterText}" are not readable`);
  }
  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelism = Number(match[3]);
  // scrypt requires N to be a power of two greater than one; anything else
  // makes the derivation throw rather than answer.
  if (cost < 2 || (cost & (cost - 1)) !== 0 || blockSize < 1 || parallelism < 1) {
    throw new MalformedPasswordHashError(`its parameters "${parameterText}" are out of range`);
  }

  const salt = decodeBase64(saltText, "salt");
  const hash = decodeBase64(hashText, "hash");
  return {
    parameters: { cost, blockSize, parallelism, keyLength: hash.length },
    salt,
    hash,
  };
}

/** Hashing with scrypt, the algorithm Team uses today. */
export class ScryptPasswordHasher implements PasswordHasher {
  readonly #parameters: ScryptParameters;

  constructor(parameters: ScryptParameters = OWASP_SCRYPT_PARAMETERS) {
    this.#parameters = parameters;
  }

  /** The parameters new hashes are made with. */
  get parameters(): ScryptParameters {
    return this.#parameters;
  }

  /**
   * The password is normalised first: the same characters typed on two
   * keyboards can arrive as different byte sequences, and a person whose name
   * or passphrase carries an accent would otherwise be locked out by which
   * machine they set it on.
   */
  async #derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
    // Every derivation this class performs passes through here, which is why
    // the limit is taken here and not around any of the callers: hashing a new
    // password and checking an old one cost the same, and a caller added later
    // cannot forget to ask. Never nested — this is a leaf — so the turn is
    // always given back before another is wanted.
    return await derivingAKey(() =>
      deriveKey(password.normalize("NFKC"), salt, parameters.keyLength, {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelism,
        maxmem: maximumMemory(parameters),
      }),
    );
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await this.#derive(password, salt, this.#parameters);
    return [
      ALGORITHM,
      encodeParameters(this.#parameters),
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    const derived = await this.#derive(password, parsed.salt, parsed.parameters);
    // Lengths are compared first because timingSafeEqual throws on a mismatch,
    // and the length of a stored hash is a parameter of the record rather than
    // anything the password decides. The comparison itself takes the same time
    // whether the first byte differs or none of them do, so a caller cannot be
    // told how much of a guess was right.
    if (derived.length !== parsed.hash.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.hash);
  }

  needsRehash(stored: string): boolean {
    let parsed: ParsedHash;
    try {
      parsed = parse(stored);
    } catch {
      // Something this implementation cannot read is certainly not something
      // it wrote with the current parameters. Saying so is safe: rehashing
      // only ever happens after a successful verify, which such a string
      // cannot produce.
      return true;
    }
    const current = this.#parameters;
    return (
      parsed.parameters.cost !== current.cost ||
      parsed.parameters.blockSize !== current.blockSize ||
      parsed.parameters.parallelism !== current.parallelism ||
      parsed.hash.length !== current.keyLength
    );
  }
}

/** The hasher Team uses when a caller expresses no preference. */
export function defaultPasswordHasher(): PasswordHasher {
  return new ScryptPasswordHasher();
}
