/**
 * Phase G: two-step sign-in, API tokens, reset links, the call gate, audit
 * filters, the tar writer and reader, backups and restore, storage quotas, the
 * LDAP bind codec, and the OIDC id_token check.
 */
import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createGunzip } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { createBackup, exportProject, listBackups, PID_FILE, pruneBackups, restoreBackup, writePidFile } from "../src/backup.js";
import { recordBuild, storageRoom, storageView } from "../src/collab/builds.js";
import { createApiToken, identifyApiToken, listApiTokens, revokeApiToken } from "../src/identity/apitokens.js";
import { pageDecisions, recordDecision } from "../src/identity/audit.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { bindDnFor, bindRequest, bindResult, escapeDnValue } from "../src/identity/ldap.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { BUILD_LIMIT_MB, REQUIRE_TWO_FACTOR, setPolicy, STORAGE_QUOTA_MB } from "../src/identity/policy.js";
import { createPasswordReset, resetTarget, usePasswordReset } from "../src/identity/resets.js";
import { externalAccount, usernameFrom } from "../src/identity/sso.js";
import {
  base32Decode,
  base32Encode,
  beginTotp,
  confirmTotp,
  hotp,
  matchTotp,
  totpCode,
  totpState,
  verifySecondFactor,
} from "../src/identity/totp.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { extractTarGz, safeTarget, writeTarGzFile, type TarEntry } from "../src/tar.js";
import { gateCall } from "../src/team/session.js";
import { verifyIdToken } from "../src/web/consoleSecurity.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-security-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const PASSWORD = "a password nobody guesses";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  for (const username of ["ada", "eve"]) {
    await createUser(database, hasher, { username, password: PASSWORD });
  }
  const ada = requireUser(database, "ada");
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: ada.id });
  const other = createProject(database, { id: newProjectId(), name: "lighthouse", createdBy: ada.id });
  return { root, database, ada, eve: requireUser(database, "eve"), project, other };
}

/* -------------------------------------------------------------------- TOTP */

describe("two-step sign-in", () => {
  it("matches the RFC 6238 test vector and round-trips base32", () => {
    // RFC 6238, SHA-1, T = 59s: 94287082, of which an authenticator shows the last six.
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect(hotp(secret, 1)).toBe("287082");
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(totpCode(base32Encode(secret), 59_000)).toBe("287082");
  });

  it("takes a code one step either side, and no further", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const now = 1_000_000_000_000;
    expect(matchTotp(secret, totpCode(secret, now - 30_000), now)).toBeDefined();
    expect(matchTotp(secret, totpCode(secret, now + 30_000), now)).toBeDefined();
    expect(matchTotp(secret, totpCode(secret, now - 120_000), now)).toBeUndefined();
    expect(matchTotp(secret, "abc", now)).toBeUndefined();
  });

  it("is on only after a confirmed code, refuses a replayed code, and spends recovery codes once", async () => {
    const { database, ada } = await team();
    const secret = beginTotp(database, ada.id);
    const now = 1_700_000_000_000;
    expect(totpState(database, ada.id).enabled).toBe(false);
    expect(confirmTotp(database, ada.id, "000000", now)).toBeUndefined();
    const codes = confirmTotp(database, ada.id, totpCode(secret, now), now);
    expect(codes).toHaveLength(10);
    expect(totpState(database, ada.id).enabled).toBe(true);

    // The code that confirmed it was used; the same one is refused again.
    expect(verifySecondFactor(database, ada.id, totpCode(secret, now), now)).toBe(false);
    const later = now + 60_000;
    expect(verifySecondFactor(database, ada.id, totpCode(secret, later), later)).toBe(true);

    const recovery = codes?.[0] ?? "";
    expect(verifySecondFactor(database, ada.id, recovery, later)).toBe(true);
    expect(verifySecondFactor(database, ada.id, recovery, later)).toBe(false);
  });
});

/* -------------------------------------------------------------- API tokens */

