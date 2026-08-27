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
import { SignInLimiter } from "../src/identity/signin.js";
import { createUser } from "../src/identity/users.js";
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

async function harness(): Promise<Harness> {
  const root = await temporaryRoot();
  const certificates = await ensureCertificates(root);
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const service: TeamService = {
    database,
    keys,
    config,
    dataPort: config.dataPort,
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
          data: { url: `lore://127.0.0.1:${config.dataPort}` },
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

  await createUser(database, hasher, { username: "ada", password: PASSWORD, displayName: "Ada" });

  return {
    address: `127.0.0.1:${port}`,
    fingerprint: certificates.authority.fingerprint256,
    root,
    database,
  };
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
