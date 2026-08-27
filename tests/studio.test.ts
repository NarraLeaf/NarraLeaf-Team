/**
 * The one thing a Studio installation asks a server for over HTTP.
 *
 * The sign-in route, and what this build tells a client it can do. Both happen
 * before a session exists, which is why they are here and not in
 * tests/team.test.ts: everything an author does afterwards travels on the
 * socket, and is asserted there.
 *
 * The door is what is worth asserting about the sign-in. What it hands back is a
 * token, every way of being refused is one status and one sentence, and a
 * password is never looked at once one place has been wrong often enough.
 *
 * The capability vocabulary is worth asserting because a client stops asking
 * after it: a name in that list which nothing answers leaves a client waiting on
 * a 404, and a name missing from it leaves a feature switched off on a server
 * that has it. What decides one is a reader, and the reader is stood in for
 * below — its own behaviour is in tests/cache.test.ts, against the real one.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig, type IdentityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { setTokenLifetimes, type TokenLifetimes } from "../src/identity/settings.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { SignInLimiter } from "../src/identity/signin.js";
import { identifyToken } from "../src/identity/bearer.js";
import { decodeToken, mintToken, type TokenClaims } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  requireUser,
  SIGN_IN_REFUSED_MESSAGE,
} from "../src/identity/users.js";
import { DISCOVERY_PATH, type DiscoveryDocument } from "../src/identity/discovery.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";
import { ProjectReadings } from "../src/projects/refresh.js";
import { webHandler } from "../src/web/router.js";
import {
  serviceCapabilities,
  type RepositoryReadings,
  type TeamService,
} from "../src/team/service.js";
import { methodTable, serverCapabilities } from "../src/team/methods.js";
import { teamMethods } from "../src/team/endpoint.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-studio-");

/** Cheap parameters: these tests are about the door, not what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";
const SIGN_IN = "/api/studio/v1/sign-in";

/** Stands in for a certificate authority, which these tests do not need one of. */
const FINGERPRINT = "3D:38:9F:E6";

const DISCOVERY: DiscoveryDocument = {
  protocol: 2,
  name: "127.0.0.1",
  auth: { required: true, url: "https://127.0.0.1:41402" },
  data: { url: "lore://127.0.0.1:41337" },
  capabilities: ["projects", "project-detail", "members"],
  authority: { sha256: "" },
  version: "0.0.0-test",
};

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

interface Harness {
  readonly origin: string;
  readonly database: DatabaseSync;
  /** A token for one account, as `nlteam token mint` would produce. */
  readonly tokenFor: (username: string) => Promise<string>;
  /** What that mint was made with, for comparing it against one the server made. */
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
}

/**
 * What a harness is given to read repositories with.
 *
 * A function where the reader has to be the real one: `ProjectReadings` needs
 * the database and the storage root this harness makes, and handing it back a
 * wrapper afterwards would hide exactly the mistake one test below is about.
 */
type ReadingsFor =
  | RepositoryReadings
  | ((of: { root: string; database: DatabaseSync; config: IdentityConfig }) => RepositoryReadings);

async function harness(
  readings?: ReadingsFor,
  log?: (line: string) => void,
  namedLifetimes?: Partial<TokenLifetimes>,
): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});
  const held =
    typeof readings === "function" ? readings({ root, database, config }) : readings;

  const studio = {
    database,
    keys,
    config,
    root,
    ...(namedLifetimes === undefined ? {} : { namedLifetimes }),
    dataPort: config.dataPort,
    healthPort: DEFAULT_PORTS.healthPort,
    fingerprint: FINGERPRINT,
    // One per harness. The limiter a running server uses is shared by every
    // door of one process, and two harnesses in one test run are two servers:
    // sharing one would let a test spend what the next one is counting on.
    signIns: new SignInLimiter(),
    ...(held === undefined ? {} : { readings: held }),
    ...(log === undefined ? {} : { log }),
  };
  const server = createServer(
    webHandler(
      () => ({
        ...DISCOVERY,
        capabilities: serverCapabilities(methodTable(teamMethods()), studio),
      }),
      { studio },
    ),
  );
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    database,
    keys,
    config,
    tokenFor: (username: string): Promise<string> =>
      Promise.resolve(
        mintToken(requireUser(database, username), keys.signingKey, config, {
          purpose: "sign-in",
        }).token,
      ),
  };
}

