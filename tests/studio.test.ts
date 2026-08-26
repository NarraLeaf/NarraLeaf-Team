/**
 * The API a Studio installation talks to.
 *
 * What is worth asserting here is the door and the list. The door, because the
 * token is the whole of the authentication and a token this refused would be a
 * token that reached a repository anyway. The list, because it is the answer to
 * the question this API exists for — and because it is the same list whoever
 * asks, which is the rule the rest of the server was rebuilt around.
 *
 * Creating a project is not exercised end to end here: it asks loreserver for a
 * repository, and a test that started one would be testing loreserver. What is
 * covered is everything up to that call.
 *
 * What comes out of a repository arrives through a reader, and the reader is
 * stood in for below. That is not a shortcut around it: what these assert is
 * the difference between a reading that has landed and one that has not, and a
 * real reader would have to be given a running loreserver to produce either.
 * The reader's own behaviour — that it answers absent rather than empty for a
 * project it has no checkout of — is in tests/cache.test.ts, against the real
 * one.
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
import { decodeToken, mintToken, type TokenClaims } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  requireUser,
  revokeUserTokens,
  SIGN_IN_REFUSED_MESSAGE,
} from "../src/identity/users.js";
import { DISCOVERY_PATH, type DiscoveryDocument } from "../src/identity/discovery.js";
import type { RevisionPage } from "../src/projects/read.js";
import { ProjectReadings } from "../src/projects/refresh.js";
import {
  createProject,
  findProjectById,
  listProjects,
  newProjectId,
  resourceIdOf,
} from "../src/projects/registry.js";
import type { ProjectFileView, RevisionView } from "../src/teamview.js";
import { webHandler } from "../src/web/router.js";
import {
  studioCapabilities,
  type StudioApiOptions,
  type StudioReadings,
} from "../src/web/studio.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-studio-");

/** Cheap parameters: these tests are about the door, not what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";
const PATH = "/api/studio/v1/projects";
const MEMBERS = "/api/studio/v1/members";
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
  | StudioReadings
  | ((of: { root: string; database: DatabaseSync; config: IdentityConfig }) => StudioReadings);

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
    ...(namedLifetimes === undefined ? {} : { namedLifetimes }),
    dataPort: config.dataPort,
    fingerprint: FINGERPRINT,
    // One per harness. The limiter a running server uses is shared by every
    // door of one process, and two harnesses in one test run are two servers:
    // sharing one would let a test spend what the next one is counting on.
    signIns: new SignInLimiter(),
    ...(held === undefined ? {} : { readings: held }),
    ...(log === undefined ? {} : { log }),
  };
  const server = createServer(
    webHandler(() => ({ ...DISCOVERY, capabilities: studioCapabilities(studio) }), { studio }),
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

async function get(origin: string, token?: string): Promise<{ status: number; body: unknown }> {
  return fetchPath(origin, PATH, token);
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
 * A reader that has landed on some projects and not on others.
 *
 * Standing in for the real one, which needs a running loreserver to produce
 * either answer. What matters to everything below is the shape of the two: a
 * project it knows about, and one it has never reached.
 */
function readerHolding(
  held: Record<string, { history: RevisionView; file: ProjectFileView }>,
  pages: Record<string, RevisionPage> = {},
): StudioReadings {
  return {
    get: (projectId) => held[projectId],
    revisions: (projectId, page) => {
      const whole = pages[projectId];
      if (whole === undefined) {
        return Promise.resolve(undefined);
      }
      const start =
        page.before === undefined
          ? 0
          : whole.revisions.findIndex((revision) => revision.id === page.before) + 1;
      const taken = whole.revisions.slice(start, start + page.limit);
      return Promise.resolve({
        revisions: taken,
        more: start + taken.length < whole.revisions.length,
      });
    },
  };
}

/** A reader that knows nothing, which is a server whose first clone is still running. */
const READ_NOTHING = readerHolding({});

/**
 * A reader whose readings can be taken away again.
 *
 * The map is held rather than copied, so what a route did to it is a thing the
 * test can look at afterwards — which is the whole of what the delete route is
 * asserted to do to a reading.
 */