describe("API tokens", () => {
  it("identify their account with their limits, expire, and stop when revoked", async () => {
    const { database, ada, project } = await team();
    const made = createApiToken(database, ada.id, { name: "export", projects: [project.id], write: false, expiresAt: 2_000 }, 1_000);
    expect(made.token.startsWith("nlt_")).toBe(true);
    const seen = identifyApiToken(database, made.token, 1_500);
    expect(seen.kind).toBe("identified");
    if (seen.kind === "identified") {
      expect(seen.user.username).toBe("ada");
      expect(seen.limits).toEqual({ projects: [project.id], write: false });
    }
    expect(identifyApiToken(database, made.token, 2_000).kind).toBe("refused");
    expect(identifyApiToken(database, "nlt_nothing", 1_500).kind).toBe("refused");

    const forever = createApiToken(database, ada.id, { name: "ci", write: true });
    expect(listApiTokens(database, ada.id).map((row) => row.name).sort()).toEqual(["ci", "export"]);
    expect(revokeApiToken(database, ada.id, forever.record.id)).toBe(true);
    expect(identifyApiToken(database, forever.token).kind).toBe("refused");
  });
});

/* ---------------------------------------------------------------- the gate */

describe("gateCall", () => {
  it("keeps a token to reading, to its projects, and off the management plane", async () => {
    const { database, ada, project, other } = await team();
    const limits = { projects: [project.id], write: false };
    expect(gateCall(database, ada, limits, "admin.users.list", {})).toMatch(/management plane/);
    expect(gateCall(database, ada, limits, "account.tokens.create", {})).toMatch(/management plane/);
    expect(gateCall(database, ada, limits, "todos.create", { project: project.id })).toMatch(/reads only/);
    expect(gateCall(database, ada, limits, "todos.list", { project: other.id })).toMatch(/does not reach/);
    expect(gateCall(database, ada, limits, "todos.list", { project: "harbour" })).toBeUndefined();
    expect(gateCall(database, ada, { write: true }, "todos.create", { project: other.id })).toBeUndefined();
  });

  it("holds an account without a second factor to setting one up while it is required", async () => {
    const { database, ada, project } = await team();
    expect(gateCall(database, ada, undefined, "todos.list", { project: project.id })).toBeUndefined();
    setPolicy(database, REQUIRE_TWO_FACTOR, "on");
    expect(gateCall(database, ada, undefined, "todos.list", { project: project.id })).toMatch(/two-step/);
    expect(gateCall(database, ada, undefined, "account.totp.begin", {})).toBeUndefined();
    const secret = beginTotp(database, ada.id);
    confirmTotp(database, ada.id, totpCode(secret));
    expect(gateCall(database, ada, undefined, "todos.list", { project: project.id })).toBeUndefined();
  });

  it("makes an archived project read-only but lets it be restored", async () => {
    const { database, ada, project } = await team();
    database.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(Date.now(), project.id);
    expect(gateCall(database, ada, undefined, "todos.create", { project: project.id })).toMatch(/archived/);
    expect(gateCall(database, ada, undefined, "todos.list", { project: project.id })).toBeUndefined();
    expect(gateCall(database, ada, undefined, "projects.restore", { project: project.id })).toBeUndefined();
  });
});

/* ------------------------------------------------------------- reset links */

describe("password reset links", () => {
  it("work once, within a day, and refuse a weak password", async () => {
    const { database, eve, ada } = await team();
    const now = 1_700_000_000_000;
    const link = createPasswordReset(database, eve.id, ada.id, now);
    expect(resetTarget(database, link.token, now)?.username).toBe("eve");
    expect(resetTarget(database, link.token, link.expiresAt)).toBeUndefined();
    expect((await usePasswordReset(database, hasher, link.token, "short", now)).kind).toBe("weak");
    expect((await usePasswordReset(database, hasher, link.token, "a brand new long password", now)).kind).toBe("done");
    expect((await usePasswordReset(database, hasher, link.token, "a brand new long password", now)).kind).toBe("gone");
  });

  it("spends an earlier link when a new one is made", async () => {
    const { database, eve } = await team();
    const first = createPasswordReset(database, eve.id, undefined);
    const second = createPasswordReset(database, eve.id, undefined);
    expect(resetTarget(database, first.token)).toBeUndefined();
    expect(resetTarget(database, second.token)?.username).toBe("eve");
  });
});

