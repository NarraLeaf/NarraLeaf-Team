import { describe, expect, it } from "vitest";

import { compareVersions, newestRelease, parseVersion, UpdateCheck } from "../src/updates.js";

function answering(body: unknown, status = 200): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  };
}

describe("release versions", () => {
  it("reads X.Y.Z with or without a v, and nothing else", () => {
    expect(parseVersion("v1.0.5")).toEqual([1, 0, 5]);
    expect(parseVersion("1.10.0")).toEqual([1, 10, 0]);
    expect(parseVersion("v1.1.0-beta.1")).toBeUndefined();
    expect(parseVersion("latest")).toBeUndefined();
  });

  it("orders by number, not by text", () => {
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 5], [1, 0, 5])).toBe(0);
    expect(newestRelease(["v1.0.0", "v1.10.0", "v1.9.3", "v2.0.0-rc.1", "nightly"])).toBe("1.10.0");
    expect(newestRelease(["nightly"])).toBeUndefined();
  });
});

describe("the update check", () => {
  it("says a newer release is out, and where to read about it", async () => {
    const github = answering([{ name: "v1.0.6" }, { name: "v1.0.5" }]);
    const check = new UpdateCheck({ enabled: true, current: "1.0.5", fetch: github.fetch, now: () => 42 });
    await check.check();
    expect(github.calls[0]).toContain("api.github.com/repos/NarraLeaf/NarraLeaf-Team/tags");
    expect(check.status()).toEqual({
      current: "1.0.5",
      enabled: true,
      latest: "1.0.6",
      newer: true,
      releaseUrl: "https://github.com/NarraLeaf/NarraLeaf-Team/releases/tag/v1.0.6",
      checkedAt: 42,
    });
  });

  it("is not newer when this server is the newest, or ahead of it", async () => {
    for (const current of ["1.0.6", "1.1.0"]) {
      const check = new UpdateCheck({ enabled: true, current, fetch: answering([{ name: "v1.0.6" }]).fetch });
      await check.check();
      expect(check.status().newer).toBe(false);
    }
  });

  it("keeps what it learned when a later check fails, and says why", async () => {
    let fail = false;
    const check = new UpdateCheck({
      enabled: true,
      current: "1.0.5",
      fetch: (async () => (fail ? new Response("", { status: 503 }) : new Response(JSON.stringify([{ name: "v1.0.6" }])))) as typeof fetch,
    });
    await check.check();
    fail = true;
    await check.check();
    expect(check.status()).toMatchObject({ latest: "1.0.6", newer: true, problem: "GitHub answered 503" });
  });

  it("never asks when it is off", async () => {
    const github = answering([{ name: "v9.0.0" }]);
    const check = new UpdateCheck({ enabled: false, current: "1.0.5", fetch: github.fetch });
    check.start();
    await check.check();
    check.stop();
    expect(github.calls).toEqual([]);
    expect(check.status()).toEqual({ current: "1.0.5", enabled: false, newer: false });
  });
});
