/**
 * The command line as a client of a server rather than of a database file.
 *
 * Driven against a real TLS listener with a real certificate authority, because
 * everything worth asserting here is about the connection: which authority was
 * pinned, that a different one is refused, and that what a server says no to is
 * printed as the server worded it.
 *
 * The listener is an ordinary HTTPS server rather than the HTTP/2-with-http/1.1
 * one `up` starts. What differs between them is settled elsewhere — see the note
 * in src/team/endpoint.ts about the `upgrade` event firing on that listener — and
 * from the client's side there is nothing to tell apart: it offers `http/1.1` in
 * ALPN and speaks HTTP/1.1 either way.
 *
 * Commands are driven through `run` with captured streams, the way
 * tests/cli.test.ts drives them, so what is asserted is what somebody at a
 * terminal would see.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import {
  configDirectory,
  readCredentials,
  rememberServer,
  type ServerCredential,
} from "../src/client/config.js";
import { TeamCallError, TeamSessionClient, UnservedMethodError } from "../src/client/session.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { discoveryDocument } from "../src/identity/discovery.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import {
  persistIdentity,
  SERVER_NAME_KEY,
  SIGN_IN_LIFETIME_KEY,
  storedTokenLifetimes,
} from "../src/identity/settings.js";
import { SignInLimiter } from "../src/identity/signin.js";
import {
  ADMIN_ROLE,
  countEnabledAdmins,
  createUser,
  insertUser,
  listUsers,
  prepareUser,
} from "../src/identity/users.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { createTeamSocket } from "../src/team/endpoint.js";
import { TEAM_METHODS } from "../src/team/protocol.js";
import type { TeamService } from "../src/team/service.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-client-");

const PASSWORD = "a password nobody guesses";

/** Cheap parameters: nothing here is about what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];

// Replaced rather than written to, because readPassword reads process.stdin
// itself: a command that took a stream as an argument would be a command
// nobody runs the way it is tested.
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
const realConfigDir = process.env["NLTEAM_CONFIG_DIR"];

afterEach(async () => {
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
  if (realConfigDir === undefined) {
    delete process.env["NLTEAM_CONFIG_DIR"];
  } else {
    process.env["NLTEAM_CONFIG_DIR"] = realConfigDir;
  }
  delete process.env["NLTEAM_SERVER"];
  delete process.env["NLTEAM_ROOT"];

  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
  }
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function pipeIn(text: string): void {
  const stream = Readable.from([Buffer.from(text, "utf8")]) as unknown as NodeJS.ReadStream;
  stream.isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

/** One Team server, listening on TLS with an authority it generated for itself. */
interface Harness {
  /** The address a person would be given, and the one this test dials. */
  readonly address: string;
  /** SHA-256 of its authority, as nlteam trust would print it. */
  readonly fingerprint: string;
  readonly root: string;
  readonly database: DatabaseSync;
}

/**
 * A port number nothing is listening on, borrowed and given straight back.
 *
 * The same reasoning as its twin in team.test.ts: a fixed number would be one
 * this suite hopes is free rather than one this machine said was.
 */