async function account(
  database: DatabaseSync,
  username: string,
  extra: {
    displayName?: string;
    email?: string;
    groups?: readonly string[];
    isServiceAccount?: boolean;
  } = {},
): Promise<string> {
  const user = await createUser(database, hasher, { username, password: PASSWORD, ...extra });
  return user.id;
}

async function fetchPath(
  origin: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

/**
 * A reader that knows nothing, which is a server whose first clone is still
 * running.
 *
 * Standing in for the real one, which needs a running loreserver to have read
 * anything. It can page a history — which is what decides whether this build
 * says it serves one — and has yet to find a revision to put in a page.
 */
const READ_NOTHING: RepositoryReadings = {
  get: () => undefined,
  revisions: () => Promise.resolve(undefined),
};

/**
 * Options with nothing interesting in them.
 *
 * What this build serves is decided by what it was given, so the capability
 * tests below need something to hand it — and everything that decides one is
 * added on top of this rather than being in it.
 */
async function anyOptions(): Promise<TeamService> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const config = identityConfig({});
  return {
    database,
    keys: await KeyStore.open(layout.keysDir),
    config,
    root,
    dataPort: config.dataPort,
    healthPort: DEFAULT_PORTS.healthPort,
  };
}

describe("what this build says it can do", () => {
  it("names only what a method table cannot say for itself", async () => {
    // Everything a session can be asked for is derived from the method table, so
    // nothing there is named again here. What is left is the sign-in, which
    // happens before any session exists. Matched literally by Studio, so the
    // spelling is the assertion.
    expect(serviceCapabilities(await anyOptions())).toEqual(["password-sign-in"]);
  });

  it("adds the history only where there is something to read one out of", async () => {
    expect(serviceCapabilities({ ...(await anyOptions()), readings: READ_NOTHING })).toContain(
      "project-history",
    );
    // A reader that cannot page a history is a build that does not claim to.
    expect(
      serviceCapabilities({ ...(await anyOptions()), readings: { get: () => undefined } }),
    ).not.toContain("project-history");
  });

  it("claims the sign-in only while there is a route answering at that address", async () => {
    // The list is what a client stops asking after, so a name in it that
    // nothing answers would be a client waiting on a 404. Asserted against the
    // address rather than against the list twice: this build says it serves a
    // password sign-in, and this is that route refusing a sign-in rather than
    // saying there is nothing here.
    const team = await harness();
    expect(serviceCapabilities({ ...(await anyOptions()) })).toContain("password-sign-in");

    const response = await fetch(`${team.origin}${SIGN_IN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "nothing at all" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: SIGN_IN_REFUSED_MESSAGE });
  });

  it("is in the document one address turns into a server", async () => {
    const team = await harness(READ_NOTHING);

    const response = await fetch(`${team.origin}${DISCOVERY_PATH}`);
    const document = (await response.json()) as DiscoveryDocument;

    expect(response.status).toBe(200);
    // The one number a client compares before anything else, and the same one
    // the opening socket frame carries.
    expect(document.protocol).toBe(2);
    // One vocabulary, in the document and in the opening socket frame alike. The
    // project list, one project and the members are reached over the socket under
    // `session`, so they are not names of their own here.
    expect(document.capabilities).toContain("session");
    expect(document.capabilities).toContain("project-history");
    expect(document.capabilities).not.toContain("project-detail");
    expect(document.capabilities).not.toContain("members");
  });
});

describe("an address under this API that there is nothing at", () => {
  it("says so itself, rather than leaving it to the arm that serves a page", async () => {
    // On a server with the operator's page switched off, falling through would
    // answer a mistyped API address with a sentence about a web interface.
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");

    const answer = await fetchPath(
      team.origin,
      "/api/studio/v1/projects/anything/nowhere",
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: "this server has nothing at that address." });
  });
});

describe("what the reader this server actually runs makes it say", () => {
  it("is a history, because that reader can read one", async () => {
    // The gap this closes is between the capability being worked out correctly
    // and the thing `up` hands it being the thing it was worked out from. A
    // reader that grew a different name for this would go on serving histories
    // while the document stopped announcing them.
    const options = await anyOptions();
    const readings = new ProjectReadings({
      root: await temporaryRoot(),
      database: options.database,
      config: options.config,
    });

    expect(serviceCapabilities({ ...options, readings })).toEqual([
      "password-sign-in",
      "project-history",
    ]);
  });
});

describe("signing in with a password", () => {
  /** Ask for a token, however badly. */
  async function signIn(
    origin: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}${SIGN_IN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** The claims of a token, without the two that are a clock reading. */
  function claimsOf(token: string): Omit<TokenClaims, "iat" | "exp"> {
    const { iat: _iat, exp: _exp, ...rest } = decodeToken(token).claims as TokenClaims;
    return rest;
  }

  it("hands back a token this API takes, and the account that was signed in", async () => {
    const team = await harness();
    await account(team.database, "ada", {
      displayName: "Ada Lovelace",
      email: "ada@example.lan",
    });

    const answer = await signIn(team.origin, { username: "ada", password: PASSWORD });

    expect(answer.status).toBe(200);
    expect(answer.body["account"]).toEqual({
      username: "ada",
      displayName: "Ada Lovelace",
      email: "ada@example.lan",
    });
    // The token is the whole point, so it is put to the check that stands between
    // it and a session rather than only inspected.
    const identified = identifyToken(
      team.database,
      team.keys,
      team.config,
      answer.body["token"] as string,
    );
    expect(identified.kind).toBe("identified");
  });

  it("is the same token nlteam token mint would have printed", async () => {
    // Studio compares a token's audience against the address it dialled and
    // refuses one that differs, and reads the authority out of the claims to
    // know which machine it was asked to trust. A token composed by hand here
    // would drift from the command's the first time either changed.
    const team = await harness();
    await account(team.database, "ada", { email: "ada@example.lan", groups: ["admin"] });

    const answer = await signIn(team.origin, { username: "ada", password: PASSWORD });
    const minted = mintToken(
      requireUser(team.database, "ada"),
      team.keys.signingKey,
      team.config,
      { purpose: "sign-in", authorityFingerprint: FINGERPRINT },
    );

    expect(claimsOf(answer.body["token"] as string)).toEqual(claimsOf(minted.token));
    // Named as well as compared, because these two are what a client acts on.
    const claims = decodeToken(answer.body["token"] as string).claims as TokenClaims;
    expect(claims.aud).toContain("https://127.0.0.1:41402");
    expect(claims.authority_sha256).toBe(FINGERPRINT);
  });

  it("lasts as long as the stored sign-in lifetime says, read as it mints", async () => {
    const team = await harness();
    await account(team.database, "ada");
    setTokenLifetimes(team.database, { signInTokenLifetimeSeconds: 3600 });

    const answer = await signIn(team.origin, { username: "ada", password: PASSWORD });
    const claims = decodeToken(answer.body["token"] as string).claims as TokenClaims;

    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("lets a lifetime the server was started with outrank one that is stored", async () => {
    // `up --token-lifetime` is written for the run, and a stored setting must
    // not beat it — or the option would stop doing anything the moment somebody
    // stored the setting it names. This is the sign-in a Studio installation
    // takes, so it is the one that has to agree with the exchange the same
    // command line configures.
    const team = await harness(undefined, undefined, { signInTokenLifetimeSeconds: 1800 });
    await account(team.database, "ada");
    setTokenLifetimes(team.database, { signInTokenLifetimeSeconds: 3600 });

    const answer = await signIn(team.origin, { username: "ada", password: PASSWORD });
    const claims = decodeToken(answer.body["token"] as string).claims as TokenClaims;

    expect(claims.exp - claims.iat).toBe(1800);
  });

  it("says one thing however it was refused", async () => {
    // Four ways to be turned away, one status and one sentence: an unknown
    // name, a wrong password, an account that has been disabled and one that
    // belongs to a machine. Anything that told them apart would be a way to
    // find out which accounts exist here.
    const team = await harness();
    await account(team.database, "ada");
    await account(team.database, "bob");
    disableUser(team.database, "bob");
    await account(team.database, "builder", { isServiceAccount: true });

    const answers = [
      await signIn(team.origin, { username: "grace", password: PASSWORD }),
      await signIn(team.origin, { username: "ada", password: "not the password" }),
      await signIn(team.origin, { username: "bob", password: PASSWORD }),
      await signIn(team.origin, { username: "builder", password: PASSWORD }),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: SIGN_IN_REFUSED_MESSAGE });
    }
  });

  it("refuses a body larger than anything this API takes, rather than reading it", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const answer = await signIn(
      team.origin,
      JSON.stringify({ username: "ada", password: PASSWORD, filler: "x".repeat(8 * 1024) }),
    );

    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toContain("larger than anything this API takes");
  });

  it("says what a sign-in takes when it was sent something else", async () => {
    const team = await harness();

    expect((await signIn(team.origin, { username: "ada" })).status).toBe(400);
    expect((await signIn(team.origin, { username: "ada", password: 12 })).status).toBe(400);
    expect((await signIn(team.origin, "not json at all")).status).toBe(400);
  });

  it("takes POST, and says so about anything else", async () => {
    const team = await harness();

    const response = await fetch(`${team.origin}${SIGN_IN}`, { method: "GET" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("says nothing about a password, and names only the account in a refusal", async () => {
    // The log is read beside everything else `up` prints, and a password in it
    // would outlive every other copy of that password.
    const lines: string[] = [];
    const team = await harness(undefined, (line) => lines.push(line));
    await account(team.database, "ada");

    await signIn(team.origin, { username: "ada", password: "not the password" });
    await signIn(team.origin, { username: "ada", password: PASSWORD });

    expect(lines).toEqual(['studio: sign-in refused for "ada"', "studio: ada signed in"]);
    for (const line of lines) {
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toContain("not the password");
    }
  });

  it("stops checking the password once enough from one place have been refused", async () => {
    const team = await harness();
    await account(team.database, "ada");

    let answer = await signIn(team.origin, { username: "ada", password: "not the password" });
    for (let attempt = 0; attempt < 10 && answer.status === 401; attempt += 1) {
      answer = await signIn(team.origin, { username: "ada", password: "not the password" });
    }

    // A password check is the most expensive thing this server does for
    // somebody who has presented nothing, and an unknown username costs the
    // same as a known one, so how often it may be asked for is the whole of
    // what stops a password being guessed at wholesale.
    expect(answer.status).toBe(429);
    expect(answer.body["error"]).toContain("try again in");
    // The right password is not checked either while the wait stands: it is the
    // check that is being held off, not the answer.
    const right = await signIn(team.origin, { username: "ada", password: PASSWORD });
    expect(right.status).toBe(429);
    // Every refused sign-in is held before it is answered, so the run of them
    // this needs takes a few seconds on its own.
  }, 60_000);

  it("refuses a sign-in driven from a page of somewhere else", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const response = await fetch(`${team.origin}${SIGN_IN}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://somewhere.example" },
      body: JSON.stringify({ username: "ada", password: PASSWORD }),
    });

    // The token comes back in the body rather than in a cookie, so a page
    // elsewhere gains nothing by reaching this. What it would gain is a
    // visitor's browser spending this server's password checking for it.
    expect(response.status).toBe(403);
  });
});
