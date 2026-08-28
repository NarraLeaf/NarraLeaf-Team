import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WriteText } from "../src/cli.js";
import { DEFAULT_IDENTITY, identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import {
  InvalidServerNameError,
  InvalidSettingError,
  InvalidStoredIdentityError,
  isSettingStored,
  MAXIMUM_SERVER_NAME_LENGTH,
  MAXIMUM_TOKEN_LIFETIME_SECONDS,
  MINIMUM_TOKEN_LIFETIME_SECONDS,
  namedTokenLifetimes,
  persistIdentity,
  REPOSITORY_LIFETIME_KEY,
  PUBLISH_LINEAGE_KEY,
  SERVER_NAME_KEY,
  storedPublishLineage,
  setServerName,
  setTokenLifetimes,
  SIGN_IN_LIFETIME_KEY,
  storedIdentity,
  storedServerName,
  storedTokenLifetimes,
} from "../src/identity/settings.js";
import { settingsList, settingsSet } from "../src/settings.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-settings-");

/** Run one of the commands and collect both its streams. */
async function invoke(
  command: (stdout: WriteText, stderr: WriteText) => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await command(
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

const open: DatabaseSync[] = [];

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

/** Put a value in the table directly, the way an operator with the file could. */
function store(connection: DatabaseSync, key: string, value: string): void {
  connection
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, value, Date.now());
}

describe("storedTokenLifetimes", () => {
  it("answers with the defaults on a Team server where nobody has stored anything", async () => {
    const connection = await database();

    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
    // The two numbers themselves, because the asymmetry is the point: a token
    // Team is asked about again can last a month, and one loreserver's data
    // plane checks for itself has nothing but its expiry to bound it.
    expect(DEFAULT_IDENTITY.signInTokenLifetimeSeconds).toBe(30 * 24 * 60 * 60);
    expect(DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds).toBe(15 * 60);
  });

  it("reads back a value that has been stored, and leaves the other at its default", async () => {
    const connection = await database();

    setTokenLifetimes(connection, { signInTokenLifetimeSeconds: 7 * 24 * 60 * 60 });

    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: 7 * 24 * 60 * 60,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
  });

  it("replaces a value rather than making a second row for the same setting", async () => {
    const connection = await database();

    setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 300 });
    setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 600 });

    expect(storedTokenLifetimes(connection).repositoryTokenLifetimeSeconds).toBe(600);
    expect(connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({
      count: 1,
    });
  });

  it("refuses a stored value that is not a number of seconds", async () => {
    const connection = await database();
    // Nothing Team writes could put this here. Whoever has the storage root has
    // the SQLite file, and a value read back as NaN would reach a token's `exp`
    // and issue it already expired, from a Team server saying nothing is wrong.
    store(connection, SIGN_IN_LIFETIME_KEY, "an hour or so");

    expect(() => storedTokenLifetimes(connection)).toThrow(InvalidSettingError);
  });

  it("refuses a stored number outside the range it would have accepted", async () => {
    const connection = await database();
    store(connection, REPOSITORY_LIFETIME_KEY, String(MINIMUM_TOKEN_LIFETIME_SECONDS - 1));

    expect(() => storedTokenLifetimes(connection)).toThrow(InvalidSettingError);
  });
});

describe("setTokenLifetimes", () => {
  it("refuses a lifetime shorter or longer than one Team server will store", async () => {
    const connection = await database();

    expect(() => setTokenLifetimes(connection, { signInTokenLifetimeSeconds: 0 })).toThrow(
      InvalidSettingError,
    );
    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: MINIMUM_TOKEN_LIFETIME_SECONDS - 1,
      }),
    ).toThrow(InvalidSettingError);
    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: MAXIMUM_TOKEN_LIFETIME_SECONDS + 1,
      }),
    ).toThrow(InvalidSettingError);
    expect(() => setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 90.5 })).toThrow(
      InvalidSettingError,
    );
  });

  it("names the setting it would not take, not merely the number", async () => {
    const connection = await database();

    expect(() => setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 1 })).toThrow(
      new RegExp(REPOSITORY_LIFETIME_KEY.replace(".", "\.")),
    );
  });

  it("writes neither when one of a pair is refused", async () => {
    const connection = await database();

    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: 3600,
        repositoryTokenLifetimeSeconds: 1,
      }),
    ).toThrow(InvalidSettingError);

    // Half of a change is worse than none of one: an operator who saw the
    // failure would have no reason to go and look at the other setting.
    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
  });

  it("hands back the pair as it stands after the write", async () => {
    const connection = await database();

    expect(setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 120 })).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: 120,
    });
  });
});