async function unusedPort(): Promise<number> {
  const server = createHttpsServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function harness(): Promise<Harness> {
  const root = await temporaryRoot();
  const certificates = await ensureCertificates(root);
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  // A port this process held long enough to learn the number of and then let go
  // of, for the same reason the health port below is one: `project create`
  // reaches loreserver on it, and a test that named loreserver's usual port
  // would be asserting about whatever happened to be listening on the machine
  // it ran on.
  const dataPort = await unusedPort();
  const config = identityConfig({ dataPort });
  // What `up` writes on every start, written here too, so that the commands
  // which read the stored identity off the disk read the same deployment this
  // server is answering as. Without it the two halves of `settings list` would
  // be describing a server that had never been brought up and one that had.
  persistIdentity(database, config);

  const service: TeamService = {
    database,
    keys,
    config,
    root,
    // Nothing here asks this server what it is, so this names a port this
    // process held long enough to learn the number of and then let go of. Not
    // the port loreserver ordinarily uses: a test naming that one passes only
    // on a machine with no Team server running, which is not the machine of
    // anybody working on this.
    healthPort: await unusedPort(),
    dataPort,
    fingerprint: certificates.authority.fingerprint256,
    // One per harness, so that a test cannot spend what the next one counts on.
    signIns: new SignInLimiter(),
  };
  const socket = createTeamSocket({ service, version: "0.0.0-test", host: "127.0.0.1" });

  // Known only once the listener has taken a port, and named in the document
  // this server serves about itself.
  let port = 0;
  const server = createHttpsServer(
    { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
    webHandler(
      () =>
        discoveryDocument({
          database,
          host: "127.0.0.1",
          auth: { required: true, url: `https://127.0.0.1:${port}` },
          data: { url: `lore://127.0.0.1:${dataPort}` },
          capabilities: socket.capabilities,
          authority: { sha256: certificates.authority.fingerprint256 },
          version: "0.0.0-test",
        }),
      { studio: service },
    ),
  );
  server.on("upgrade", (request, raw, head) => {
    if (!socket.handleUpgrade(request, raw, head)) {
      raw.destroy();
    }
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;

  await createUser(database, hasher, {
    username: "ada",
    password: PASSWORD,
    displayName: "Ada",
    // The account this server starts with administers it, exactly as the one
    // `nlteam init` makes does: a server whose only account could not administer
    // it would need a second command to undo the first.
    groups: [ADMIN_ROLE],
  });

  return {
    address: `127.0.0.1:${port}`,
    fingerprint: certificates.authority.fingerprint256,
    root,
    database,
  };
}

/** One more account on a server, for the tests that need somebody besides Ada. */
async function account(
  server: Harness,
  username: string,
  groups: readonly string[] = [],
): Promise<void> {
  await createUser(server.database, hasher, { username, password: PASSWORD, groups });
}

/** A fresh directory for this test's credentials, and nobody else's. */
async function credentialDirectory(): Promise<string> {
  const directory = await temporaryRoot();
  process.env["NLTEAM_CONFIG_DIR"] = directory;
  return directory;
}

async function invoke(
  argv: readonly string[],
  password?: string,
): Promise<{ code: number; out: string; err: string }> {
  if (password !== undefined) {
    pipeIn(password);
  }
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

/** Sign in, and insist it worked, for the tests that are about what comes after. */
async function signedIn(server: Harness): Promise<void> {
  const { code, err } = await invoke(["login", server.address, "ada"], PASSWORD);
  expect(err).toBe("");
  expect(code).toBe(0);
}

describe("nlteam login", () => {
  it("signs in over TLS and pins the authority it was shown, leaving a receipt", async () => {
    const server = await harness();
    const directory = await credentialDirectory();

    const { code, out, err } = await invoke(["login", server.address, "ada"], PASSWORD);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`as ada`);
    // Trusting on first use is a decision, so it says what was decided and where
    // to check it. A person who never sees the fingerprint cannot compare one.
    expect(out).toContain(server.fingerprint);
    expect(out).toContain("nlteam trust");

    const stored = (await readCredentials(directory)).get(server.address);
    expect(stored?.account).toBe("ada");
    expect(stored?.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored?.authority.sha256).toBe(server.fingerprint);
    expect(stored?.authority.pem).toContain("BEGIN CERTIFICATE");
  });

  it("says nothing about a fingerprint it was told to expect", async () => {
    const server = await harness();
    await credentialDirectory();

    const { code, out, err } = await invoke(
      ["login", server.address, "ada", "--fingerprint", server.fingerprint],
      PASSWORD,
    );

    expect(err).toBe("");
    expect(code).toBe(0);
    // The deployment was told what to trust and it was that, so there is no
    // decision left for anybody to check and nothing to print about one.
    expect(out).not.toContain("SHA-256");
    expect(out).not.toContain("nlteam trust");
  });

  it("takes a fingerprint without the colons, which is how a script holds one", async () => {
    const server = await harness();
    await credentialDirectory();

    const { code, err } = await invoke(
      ["login", server.address, "ada", "--fingerprint", server.fingerprint.replace(/:/g, "")],
      PASSWORD,
    );

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  it("refuses a fingerprint that is not the one presented, and signs in to nothing", async () => {
    const server = await harness();
    const directory = await credentialDirectory();
    const wrong = "AA".repeat(32);

    const { code, out, err } = await invoke(
      ["login", server.address, "ada", "--fingerprint", wrong],
      PASSWORD,
    );

    expect(code).toBe(1);
    expect(out).toBe("");
    // Both, so that whoever is reading can see which of the two they got wrong.
    expect(err).toContain(server.fingerprint);
    expect(err).toContain("AA:AA:AA");
    expect(err).toContain("Nothing was sent to it");
    expect(await readCredentials(directory)).toEqual(new Map());
  });

  it("refuses a fingerprint that is not a fingerprint, before it dials anything", async () => {
    const server = await harness();
    await credentialDirectory();

    const { code, err } = await invoke(
      ["login", server.address, "ada", "--fingerprint", "probably"],
      PASSWORD,
    );

    expect(code).toBe(2);
    expect(err).toContain("sixty-four hexadecimal digits");
  });

  it("refuses a server that presents a different authority from the one trusted", async () => {
    // Two real servers with two real authorities. What is staged is only that
    // the second address is already filed under the first one's authority,
    // which is what a reissued authority — or somebody else answering — looks
    // like from here.
    const first = await harness();
    const second = await harness();
    const directory = await credentialDirectory();
    await signedIn(first);
    const held = (await readCredentials(directory)).get(first.address) as ServerCredential;
    await rememberServer(directory, { ...held, address: second.address });

    const { code, out, err } = await invoke(["login", second.address, "ada"], PASSWORD);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("different certificate authority");
    expect(err).toContain(first.fingerprint);
    expect(err).toContain(second.fingerprint);
    expect(err).toContain(`nlteam logout ${second.address}`);
    // What was already trusted is left exactly as it was: a refusal must not be
    // the thing that replaces a pinned authority.
    expect((await readCredentials(directory)).get(second.address)?.authority.sha256).toBe(
      first.fingerprint,
    );
  });

  it("prints the server's own sentence when it refuses the password", async () => {
    const server = await harness();
    await credentialDirectory();

    const { code, out, err } = await invoke(["login", server.address, "ada"], "not the password");

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err.startsWith("nlteam: ")).toBe(true);
    expect(err).not.toContain("at Object.");
  });

  it("refuses an address that is not a host and a port, before anything is read", async () => {
    const { code, err } = await invoke(["login", "https://team.example.lan", "ada"]);

    expect(code).toBe(2);
    expect(err).toContain("scheme");
  });
});

describe("nlteam logout", () => {
  it("forgets one server and leaves the rest", async () => {
    const first = await harness();
    const second = await harness();
    const directory = await credentialDirectory();
    await signedIn(first);
    await signedIn(second);

    const { code, out } = await invoke(["logout", first.address]);

    expect(code).toBe(0);
    expect(out).toContain(`for ${first.address}`);
    expect([...(await readCredentials(directory)).keys()]).toEqual([second.address]);
  });

  it("says so and changes nothing where there was nothing signed in", async () => {
    await credentialDirectory();

    const { code, out, err } = await invoke(["logout", "team.example.lan:41402"]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("nothing was changed");
  });
});

describe("project list", () => {
  /** A project in a server's own database, as `project create` would leave one. */
  function project(server: Harness, name: string): void {
    const [ada] = server.database.prepare("SELECT id FROM users").all() as { id: string }[];
    createProject(server.database, {
      id: newProjectId(),
      name,
      createdBy: (ada as { id: string }).id,
    });
  }

  it("reads the same list from a storage root and from a session", async () => {
    const server = await harness();
    await credentialDirectory();
    project(server, "night-port");
    project(server, "the-long-quiet");
    await signedIn(server);

    const onDisk = await invoke(["project", "list", "--root", server.root]);
    const overProtocol = await invoke(["project", "list", "--server", server.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.code).toBe(0);
    expect(overProtocol.err).toBe("");
    // The same rows, laid out the same way. A person administering one server
    // over ssh and another over the protocol is reading one thing.
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("night-port");
    expect(overProtocol.out).toContain("ada");
  });

  it("says to log in rather than reading whatever database is nearby", async () => {
    const server = await harness();
    await credentialDirectory();
    project(server, "night-port");

    const { code, out, err } = await invoke(["project", "list", "--server", server.address]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("not signed in");
    expect(err).toContain(`nlteam login ${server.address}`);
  });

  it("refuses a command line that names both, rather than choosing one", async () => {
    const server = await harness();

    const { code, err } = await invoke([
      "project",
      "list",
      "--root",
      server.root,
      "--server",
      server.address,
    ]);

    expect(code).toBe(2);
    expect(err).toContain("not both");
  });

  it("refuses a command line that names neither", async () => {
    const { code, err } = await invoke(["project", "list"]);

    expect(code).toBe(2);
    expect(err).toContain("--root");
    expect(err).toContain("--server");
  });

  it("reads the address out of NLTEAM_SERVER, as the environment layer does", async () => {
    const server = await harness();
    await credentialDirectory();
    project(server, "night-port");
    await signedIn(server);
    process.env["NLTEAM_SERVER"] = server.address;

    const { code, out, err } = await invoke(["project", "list"]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("night-port");
  });

  it("will not choose between NLTEAM_SERVER and NLTEAM_ROOT", async () => {
    const server = await harness();
    process.env["NLTEAM_SERVER"] = server.address;
    process.env["NLTEAM_ROOT"] = server.root;

    const { code, err } = await invoke(["project", "list"]);

    expect(code).toBe(2);
    expect(err).toContain("both set");
  });

  it("prints the server's refusal and exits non-zero when the token is no longer good", async () => {
    const server = await harness();
    const directory = await credentialDirectory();
    await signedIn(server);
    const held = (await readCredentials(directory)).get(server.address) as ServerCredential;
    await rememberServer(directory, { ...held, token: "not.a.token" });

    const { code, out, err } = await invoke(["project", "list", "--server", server.address]);

    expect(code).toBe(1);
    expect(out).toBe("");
    // The server's own words, not a rewording of them, and not a stack trace.
    expect(err.startsWith("nlteam: ")).toBe(true);
    expect(err.trimEnd().split("\n")).toHaveLength(1);
    expect(err).not.toContain("at Object.");
  });
});

describe("a session", () => {
  async function session(server: Harness): Promise<TeamSessionClient> {
    const directory = await credentialDirectory();
    await signedIn(server);
    const held = (await readCredentials(directory)).get(server.address) as ServerCredential;
    return await TeamSessionClient.open({
      address: held.address,
      ca: held.authority.pem,
      token: held.token,
    });
  }

  it("learns what a server answers from the frame it opens with", async () => {
    const server = await harness();
    const open = await session(server);
    try {
      expect(open.hello.account.username).toBe("ada");
      expect(open.serves(TEAM_METHODS.projectsList)).toBe(true);
      expect(open.can("session")).toBe(true);
    } finally {
      open.close();
    }
  });

  it("refuses a method the opening frame did not list, rather than asking", async () => {
    const server = await harness();
    const open = await session(server);
    try {
      // A capability or a method name is how a client decides what a server can
      // do — never a probe. Calling to find out is how "this server is older
      // than you are" comes to be reported as "refused".
      await expect(open.call("projects.rename")).rejects.toBeInstanceOf(UnservedMethodError);
    } finally {
      open.close();
    }
  });

  it("hands a refusal back with the code and the sentence the server sent", async () => {
    const server = await harness();
    const open = await session(server);
    try {
      await expect(
        open.call(TEAM_METHODS.projectsGet, { project: "nothing-of-that-id" }),
      ).rejects.toMatchObject({
        name: "TeamCallError",
        code: "not-found",
        message: "there is no project of that id on this server",
      });
      // And it is still usable afterwards: a refusal is an answer, not an end.
      expect(await open.call(TEAM_METHODS.projectsList)).toEqual({ projects: [] });
    } finally {
      open.close();
    }
  });

  it("is the same TeamCallError however it is caught", async () => {
    const server = await harness();
    const open = await session(server);
    try {
      const refusal = await open
        .call(TEAM_METHODS.projectsGet, { project: "nothing-of-that-id" })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(TeamCallError);
    } finally {
      open.close();
    }
  });
});

/**
 * The rest of the administrative commands, driven both ways.
 *
 * What each of these asserts is the same pair of things: that the command
 * reaches its method when it is given an address, and that what it prints does
 * not depend on which of the two it took. The exceptions are the interesting
 * part, and each of them has a test of its own saying what the difference is
 * and why it is not a defect.
 */

/** The same line with whichever key it named taken out; a kid differs per server. */
function withoutKid(text: string): string {
  return text.replace(/signing with \S+/, "signing with <kid>");
}

describe("user list", () => {
  it("reads the same accounts from a storage root and from a session", async () => {
    const server = await harness();
    await credentialDirectory();
    await account(server, "bob", ["authors"]);
    await account(server, "zoe");
    await signedIn(server);

    const onDisk = await invoke(["user", "list", "--root", server.root]);
    const overProtocol = await invoke(["user", "list", "--server", server.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.code).toBe(0);
    expect(overProtocol.err).toBe("");
    // By name on both, though the method hands them back newest first: a cursor
    // has to be cut on something that cannot move, and a person reads a list by
    // name.
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("bob");
    expect(overProtocol.out).toContain("authors");
  });

  it("pages through a list longer than one page rather than stopping at the first", async () => {
    const server = await harness();
    await credentialDirectory();
    // More than the fifty a page holds by default. Hashed once and inserted
    // sixty times: nothing here is about what a password costs, and sixty
    // scrypt runs would be the slowest thing in this file by a long way.
    const prepared = await prepareUser(hasher, { username: "filler", password: PASSWORD });
    for (let index = 0; index < 60; index += 1) {
      insertUser(server.database, {
        ...prepared,
        id: randomUUID(),
        username: `filler${String(index).padStart(3, "0")}`,
      });
    }
    await signedIn(server);

    const { code, out, err } = await invoke(["user", "list", "--server", server.address]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out.trimEnd().split("\n")).toHaveLength(listUsers(server.database).length);
    // The first page and the last row of the second, so that a command which
    // asked once and printed what it got would fail here.
    expect(out).toContain("filler000");
    expect(out).toContain("filler059");
    expect(out).toBe((await invoke(["user", "list", "--root", server.root])).out);
  });
});

describe("user create", () => {
  it("makes the account either way, and names the command that gives them a token", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await signedIn(second);

    const onDisk = await invoke(["user", "create", "bob", "--root", first.root], PASSWORD);
    const overProtocol = await invoke(
      ["user", "create", "bob", "--server", second.address],
      PASSWORD,
    );

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.code).toBe(0);
    // The same two lines on both, up to the id each server made. The third is
    // the one that differs, and it differs because it names the command the
    // person reading it would actually run next.
    expect(onDisk.out).toContain("groups: member\n");
    expect(overProtocol.out).toContain("groups: member\n");
    expect(onDisk.out).toContain(`nlteam token mint bob --root ${first.root}`);
    expect(overProtocol.out).toContain(`nlteam token mint bob --server ${second.address}`);
  });

  it("sends the password over the session, and puts it in nothing it prints", async () => {
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);
    const secret = "the password bob was given";

    const made = await invoke(["user", "create", "bob", "--server", server.address], secret);

    expect(made.code).toBe(0);
    expect(made.out).not.toContain(secret);
    expect(made.err).toBe("");
    // It arrived, rather than merely having been sent: bob signs in with it.
    const asBob = await invoke(["login", server.address, "bob"], secret);
    expect(asBob.err).toBe("");
    expect(asBob.code).toBe(0);
  });

  it("makes an operator when it is asked to, and says so", async () => {
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);

    const { code, out } = await invoke(
      ["user", "create", "bob", "--server", server.address, "--role", "admin"],
      PASSWORD,
    );

    expect(code).toBe(0);
    expect(out).toContain("groups: admin\n");
  });

  it("refuses a role and a mark the protocol cannot carry, before it dials anything", async () => {
    // Dropped silently, either of these would look exactly like it had worked.
    const role = await invoke([
      "user",
      "create",
      "bob",
      "--server",
      "team.example.lan:41402",
      "--role",
      "authors",
    ]);
    expect(role.code).toBe(2);
    expect(role.err).toContain("--role admin");
    expect(role.err).toContain("--root");

    const mark = await invoke([
      "user",
      "create",
      "builder",
      "--server",
      "team.example.lan:41402",
      "--service-account",
    ]);
    expect(mark.code).toBe(2);
    expect(mark.err).toContain("--service-account");
  });
});

describe("taking access away", () => {
  it("says how far disabling reaches, in the same words either way", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await account(first, "bob");
    await account(second, "bob");
    await signedIn(second);

    const onDisk = await invoke(["user", "disable", "bob", "--root", first.root]);
    const overProtocol = await invoke(["user", "disable", "bob", "--server", second.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.code).toBe(0);
    // Including the repository lifetime in the middle of it, which this path has
    // to ask the server for: a sentence that lost its number on one of the two
    // would be the two paths saying different things about one server.
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("15 minutes from now");
  });

  it("says the same about refusing the tokens an account holds", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await account(first, "bob");
    await account(second, "bob");
    await signedIn(second);

    const onDisk = await invoke(["user", "revoke-tokens", "bob", "--root", first.root]);
    const overProtocol = await invoke([
      "user",
      "revoke-tokens",
      "bob",
      "--server",
      second.address,
    ]);

    expect(overProtocol.err).toBe("");
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("is not disabled");
  });

  it("enables an account again, and says the same either way", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await account(first, "bob");
    await account(second, "bob");
    await invoke(["user", "disable", "bob", "--root", first.root]);
    await invoke(["user", "disable", "bob", "--root", second.root]);
    await signedIn(second);

    const onDisk = await invoke(["user", "enable", "bob", "--root", first.root]);
    const overProtocol = await invoke(["user", "enable", "bob", "--server", second.address]);

    expect(overProtocol.err).toBe("");
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toBe("enabled bob\n");
  });

  it("grants and revokes administration, and says the same either way", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await account(first, "bob");
    await account(second, "bob");
    await signedIn(second);

    const granted = await invoke(["user", "grant-admin", "bob", "--root", first.root]);
    const grantedOverProtocol = await invoke([
      "user",
      "grant-admin",
      "bob",
      "--server",
      second.address,
    ]);
    expect(grantedOverProtocol.err).toBe("");
    expect(grantedOverProtocol.out).toBe(granted.out);

    const revoked = await invoke(["user", "revoke-admin", "bob", "--root", first.root]);
    const revokedOverProtocol = await invoke([
      "user",
      "revoke-admin",
      "bob",
      "--server",
      second.address,
    ]);
    expect(revokedOverProtocol.err).toBe("");
    expect(revokedOverProtocol.out).toBe(revoked.out);
    expect(revokedOverProtocol.out).toContain("no longer an admin");
  });
});

describe("token mint", () => {
  it("mints over the session without reading standard input", async () => {
    const server = await harness();
    await credentialDirectory();
    await account(server, "bob");
    await signedIn(server);

    // A stream that records having been read from and then ends, rather than
    // one that never does: a command which read this would otherwise hang, and
    // a test that proves something by timing out proves it slowly and badly.
    let readStandardInput = false;
    const stream = new Readable({
      read() {
        readStandardInput = true;
        this.push(null);
      },
    }) as unknown as NodeJS.ReadStream;
    stream.isTTY = false;
    Object.defineProperty(process, "stdin", { value: stream, configurable: true });

    const { code, out, err } = await invoke(["token", "mint", "bob", "--server", server.address]);

    expect(code).toBe(0);
    expect(readStandardInput).toBe(false);
    // The credential on standard output on its own, as the other path prints it,
    // so that a script capturing one need not know which path it came from.
    expect(out).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+\n$/);
    expect(err).toContain("expires ");
    // The header and the claims belong to the local path, because they are what
    // that path minted rather than anything this answer carries.
    expect(err).not.toContain("claims ");
  });

  it("mints a token that server accepts", async () => {
    const server = await harness();
    const directory = await credentialDirectory();
    await account(server, "bob");
    await signedIn(server);

    const { out } = await invoke(["token", "mint", "bob", "--server", server.address]);

    const held = (await readCredentials(directory)).get(server.address) as ServerCredential;
    const open = await TeamSessionClient.open({
      address: held.address,
      ca: held.authority.pem,
      token: out.trim(),
    });
    try {
      expect(open.hello.account.username).toBe("bob");
    } finally {
      open.close();
    }
  });

  it("refuses an identity option written beside an address", async () => {
    const { code, err } = await invoke([
      "token",
      "mint",
      "bob",
      "--server",
      "team.example.lan:41402",
      "--data-port",
      "41500",
    ]);

    expect(code).toBe(2);
    expect(err).toContain("--data-port");
    expect(err).toContain("--root");
  });
});

describe("settings", () => {
  it("reads the same settings both ways, the last column included", async () => {
    const server = await harness();
    await credentialDirectory();
    await invoke(["settings", "set", SERVER_NAME_KEY, "Winterlight", "--root", server.root]);
    await signedIn(server);

    const onDisk = await invoke(["settings", "list", "--root", server.root]);
    const overProtocol = await invoke(["settings", "list", "--server", server.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.code).toBe(0);
    // Every column agrees, the third one now among them: a server says whether
    // each value was chosen or is a default answering for it, so this path has
    // nothing left to leave blank.
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("Winterlight");
    // The name was set a moment ago and nothing else was, so both words are on
    // this listing — which is what makes it worth comparing the two.
    expect(overProtocol.out).toContain("set here");
    expect(overProtocol.out).toContain("default");
  });

  it("changes one, says what it was and what it is, and reaches the running server", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await signedIn(second);

    const onDisk = await invoke([
      "settings",
      "set",
      SIGN_IN_LIFETIME_KEY,
      "7d",
      "--root",
      first.root,
    ]);
    const overProtocol = await invoke([
      "settings",
      "set",
      SIGN_IN_LIFETIME_KEY,
      "7d",
      "--server",
      second.address,
    ]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.code).toBe(0);
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("is 7 days, and was 30 days");
    // Written where the server reads it, not somewhere that also keeps a copy.
    expect(storedTokenLifetimes(second.database).signInTokenLifetimeSeconds).toBe(
      7 * 24 * 60 * 60,
    );
  });

  it("names the settings there are when given one there is not, without dialling", async () => {
    const { code, err } = await invoke([
      "settings",
      "set",
      "token.lifetime",
      "7d",
      "--server",
      "team.example.lan:41402",
    ]);

    expect(code).toBe(2);
    expect(err).toContain("there is no setting called token.lifetime");
  });
});

describe("signing keys", () => {
  it("reads the same keys both ways", async () => {
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);

    const onDisk = await invoke(["key", "list", "--root", server.root]);
    const overProtocol = await invoke(["key", "list", "--server", server.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.out).toBe(onDisk.out);
    expect(overProtocol.out).toContain("signing  ");
  });

  it("rotates the running server's keys and says what the other path says", async () => {
    const first = await harness();
    const second = await harness();
    await credentialDirectory();
    await signedIn(second);

    const onDisk = await invoke(["key", "rotate", "--root", first.root]);
    const overProtocol = await invoke(["key", "rotate", "--server", second.address]);

    expect(onDisk.code).toBe(0);
    expect(overProtocol.err).toBe("");
    expect(overProtocol.code).toBe(0);
    expect(overProtocol.out).toContain("2 key(s) are published");
    expect(withoutKid(overProtocol.out)).toBe(withoutKid(onDisk.out));
    // The store the server itself holds, so the next token it mints is signed by
    // the new key with nothing restarted. Reading the directory again would only
    // prove that a file had appeared.
    const listed = await invoke(["key", "list", "--server", second.address]);
    expect(listed.out.trimEnd().split("\n")).toHaveLength(2);
    expect(listed.out).toContain(
      (overProtocol.out.split("\n")[0] ?? "").replace("signing with ", ""),
    );
  });
});

describe("project create", () => {
  it("reaches projects.create and prints the server's own refusal", async () => {
    // Nothing is listening on this server's data port — the harness borrowed one
    // and gave it straight back — so loreserver cannot be asked for the
    // repository and the server says so. That the refusal is about a repository
    // rather than about a command line is the assertion: this reached the method.
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);

    const { code, out, err } = await invoke([
      "project",
      "create",
      "harbour",
      "--server",
      server.address,
    ]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err.startsWith("nlteam: ")).toBe(true);
    expect(err).not.toContain("at Object.");
    // The row was rolled back with it, so the list is as it was.
    const listed = await invoke(["project", "list", "--server", server.address]);
    expect(listed.out).toContain("no projects yet");
  });

  it("refuses --as beside an address rather than dropping it", async () => {
    const { code, err } = await invoke([
      "project",
      "create",
      "harbour",
      "--server",
      "team.example.lan:41402",
      "--as",
      "ada",
    ]);

    expect(code).toBe(2);
    expect(err).toContain("--as");
    expect(err).toContain("--root");
  });
});

describe("what a server refuses", () => {
  it("prints the server's own sentence for an account it does not have", async () => {
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);

    const { code, out, err } = await invoke([
      "user",
      "disable",
      "nobody",
      "--server",
      server.address,
    ]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("nlteam: there is no account of that name on this server\n");
  });

  it("prints the server's own sentence to somebody who may not administer it", async () => {
    const server = await harness();
    await credentialDirectory();
    await account(server, "bob");
    const signIn = await invoke(["login", server.address, "bob"], PASSWORD);
    expect(signIn.code).toBe(0);

    const { code, out, err } = await invoke(["user", "list", "--server", server.address]);

    expect(code).toBe(1);
    expect(out).toBe("");
    // Worded by the server, printed as it arrived. A client that reworded a
    // refusal is a client whose output cannot be found in the server's log.
    expect(err).toBe("nlteam: administering this server is for its operators\n");
  });

  it("refuses the last operator's administration, and names the way back", async () => {
    const server = await harness();
    await credentialDirectory();
    await signedIn(server);

    const { code, err } = await invoke([
      "user",
      "revoke-admin",
      "ada",
      "--server",
      server.address,
    ]);

    expect(code).toBe(1);
    expect(err).toContain("only operator");
    // The rescue plane, named in the refusal, because the person reading it is
    // exactly the person who needs to know there is one.
    expect(err).toContain("nlteam user grant-admin ada");
    expect(err).toContain("storage root");
  });

  it("refuses none of that on the machine that holds the storage root", async () => {
    // The very change the test above will not make over the protocol, made here
    // without a word about it. "This server must not be left with nobody who can
    // administer it" is the management plane's rule and the management plane
    // enforces it; whoever holds the disk is not inside that world, and is how a
    // server left in this state is repaired.
    const server = await harness();
    await credentialDirectory();

    const { code, out, err } = await invoke(["user", "revoke-admin", "ada", "--root", server.root]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("no longer an admin");
    expect(countEnabledAdmins(server.database)).toBe(0);
  });
});