/* ------------------------------------------------------------ audit filter */

describe("audit filters", () => {
  it("filter by account, words, outcome and time", async () => {
    const { database } = await team();
    recordDecision(database, { username: "ada", resource: "project:harbour", allowed: true, detail: "archived", at: 1_000 });
    recordDecision(database, { username: "eve", resource: "project:harbour", allowed: false, detail: "write refused", at: 2_000 });
    recordDecision(database, { username: "eve", resource: "account:eve", allowed: true, detail: "reset link made", at: 3_000 });
    const names = (query: Parameters<typeof pageDecisions>[1]) => pageDecisions(database, query).decisions.map((row) => row.detail);
    expect(names({ limit: 10, username: "eve" })).toEqual(["reset link made", "write refused"]);
    expect(names({ limit: 10, action: "HARBOUR" })).toEqual(["write refused", "archived"]);
    expect(names({ limit: 10, allowed: false })).toEqual(["write refused"]);
    expect(names({ limit: 10, since: 2_000, until: 3_000 })).toEqual(["write refused"]);
    expect(names({ limit: 10, action: "100%_" })).toEqual([]);
  });
});

/* --------------------------------------------------------------------- tar */

describe("tar", () => {
  it("round-trips files, directories, long names and streamed bodies", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.bin");
    await writeFile(source, Buffer.alloc(70_000, 7));
    const long = `${"deep/".repeat(30)}file.txt`;
    const entries: TarEntry[] = [
      { name: "empty", size: 0, directory: true },
      { name: "a.txt", size: 5, body: Buffer.from("hello") },
      { name: long, size: 3, body: Buffer.from("far") },
      { name: "big.bin", size: 70_000, body: () => (async function* () { yield await readFile(source); })() },
    ];
    const archive = join(root, "out.tar.gz");
    await writeTarGzFile(entries, archive);
    const target = join(root, "unpacked");
    const result = await extractTarGz(archive, target);
    expect(result).toMatchObject({ files: 3, skipped: 0 });
    expect(await readFile(join(target, "a.txt"), "utf-8")).toBe("hello");
    expect(await readFile(join(target, long), "utf-8")).toBe("far");
    expect((await readFile(join(target, "big.bin"))).length).toBe(70_000);
    expect(await readdir(join(target, "empty"))).toEqual([]);
  });

  it("never writes outside the target", async () => {
    const root = await temporaryRoot();
    expect(safeTarget(root, "../escape")).toBeUndefined();
    expect(safeTarget(root, "/etc/passwd")).toBeUndefined();
    expect(safeTarget(root, "a/../../b")).toBeUndefined();
    expect(safeTarget(root, "a/b")).toBe(join(root, "a/b"));
    const archive = join(root, "evil.tar.gz");
    await writeTarGzFile([{ name: "../escape.txt", size: 1, body: Buffer.from("x") }, { name: "ok.txt", size: 1, body: Buffer.from("y") }], archive);
    const target = join(root, "inside");
    const result = await extractTarGz(archive, target);
    expect(result).toMatchObject({ files: 1, skipped: 1 });
    await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
  });
});

/* -------------------------------------------------------- backup / restore */

