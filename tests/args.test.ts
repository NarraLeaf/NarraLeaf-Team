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

/** The error message out of an already-parsed result, for the env-var cases. */
function messageFor2(result: ReturnType<typeof parseArgs>): string {
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

describe("parseArgs, the root from the environment", () => {
  it("takes NLTEAM_ROOT as the root when no flag names one", () => {
    // The container case: an image sets the variable once and every command it
    // runs is given the root without a flag list to compose.
    expect(parseArgs(["up"], { NLTEAM_ROOT: "/var/lib/nlteam" })).toMatchObject({
      kind: "up",
      root: "/var/lib/nlteam",
    });
    expect(parseArgs(["settings", "list"], { NLTEAM_ROOT: "/var/lib/nlteam" })).toEqual({
      kind: "settings-list",
      target: { kind: "root", root: "/var/lib/nlteam" },
    });
  });

  it("lets an explicit --root win over the environment", () => {
    expect(
      parseArgs(["settings", "list", "--root", "/srv/team"], { NLTEAM_ROOT: "/var/lib/nlteam" }),
    ).toEqual({ kind: "settings-list", target: { kind: "root", root: "/srv/team" } });
  });

  it("treats an empty NLTEAM_ROOT as no root at all", () => {
    // A variable declared and left blank has named nothing, so the missing-root
    // error is still what a command with no flag gets.
    const result = parseArgs(["settings", "list"], { NLTEAM_ROOT: "" });
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--root");
  });

  it("still insists on a root when neither the flag nor the variable names one", () => {
    const result = parseArgs(["up"], {});
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("NLTEAM_ROOT");
  });
});

describe("parseArgs, the ports and identity from the environment", () => {
  it("fills the identity overrides from the environment on up", () => {
    expect(
      parseArgs(["up", "--root", "/srv/team"], {
        NLTEAM_ISSUER: "team.example.com",
        NLTEAM_AUDIENCE: "lore",
        NLTEAM_AUTH_ORIGIN: "team.example.com:41402",
        NLTEAM_ENV: "staging",
        NLTEAM_IDP: "example",
        NLTEAM_TOKEN_LIFETIME: "5m",
        NLTEAM_TEAM_PORT: "41500",
        NLTEAM_AUTH_PORT: "41501",
        NLTEAM_AUTH_TLS_PORT: "41502",
        NLTEAM_DATA_PORT: "41337",
        NLTEAM_HEALTH_PORT: "41339",
        NLTEAM_HOSTNAME: "team.example.com, team.internal",
      }),
    ).toMatchObject({
      kind: "up",
      dataPort: 41337,
      healthPort: 41339,
      overrides: {
        issuer: "team.example.com",
        audience: "lore",
        authOrigin: "team.example.com:41402",
        env: "staging",
        idp: "example",
        signInTokenLifetimeSeconds: 300,
        teamPort: 41500,
        authPort: 41501,
        authTlsPort: 41502,
        dataPort: 41337,
        hostnames: ["team.example.com", "team.internal"],
      },
    });
  });

  it("fills the identity overrides from the environment on token mint too", () => {
    expect(
      parseArgs(["token", "mint", "ada", "--root", "/srv/team"], {
        NLTEAM_ISSUER: "team.example.com",
        NLTEAM_DATA_PORT: "41500",
      }),
    ).toMatchObject({
      kind: "token-mint",
      overrides: { issuer: "team.example.com", dataPort: 41500 },
    });
  });

  it("lets a flag on the line beat its variable", () => {
    expect(
      parseArgs(["up", "--root", "/srv/team", "--data-port", "42000"], {
        NLTEAM_DATA_PORT: "41500",
      }),
    ).toMatchObject({ dataPort: 42000, overrides: { dataPort: 42000 } });
  });

  it("lets --hostname on the line replace the whole variable, rather than adding to it", () => {
    // The flag describes the set of hosts. A command line that names any is the
    // whole of the list, so the variable does not smuggle another in beside it.
    expect(
      parseArgs(["up", "--root", "/srv/team", "--hostname", "only.example.com"], {
        NLTEAM_HOSTNAME: "ignored.example.com",
      }),
    ).toMatchObject({ overrides: { hostnames: ["only.example.com"] } });
  });

  it("refuses a port from the environment exactly as it refuses one on the line", () => {
    expect(
      messageFor2(parseArgs(["up", "--root", "/srv/team"], { NLTEAM_DATA_PORT: "70000" })),
    ).toContain("between 1");
    expect(
      messageFor2(parseArgs(["up", "--root", "/srv/team"], { NLTEAM_TEAM_PORT: "http" })),
    ).toContain("needs a port number");
  });

  it("reads a duration from NLTEAM_TOKEN_LIFETIME the way the flag does", () => {
    expect(
      parseArgs(["token", "mint", "ada", "--root", "/srv/team"], { NLTEAM_TOKEN_LIFETIME: "48h" }),
    ).toMatchObject({ overrides: { signInTokenLifetimeSeconds: 48 * 60 * 60 } });
  });

  it("drops the blank entries a doubled or trailing comma leaves behind", () => {
    expect(
      parseArgs(["up", "--root", "/srv/team"], { NLTEAM_HOSTNAME: "a.example.com,,b.example.com," }),
    ).toMatchObject({ overrides: { hostnames: ["a.example.com", "b.example.com"] } });
  });
});

describe("parseArgs, identity on or off from the environment", () => {
  it("turns identity off when NLTEAM_IDENTITY says so, without a flag", () => {
    for (const off of ["0", "false", "no", "NO", "False"]) {
      expect(parseArgs(["up", "--root", "/srv/team"], { NLTEAM_IDENTITY: off })).toMatchObject({
        identity: false,
      });
    }
  });

  it("turns identity on for the on-ish values, which is also the default", () => {
    for (const on of ["1", "true", "yes", "YES"]) {
      expect(parseArgs(["up", "--root", "/srv/team"], { NLTEAM_IDENTITY: on })).toMatchObject({
        identity: true,
      });
    }
    // No variable at all is on, because the safe reading is the one that needs
    // nothing said.
    expect(parseArgs(["up", "--root", "/srv/team"], {})).toMatchObject({ identity: true });
  });

  it("lets a flag beat the variable, in both directions", () => {
    expect(
      parseArgs(["up", "--root", "/srv/team", "--no-identity"], { NLTEAM_IDENTITY: "true" }),
    ).toMatchObject({ identity: false });
    expect(
      parseArgs(["up", "--root", "/srv/team", "--identity"], { NLTEAM_IDENTITY: "false" }),
    ).toMatchObject({ identity: true });
  });

  it("refuses a variable that is neither on nor off", () => {
    expect(
      messageFor2(parseArgs(["up", "--root", "/srv/team"], { NLTEAM_IDENTITY: "maybe" })),
    ).toContain("NLTEAM_IDENTITY is on or off");
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
      target: { kind: "root", root: "/srv/team" },
      username: "ada",
    });
    expect(parseArgs(["user", "enable", "--root", "/srv/team", "ada"])).toEqual({
      kind: "user-enable",
      target: { kind: "root", root: "/srv/team" },
      username: "ada",
    });
    expect(parseArgs(["user", "revoke-tokens", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-revoke-tokens",
      target: { kind: "root", root: "/srv/team" },
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
      target: { kind: "root", root: "/srv/team" },
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
      target: { kind: "root", root: "/srv/team" },
      username: "ada",
      overrides: { env: "staging" },
    });
  });

  it("rotates and lists keys", () => {
    expect(parseArgs(["key", "rotate", "--root", "/srv/team"])).toEqual({
      kind: "key-rotate",
      target: { kind: "root", root: "/srv/team" },
    });
    expect(parseArgs(["key", "list", "--root", "/srv/team"])).toEqual({
      kind: "key-list",
      target: { kind: "root", root: "/srv/team" },
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
      target: { kind: "root", root: "/srv/team" },
    });
  });

  it("reads a value in every duration a command line here takes", () => {
    expect(parseArgs(["settings", "set", SIGN_IN_LIFETIME_KEY, "7d", "--root", "/srv/team"])).toEqual(
      {
        kind: "settings-set",
        target: { kind: "root", root: "/srv/team" },
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
        target: { kind: "root", root: "/srv/team" },
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
      target: { kind: "root", root: "/srv/team" },
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
      target: { kind: "root", root: "/srv/team" },
    });
    // There is no per-account listing, because there is no per-account access.
    expect(messageFor(["project", "list", "--root", "/srv/team", "--as", "ada"])).toContain("--as");
  });

  it("puts an account in the admin group, and takes it out", () => {
    expect(parseArgs(["user", "grant-admin", "ada", "--root", "/srv/team"])).toEqual({
      kind: "user-set-admin",
      target: { kind: "root", root: "/srv/team" },
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

describe("parseArgs, naming a server rather than a storage root", () => {
  it("takes an address on the line, in the one spelling it is filed under", () => {
    expect(parseArgs(["project", "list", "--server", "Team.Example.LAN"])).toEqual({
      kind: "project-list",
      target: { kind: "server", server: "team.example.lan:41402" },
    });
  });

  it("lets NLTEAM_SERVER stand in for the flag, as every other variable does", () => {
    expect(parseArgs(["project", "list"], { NLTEAM_SERVER: "team.example.lan:41402" })).toEqual({
      kind: "project-list",
      target: { kind: "server", server: "team.example.lan:41402" },
    });
  });

  it("lets a flag beat a variable, either way round", () => {
    // The rule the whole environment layer is written to, applied across the
    // two halves rather than only within one of them: a flag is what somebody
    // typed just now, and a variable is what a container was configured with.
    expect(
      parseArgs(["project", "list", "--root", "/srv/team"], {
        NLTEAM_SERVER: "team.example.lan:41402",
      }),
    ).toEqual({ kind: "project-list", target: { kind: "root", root: "/srv/team" } });
    expect(
      parseArgs(["project", "list", "--server", "team.example.lan:41402"], {
        NLTEAM_ROOT: "/srv/team",
      }),
    ).toEqual({
      kind: "project-list",
      target: { kind: "server", server: "team.example.lan:41402" },
    });
  });

  it("refuses both, on the line and in the environment, rather than choosing", () => {
    expect(
      messageFor(["project", "list", "--root", "/srv/team", "--server", "team.example.lan"]),
    ).toContain("not both");
    expect(
      messageFor2(
        parseArgs(["project", "list"], {
          NLTEAM_ROOT: "/srv/team",
          NLTEAM_SERVER: "team.example.lan:41402",
        }),
      ),
    ).toContain("both set");
  });

  it("names both when a command line named neither", () => {
    const message = messageFor2(parseArgs(["project", "list"], {}));

    expect(message).toContain("--root");
    expect(message).toContain("--server");
  });

  it("still takes --root alone on the commands that rescue a server", () => {
    // up, init and trust reach a storage root and nothing else. A rescue that
    // could only be performed over the protocol would not be one.
    expect(messageFor(["up", "--server", "team.example.lan"])).toBe(
      "unknown argument: --server",
    );
    expect(messageFor(["init", "ada", "--server", "team.example.lan"])).toBe(
      "unknown argument: --server",
    );
    expect(messageFor(["trust", "--server", "team.example.lan"])).toBe(
      "unknown argument: --server",
    );
  });
});

describe("parseArgs, login and logout", () => {
  it("takes an address and the account to sign in as", () => {
    expect(parseArgs(["login", "team.example.lan:41402", "ada"])).toEqual({
      kind: "login",
      server: "team.example.lan:41402",
      username: "ada",
      fingerprint: undefined,
    });
    // The address a person is actually given, scheme and all.
    expect(parseArgs(["login", "nlteam://team.example.lan:41402", "ada"])).toMatchObject({
      server: "team.example.lan:41402",
    });
  });

  it("takes the authority to expect, on the line or in the environment", () => {
    expect(
      parseArgs(["login", "team.example.lan:41402", "ada", "--fingerprint", "AB:CD"]),
    ).toMatchObject({ fingerprint: "AB:CD" });
    // The deployment that most needs to name a fingerprint is the one that
    // composes no command line at all.
    expect(
      parseArgs(["login", "team.example.lan:41402", "ada"], { NLTEAM_FINGERPRINT: "AB:CD" }),
    ).toMatchObject({ fingerprint: "AB:CD" });
  });

  it("says which half of the command line is missing", () => {
    expect(messageFor(["login"])).toContain("address of a server");
    expect(messageFor(["login", "team.example.lan:41402"])).toContain("username");
    expect(messageFor(["logout"])).toContain("address of a server");
  });

  it("refuses an address that is not one, where the command line is read", () => {
    expect(messageFor(["login", "https://team.example.lan", "ada"])).toContain("scheme");
    expect(messageFor(["logout", "team.example.lan/projects"])).toContain("nothing after it");
  });

  it("forgets one server by address, in the same spelling login filed it under", () => {
    expect(parseArgs(["logout", "TEAM.example.lan"])).toEqual({
      kind: "logout",
      server: "team.example.lan:41402",
    });
  });
});
