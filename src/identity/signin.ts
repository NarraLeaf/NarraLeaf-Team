/**
 * What happens around a password check on the door that takes one from anybody.
 *
 * Checking the password itself is src/identity/passwords.ts, and it is
 * deliberately expensive: scrypt at OWASP's parameters is about 128 MiB and a
 * few hundred milliseconds. That is the right cost for one attempt and the
 * wrong cost for a thousand, and nothing about the algorithm bounds how many
 * run at once. Node's default threadpool is four threads, shared with every
 * file operation and every call into lorelib in the process, so four
 * simultaneous attempts stall everything else this server does and eight cost
 * about a gigabyte of resident memory.
 *
 * One door reaches it without a credential: the sign-in a Studio installation
 * posts to, in src/web/studio.ts. An unknown username is hashed against a decoy
 * so that it costs what a real one does — which is what stops anybody
 * enumerating the accounts, and which also means an attacker needs no valid
 * account to spend this.
 *
 * `nlteam token mint --root` checks a password too and is deliberately not
 * guarded by any of this. It is reached only by somebody holding the storage
 * root, who holds the signing keys with it and can already mint a token for any
 * account without knowing a password — `nlteam project create --root` does
 * exactly that. A limiter in front of that door would slow down the one person
 * it cannot keep out.
 *
 * So three things live here, in front of the check rather than behind it:
 *
 *   - {@link SignInLimiter}, which makes repeated refusals of one name from one
 *     place wait longer and longer, and is asked before a password is checked.
 *   - {@link verifyingPassword}, which lets two run at once and queues the rest.
 *   - {@link holdRefusedSignIn}, the flat pause every refusal is held for,
 *     which is about the rate one connection can guess at rather than the cost.
 */
import { normaliseUsername } from "./users.js";

/**
 * How long a refused sign-in is held before it is answered.
 *
 * Password checking is already slow on purpose, so this is not about the cost
 * of a guess. It is about the rate of them: with this, one connection gets at
 * most a couple of attempts a second, and the sentence it is answered with says
 * nothing about which half was wrong anyway.
 */
export const REFUSED_SIGN_IN_DELAY_MS = 500;

/**
 * Refusals from one place that cost nothing beyond the check itself.
 *
 * People mistype their own passwords, and a password manager filling in a stale
 * entry can be wrong several times in a row without anybody being at the
 * keyboard. Below this, the answer is only slow the way every refusal is slow.
 */
const FREE_ATTEMPTS = 5;

/** What the wait is the first time it is imposed, doubling with each refusal after. */
const FIRST_BACKOFF_MS = 1000;

/**
 * The longest anyone is held off, however many times they have been wrong.
 *
 * Doubling without a ceiling would eventually lock an account out of its own
 * server for a week over a bad afternoon. Five minutes is short enough to wait
 * out and long enough that guessing at this rate is not a way in.
 */
const MAXIMUM_BACKOFF_MS = 5 * 60 * 1000;

/**
 * How long a place is remembered after its last refusal.
 *
 * Long enough to outlast the backoff it earned, so that waiting out a wait and
 * failing again is treated as the continuation it is rather than as a fresh
 * start.
 */
const FORGET_AFTER_MS = 30 * 60 * 1000;

/**
 * The most name-and-address pairs held at once.
 *
 * The keys are chosen by whoever is knocking, so an attacker varying the
 * username spends nothing and would otherwise make this server hold a row per
 * guess — the shape of problem this exists to stop. When the table is full the
 * entries nobody is waiting on go first, and then the one whose wait ends
 * soonest, which is the one there is least left to remember.
 */
const MAXIMUM_TRACKED = 4096;

/** What is remembered about one name being tried from one place. */
interface Attempt {
  /** Refusals in a row, counting from the last accepted sign-in or from none. */
  refusals: number;
  /** When nothing more need be remembered about this pair. */
  expiresAt: number;
  /** The clock reading before which the next attempt is not checked at all. */
  readyAt: number;
}

/**
 * The wait one pair has earned, in milliseconds.
 *
 * The first {@link FREE_ATTEMPTS} earn nothing. After that it doubles, from one
 * second, to a ceiling.
 */
function backoffFor(refusals: number): number {
  if (refusals <= FREE_ATTEMPTS) {
    return 0;
  }
  const doublings = refusals - FREE_ATTEMPTS - 1;
  return Math.min(FIRST_BACKOFF_MS * 2 ** doublings, MAXIMUM_BACKOFF_MS);
}

/**
 * How often a name may be tried from one place.
 *
 * Keyed on the pair rather than on either half. On the address alone, one
 * office behind one address would lock itself out between colleagues; on the
 * username alone, anybody who knows a name could lock its owner out from
 * anywhere, which is a denial of service handed to whoever asks for it.
 *
 * Held in memory and lost when the process stops, which is the honest scope of
 * it: what it defends against is a flood inside one run, and a restart is not
 * something an attacker can ask for.
 */
export class SignInLimiter {
  readonly #attempts = new Map<string, Attempt>();

