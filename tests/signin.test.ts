/**
 * What guards a password check, rather than what a password check is.
 *
 * Both are about cost. scrypt at the parameters this server uses is around
 * 128 MiB and a few hundred milliseconds of one of four threads, which is the
 * right price for one attempt and a way to stop the process for a hundred. The
 * two things below are what keep the number of attempts down and the number
 * running at once down, and neither of them is the algorithm's business.
 */
import { describe, expect, it, vi } from "vitest";

import { SignInLimiter, verifyingPassword } from "../src/identity/signin.js";

/** Let every microtask and every already-resolved promise run out. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Refuse `times` in a row, so that a pair has spent what it is allowed. */
function refuseSeveral(limiter: SignInLimiter, times: number): void {
  for (let attempt = 0; attempt < times; attempt += 1) {
    limiter.refused("ada", "198.51.100.7");
  }
}

describe("how often one place may guess at one password", () => {
  it("lets a few through, because people mistype their own passwords", () => {
    const limiter = new SignInLimiter();

    refuseSeveral(limiter, 5);

    expect(limiter.waitFor("ada", "198.51.100.7")).toBe(0);
  });

  it("makes the wait longer with each refusal after that", () => {
    const limiter = new SignInLimiter();

    refuseSeveral(limiter, 6);
    const first = limiter.waitFor("ada", "198.51.100.7");
    refuseSeveral(limiter, 1);
    const second = limiter.waitFor("ada", "198.51.100.7");

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it("holds it against the pair and not against either half of it", () => {
    const limiter = new SignInLimiter();

    refuseSeveral(limiter, 8);

    // On the name alone, anybody who knows a username could lock its owner out
    // from everywhere; on the address alone, one office would lock itself out
    // between colleagues.
    expect(limiter.waitFor("ada", "198.51.100.7")).toBeGreaterThan(0);
    expect(limiter.waitFor("ada", "203.0.113.9")).toBe(0);
    expect(limiter.waitFor("bob", "198.51.100.7")).toBe(0);
  });

  it("counts one account however the name was capitalised", () => {
    const limiter = new SignInLimiter();

    // The account lookup folds the name, so a limiter that did not would hand
    // out a fresh allowance for every spelling of the same account.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      limiter.refused("Ada", "198.51.100.7");
    }

    expect(limiter.waitFor("ada", "198.51.100.7")).toBeGreaterThan(0);
  });

  it("forgets the run once the wait has been waited out", () => {
    const limiter = new SignInLimiter();
    refuseSeveral(limiter, 8);
    const wait = limiter.waitFor("ada", "198.51.100.7");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + wait + 1));
      expect(limiter.waitFor("ada", "198.51.100.7")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the run the moment a password turns out to be right", () => {
    const limiter = new SignInLimiter();
    refuseSeveral(limiter, 8);
    expect(limiter.waitFor("ada", "198.51.100.7")).toBeGreaterThan(0);

    limiter.accepted("ada", "198.51.100.7");

    expect(limiter.waitFor("ada", "198.51.100.7")).toBe(0);
  });
});

describe("how many passwords are checked at once", () => {
  it("runs two and queues the rest, whoever asked", async () => {
    const started: number[] = [];
    const release: Array<() => void> = [];
    const check = (which: number): Promise<void> =>
      verifyingPassword(async () => {
        started.push(which);
        await new Promise<void>((resolve) => release.push(resolve));
      });

    const all = [check(1), check(2), check(3), check(4)];
    await settle();

    // Four at once would fill the threadpool this whole process shares and cost
    // about half a gigabyte of memory while they ran.
    expect(started).toEqual([1, 2]);

    release[0]?.();
    await settle();
    expect(started).toEqual([1, 2, 3]);

    release[1]?.();
    release[2]?.();
    await settle();
    expect(started).toEqual([1, 2, 3, 4]);

    release[3]?.();
    await Promise.all(all);
  });

  it("gives a place back even when the check it was taken for failed", async () => {
    await expect(
      verifyingPassword(() => Promise.reject(new Error("a stored hash could not be read"))),
    ).rejects.toThrow("a stored hash could not be read");

    // If the place had been kept, this would never start.
    await expect(verifyingPassword(() => Promise.resolve("done"))).resolves.toBe("done");
  });
});