describe("backups", () => {
  it("take, list, prune and restore a root, refusing while a server runs", async () => {
    const { root, database } = await team();
    await mkdir(join(root, "repos", "harbour"), { recursive: true });
    await writeFile(join(root, "repos", "harbour", "HEAD"), "ref: main\n");
    const first = await createBackup(root, database, 1_000);
    const second = await createBackup(root, database, 2_000);
    expect(first.size).toBeGreaterThan(0);
    expect((await listBackups(root)).map((row) => row.name)).toEqual([second.name, first.name]);
    expect(await pruneBackups(root, 1)).toBe(1);
    expect((await listBackups(root)).map((row) => row.name)).toEqual([second.name]);

    const archive = join(root, "backups", second.name);
    const elsewhere = join(await temporaryRoot(), "restored");
    const done = await restoreBackup(archive, elsewhere, false);
    expect(done.kind).toBe("restored");
    expect(await readFile(join(elsewhere, "repos", "harbour", "HEAD"), "utf-8")).toBe("ref: main\n");

    const again = await restoreBackup(archive, elsewhere, false);
    expect(again).toMatchObject({ kind: "refused" });
    // Another live process, standing in for the server: restore ignores a pid
    // file naming its own pid, which in a container is a stopped server's pid 1.
    await writeFile(join(elsewhere, PID_FILE), `${process.ppid}\n`);
    const running = await restoreBackup(archive, elsewhere, true);
    expect(running.kind === "refused" && running.reason).toMatch(/running/);
    await writePidFile(elsewhere);
    const ourselves = await restoreBackup(archive, elsewhere, true);
    expect(ourselves.kind).toBe("restored");
  });

  it("restores a root from one of its own backups, moving what was there inside it", async () => {
    const { root, database } = await team();
    await mkdir(join(root, "repos", "harbour"), { recursive: true });
    await writeFile(join(root, "repos", "harbour", "HEAD"), "ref: main\n");
    const made = await createBackup(root, database, 1_000);
    databases.splice(databases.indexOf(database), 1);
    database.close();
    await writeFile(join(root, "repos", "harbour", "HEAD"), "ref: broken\n");

    const archive = join(root, "backups", made.name);
    expect(await restoreBackup(archive, root, false)).toMatchObject({ kind: "refused" });
    const done = await restoreBackup(archive, root, true, 5_000);
    expect(done.kind).toBe("restored");
    const aside = done.kind === "restored" ? done.movedAside : undefined;
    expect(aside).toBe(join(root, "before-restore-19700101-000005"));
    expect(await readFile(join(root, "repos", "harbour", "HEAD"), "utf-8")).toBe("ref: main\n");
    expect(await readFile(join(aside!, "repos", "harbour", "HEAD"), "utf-8")).toBe("ref: broken\n");
    expect(await readFile(join(aside!, "backups", made.name))).toBeTruthy();

    const reopened = await openMigratedDatabase(identityLayout(root).databasePath);
    databases.push(reopened);
    const next = await createBackup(root, reopened, 9_000);
    const names: string[] = [];
    const sink = createGunzip();
    sink.on("data", (chunk: Buffer) => names.push(chunk.toString("latin1")));
    const ended = new Promise((resolve) => sink.on("end", resolve));
    sink.end(await readFile(join(root, "backups", next.name)));
    await ended;
    expect(names.join("")).toContain("repos/harbour/HEAD");
    expect(names.join("")).not.toContain("before-restore-");
  });

  it("exports a project without secrets", async () => {
    const { root, database, project } = await team();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    const gunzip = sink.pipe(createGunzip());
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => gunzip.on("end", resolve));
    await exportProject(root, database, project.id, sink);
    await ended;
    const text = Buffer.concat(chunks).toString("utf-8");
    expect(text).toContain("README.txt");
    expect(text).toContain('"format": "nlteam-project"');
    expect(text).not.toMatch(/token_hash|password_hash/);
  });

  it("parses backup and restore on the command line", () => {
    expect(parseArgs(["backup", "--root", "/srv/team"])).toMatchObject({ kind: "backup", root: "/srv/team" });
    expect(parseArgs(["restore", "--root", "/srv/team", "b.tar.gz", "--force"])).toMatchObject({
      kind: "restore",
      root: "/srv/team",
      archive: "b.tar.gz",
      force: true,
    });
    expect(parseArgs(["restore", "--root", "/srv/team"])).toMatchObject({ kind: "error" });
  });
});

/* ----------------------------------------------------------------- storage */