describe("nlteam settings list", () => {
  it("says what each setting is, and whether anybody chose it", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsList({ root }, stdout, stderr),
    );

    expect(code).toBe(0);
    expect(err).toBe("");
    // Pinned in full. The durations are in the words somebody would have typed
    // rather than the seconds the keys are named for, and the last column is
    // the difference between a value that was chosen and one that has never
    // been touched — which is the difference between a Team server that keeps this
    // number through an upgrade and one that follows the default.
    expect(out).toBe(
      "server.name                        the server's host  default\n" +
        "server.collaboration               open               default\n" +
        "project.publish_lineage            merge              default\n" +
        "token.sign_in_lifetime_seconds     30 days            default\n" +
        "token.repository_lifetime_seconds  15 minutes         default\n",
    );
  });

  it("says a value was set here once somebody has set it", async () => {
    const root = await temporaryRoot();
    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 5 * 60 });
    connection.close();

    const { out } = await invoke((stdout, stderr) => settingsList({ root }, stdout, stderr));

    expect(out).toContain("token.repository_lifetime_seconds  5 minutes          set here");
    expect(out).toContain("token.sign_in_lifetime_seconds     30 days            default");
  });
});

describe("nlteam settings set", () => {
  it("says what the setting now is, what it was, and what the change does not reach", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet(
        { root, change: { key: SIGN_IN_LIFETIME_KEY, seconds: 7 * 24 * 60 * 60 } },
        stdout,
        stderr,
      ),
    );

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(
      "token.sign_in_lifetime_seconds is 7 days, and was 30 days\n" +
        "Tokens already minted keep the lifetime they were given.\n",
    );
  });

  it("adds the one thing about the repository lifetime that is not obvious", async () => {
    const root = await temporaryRoot();

    const { out } = await invoke((stdout, stderr) =>
      settingsSet(
        { root, change: { key: REPOSITORY_LIFETIME_KEY, seconds: 5 * 60 } },
        stdout,
        stderr,
      ),
    );

    expect(out).toBe(
      "token.repository_lifetime_seconds is 5 minutes, and was 15 minutes\n" +
        "Tokens already minted keep the lifetime they were given.\n" +
        "loreserver accepts this one without asking Team, so revoking access cannot cut it " +
        "short.\n",
    );
  });

  it("writes the value where a running Team reads it from", async () => {
    const root = await temporaryRoot();

    await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: SIGN_IN_LIFETIME_KEY, seconds: 3600 } }, stdout, stderr),
    );

    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      expect(storedTokenLifetimes(connection).signInTokenLifetimeSeconds).toBe(3600);
    } finally {
      connection.close();
    }
  });

  it("refuses a lifetime outside the range, and changes nothing", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: SIGN_IN_LIFETIME_KEY, seconds: 1 } }, stdout, stderr),
    );

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain(SIGN_IN_LIFETIME_KEY);

    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      expect(storedTokenLifetimes(connection).signInTokenLifetimeSeconds).toBe(
        DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      );
    } finally {
      connection.close();
    }
  });
});

