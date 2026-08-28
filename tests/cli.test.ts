import { describe, expect, it } from "vitest";

import { USAGE, run } from "../src/cli.js";

/** Runs a command line and collects everything written to each stream. */
async function invoke(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

describe("run", () => {
  it("prints the version alone, so a script can read it unedited", async () => {
    const { code, out, err } = await invoke(["--version"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    // The exact number moves with every release; that it stands by itself,
    // with no label and no second line, is the part callers depend on.
    expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("prints usage for --help and succeeds", async () => {
    const { code, out, err } = await invoke(["--help"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`${USAGE}\n`);
    expect(out).toContain("Usage: nlteam");
  });

  it("documents taking an account's tokens away without disabling it", async () => {
    const { out } = await invoke(["--help"]);

    expect(out).toContain("user revoke-tokens <username>");
  });

  it("says how long a sign-in token lasts in a unit somebody would type", async () => {
    const { out } = await invoke(["--help"]);

    // Thirty days, said as thirty days. The same number in the minutes the
    // one-lifetime version printed is "43200m", which is correct and which
    // nobody can compare with what they set.
    expect(out).toContain("--token-lifetime");
    expect(out).toContain("30 days");
    expect(out).not.toContain("43200");
  });

  it("documents changing a setting from a command line, and names the keys", async () => {
    const { out } = await invoke(["--help"]);

    // The lifetimes are settings a person changes from a command line,
    // which left them unreachable over ssh and from a script.
    expect(out).toContain("settings list");
    expect(out).toContain("settings set <key> <value>");
    expect(out).toContain("token.sign_in_lifetime_seconds");
    expect(out).toContain("token.repository_lifetime_seconds");
  });

  it("documents recording a repository that already exists, and what it is for", async () => {
    const { out } = await invoke(["--help"]);

    // Not discoverable by trying it, and the moment somebody wants it is the
    // moment a project has gone off a list — so the help says what taking one
    // off leaves behind rather than only naming the flag.
    expect(out).toContain("--repository <id>");
    expect(out).toContain("Thirty-two");
    expect(out).toContain("repository and every revision in it where they were");
    expect(out).toContain("Both paths take");
  });

  it("documents the up command and its options", async () => {
    const { out } = await invoke(["--help"]);

    expect(out).toContain("up");
    expect(out).toContain("--root");
    expect(out).toContain("--data-port");
    expect(out).toContain("--health-port");
  });

  it("documents signing in to a server, and where the credentials go", async () => {
    const { out } = await invoke(["--help"]);

    // Where a token is kept is not a detail: it is what somebody has to back
    // up, mount into a container, or delete when they leave a machine.
    expect(out).toContain("login <server> <username>");
    expect(out).toContain("logout <server>");
    expect(out).toContain("--fingerprint <sha256>");
    expect(out).toContain("NLTEAM_CONFIG_DIR");
    expect(out).toContain("%APPDATA%\\nlteam");
    expect(out).toContain("~/.config/nlteam");
  });

  it("documents --server beside --root, and which commands take only one", async () => {
    const { out } = await invoke(["--help"]);

    expect(out).toContain("--server <host:port>");
    expect(out).toContain("NLTEAM_SERVER");
    // The rescue commands are named as such, because a reader deciding how to
    // administer a server from elsewhere needs to know what still cannot be.
    expect(out).toContain("up, init and trust take --root alone");
    expect(out).toContain("Every command above except up, init and trust");
  });

  it("names the one place the two paths ask for different things", async () => {
    const { out } = await invoke(["--help"]);

    // Not a defect, and not discoverable by trying it: a person scripting token
    // mint has to know before they pipe a password at it.
    expect(out).toContain("token mint --server");
    expect(out).toContain("reads none");
    // The listing used to be the second of these, and is not any more: a server
    // says whether a value was chosen, so both paths print the same third
    // column and there is nothing left to warn anybody about.
    expect(out).not.toContain("leaves the last column blank");
  });

  it("says where a password goes on the path that sends one over a session", async () => {
    const { out } = await invoke(["--help"]);

    expect(out).toContain("user create --server sends the password over the session");
    expect(out).toContain("never from an argument");
  });

  it("fails with one line on stderr for an unknown argument", async () => {
    const { code, out, err } = await invoke(["--nonsense"]);

    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err).toBe("nlteam: unknown argument: --nonsense\n");
  });

  it("rejects an unusable up command line before it touches anything", async () => {
    // No root means no storage to create and nothing to download, so this
    // returns without a network request or a directory appearing anywhere.
    const { code, out, err } = await invoke(["up"]);

    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("--root");
  });
});