describe("storage quota", () => {
  it("counts builds against the quota and warns near it", async () => {
    const { database, ada, project } = await team();
    expect(storageView(database, project.id).quotaBytes).toBeUndefined();
    expect(storageRoom(database, project.id)).toBe(Number.POSITIVE_INFINITY);
    setPolicy(database, STORAGE_QUOTA_MB, "1");
    setPolicy(database, BUILD_LIMIT_MB, "5");
    recordBuild(database, { id: "b1", projectId: project.id, name: "one", file: "one.zip", size: 1_000_000, sha256: "x", uploadedBy: ada.id });
    const view = storageView(database, project.id);
    expect(view).toMatchObject({ usedBytes: 1_000_000, buildBytes: 1_000_000, quotaBytes: 1024 * 1024, nearlyFull: true, full: false });
    expect(storageRoom(database, project.id)).toBe(1024 * 1024 - 1_000_000);
  });
});

/* -------------------------------------------------------------------- LDAP */

describe("LDAP", () => {
  it("encodes a simple bind and reads its result code", () => {
    const request = bindRequest("uid=ada,dc=example", "pw");
    expect(request[0]).toBe(0x30);
    expect(request.includes(Buffer.from("uid=ada,dc=example"))).toBe(true);
    // LDAPMessage { id 1, BindResponse { resultCode 49 (invalidCredentials), "", "" } }
    const refused = Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07, 0x0a, 0x01, 0x31, 0x04, 0x00, 0x04, 0x00]);
    expect(bindResult(refused)).toBe(49);
    expect(bindResult(refused.subarray(0, 6))).toBeUndefined();
    expect(bindResult(Buffer.from([0x04, 0x00]))).toBe(-1);
  });

  it("escapes a username placed in a DN", () => {
    expect(escapeDnValue("a,b=c")).toBe("a\\,b\\=c");
    expect(escapeDnValue("#x ")).toBe("\\#x\\ ");
    expect(bindDnFor("uid={username},ou=people", "ev,e")).toBe("uid=ev\\,e,ou=people");
  });
});

/* -------------------------------------------------------------------- OIDC */

describe("single sign-on", () => {
  const ISSUER = "https://id.example";
  function jwt(claims: Record<string, unknown>, key: ReturnType<typeof generateKeyPairSync>["privateKey"], kid = "k1"): string {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${signer.sign(key).toString("base64url")}`;
  }

  it("accepts a well-signed token and refuses a bad audience, nonce, expiry or signature", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1" };
    const keys = () => Promise.resolve([jwk]);
    const now = 1_700_000_000_000;
    const base = { iss: ISSUER, aud: "team", sub: "u1", nonce: "n1", iat: now / 1000, exp: now / 1000 + 300 };
    const expected = { issuer: ISSUER, audience: "team", nonce: "n1" };
    const good = await verifyIdToken(jwt(base, privateKey), expected, keys, now);
    expect(typeof good === "object" && good["sub"]).toBe("u1");
    expect(typeof (await verifyIdToken(jwt({ ...base, aud: "other" }, privateKey), expected, keys, now))).toBe("string");
    expect(typeof (await verifyIdToken(jwt({ ...base, nonce: "n2" }, privateKey), expected, keys, now))).toBe("string");
    expect(typeof (await verifyIdToken(jwt({ ...base, exp: now / 1000 - 600 }, privateKey), expected, keys, now))).toBe("string");
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(typeof (await verifyIdToken(jwt(base, stranger), expected, keys, now))).toBe("string");
  });

  it("links an identity to an account by email or name, and makes none unless allowed", async () => {
    const { database } = await team();
    database.prepare("UPDATE users SET email = ? WHERE username = ?").run("eve@example.com", "eve");
    const byMail = await externalAccount(database, { provider: "oidc", subject: `${ISSUER}#1`, email: "EVE@example.com" });
    expect(byMail.kind === "matched" && byMail.user.username).toBe("eve");
    // Linked now: the same subject finds eve without an email.
    const again = await externalAccount(database, { provider: "oidc", subject: `${ISSUER}#1` });
    expect(again.kind === "matched" && again.user.username).toBe("eve");
    expect((await externalAccount(database, { provider: "oidc", subject: `${ISSUER}#2`, username: "zed" })).kind).toBe("unknown");
    expect(usernameFrom("Zed.Smith@example.com")).toBe("zed.smith");
  });
});