describe("the deployment identity a token's audience depends on", () => {
  it("is empty on a server that has never been brought up", async () => {
    const connection = await database();

    // Nothing stored, so nothing is named and the defaults answer for all of
    // it. A token minted from this carries the loopback, which is right for a
    // machine nobody else reaches.
    expect(storedIdentity(connection)).toEqual({});
  });

  it("reads back what was persisted, and only that", async () => {
    const connection = await database();

    persistIdentity(
      connection,
      identityConfig({
        issuer: "team.example.com",
        audience: "lore",
        authOrigin: "team.example.com:41402",
        env: "staging",
        idp: "example",
        teamPort: 41500,
        authTlsPort: 41502,
        dataPort: 41337,
        hostnames: ["team.example.com", "team.internal"],
      }),
    );

    expect(storedIdentity(connection)).toEqual({
      issuer: "team.example.com",
      audience: "lore",
      authOrigin: "team.example.com:41402",
      env: "staging",
      idp: "example",
      teamPort: 41500,
      authTlsPort: 41502,
      dataPort: 41337,
      hostnames: ["team.example.com", "team.internal"],
    });
  });

  it("refreshes rather than adding a second row for the same setting", async () => {
    const connection = await database();

    persistIdentity(connection, identityConfig({ hostnames: ["old.example.com"] }));
    persistIdentity(connection, identityConfig({ hostnames: ["new.example.com"] }));

    expect(storedIdentity(connection).hostnames).toEqual(["new.example.com"]);
    // Nine settings, one row each, however many times they are written.
    expect(connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({
      count: 9,
    });
  });

  it("reads an empty host list back as an empty list, not as unset", async () => {
    const connection = await database();

    persistIdentity(connection, identityConfig({}));

    // The auth origin's own host is the only one, so no host was named beyond
    // it: that is an answer, and it round-trips as one rather than reverting to
    // whatever a default might be.
    expect(storedIdentity(connection).hostnames).toEqual([]);
  });

  it("refuses stored port text that is not a port, rather than naming a wrong address", async () => {
    const connection = await database();
    // Nothing Team writes could put this here; whoever has the storage root has
    // the file. A port read back as nonsense would reach a token's audience.
    store(connection, "identity.data_port", "not a port");

    expect(() => storedIdentity(connection)).toThrow(InvalidStoredIdentityError);
  });

  it("refuses a stored port outside the range a listener accepts", async () => {
    const connection = await database();
    store(connection, "identity.data_port", "70000");

    expect(() => storedIdentity(connection)).toThrow(InvalidStoredIdentityError);
  });
});

describe("namedTokenLifetimes", () => {
  it("keeps the lifetimes a command line named and nothing else about it", () => {
    expect(namedTokenLifetimes({ signInTokenLifetimeSeconds: 300, issuer: "elsewhere" })).toEqual({
      signInTokenLifetimeSeconds: 300,
    });
  });

  it("is empty when a command line named neither", () => {
    // Which is what lets it be spread over the stored settings without hiding
    // them: an empty object changes nothing, and `undefined` values would.
    expect(namedTokenLifetimes({})).toEqual({});
  });
});

describe("the name a server calls itself", () => {
  it("is the host it is reached at until somebody chooses one", async () => {
    const connection = await database();

    // No row, and therefore no name of its own. The fallback is handed in
    // rather than worked out here, because who this server is reached as is a
    // fact about the deployment rather than about the setting.
    expect(storedServerName(connection, "team.example.lan")).toBe("team.example.lan");
    expect(isSettingStored(connection, SERVER_NAME_KEY)).toBe(false);
  });

  it("is what was chosen, once somebody has", async () => {
    const connection = await database();

    expect(setServerName(connection, "Winterlight")).toBe("Winterlight");
    expect(storedServerName(connection, "team.example.lan")).toBe("Winterlight");
    expect(isSettingStored(connection, SERVER_NAME_KEY)).toBe(true);
  });

  it("is stored without the spaces around it", async () => {
    const connection = await database();

    expect(setServerName(connection, "  Winterlight  ")).toBe("Winterlight");
    expect(storedServerName(connection, "elsewhere")).toBe("Winterlight");
  });

  it("refuses a name that is nothing, however it was written", async () => {
    const connection = await database();

    expect(() => setServerName(connection, "")).toThrow(InvalidServerNameError);
    expect(() => setServerName(connection, "   ")).toThrow(InvalidServerNameError);
    expect(isSettingStored(connection, SERVER_NAME_KEY)).toBe(false);
  });

  it("refuses one longer than a label", async () => {
    const connection = await database();
    const longest = "n".repeat(MAXIMUM_SERVER_NAME_LENGTH);

    expect(setServerName(connection, longest)).toBe(longest);
    expect(() => setServerName(connection, `${longest}n`)).toThrow(InvalidServerNameError);
    // The refused one changed nothing: what is stored is still the name that
    // was accepted.
    expect(storedServerName(connection, "elsewhere")).toBe(longest);
  });

  it("refuses control characters, which are one interface writing another's lines", async () => {
    const connection = await database();

    expect(() => setServerName(connection, "Winter\nlight")).toThrow(InvalidServerNameError);
    expect(() => setServerName(connection, "Winter\u001b[31mlight")).toThrow(
      InvalidServerNameError,
    );
    // Every other alphabet is a name somebody calls a deployment by.
    expect(setServerName(connection, "\u51ac\u306e\u5149")).toBe("\u51ac\u306e\u5149");
  });

  it("falls back to the host rather than raising over a stored name nobody can use", async () => {
    const connection = await database();
    // Nothing Team writes could put this here; whoever has the storage root has
    // the file. Refusing to answer would take out the document that says where
    // to sign in, over a caption - which is the opposite of what a lifetime
    // read back as nonsense does, and deliberately.
    store(connection, SERVER_NAME_KEY, "  ");

    expect(storedServerName(connection, "team.example.lan")).toBe("team.example.lan");
  });
});

describe("nlteam settings set, on the name", () => {
  it("says what it now is, what it was, and that nothing has to be restarted", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: SERVER_NAME_KEY, name: "Winterlight" } }, stdout, stderr),
    );

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(
      "server.name is Winterlight, and was the server's host\n" +
        "The next client to read this server's address is told the new name; nothing is " +
        "restarted.\n",
    );
  });

  it("says a name was set here once somebody has set one", async () => {
    const root = await temporaryRoot();
    await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: SERVER_NAME_KEY, name: "Winterlight" } }, stdout, stderr),
    );

    const { out } = await invoke((stdout, stderr) => settingsList({ root }, stdout, stderr));

    // Every column lines up whatever a name is: the widest value there is
    // decides the column, rather than a number chosen for two durations.
    expect(out).toContain("server.name                        Winterlight   set here");
    expect(out).toContain("token.sign_in_lifetime_seconds     30 days       default");
  });

  it("refuses a name it will not store, and changes nothing", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: SERVER_NAME_KEY, name: "  " } }, stdout, stderr),
    );

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("cannot be this server's name");

    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      expect(isSettingStored(connection, SERVER_NAME_KEY)).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("stores the rule for a repository this server already holds", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet({ root, change: { key: PUBLISH_LINEAGE_KEY, rule: "refuse" } }, stdout, stderr),
    );

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("project.publish_lineage is refuse, and was merge");
    // The one thing an operator would otherwise learn by watching somebody
    // publish: nothing restarts, and a machine already open picks it up when it
    // next reads this server.
    expect(out).toContain("the next time it looks");

    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      expect(storedPublishLineage(connection)).toBe("refuse");
    } finally {
      connection.close();
    }
  });

  it("refuses a rule that is neither of the two, and changes nothing", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await invoke((stdout, stderr) =>
      settingsSet(
        // Past the command line's own check, which is where a person's typing is
        // caught. This is the other half: the store answers the same question, so
        // that a caller reaching it another way cannot put a word here that
        // everything downstream would read as neither rule.
        { root, change: { key: PUBLISH_LINEAGE_KEY, rule: "ask" as "merge" } },
        stdout,
        stderr,
      ),
    );

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("is one of merge or refuse");

    const connection = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      expect(isSettingStored(connection, PUBLISH_LINEAGE_KEY)).toBe(false);
      // And what it answers meanwhile is the default rather than nothing.
      expect(storedPublishLineage(connection)).toBe("merge");
    } finally {
      connection.close();
    }
  });
});