function readerForgetting(
  held: Record<string, { history: RevisionView; file: ProjectFileView }>,
): StudioReadings {
  return {
    get: (projectId) => held[projectId],
    forget: (projectId) => {
      delete held[projectId];
    },
  };
}

/**
 * Options with nothing interesting in them.
 *
 * What this build serves is decided by what it was given, so the capability
 * tests below need something to hand it — and everything that decides one is
 * added on top of this rather than being in it.
 */
async function anyOptions(): Promise<StudioApiOptions> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const config = identityConfig({});
  return { database, keys: await KeyStore.open(layout.keysDir), config, dataPort: config.dataPort };
}

/** What a repository that has been read says about itself. */
const READ_HARBOUR: { history: RevisionView; file: ProjectFileView } = {
  history: {
    revisions: 41,
    branch: "main",
    bytes: 8_388_608,
    lastAt: 1_700_000_000_000,
    lastBy: "ada",
    lastMessage: "the harbour scene, lit",
  },
  file: { readable: true, title: "Harbour", stageWidth: 1920, stageHeight: 1080, scenes: 12 },
};

describe("the projects a Studio installation is shown", () => {
  it("refuses a request carrying no token", async () => {
    const team = await harness();

    const answer = await get(team.origin);

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: expect.stringContaining("bearer") });
  });

  it("refuses a token this server did not sign", async () => {
    const team = await harness();

    const answer = await get(team.origin, "not.a.token");

    expect(answer.status).toBe(401);
  });

  it("is empty on a server with no projects, rather than absent", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const answer = await get(team.origin, await team.tokenFor("ada"));

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ projects: [] });
  });

  it("is the same list whoever asks, because every account reaches every project", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      description: "the one everybody is working on",
      createdBy: ada,
    });

    const hers = await get(team.origin, await team.tokenFor("ada"));
    const his = await get(team.origin, await team.tokenFor("bob"));

    expect(hers.body).toEqual(his.body);
    expect(hers.body).toMatchObject({
      projects: [
        {
          name: "harbour",
          description: "the one everybody is working on",
          // Who made it is shown; it is not what decides who may open it.
          createdBy: "ada",
          // The address Studio would otherwise have to be told by hand, with the
          // project's name on the end: a client refuses one without it.
          remote: "lore://127.0.0.1:41337/harbour",
        },
      ],
    });
  });

  it("refuses an account that has been disabled", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = await team.tokenFor("ada");
    disableUser(team.database, "ada");

    expect((await get(team.origin, token)).status).toBe(401);
  });

  it("refuses a token that revoking made stale", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = await team.tokenFor("ada");
    revokeUserTokens(team.database, "ada");

    expect((await get(team.origin, token)).status).toBe(401);
  });

  it("says what a project needs when it is asked to make one without a name", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const response = await fetch(`${team.origin}${PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await team.tokenFor("ada")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ description: "no name" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "a project needs a name" });
  });

  it("takes GET and POST, and says so about anything else", async () => {
    const team = await harness();

    const response = await fetch(`${team.origin}${PATH}`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it("is served whether or not the web interface is on", async () => {
    // The interface is off in this harness — no `api` — and this answered
    // anyway. A server that only listed projects for operators who had switched
    // a page on would be one every author was locked out of.
    const team = await harness();
    await account(team.database, "ada");

    expect((await get(team.origin, await team.tokenFor("ada"))).status).toBe(200);
  });
});

describe("what a server says it serves", () => {
  it("names the routes this build answers, and nothing it only plans to", async () => {
    // Matched literally by Studio, so the spelling is the assertion.
    expect(studioCapabilities(await anyOptions())).toEqual([
      "projects",
      "project-detail",
      "members",
      "password-sign-in",
    ]);
  });

  it("adds the history only where there is something to read one out of", async () => {
    expect(studioCapabilities({ ...(await anyOptions()), readings: READ_NOTHING })).toContain(
      "project-history",
    );
    // A reader that cannot page a history is a build that does not claim to.
    expect(
      studioCapabilities({ ...(await anyOptions()), readings: { get: () => undefined } }),
    ).not.toContain("project-history");
  });

  it("claims the sign-in only while there is a route answering at that address", async () => {
    // The list is what a client stops asking after, so a name in it that
    // nothing answers would be a client waiting on a 404. Asserted against the
    // address rather than against the list twice: this build says it serves a
    // password sign-in, and this is that route refusing a sign-in rather than
    // saying there is nothing here.
    const team = await harness();
    expect(studioCapabilities({ ...(await anyOptions()) })).toContain("password-sign-in");

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
    expect(document.capabilities).toContain("project-detail");
    expect(document.capabilities).toContain("members");
    expect(document.capabilities).toContain("project-history");
  });
});

describe("what a project row says about its repository", () => {
  it("says nothing at all about one nobody has read yet", async () => {
    // The whole of the discipline in one assertion. A project cloned minutes
    // ago has no history to report, and a zeroed one would say nobody had ever
    // worked on it.
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      description: "",
      createdBy: ada,
    });

    const answer = await get(team.origin, await team.tokenFor("ada"));
    const [project] = (answer.body as { projects: Array<Record<string, unknown>> }).projects;

    expect(answer.status).toBe(200);
    expect(project).toBeDefined();
    expect(project).not.toHaveProperty("history");
  });

  it("carries what the repository last said, once it has been read", async () => {
    const id = newProjectId();
    const team = await harness(readerHolding({ [id]: READ_HARBOUR }));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const answer = await get(team.origin, await team.tokenFor("ada"));

    expect(answer.body).toMatchObject({
      projects: [{ name: "harbour", history: READ_HARBOUR.history }],
    });
  });
});

describe("one project on its own", () => {
  it("refuses a request carrying no token", async () => {
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    const id = newProjectId();
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    expect((await fetchPath(team.origin, `${PATH}/${id}`)).status).toBe(401);
  });

  it("says there is no such project, in one sentence", async () => {
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");

    const answer = await fetchPath(
      team.origin,
      `${PATH}/0123456789abcdef0123456789abcdef`,
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({
      error: "there is no project called 0123456789abcdef0123456789abcdef.",
    });
  });

  it("is the project and what is in it", async () => {
    const id = newProjectId();
    const team = await harness(readerHolding({ [id]: READ_HARBOUR }));
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id,
      name: "harbour",
      description: "the one everybody is working on",
      createdBy: ada,
    });

    const answer = await fetchPath(team.origin, `${PATH}/${id}`, await team.tokenFor("ada"));

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      project: {
        id,
        name: "harbour",
        description: "the one everybody is working on",
        createdBy: "ada",
        createdAt: expect.any(Number),
        remote: "lore://127.0.0.1:41337/harbour",
        history: READ_HARBOUR.history,
      },
      file: READ_HARBOUR.file,
    });
  });

  it("says the repository has not been read, rather than refusing", async () => {
    // A project written by a newer Studio arrives here the same way, and for
    // the same reason: what Team cannot make sense of is a sentence, never a
    // refusal, so that this server does not have to be upgraded in step.
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    const id = newProjectId();
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const answer = await fetchPath(team.origin, `${PATH}/${id}`, await team.tokenFor("ada"));
    const body = answer.body as { project: Record<string, unknown>; file: ProjectFileView };

    expect(answer.status).toBe(200);
    expect(body.file.readable).toBe(false);
    expect(body.file.reason).toBe("Team has not read this project's repository yet");
    expect(body.project).not.toHaveProperty("history");
  });

  it("is the same project whoever asks", async () => {
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    const id = newProjectId();
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const hers = await fetchPath(team.origin, `${PATH}/${id}`, await team.tokenFor("ada"));
    const his = await fetchPath(team.origin, `${PATH}/${id}`, await team.tokenFor("bob"));

    expect(hers.body).toEqual(his.body);
  });
});

/**
 * Taking a project off this server.
 *
 * The act is narrow on purpose and the tests are about the edge of it: the row
 * goes, the reading goes with it, and nothing is asked of loreserver. That last
 * one is assertable here for the reason the publish tests below are — nothing
 * is listening on the data port in this file, so an answer that arrives at all
 * is an answer that spoke to nobody.
 */
describe("taking a project off this server", () => {
  async function remove(
    origin: string,
    reference: string,
    token?: string,
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${origin}${PATH}/${reference}`, {
      method: "DELETE",
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: response.status, text: await response.text() };
  }

  /** A server with one project on it, and the id of that project. */
  async function withOneProject(
    readings: ReadingsFor = READ_NOTHING,
    log?: (line: string) => void,
  ): Promise<{ team: Harness; id: string }> {
    const team = await harness(readings, log);
    const ada = await account(team.database, "ada");
    const id = newProjectId();
    createProject(team.database, {
      id,
      name: "harbour",
      description: "the one everybody is working on",
      createdBy: ada,
    });
    return { team, id };
  }

  it("refuses a request carrying no token, and the project stays", async () => {
    const { team, id } = await withOneProject();

    const answer = await remove(team.origin, id);

    expect(answer.status).toBe(401);
    expect(listProjects(team.database)).toHaveLength(1);
  });

  it("refuses a token this server did not sign, and the project stays", async () => {
    const { team, id } = await withOneProject();

    const answer = await remove(team.origin, id, "not.a.token");

    expect(answer.status).toBe(401);
    expect(findProjectById(team.database, id)).toBeDefined();
  });

  it("refuses an account that has been disabled", async () => {
    // The same door as every other route: whoever may not reach a repository
    // may not take one off the list either.
    const { team, id } = await withOneProject();
    const token = await team.tokenFor("ada");
    disableUser(team.database, "ada");

    const answer = await remove(team.origin, id, token);

    expect(answer.status).toBe(401);
    expect(findProjectById(team.database, id)).toBeDefined();
  });

  it("answers 204 with no body at all, and the project is gone from the list", async () => {
    const { team, id } = await withOneProject();
    const token = await team.tokenFor("ada");

    const answer = await remove(team.origin, id, token);

    expect(answer.status).toBe(204);
    expect(answer.text).toBe("");
    expect(listProjects(team.database)).toEqual([]);
    expect(findProjectById(team.database, id)).toBeUndefined();
    // Read back through the API rather than only out of the database, because
    // the list is what an operator was looking at when they asked for this.
    expect((await get(team.origin, token)).body).toEqual({ projects: [] });
    expect((await fetchPath(team.origin, `${PATH}/${id}`, token)).status).toBe(404);
  });

  it("says there is no such project the second time, in the same sentence a read does", async () => {
    const { team, id } = await withOneProject();
    const token = await team.tokenFor("ada");

    expect((await remove(team.origin, id, token)).status).toBe(204);
    const again = await remove(team.origin, id, token);

    expect(again.status).toBe(404);
    expect(JSON.parse(again.text)).toEqual({ error: `there is no project called ${id}.` });
  });

  it("says there is no such project for an id this server never had", async () => {
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");

    const answer = await remove(
      team.origin,
      "0123456789abcdef0123456789abcdef",
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(404);
    expect(listProjects(team.database)).toEqual([]);
  });

  it("takes a name as well as an id, as the read of one project does", async () => {
    const { team } = await withOneProject();

    const answer = await remove(team.origin, "harbour", await team.tokenFor("ada"));

    expect(answer.status).toBe(204);
    expect(listProjects(team.database)).toEqual([]);
  });

  it("is any account of this server, not only the one that created it", async () => {
    // The standing rule, asserted where it would be easiest to quietly break:
    // an account of this server reaches every project on it, and the name
    // beside a project is a name rather than a claim over it.
    const { team, id } = await withOneProject();
    await account(team.database, "bob");

    const answer = await remove(team.origin, id, await team.tokenFor("bob"));

    expect(answer.status).toBe(204);
    expect(findProjectById(team.database, id)).toBeUndefined();
  });

  it("drops what was read, so the same repository published again is not answered for out of it", async () => {
    // The case this route exists for leaves a stray project behind, and the
    // author publishes the real one under the same repository id a moment
    // later. A reading kept from the stray would become that project's
    // history.
    const id = newProjectId();
    const held = { [id]: READ_HARBOUR };
    const team = await harness(readerForgetting(held));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });
    const token = await team.tokenFor("ada");
    // The reading is there to begin with, or what follows would assert nothing.
    expect(
      (await fetchPath(team.origin, `${PATH}/${id}`, token)).body,
    ).toMatchObject({ project: { history: READ_HARBOUR.history } });

    expect((await remove(team.origin, "harbour", token)).status).toBe(204);
    expect(held).toEqual({});

    const republished = await fetch(`${team.origin}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "harbour", repositoryId: id }),
    });
    expect(republished.status).toBe(201);

    const answer = await fetchPath(team.origin, `${PATH}/${id}`, token);
    const body = answer.body as { project: Record<string, unknown>; file: ProjectFileView };
    expect(body.project).not.toHaveProperty("history");
    expect(body.file.readable).toBe(false);
  });

  it("says who did it, and what it was called before it went", async () => {
    const lines: string[] = [];
    const { team, id } = await withOneProject(READ_NOTHING, (line) => lines.push(line));

    await remove(team.origin, id, await team.tokenFor("ada"));

    expect(lines).toEqual([`studio: ada forgot harbour (${id})`]);
  });

  it("takes GET and DELETE, and says so about anything else", async () => {
    const { team, id } = await withOneProject();

    const response = await fetch(`${team.origin}${PATH}/${id}`, { method: "PUT" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, DELETE");
  });

  it("leaves the collection itself taking GET and POST and nothing else", async () => {
    // The delete hangs off one project. A DELETE of the whole list is not a
    // shorter way of saying it, and must go on being refused.
    const { team } = await withOneProject();

    const response = await fetch(`${team.origin}${PATH}`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(listProjects(team.database)).toHaveLength(1);
  });
});

/**
 * Putting a project that already exists on to this server.
 *
 * This half of the create route is testable end to end where the other half is
 * not, and for the reason that makes it worth having: a request carrying a
 * repository id asks loreserver for nothing. Nothing is listening on the data
 * port in these tests, so a 201 out of this route is itself the assertion that
 * no repository was asked for — the other half answers 502 here.
 *
 * What the author brings is the id their repository has carried since they
 * enabled version control, and the name they want it known by. Both have to
 * survive: the id because loreserver will ask permission questions about it
 * character by character, and the name because it is what a collaborator
 * clones by.
 */
describe("a project the author already has", () => {
  async function publish(
    origin: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("is recorded under the repository id it already has", async () => {
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");
    const repositoryId = newProjectId();

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      description: "eight months of it",
      repositoryId,
    });

    expect(answer.status).toBe(201);
    expect(answer.body["project"]).toMatchObject({
      id: repositoryId,
      name: "driftwood",
      description: "eight months of it",
      createdBy: "ada",
      remote: "lore://127.0.0.1:41337/driftwood",
    });
    // The row is what loreserver is answered out of, so it is read back rather
    // than inferred from the reply that was just built from it.
    expect(findProjectById(team.database, repositoryId)).toMatchObject({ name: "driftwood" });
  });

  it("says nothing about a history it has not been sent yet", async () => {
    // The project may have years of it. Absent says the reader has not been
    // round; a nought would say the author published an empty project.
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      repositoryId: newProjectId(),
    });

    expect(answer.body["project"]).not.toHaveProperty("history");
  });

  it("takes the id in either spelling, and holds it in the one loreserver asks about", async () => {
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");
    const repositoryId = newProjectId();

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      repositoryId: repositoryId.toUpperCase(),
    });

    expect(answer.status).toBe(201);
    expect(answer.body["project"]).toMatchObject({ id: repositoryId });
    expect(resourceIdOf(repositoryId)).toBe(`urc-${repositoryId}`);
  });

  it("refuses something that is not a repository id, rather than storing it", async () => {
    const team = await harness(READ_NOTHING);
    await account(team.database, "ada");

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      repositoryId: "not-a-repository-id",
    });

    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toContain("thirty-two");
    expect(listProjects(team.database)).toEqual([]);
  });

  it("refuses a repository this server already holds, and says which", async () => {
    // Somebody has published it. The author about to push into it has to know
    // that before they do, which is why this is not a silent adoption.
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    const repositoryId = newProjectId();
    createProject(team.database, {
      id: repositoryId,
      name: "driftwood",
      description: "",
      createdBy: ada,
    });

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood-again",
      repositoryId,
    });

    expect(answer.status).toBe(409);
    expect(answer.body["error"]).toContain(repositoryId);
    expect(listProjects(team.database)).toHaveLength(1);
  });

  it("does not mistake another project's name for a repository id", async () => {
    // A repository this server adopted under a taken name is named after its
    // own id, so a name here really can look like one. Asking the name column
    // would refuse the publish and blame a project that is not involved.
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    const named = newProjectId();
    createProject(team.database, {
      id: newProjectId(),
      name: named,
      description: "",
      createdBy: ada,
    });

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      repositoryId: named,
    });

    expect(answer.status).toBe(201);
    expect(answer.body["project"]).toMatchObject({ id: named, name: "driftwood" });
  });

  it("refuses a name that is taken, before anything is recorded", async () => {
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "driftwood",
      description: "",
      createdBy: ada,
    });

    const answer = await publish(team.origin, await team.tokenFor("ada"), {
      name: "driftwood",
      repositoryId: newProjectId(),
    });

    expect(answer.status).toBe(409);
    expect(listProjects(team.database)).toHaveLength(1);
  });

  it("refuses a request carrying no token", async () => {
    const team = await harness(READ_NOTHING);

    const response = await fetch(`${team.origin}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "driftwood", repositoryId: newProjectId() }),
    });

    expect(response.status).toBe(401);
    expect(listProjects(team.database)).toEqual([]);
  });
});

