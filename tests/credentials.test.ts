/**
 * Where a token lives once somebody has signed in, and how an address is spelled.
 *
 * Both are about a file nobody looks at, which is why they are asserted rather
 * than left to be noticed. A configuration directory chosen wrongly is a machine
 * where signing in appears to work and every later command says to log in; an
 * address spelled two ways is one server filed as two, with the same symptom.
 *
 * The permissions are asserted on POSIX and skipped on Windows, which has no
 * such bits. That is a fact about the platform rather than a case worth a second
 * expectation: the mode is set unconditionally in src/client/config.ts, exactly
 * as it is for the private keys under a storage root.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configDirectory,
  credentialsPath,
  forgetServer,
  parseServerAddress,
  readCredentials,
  rememberServer,
  UnreadableCredentialsError,
  type ServerCredential,
} from "../src/client/config.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-credentials-");

/** Somewhere with no variables set at all, so a case decides on the platform. */
const NOTHING_SET: NodeJS.ProcessEnv = {};

function credential(address: string, extra: Partial<ServerCredential> = {}): ServerCredential {
  return {
    address,
    token: "a.token.somebody-signed",
    account: "ada",
    authority: { sha256: "AB:CD", pem: "-----BEGIN CERTIFICATE-----\nnot really\n" },
    signedInAt: 1_700_000_000_000,
    ...extra,
  };
}

describe("where credentials are kept", () => {
  it("puts them beside this account's own configuration, per platform", () => {
    expect(configDirectory({ APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, "win32", "C:\\Users\\ada")).toBe(
      join("C:\\Users\\ada\\AppData\\Roaming", "nlteam"),
    );
    expect(configDirectory(NOTHING_SET, "darwin", "/Users/ada")).toBe(
      join("/Users/ada", "Library", "Application Support", "nlteam"),
    );
    expect(configDirectory(NOTHING_SET, "linux", "/home/ada")).toBe(
      join("/home/ada", ".config", "nlteam"),
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "/home/ada/conf" }, "linux", "/home/ada")).toBe(
      join("/home/ada/conf", "nlteam"),
    );
  });

  it("falls back to the roaming profile where Windows has not said where it is", () => {
    // A service account or a stripped-down container can be running without
    // APPDATA. Answering with a path under the home directory beats answering
    // with "nlteam" relative to wherever the command happened to be run.
    expect(configDirectory(NOTHING_SET, "win32", "C:\\Users\\ada")).toBe(
      join("C:\\Users\\ada", "AppData", "Roaming", "nlteam"),
    );
  });

  it("lets NLTEAM_CONFIG_DIR name one outright, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        configDirectory({ NLTEAM_CONFIG_DIR: "/srv/creds", APPDATA: "C:\\ignored" }, platform, "/home/ada"),
      ).toBe("/srv/creds");
    }
  });

  it("treats an empty variable as one nobody set", () => {
    // The same reading src/args.ts gives every other variable: a container that
    // declares one and leaves it blank has named no directory.
    expect(configDirectory({ NLTEAM_CONFIG_DIR: "" }, "linux", "/home/ada")).toBe(
      join("/home/ada", ".config", "nlteam"),
    );
  });
});

describe("the credential file", () => {
  it("is an empty answer on an account that has never signed in", async () => {
    const directory = join(await temporaryRoot(), "never-used");

    expect(await readCredentials(directory)).toEqual(new Map());
  });

  it("holds several servers at once and forgets one of them", async () => {
    const directory = await temporaryRoot();
    await rememberServer(directory, credential("one.example.lan:41402"));
    await rememberServer(directory, credential("two.example.lan:41402", { account: "bob" }));

    expect([...(await readCredentials(directory)).keys()]).toEqual([
      "one.example.lan:41402",
      "two.example.lan:41402",
    ]);

    expect(await forgetServer(directory, "one.example.lan:41402")).toBe(true);
    expect([...(await readCredentials(directory)).keys()]).toEqual(["two.example.lan:41402"]);
    // Twice is not a mistake: there is simply nothing left to forget.
    expect(await forgetServer(directory, "one.example.lan:41402")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "is readable by nobody but its owner, and so is the directory",
    async () => {
      const directory = join(await temporaryRoot(), "fresh");
      await rememberServer(directory, credential("one.example.lan:41402"));

      expect((await stat(credentialsPath(directory))).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    },
  );

  it("drops one entry it cannot read rather than every entry beside it", async () => {
    const directory = await temporaryRoot();
    await rememberServer(directory, credential("good.example.lan:41402"));
    const path = credentialsPath(directory);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    (stored["servers"] as Record<string, unknown>)["odd.example.lan:41402"] = { token: 7 };
    await writeFile(path, JSON.stringify(stored), "utf8");

    const read = await readCredentials(directory);

    expect([...read.keys()]).toEqual(["good.example.lan:41402"]);
  });

  it("refuses a file written by a later nlteam, rather than reading half of it", async () => {
    const directory = await temporaryRoot();
    await writeFile(
      credentialsPath(directory),
      JSON.stringify({ version: 99, servers: {} }),
      "utf8",
    );

    await expect(readCredentials(directory)).rejects.toBeInstanceOf(UnreadableCredentialsError);
  });
});

describe("a server address", () => {
  it("has one spelling, whichever was typed", () => {
    // Two spellings of one server would be one server filed as two, and the
    // second of them would be a machine nobody is signed in to.
    expect(parseServerAddress("Team.Example.LAN:41402")).toBe("team.example.lan:41402");
    expect(parseServerAddress("  team.example.lan:41402  ")).toBe("team.example.lan:41402");
    expect(parseServerAddress("nlteam://team.example.lan:41402")).toBe("team.example.lan:41402");
  });

  it("fills in the port a Team server listens on when none was written", () => {
    expect(parseServerAddress("team.example.lan")).toBe("team.example.lan:41402");
  });

  it("brackets an IPv6 address however it arrived", () => {
    expect(parseServerAddress("[::1]:9000")).toBe("[::1]:9000");
    expect(parseServerAddress("::1")).toBe("[::1]:41402");
  });

  it("refuses what is not a host and a port, saying which part was wrong", () => {
    expect(() => parseServerAddress("https://team.example.lan")).toThrow(/scheme/);
    expect(() => parseServerAddress("team.example.lan/projects")).toThrow(/nothing after it/);
    expect(() => parseServerAddress("team.example.lan:0")).toThrow(/port number/);
    expect(() => parseServerAddress("team.example.lan:http")).toThrow(/port number/);
    expect(() => parseServerAddress(":41402")).toThrow(/no host/);
  });
});
