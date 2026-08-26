import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import {
  REPOSITORY_LIFETIME_KEY,
  SERVER_NAME_KEY,
  SETTING_KEYS,
  SIGN_IN_LIFETIME_KEY,
} from "../src/identity/settings.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";

/** The error message from a command line that was not understood. */
function messageFor(argv: readonly string[]): string {
  const result = parseArgs(argv);
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
}

describe("parseArgs", () => {
  it("recognises the long and short spellings of --version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("recognises the long and short spellings of --help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("treats an empty command line as a request for help", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
  });

  it("reports an unknown argument and names it", () => {
    const result = parseArgs(["--nonsense"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--nonsense");
  });

  it("rejects a trailing argument that no option or command can consume", () => {
    const result = parseArgs(["--version", "stray"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("stray");
  });

  it("calls a word that is not a command a command", () => {
    expect(messageFor(["dance"])).toBe("unknown command: dance");
  });
});

describe("parseArgs, up", () => {
  it("takes a root and fills in the default ports", () => {
    expect(parseArgs(["up", "--root", "/srv/team"])).toEqual({
      kind: "up",
      root: "/srv/team",
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: DEFAULT_PORTS.healthPort,
      // Identity is on unless it is switched off: without it loreserver is
      // never told to demand a token and Team is never asked about anybody, so
      // a command line that says nothing about it has to mean the safe one.
      identity: true,
      overrides: {},
    });
  });

  it("switches identity off when it is deliberately given up", () => {
    expect(parseArgs(["up", "--root", "/srv/team", "--no-identity"])).toMatchObject({
      identity: false,
    });
  });

  it("still takes --identity, which every operator's script already passes", () => {
    expect(parseArgs(["up", "--root", "/srv/team", "--identity"])).toMatchObject({
      identity: true,
    });
  });

  it("refuses a command line that asks for identity and gives it up at once", () => {
    expect(messageFor(["up", "--root", "/srv/team", "--identity", "--no-identity"])).toContain(
      "cannot both be given",
    );
  });

  it("switches identity on, and carries the settings that go with it", () => {
    expect(
      parseArgs([
        "up",
        "--root",
        "/srv/team",
        "--identity",
        "--issuer",
        "team.example.com",
        "--audience",
        "lore",
        "--auth-origin",
        "team.example.com",
        "--team-port",
        "41500",
        "--token-lifetime",
        "5m",
      ]),
    ).toMatchObject({
      identity: true,
      overrides: {
        issuer: "team.example.com",
        audience: "lore",
        authOrigin: "team.example.com",
        teamPort: 41500,
        signInTokenLifetimeSeconds: 300,
      },
    });
  });

  it("refuses an auth origin written as a URL, which would be doubled", () => {
    expect(messageFor(["up", "--root", "/srv/team", "--auth-origin", "https://team.example.com"]))
      .toContain("without a scheme");
  });

  it("accepts ports on the command line", () => {
    expect(parseArgs(["up", "--root", "/srv/team", "--data-port", "9000"])).toMatchObject({
      dataPort: 9000,
      healthPort: DEFAULT_PORTS.healthPort,
    });
    expect(parseArgs(["up", "--root", "/srv/team", "--health-port", "9001"])).toMatchObject({
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: 9001,
    });
  });

  it("accepts a value joined to its option with an equals sign", () => {
    expect(parseArgs(["up", "--root=/srv/team", "--data-port=9000"])).toMatchObject({
      root: "/srv/team",
      dataPort: 9000,
    });
  });

  it("keeps a Windows path intact, backslashes and all", () => {
    expect(parseArgs(["up", "--root", "D:\\srv\\team"])).toMatchObject({ root: "D:\\srv\\team" });
  });

  it("insists on a root, because there is no sensible default for one", () => {
    expect(messageFor(["up"])).toContain("--root");
    expect(messageFor(["up", "--data-port", "9000"])).toContain("--root");
  });

  it("rejects a port that is not one", () => {
    expect(messageFor(["up", "--root", "/srv/team", "--data-port", "http"])).toContain(
      "needs a port number",
    );
    expect(messageFor(["up", "--root", "/srv/team", "--data-port", "0"])).toContain("between 1");
    expect(messageFor(["up", "--root", "/srv/team", "--data-port", "70000"])).toContain(
      "between 1",
    );
    expect(messageFor(["up", "--root", "/srv/team", "--health-port", "1.5"])).toContain(
      "needs a port number",
    );
  });

  it("rejects one port doing both jobs", () => {
    // gRPC and QUIC share a number because they are on different transports.
    // The health check is HTTP, on the same transport as gRPC.
    expect(
      messageFor(["up", "--root", "/srv/team", "--data-port", "9000", "--health-port", "9000"]),
    ).toContain("cannot both be 9000");
    // Four listeners come up on one machine, so the check covers Team's two as
    // well: whichever lost the race would be silently absent.
    expect(
      messageFor(["up", "--root", "/srv/team", "--team-port", "9000", "--auth-port", "9000"]),
    ).toContain("cannot both be 9000");
    expect(
      messageFor(["up", "--root", "/srv/team", "--auth-port", String(DEFAULT_PORTS.dataPort)]),
    ).toContain("cannot both be");
  });

  it("reports an option with nothing after it", () => {
    expect(messageFor(["up", "--root"])).toContain("--root needs a value");
  });

  it("reports an option it does not have", () => {
    expect(messageFor(["up", "--root", "/srv/team", "--verbose"])).toContain("--verbose");
  });

  it("answers --help after the command with help", () => {
    expect(parseArgs(["up", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["up", "--root", "/srv/team", "-h"])).toEqual({ kind: "help" });
  });
});

describe("parseArgs, the identity commands", () => {
  it("makes the first account, and wants a name for it", () => {
    expect(parseArgs(["init", "ada", "--root", "/srv/team"])).toEqual({
      kind: "init",
      root: "/srv/team",
      username: "ada",
      displayName: undefined,
      email: undefined,
    });
    expect(messageFor(["init", "--root", "/srv/team"])).toContain("needs a username");
  });

  it("takes a username as the word after the verb", () => {
    expect(parseArgs(["user", "disable", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-disable",
      root: "/srv/team",
      username: "ada",
    });
    expect(parseArgs(["user", "enable", "--root", "/srv/team", "ada"])).toEqual({
      kind: "user-enable",
      root: "/srv/team",
      username: "ada",
    });
    expect(parseArgs(["user", "revoke-tokens", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-revoke-tokens",
      root: "/srv/team",
      username: "ada",
    });
    expect(messageFor(["user", "disable", "--root", "/srv/team"])).toContain("needs a username");
    expect(messageFor(["user", "revoke-tokens", "--root", "/srv/team"])).toContain(
      "needs a username",
    );
  });

  it("makes an account, in the default group unless told another", () => {
    expect(parseArgs(["user", "create", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-create",
      root: "/srv/team",
      username: "ada",
      role: "member",
      displayName: undefined,
      email: undefined,
      isServiceAccount: false,
    });
    expect(
      parseArgs(["user", "create", "ada", "--root", "/srv/team", "--role", "admin"]),
    ).toMatchObject({ role: "admin" });
    expect(messageFor(["user", "create", "--root", "/srv/team"])).toContain("needs a username");
  });

  it("marks a service account when it is told to", () => {
    expect(
      parseArgs([
        "user",
        "create",
        "builder",
        "--root",
        "/srv/team",
        "--service-account",
        "--display-name",
        "Build robot",
      ]),
    ).toMatchObject({ isServiceAccount: true, displayName: "Build robot" });
  });

  it("mints for one named account, with the identity settings it is given", () => {
    expect(
      parseArgs(["token", "mint", "ada", "--root", "/srv/team", "--env", "staging"]),
    ).toEqual({
      kind: "token-mint",
      root: "/srv/team",
      username: "ada",
      overrides: { env: "staging" },
    });
  });

  it("rotates and lists keys", () => {
    expect(parseArgs(["key", "rotate", "--root", "/srv/team"])).toEqual({
      kind: "key-rotate",
      root: "/srv/team",
    });
    expect(parseArgs(["key", "list", "--root", "/srv/team"])).toEqual({
      kind: "key-list",
      root: "/srv/team",
    });
  });

  it("names the verb it did not recognise, and the ones it has", () => {
    expect(messageFor(["user", "invent", "--root", "/srv/team"])).toBe("unknown user command: invent");
    expect(messageFor(["user"])).toContain("grant-admin");
    expect(messageFor(["key", "melt", "--root", "/srv/team"])).toBe("unknown key command: melt");
  });

  it("wants a root for every command that keeps state", () => {
    for (const argv of [
      ["init", "ada"],
      ["user", "list"],
      ["user", "disable", "ada"],
      ["user", "revoke-tokens", "ada"],
      ["token", "mint", "ada"],
      ["project", "list"],
      ["project", "create", "harbour"],
      ["key", "rotate"],
      ["settings", "list"],
      ["settings", "set", SIGN_IN_LIFETIME_KEY, "7d"],
    ]) {
      expect(messageFor(argv)).toContain("--root");
    }
  });
});

describe("parseArgs, the settings commands", () => {
  it("lists them", () => {
    expect(parseArgs(["settings", "list", "--root", "/srv/team"])).toEqual({
      kind: "settings-list",
      root: "/srv/team",
    });
  });

  it("reads a value in every duration a command line here takes", () => {
    expect(parseArgs(["settings", "set", SIGN_IN_LIFETIME_KEY, "7d", "--root", "/srv/team"])).toEqual(
      {
        kind: "settings-set",
        root: "/srv/team",
        change: { key: SIGN_IN_LIFETIME_KEY, seconds: 7 * 24 * 60 * 60 },
      },
    );
    // The same spellings --token-lifetime takes, because somebody who knows one
    // of them should not have to discover a second.
    expect(
      parseArgs(["settings", "set", REPOSITORY_LIFETIME_KEY, "30m", "--root", "/srv/team"]),
    ).toMatchObject({ change: { key: REPOSITORY_LIFETIME_KEY, seconds: 30 * 60 } });
    expect(
      parseArgs(["settings", "set", REPOSITORY_LIFETIME_KEY, "900", "--root", "/srv/team"]),
    ).toMatchObject({ change: { seconds: 900 } });
  });

  it("leaves a name as it was written, rather than reading a duration out of it", () => {
    // Every check on a name is the database's. What reaches here is what was
    // typed, spaces and all, so that a deployment called "7d" is not stored as
    // a week and one called "Studio" is not refused by the command line.
    expect(parseArgs(["settings", "set", SERVER_NAME_KEY, "Winterlight", "--root", "/srv/team"])).toEqual(
      {
        kind: "settings-set",
        root: "/srv/team",
        change: { key: SERVER_NAME_KEY, name: "Winterlight" },
      },
    );
    expect(
      parseArgs(["settings", "set", SERVER_NAME_KEY, "7d", "--root", "/srv/team"]),
    ).toMatchObject({ change: { key: SERVER_NAME_KEY, name: "7d" } });
  });

  it("names the settings there are when it is given one there is not", () => {
    const message = messageFor(["settings", "set", "token.lifetime", "7d", "--root", "/srv/team"]);

    expect(message).toContain("there is no setting called token.lifetime");
    for (const key of SETTING_KEYS) {
      expect(message).toContain(key);
    }
  });

  it("names the key in what it says about a value it could not read", () => {
    expect(
      messageFor(["settings", "set", SIGN_IN_LIFETIME_KEY, "a while", "--root", "/srv/team"]),
    ).toContain(SIGN_IN_LIFETIME_KEY);
  });

  it("says what is missing, and names the verb it did not recognise", () => {
    expect(messageFor(["settings", "set", "--root", "/srv/team"])).toContain("a key and a value");
    expect(messageFor(["settings", "invent"])).toBe("unknown settings command: invent");
    expect(messageFor(["settings"])).toContain("list or set");
  });
});

describe("parseArgs, the project commands", () => {
  it("creates a project, with the default loreserver port and no owner named", () => {
    expect(parseArgs(["project", "create", "harbour", "--root", "/srv/team"])).toEqual({
      kind: "project-create",
      root: "/srv/team",
      name: "harbour",
      description: undefined,
      // Absent means the account is worked out from the Team server, which only has an
      // answer when there is exactly one.
      as: undefined,
      dataPort: DEFAULT_PORTS.dataPort,
      overrides: {},
    });
  });

  it("takes a description, an owner, a port and the identity settings", () => {
    expect(
      parseArgs([
        "project",
        "create",
        "harbour",
        "--root",
        "/srv/team",
        "--description",
        "a game about a port at night",
        "--as",
        "ada",
        "--data-port",
        "9000",
        "--issuer",
        "team.example.com",
      ]),
    ).toMatchObject({
      description: "a game about a port at night",
      as: "ada",
      dataPort: 9000,
      overrides: { issuer: "team.example.com" },
    });
  });

  it("lists what the server holds, and takes no account to list it for", () => {
    expect(parseArgs(["project", "list", "--root", "/srv/team"])).toEqual({
      kind: "project-list",
      root: "/srv/team",
    });
    // There is no per-account listing, because there is no per-account access.
    expect(messageFor(["project", "list", "--root", "/srv/team", "--as", "ada"])).toContain("--as");
  });

  it("puts an account in the admin group, and takes it out", () => {
    expect(parseArgs(["user", "grant-admin", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-set-admin",
      root: "/srv/team",
      username: "ada",
      admin: true,
    });
    expect(parseArgs(["user", "revoke-admin", "ada", "--root", "/srv/team"])).toMatchObject({
      admin: false,
    });
    expect(messageFor(["user", "grant-admin", "--root", "/srv/team"])).toContain(
      "needs a username",
    );
  });

  it("says what is missing, and names the verb it did not recognise", () => {
    expect(messageFor(["project", "create", "--root", "/srv/team"])).toContain("needs a name");
    expect(messageFor(["project", "invent"])).toBe("unknown project command: invent");
    expect(messageFor(["project"])).toContain("create or list");
  });
});
