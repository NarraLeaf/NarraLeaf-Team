// The two variables the version control library reads out of the environment.
//
// The regression this file exists for: Lore keeps signed-in sessions in one
// store per machine and per user, and selects one **by the host of the remote**
// rather than by the server it belongs to. A machine that has run two Team
// servers therefore has two sessions for `127.0.0.1`, and the client picks
// whichever it likes. When it picks the other one, loreserver has no signing
// key for the token, refuses the repository lookup, and the client reports "Not
// authorized to access repository" — before Team is asked anything, which is
// why the server's authorization log is empty while every project on it reads
// as unknown.
//
// So the assertion that matters here is the dull one: the store Team signs in
// through is under the storage root and belongs to that root alone. There is
// nothing to reproduce in a unit test about what the native library does with a
// shared one; what can be asserted is that Team never asks it to.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIALS_VARIABLE,
  credentialsDir,
  FILE_KEY_STORE,
  KEY_STORE_VARIABLE,
  prepareLoreEnvironment,
  TRUST_ANCHOR_VARIABLE,
} from "../src/lore/environment.js";
import { tlsLayout } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-loreenv-");

/**
 * A root that has been brought up, as far as this cares.
 *
 * The file's contents are never read here — rustls reads it, on each
 * connection, in another process's worth of native code. What Team decides is
 * the name, and whether there is anything at that name to point at.
 */
async function withAuthority(root: string): Promise<string> {
  const { tlsDir, caCertPath } = tlsLayout(root);
  await mkdir(tlsDir, { recursive: true });
  await writeFile(caCertPath, "-----BEGIN CERTIFICATE-----\n", "utf8");
  return caCertPath;
}

