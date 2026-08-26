import { X509Certificate } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { run } from "../src/cli.js";
import { ensureCertificates, tlsLayout } from "../src/tls/authority.js";
import { installPlan, removePlan } from "../src/tls/trust.js";
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

describe("what each platform is asked to do", () => {
  it("installs for the current account rather than for the machine", async () => {
    const root = await temporaryRoot();
    const certificates = await ensureCertificates(root);
    const layout = tlsLayout(root);
    const install = installPlan(layout.caCertPath);
    const remove = removePlan(layout.caCertPath, certificates.authority.certificate);

    switch (process.platform) {
      case "win32":
        // -user, and the Root store: anywhere else is a certificate the
        // machine holds and trusts for nothing.
        expect(install.argv).toEqual([
          "certutil",
          "-user",
          "-addstore",
          "Root",
          layout.caCertPath,
        ]);
        // By thumbprint, because two Team servers on one machine share a subject and
        // deleting by name would take out whichever was found first.
        expect(remove.argv).toEqual([
          "certutil",
          "-user",
          "-delstore",
          "Root",
          certificates.authority.certificate.fingerprint.replaceAll(":", ""),
        ]);
        // Both are warned about before the command starts. Removing is the one
        // that certainly opens a dialog on Windows — adding was measured not to
        // — and a command waiting on a window behind this one looks hung.
        expect(install.interaction).toContain("confirm");
        expect(remove.interaction).toContain("confirm");
        break;
      case "darwin":
        // No -d: that is the admin store, and it needs root.
        expect(install.argv).toEqual([
          "security",
          "add-trusted-cert",
          "-r",
          "trustRoot",
          layout.caCertPath,
        ]);
        expect(install.interaction).toContain("password");
        break;
      default:
        // Nothing is run, because there is no per-user store other programs
        // read and the machine-wide one needs root.
        expect(install.support).toBe("print-only");
        expect(install.command).toContain("update-ca-certificates");
        expect(install.argv).toEqual([]);
    }
  });
});