  /**
   * The one key a pair is filed under.
   *
   * The name is folded the way the account lookup folds it, or somebody would
   * get a fresh allowance for every way of capitalising one account. It is
   * written with its length in front of it because it is whatever was posted
   * rather than a name this server has: a separator on its own could be typed
   * into it, and two different pairs would then share one budget.
   */
  static #key(username: string, address: string): string {
    const name = normaliseUsername(username);
    return `${name.length}:${name}:${address}`;
  }

  /**
   * How long this pair must wait before its password is worth checking, in
   * milliseconds. Zero when it may be checked now.
   */
  waitFor(username: string, address: string): number {
    const now = Date.now();
    const attempt = this.#attempts.get(SignInLimiter.#key(username, address));
    if (attempt === undefined || attempt.expiresAt <= now) {
      return 0;
    }
    return Math.max(attempt.readyAt - now, 0);
  }

  /** Say that a check of this pair was refused. */
  refused(username: string, address: string): void {
    const now = Date.now();
    const key = SignInLimiter.#key(username, address);
    const existing = this.#attempts.get(key);
    const refusals = existing === undefined || existing.expiresAt <= now ? 1 : existing.refusals + 1;
    const wait = backoffFor(refusals);
    if (existing === undefined) {
      this.#makeRoom();
    }
    this.#attempts.set(key, {
      refusals,
      readyAt: now + wait,
      expiresAt: now + wait + FORGET_AFTER_MS,
    });
  }

  /**
   * Say that a check of this pair was accepted, whatever was decided about the
   * account afterwards. The password was right, so there is nothing left to
   * hold against whoever typed it.
   */
  accepted(username: string, address: string): void {
    this.#attempts.delete(SignInLimiter.#key(username, address));
  }

  /** Make room for one more entry, if the table is at its limit. */
  #makeRoom(): void {
    if (this.#attempts.size < MAXIMUM_TRACKED) {
      return;
    }
    const now = Date.now();
    for (const [key, attempt] of this.#attempts) {
      if (attempt.expiresAt <= now) {
        this.#attempts.delete(key);
      }
    }
    if (this.#attempts.size < MAXIMUM_TRACKED) {
      return;
    }
    // Still full, so something that is still worth remembering has to go. The
    // one whose wait ends soonest is the one with the least left to enforce.
    let soonest: string | undefined;
    let soonestAt = Number.POSITIVE_INFINITY;
    for (const [key, attempt] of this.#attempts) {
      if (attempt.readyAt < soonestAt) {
        soonest = key;
        soonestAt = attempt.readyAt;
      }
    }
    if (soonest !== undefined) {
      this.#attempts.delete(soonest);
    }
  }
}

/**
 * The limiter both doors use unless they were handed one.
 *
 * One per process, because the two doors are two ways to the same accounts and
 * the rate somebody may guess at a password should not depend on which of them
 * they knock on.
 */
const shared = new SignInLimiter();

/** The limiter to use when a caller named none. */
export function sharedSignInLimiter(): SignInLimiter {
  return shared;
}

/**
 * How many password checks run at once, across everything in this process.
 *
 * Two rather than four, which is the size of the threadpool they run on: the
 * point is that this server goes on reading files and answering everything else
 * while somebody is signing in, and a limit equal to the pool would leave it
 * doing nothing but hashing.
 */
const CONCURRENT_VERIFICATIONS = 2;

/** Whoever is waiting for a turn, in the order they asked. */
const waiting: Array<() => void> = [];
let running = 0;

/**
 * Take one of the places, waiting for it if both are taken.
 *
 * A caller that waits is handed the place of whoever released it rather than
 * taking one for itself. Counting it out and back in again would leave a gap
 * between a place being released and the waiter waking in which a third caller
 * could take it, and three would then be running.
 */
async function takeAPlace(): Promise<void> {
  if (running < CONCURRENT_VERIFICATIONS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

/** Give a place back, to whoever is next for it or to nobody. */
function giveThePlaceBack(): void {
  const next = waiting.shift();
  if (next === undefined) {
    running -= 1;
    return;
  }
  next();
}

/**
 * Run one password check, once fewer than {@link CONCURRENT_VERIFICATIONS} are
 * already running.
 *
 * A queue rather than a refusal: somebody signing in during a flood waits, and
 * the flood itself is what the limiter above is for. What this stops is the
 * memory and the threads, which no amount of answering quickly would give back.
 */
export async function verifyingPassword<T>(work: () => Promise<T>): Promise<T> {
  await takeAPlace();
  try {
    return await work();
  } finally {
    giveThePlaceBack();
  }
}

/** Wait, without holding the process open if it is on its way out. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

/**
 * Hold a refused sign-in for as long as every refused sign-in is held.
 *
 * The same pause on both doors, so that the rate a password may be guessed at
 * does not depend on which one somebody knocks on.
 */
export function holdRefusedSignIn(): Promise<void> {
  return pause(REFUSED_SIGN_IN_DELAY_MS);
}