describe("the people on this server", () => {
  it("refuses a request carrying no token", async () => {
    const team = await harness();

    expect((await fetchPath(team.origin, MEMBERS)).status).toBe(401);
  });

  it("is every account, with the address a revision is signed with", async () => {
    const team = await harness();
    await account(team.database, "ada", {
      displayName: "Ada Lovelace",
      email: "ada@example.lan",
      groups: ["admin"],
    });
    await account(team.database, "bob", { displayName: "Bob" });

    const answer = await fetchPath(team.origin, MEMBERS, await team.tokenFor("ada"));

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      members: [
        {
          username: "ada",
          displayName: "Ada Lovelace",
          email: "ada@example.lan",
          // A label saying this account administers the server. It is not a
          // permission over any project: every account reaches every project.
          operator: true,
          disabled: false,
          serviceAccount: false,
          createdAt: expect.any(Number),
        },
        {
          username: "bob",
          displayName: "Bob",
          operator: false,
          disabled: false,
          serviceAccount: false,
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("lists somebody who has left, so their revisions still have a name on them", async () => {
    const team = await harness();
    await account(team.database, "ada");
    await account(team.database, "bob");
    disableUser(team.database, "bob");

    const answer = await fetchPath(team.origin, MEMBERS, await team.tokenFor("ada"));
    const { members } = answer.body as { members: Array<Record<string, unknown>> };

    expect(members.map((member) => member["username"])).toEqual(["ada", "bob"]);
    expect(members[1]).toMatchObject({ username: "bob", disabled: true });
  });

  it("keeps an operator's business out of it", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = await team.tokenFor("ada");
    await account(team.database, "bob");
    revokeUserTokens(team.database, "bob");

    const answer = await fetchPath(team.origin, MEMBERS, token);
    const { members } = answer.body as { members: Array<Record<string, unknown>> };

    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member).not.toHaveProperty("tokensInvalidatedAt");
      expect(member).not.toHaveProperty("role");
      expect(member).not.toHaveProperty("id");
    }
  });
});

describe("a page of a project's revisions", () => {
  const REVISIONS: RevisionPage = {
    revisions: [
      { id: "c3", at: 1_700_000_003_000, by: "ada", message: "the harbour scene, lit" },
      { id: "c2", at: 1_700_000_002_000, by: "bob" },
      { id: "c1", at: 1_700_000_001_000, by: "ada", message: "first" },
    ],
    more: false,
  };

  async function withHistory(): Promise<{ team: Harness; id: string }> {
    const id = newProjectId();
    const team = await harness(readerHolding({ [id]: READ_HARBOUR }, { [id]: REVISIONS }));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });
    return { team, id };
  }

  it("refuses a request carrying no token", async () => {
    const { team, id } = await withHistory();

    expect((await fetchPath(team.origin, `${PATH}/${id}/history`)).status).toBe(401);
  });

  it("says there is no such project, in one sentence", async () => {
    const { team } = await withHistory();

    const answer = await fetchPath(
      team.origin,
      `${PATH}/fedcba9876543210fedcba9876543210/history`,
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({
      error: "there is no project called fedcba9876543210fedcba9876543210.",
    });
  });

  it("is the revisions, newest first", async () => {
    const { team, id } = await withHistory();

    const answer = await fetchPath(
      team.origin,
      `${PATH}/${id}/history`,
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ revisions: REVISIONS.revisions, more: false });
  });

  it("takes a page at a time, and says when there is another", async () => {
    const { team, id } = await withHistory();
    const token = await team.tokenFor("ada");

    const first = await fetchPath(team.origin, `${PATH}/${id}/history?limit=2`, token);
    const second = await fetchPath(team.origin, `${PATH}/${id}/history?limit=2&before=c2`, token);

    expect(first.body).toEqual({ revisions: REVISIONS.revisions.slice(0, 2), more: true });
    expect(second.body).toEqual({ revisions: REVISIONS.revisions.slice(2), more: false });
  });

  it("has no revisions to give for a project nobody has read yet", async () => {
    // Absent rather than empty, for the same reason a row has no history: an
    // empty page says this project has never been worked on.
    const team = await harness(READ_NOTHING);
    const ada = await account(team.database, "ada");
    const id = newProjectId();
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const answer = await fetchPath(
      team.origin,
      `${PATH}/${id}/history`,
      await team.tokenFor("ada"),
    );
    const body = answer.body as Record<string, unknown>;

    expect(answer.status).toBe(200);
    expect(body).not.toHaveProperty("revisions");
    expect(body["more"]).toBe(false);
  });

  it("answers a page rather than a complaint about the query string", async () => {
    const { team, id } = await withHistory();

    const answer = await fetchPath(
      team.origin,
      `${PATH}/${id}/history?limit=not-a-number`,
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ revisions: REVISIONS.revisions, more: false });
  });

  it("takes GET, and says so about anything else", async () => {
    const { team, id } = await withHistory();

    const response = await fetch(`${team.origin}${PATH}/${id}/history`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
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

    expect(studioCapabilities({ ...options, readings })).toEqual([
      "projects",
      "project-detail",
      "members",
      "password-sign-in",
      "project-history",
    ]);
  });

  it("answers a history request with that reader rather than throwing on it", async () => {
    // Every stand-in above is an object literal, whose `revisions` is a
    // function that never wanted a `this`. The reader `up` hands this route is
    // a class whose `revisions` keeps a set of the projects a read is inside
    // of — so a route that lifted the method off it and called the copy threw
    // on every real server and passed here, and `/history` was empty on every
    // deployment while this file stayed green.
    //
    // Nothing is cloned: there is no checkout of this project, so the honest
    // answer is that there is no page, which is the same answer a project the
    // reader has not reached yet gets.
    const id = newProjectId();
    const team = await harness((of) => new ProjectReadings(of));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const answer = await fetchPath(
      team.origin,
      `${PATH}/${id}/history?limit=5`,
      await team.tokenFor("ada"),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ more: false });
  }, 120_000);

  it("drops a reading through that reader rather than throwing on it", async () => {
    // The same trap as the one above, on the route that takes a project off
    // this server: `forget` is a method of a class that keeps two maps, and a
    // route which lifted it off the reader and called the copy would answer 500
    // on every real server while every stand-in here — an object literal that
    // never wanted a `this` — went on passing.
    const id = newProjectId();
    const team = await harness((of) => new ProjectReadings(of));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });

    const response = await fetch(`${team.origin}${PATH}/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${await team.tokenFor("ada")}` },
    });

    expect(response.status).toBe(204);
    expect(listProjects(team.database)).toEqual([]);
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
    // The token is the whole point, so it is used rather than only inspected.
    const projects = await get(team.origin, answer.body["token"] as string);
    expect(projects.status).toBe(200);
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
