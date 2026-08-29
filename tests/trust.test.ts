import { X509Certificate } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { run } from "../src/cli.js";
import { ensureCertificates, tlsLayout } from "../src/tls/authority.js";
import {
  installPlan,
  removePlan,
  runTrustCommand,
  trustCommandFor,
} from "../src/tls/trust.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-trust-");

/** Everything under a directory, with what each file holds and when it changed. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory);
  const state: Record<string, string> = {};
  for (const entry of entries.sort()) {
    const path = join(directory, entry);
    const info = await stat(path);
    state[entry] = `${await readFile(path, "utf8")}\n@${info.mtimeMs}\n#${info.mode}`;
  }
  return state;
}

/** Run one command line, collecting both streams. */
async function nlteam(argv: readonly string[]): Promise<{
  code: number;
  out: string;
  err: string;
}> {
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

describe("nlteam trust, with no arguments", () => {
  it("prints the fingerprint, and changes nothing", async () => {
    const root = await temporaryRoot();
    const certificates = await ensureCertificates(root);
    const layout = tlsLayout(root);
    const before = await snapshot(layout.tlsDir);

    const { code, out, err } = await nlteam(["trust", "--root", root]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(certificates.authority.fingerprint256);
    expect(out).toContain(layout.caCertPath);
    expect(out).toContain("Nothing has been changed.");
    // Not a claim about the trust store, which a test cannot check without
    // changing it: this is the weaker thing that can be checked, which is that
    // the command wrote nothing, including a certificate it might have made
    // for itself if the authority had been missing.
    expect(await snapshot(layout.tlsDir)).toEqual(before);
  });

  it("prints the command for this platform, so it can be run by hand", async () => {
    const root = await temporaryRoot();
    await ensureCertificates(root);
    const plan = installPlan(tlsLayout(root).caCertPath);

    const { out } = await nlteam(["trust", "--root", root]);

    expect(out).toContain(plan.command);
    if (plan.support === "runs-here") {
      expect(out).toContain("nlteam trust --install runs that for you.");
    }
  });

  it("prints the fingerprint node reports for the same file", async () => {
    const root = await temporaryRoot();
    await ensureCertificates(root);
    const layout = tlsLayout(root);
    const certificate = new X509Certificate(await readFile(layout.caCertPath, "utf8"));

    const { out } = await nlteam(["trust", "--root", root]);

    expect(out).toContain(certificate.fingerprint256);
  });

  it("says so when there is no authority, rather than making one", async () => {
    const root = await temporaryRoot();

    const { code, err } = await nlteam(["trust", "--root", root]);

    expect(code).toBe(1);
    expect(err).toContain("has no certificate authority");
    // Printing a fingerprint must not be the act that decides what the
    // fingerprint is.
    await expect(stat(tlsLayout(root).tlsDir)).rejects.toThrow();
  });
});

describe("the trust command line", () => {
  it("needs a root, like everything that keeps state", () => {
    expect(parseArgs(["trust"])).toEqual({
      kind: "error",
      message: "trust needs --root <path> or NLTEAM_ROOT, the directory Team keeps its files in",
    });
  });

  it("takes one of --install and --remove", () => {
    expect(parseArgs(["trust", "--root", "/srv/team"])).toEqual({
      kind: "trust",
      root: "/srv/team",
      install: false,
      remove: false,
    });
    expect(parseArgs(["trust", "--root", "/srv/team", "--install"])).toEqual({
      kind: "trust",
      root: "/srv/team",
      install: true,
      remove: false,
    });
    expect(parseArgs(["trust", "--root", "/srv/team", "--install", "--remove"])).toEqual({
      kind: "error",
      message: "trust takes --install or --remove, not both",
    });
  });
});

/**
 * What each platform is asked to do, on every platform.
 *
 * These used to be one test with a `switch (process.platform)` in it, which
 * meant each branch was read back on exactly one kind of machine: win32 on a
 * Windows workstation, the Linux branch on CI, and darwin nowhere at all. The
 * macOS commands are the ones a person is asked to trust with their account
 * password, and no automated run anywhere had ever looked at them.
 *
 * So the platform is an argument now, and all three answers are checked
 * wherever this runs.
 */
describe("what each platform is asked to do", () => {
  /** A certificate to name, and a path to put in a command. */
  async function authority(): Promise<{ path: string; certificate: X509Certificate }> {
    const root = await temporaryRoot();
    const certificates = await ensureCertificates(root);
    return {
      path: tlsLayout(root).caCertPath,
      certificate: certificates.authority.certificate,
    };
  }

  it("installs for the current account on Windows, in the store a chain is built to", async () => {
    const { path, certificate } = await authority();
    const install = installPlan(path, "win32");
    const remove = removePlan(path, certificate, "win32");

    // -user, and the Root store: anywhere else is a certificate the machine
    // holds and trusts for nothing.
    expect(install.argv).toEqual(["certutil", "-user", "-addstore", "Root", path]);
    // By thumbprint, because two Team servers on one machine share a subject
    // and deleting by name would take out whichever was found first.
    expect(remove.argv).toEqual([
      "certutil",
      "-user",
      "-delstore",
      "Root",
      certificate.fingerprint.replaceAll(":", ""),
    ]);
    // Both are warned about before the command starts. Removing is the one that
    // certainly opens a dialog on Windows - adding was measured not to - and a
    // command waiting on a window behind this one looks hung.
    expect(install.interaction).toContain("confirm");
    expect(remove.interaction).toContain("confirm");
    expect(install.support).toBe("runs-here");
  });

  it("installs into the login keychain on macOS, as a root rather than a copy", async () => {
    const { path, certificate } = await authority();
    const install = installPlan(path, "darwin");
    const remove = removePlan(path, certificate, "darwin");

    // No -d: that is the admin store, and it needs root. `-r trustRoot` is what
    // makes this a trusted root rather than a certificate merely held.
    expect(install.argv).toEqual(["security", "add-trusted-cert", "-r", "trustRoot", path]);
    expect(remove.argv).toEqual(["security", "remove-trusted-cert", path]);
    // The password prompt is a window of its own and can open behind this one.
    expect(install.interaction).toContain("password");
    expect(remove.interaction).toContain("password");
    expect(install.support).toBe("runs-here");
    expect(remove.support).toBe("runs-here");
  });

  it("only prints on Linux, because the store that works needs root", async () => {
    const { path, certificate } = await authority();
    const install = installPlan(path, "linux");
    const remove = removePlan(path, certificate, "linux");

    // There is a per-user NSS database Firefox and Chrome read, and it is not
    // what other programs use. The machine-wide directory is the one that
    // works, so nothing is run and both commands are printed instead.
    expect(install.support).toBe("print-only");
    expect(remove.support).toBe("print-only");
    expect(install.argv).toEqual([]);
    expect(remove.argv).toEqual([]);
    expect(install.command).toContain("/usr/local/share/ca-certificates/");
    expect(install.command).toContain("update-ca-certificates");
    // --fresh on the way out: without it the store keeps what it already read,
    // and removing the file changes nothing until something rebuilds it.
    expect(remove.command).toContain("update-ca-certificates --fresh");
    // Nothing is started, so there is nothing to warn about waiting on.
    expect(install.interaction).toBeUndefined();
    expect(remove.interaction).toBeUndefined();
  });

  it("quotes a path with a space for the shell it will be pasted into", () => {
    const spaced = "/tmp/a directory/ca.crt";

    // A POSIX shell needs single quotes, and Windows' own command line needs
    // double ones. Neither understands the other's.
    expect(installPlan(spaced, "darwin").command).toContain(`'${spaced}'`);
    expect(installPlan(spaced, "linux").command).toContain(`'${spaced}'`);
    // Raw, because in an ordinary string the backslashes would be escapes and
    // both sides of this would be wrong the same way and agree with each other.
    const windows = String.raw`C:\Program Files\ca.crt`;
    expect(installPlan(windows, "win32").command).toContain(`"${windows}"`);
    // And a path needing no quoting is left alone, so the usual case reads as
    // something a person can retype.
    expect(installPlan("/tmp/plain/ca.crt", "linux").command).toContain("/tmp/plain/ca.crt");
    expect(installPlan("/tmp/plain/ca.crt", "linux").command).not.toContain("'");
  });

  it("names the command where there is one, and what prints it where there is not", () => {
    // Where Team can carry it out, a message mentioning trust in passing can
    // say exactly what to type.
    expect(trustCommandFor("/tmp/ca.crt", "darwin")).toBe(
      "security add-trusted-cert -r trustRoot /tmp/ca.crt",
    );
    // Where it cannot, the two-line Linux recipe would be a paragraph in the
    // middle of somebody else's sentence, so it points at the command that
    // prints it instead.
    expect(trustCommandFor("/tmp/ca.crt", "linux")).toBe(
      "nlteam trust --install (it will print what to run)",
    );
  });
});

describe("running one of those commands", () => {
  it("keeps both streams together, because these programs use either", async () => {
    const outcome = await runTrustCommand([
      process.execPath,
      "-e",
      "process.stdout.write('added'); process.stderr.write('and a note')",
    ]);

    expect(outcome.code).toBe(0);
    // An operator watching a trust store change should see what the operating
    // system said about it, whichever stream it chose to say it on.
    expect(outcome.output).toContain("added");
    expect(outcome.output).toContain("and a note");
  });

  it("reports a refusal as its exit code rather than raising", async () => {
    const outcome = await runTrustCommand([process.execPath, "-e", "process.exit(3)"]);

    expect(outcome.code).toBe(3);
  });

  it("says what could not be run, and that it is part of the operating system", async () => {
    await expect(runTrustCommand(["nlteam-certainly-not-a-program", "--install"])).rejects.toThrow(
      /could not be run.*part of the operating system/s,
    );
  });

  it("refuses an empty command rather than spawning nothing", async () => {
    // The Linux plans carry no argv at all, and asking to run one of those is a
    // mistake in the caller rather than a failure of the machine.
    await expect(runTrustCommand([])).rejects.toThrow("no command to run on this platform");
  });
});
