/**
 * What guards a password check, rather than what a password check is.
 *
 * Both are about cost. scrypt at the parameters this server uses is around
 * 128 MiB and a few hundred milliseconds of one of four threads, which is the
 * right price for one attempt and a way to stop the process for a hundred.
 * What is below keeps the number of attempts down. How many run at once is the
 * hasher's own budget, and is in ./passwords.test.ts with it.
 */
import { describe, expect, it, vi } from "vitest";

import { SignInLimiter } from "../src/identity/signin.js";

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