describe("the environment the version control library is given", () => {
  it("signs in through a store of this root's own, not the one the machine shares", async () => {
    const root = await temporaryRoot();
    await withAuthority(root);
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareLoreEnvironment(root, env);

    expect(prepared.credentials).toBe(credentialsDir(root));
    expect(env[CREDENTIALS_VARIABLE]).toBe(credentialsDir(root));
    // Under this root and nowhere else: two Team servers on one machine must
    // not be able to reach each other's sessions, which is the whole defect.
    expect(credentialsDir(root).startsWith(root)).toBe(true);
    // And it exists, because the library is handed the name and does not make
    // the directory itself.
    expect((await stat(credentialsDir(root))).isDirectory()).toBe(true);
  });

  it("keeps the session key in that store rather than the platform's secret store", async () => {
    // Left to itself lorelib keeps the key in the macOS login keychain and
    // rewrites it on every sign-in. A server process the keychain does not
    // recognise then waits on a system dialog nobody is watching, and every
    // Studio call behind it times out as "offline".
    const root = await temporaryRoot();
    await withAuthority(root);
    const env: NodeJS.ProcessEnv = {};

    prepareLoreEnvironment(root, env);

    expect(env[KEY_STORE_VARIABLE]).toBe(FILE_KEY_STORE);
  });

  it("keeps an operator's key store when they named one", async () => {
    const root = await temporaryRoot();
    await withAuthority(root);
    const env: NodeJS.ProcessEnv = { [KEY_STORE_VARIABLE]: "keyring" };

    prepareLoreEnvironment(root, env);

    expect(env[KEY_STORE_VARIABLE]).toBe("keyring");
    expect(env[CREDENTIALS_VARIABLE]).toBe(credentialsDir(root));
  });

  it("trusts this server's own authority, which no trust store on earth holds", async () => {
    const root = await temporaryRoot();
    const caCertPath = await withAuthority(root);
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareLoreEnvironment(root, env);

    expect(prepared.trustAnchor).toBe(caCertPath);
    expect(env[TRUST_ANCHOR_VARIABLE]).toBe(caCertPath);
    expect(prepared.withoutAuthority).toBeUndefined();
  });

  it("trusts the bundle up wrote when a certificate was supplied", async () => {
    // This process reaches its own sign-in endpoint by the public name, which
    // is answered with the supplied certificate: the authority alone was
    // measured to fail with `tlsv1 alert unknown ca` on every read.
    const root = await temporaryRoot();
    await withAuthority(root);
    const bundle = join(tlsLayout(root).tlsDir, "loreserver-trust.pem");
    await writeFile(bundle, "-----BEGIN CERTIFICATE-----\n", "utf8");
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareLoreEnvironment(root, env, bundle);

    expect(prepared.trustAnchor).toBe(bundle);
    expect(env[TRUST_ANCHOR_VARIABLE]).toBe(bundle);
  });

  it("falls back to the authority when the bundle named is not there", async () => {
    const root = await temporaryRoot();
    const caCertPath = await withAuthority(root);
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareLoreEnvironment(root, env, join(root, "missing.pem"));

    expect(prepared.trustAnchor).toBe(caCertPath);
  });

  it("leaves an operator's own settings exactly as they were", async () => {
    // Somebody who pointed either of these somewhere has a reason. Team
    // replacing it silently would be the same class of surprise this module
    // exists to remove.
    const root = await temporaryRoot();
    await withAuthority(root);
    const env: NodeJS.ProcessEnv = {
      [TRUST_ANCHOR_VARIABLE]: "/etc/ssl/theirs.pem",
      [CREDENTIALS_VARIABLE]: "/var/lib/lore",
    };

    const prepared = prepareLoreEnvironment(root, env);

    expect(env[TRUST_ANCHOR_VARIABLE]).toBe("/etc/ssl/theirs.pem");
    expect(env[CREDENTIALS_VARIABLE]).toBe("/var/lib/lore");
    // Their store may hold sessions sealed with a key in the platform's secret
    // store; moving the key would make every one of them unreadable.
    expect(env[KEY_STORE_VARIABLE]).toBeUndefined();
    expect(prepared.trustAnchor).toBeUndefined();
    expect(prepared.credentials).toBeUndefined();
    await expect(stat(credentialsDir(root))).rejects.toThrow();
  });

  it("says a root nobody has brought up has no authority to point at", async () => {
    // The failure this replaces was silent: the anchor was set inside the
    // reader's first pass, inside a catch, and a root with no certificates
    // meant a reader that quietly never worked.
    const root = await temporaryRoot();
    const env: NodeJS.ProcessEnv = {};

    const prepared = prepareLoreEnvironment(root, env);

    expect(prepared.trustAnchor).toBeUndefined();
    expect(env[TRUST_ANCHOR_VARIABLE]).toBeUndefined();
    expect(prepared.withoutAuthority).toMatch(/no certificate authority/i);
    // The store is still Team's own: it is not the authority's to withhold.
    expect(env[CREDENTIALS_VARIABLE]).toBe(credentialsDir(root));
  });

  it("is the same answer however many commands ask for it", async () => {
    const root = await temporaryRoot();
    const caCertPath = await withAuthority(root);
    const env: NodeJS.ProcessEnv = {};

    prepareLoreEnvironment(root, env);
    const again = prepareLoreEnvironment(root, env);

    // The second call finds what the first set and keeps it, which is what
    // makes it safe for `up` and the interface to call the same function.
    expect(env[TRUST_ANCHOR_VARIABLE]).toBe(caCertPath);
    expect(env[CREDENTIALS_VARIABLE]).toBe(credentialsDir(root));
    expect(again.trustAnchor).toBeUndefined();
    expect(again.credentials).toBeUndefined();
  });

  it("keeps the store beside the keys rather than inside the disposable cache", async () => {
    // `<root>/cache` is documented as deletable at any moment. A session in
    // there would make deleting it a sign-out, which is not what that promise
    // says.
    const root = await temporaryRoot();

    expect(credentialsDir(root)).not.toContain(`${join("cache", "projects")}`);
    expect(credentialsDir(root)).toBe(join(root, "credentials"));
  });
});
