/**
 * A session, end to end.
 *
 * Driven with node's own WebSocket client rather than anything out of src, on
 * purpose: a client written beside the server agrees with it about the parts
 * both got wrong. What is asserted here is the door, the shape of the opening
 * frame, what a call answers, what a subscription is told, and the one thing a
 * request-and-response API could never do - somebody else's write arriving on a
 * connection that did not make it.
 *
 * Plain HTTP rather than TLS. What TLS decides on this listener is who may
 * connect at all, and that is settled in tests/certificates.test.ts and by the
 * one measured fact this design rests on: the `upgrade` event does fire on the
 * HTTP/2 secure listener that `allowHTTP1` puts in front of the same port. What
 * is left over is the protocol, and the protocol does not know which it is on.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig, type IdentityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { recordDecision } from "../src/identity/audit.js";
import {
  ADMIN_ROLE,
  createUser,
  disableUser,
  findUser,
  listUsers,
  requireUser,
  revokeUserTokens,
  setAdmin,
} from "../src/identity/users.js";
import { ProjectReadings } from "../src/projects/refresh.js";
import {
  createProject,
  forgetProject,
  listProjects,
  newProjectId,
} from "../src/projects/registry.js";
import { discoveryDocument, type DiscoveryDocument } from "../src/identity/discovery.js";
import { COORDINATION_CAPABILITIES } from "../src/team/collaboration.js";
import { createTeamSocket, teamMethods, type TeamSocket } from "../src/team/endpoint.js";
import {
  TEAM_METHODS,
  TEAM_SOCKET_PATH,
  liveTopic,
  projectClientsTopic,
  projectLiveTopic,
  projectOverlayTopic,
  projectThreadsTopic,
  projectTopic,
  TOPIC_ADMIN_KEYS,
  TOPIC_ADMIN_REFUSALS,
  TOPIC_ADMIN_SETTINGS,
  TOPIC_ADMIN_USERS,
  TOPIC_PROJECTS,
  type TeamHelloFrame,
} from "../src/team/protocol.js";
import type { TeamService } from "../src/team/service.js";
import { serverStatus, STATUS_FRESHNESS_MS } from "../src/team/status.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-session-");

/** Cheap parameters: nothing here is about what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  while (openClients.length > 0) {
    openClients.pop()?.close();
  }
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
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  readonly service: TeamService;
  readonly socket: TeamSocket;
  readonly tokenFor: (username: string) => string;
  readonly connect: (token: string) => Promise<Client>;
}

/**
 * What a harness is given beyond the identity it makes for itself.
 *
 * A function where the reader has to be the real one: `ProjectReadings` needs the
 * database and the storage root this harness makes, and a test that handed one in
 * from outside would be reading a different server's repositories.
 */
type ServiceFor =
  | Partial<TeamService>
  | ((of: {
      root: string;
      database: DatabaseSync;
      config: IdentityConfig;
    }) => Partial<TeamService>);

async function harness(extra: ServiceFor = {}): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const service: TeamService = {
    database,
    keys,
    config,
    root,
    // Borrowed and given back, like the health port below and for a sharper
    // reason: several tests here assert that adopting a repository asks
    // loreserver for nothing, and the whole of that assertion is that nothing
    // answers on this port. Naming loreserver's usual one would leave those
    // tests green and meaningless on any machine with a Team server running,
    // which is where a regression would most want to hide.
    dataPort: await unusedPort(),
    // A port this process held just long enough to learn its number and then
    // let go of, so a status gathered here reports a loreserver that is not
    // answering - which is the truth about a harness that never started one.
    // Not the port loreserver ordinarily uses: anybody running a Team server on
    // the machine the tests run on would have one answering there, and a test
    // that passes only where nothing else is running is a test that fails for
    // the person most likely to be running one.
    healthPort: await unusedPort(),
    // Whatever a test wants this server to have read out of a repository. Most
    // want none, which is a server that has not got round to one yet - a state
    // the overlay methods have to answer honestly rather than as "empty".
    ...(typeof extra === "function" ? extra({ root, database, config }) : extra),
  };
  const socket = createTeamSocket({ service, version: "0.0.0-test", host: "127.0.0.1" });

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (upgrade, raw, head) => {
    if (!socket.handleUpgrade(upgrade, raw, head)) {
      raw.destroy();
    }
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const origin = `127.0.0.1:${port}`;

  const tokenFor = (username: string): string =>
    mintToken(requireUser(database, username), keys.signingKey, config, {
      purpose: "sign-in",
    }).token;

  return {
    origin,
    database,
    keys,
    config,
    service,
    socket,
    tokenFor,
    connect: async (token: string) => {
      const client = await open(`ws://${origin}${TEAM_SOCKET_PATH}`, token);
      openClients.push(client);
      return client;
    },
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
  const user = await createUser(database, hasher, {
    username,
    password: "a password nobody guesses",
    displayName: username,
    ...extra,
  });
  return user.id;
}

/* --------------------------------------------------------------- a client */

interface Waiting {
  resolve: (value: { value?: unknown; code?: string; message?: string; seq?: number }) => void;
}

/** Everything a test does with a session, over node's own WebSocket. */
class Client {
  readonly events: { topic: string; seq: number; payload: unknown }[] = [];
  readonly byes: { code: string; message: string }[] = [];
  /** The WebSocket close code and reason, once the socket has closed. */
  readonly closes: { code: number; reason: string }[] = [];
  hello: TeamHelloFrame | undefined;

  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.onclose = (event: CloseEvent) => {
      this.closes.push({ code: event.code, reason: event.reason });
      for (const listener of this.listeners.splice(0)) {
        listener();
      }
    };
    ws.onmessage = (message: MessageEvent) => {
      const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (frame["t"] === "hello") {
        this.hello = frame as unknown as TeamHelloFrame;
      } else if (frame["t"] === "event") {
        this.events.push(
          frame as unknown as { topic: string; seq: number; payload: unknown },
        );
      } else if (frame["t"] === "bye") {
        this.byes.push(frame as unknown as { code: string; message: string });
      } else if (typeof frame["id"] === "number") {
        this.waiting.get(frame["id"])?.resolve(frame as never);
        this.waiting.delete(frame["id"]);
      }
      for (const listener of this.listeners.splice(0)) {
        listener();
      }
    };
  }

  /** Ask, and hand back the whole answering frame, refusals included. */
  send(
    t: "call" | "subscribe" | "unsubscribe",
    extra: Record<string, unknown>,
  ): Promise<{ value?: unknown; code?: string; message?: string; seq?: number }> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.ws.send(JSON.stringify({ t, id, ...extra }));
    });
  }

  call(method: string, params?: unknown): Promise<{ value?: unknown; code?: string }> {
    return this.send("call", { method, ...(params === undefined ? {} : { params }) });
  }

  /** What a call answered, insisting it was not a refusal. */
  async value(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const answer = await this.call(method, params);
    if (answer.code !== undefined) {
      throw new Error(`${method} was refused: ${answer.code}`);
    }
    return answer.value as Record<string, unknown>;
  }

  /**
   * Wait until something is true of what has arrived.
   *
   * A predicate rather than "one more frame", because an event can land before
   * the call that caused it has answered: a handler publishes and then returns,
   * so by the time a test has awaited the write, the frame it is waiting for is
   * often already in hand. Waiting for the next one after that waits forever.
   */
  async until(condition: () => boolean, within = 4000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > within) {
        throw new Error("what the test was waiting for never arrived");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  send_raw(text: string): void {
    this.ws.send(text);
  }

  close(): void {
    this.ws.close();
  }
}

function open(url: string, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const client = new Client(ws);
    ws.onerror = () => reject(new Error("the socket would not open"));
    ws.onmessage = ws.onmessage;
    const started = Date.now();
    const settle = (): void => {
      if (client.hello !== undefined) {
        resolve(client);
        return;
      }
      if (Date.now() - started > 4000) {
        reject(new Error("no hello frame arrived"));
        return;
      }
      setTimeout(settle, 5);
    };
    ws.onopen = () => settle();
  });
}

/** The status an upgrade was refused with, for the cases that never become a socket. */
function upgradeStatus(origin: string, path: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      host: origin.split(":")[0],
      port: Number(origin.split(":")[1]),
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    call.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    call.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    call.on("error", reject);
    call.end();
  });
}

/* ----------------------------------------------------------------- tests */

describe("opening a session", () => {
  it("refuses one with no token, in HTTP rather than as a close code", async () => {
    const team = await harness();
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH)).toBe(401);
  });

  it("refuses one whose token this server did not sign", async () => {
    const team = await harness();
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH, "not.a.token")).toBe(401);
  });

  it("refuses one whose account has been disabled", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = team.tokenFor("ada");
    disableUser(team.database, "ada");
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH, token)).toBe(401);
  });

  it("says who is calling, what it serves, and what it speaks", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    expect(client.hello?.protocol).toBe(2);
    expect(client.hello?.account.username).toBe("ada");
    expect(client.hello?.account.operator).toBe(false);
    expect(client.hello?.methods).toContain(TEAM_METHODS.projectsList);
    expect(client.hello?.methods).toContain(TEAM_METHODS.threadsCreate);
    // One vocabulary, the same list the discovery document carries: the socket
    // capabilities the method table implies and the sign-in the HTTP routes add.
    // No history here, because this harness has read no repositories. Announced
    // from what the build serves rather than written down beside it.
    expect([...(client.hello?.capabilities ?? [])].sort()).toEqual([
      "admin",
      "clients",
      "comments",
      "live",
      "overlay",
      "password-sign-in",
      "session",
    ]);
  });
});

describe("calling", () => {
  it("lists every project on this server, each with the remote to clone it from", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsList);
    const projects = answer["projects"] as { name: string; remote: string }[];
    expect(projects.map((project) => project.name)).toEqual(["lighthouse"]);
    // The name is on the end of the remote, which is the thing a client cannot
    // clone without.
    expect(projects[0]?.remote.endsWith("/lighthouse")).toBe(true);
  });

  it("says so when it has no such method, rather than going quiet", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.call("projects.invent")).code).toBe("unknown-method");
  });

  it("refuses a project that is not on this server as not-found", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.call(TEAM_METHODS.projectsGet, { project: "nope" })).code).toBe(
      "not-found",
    );
  });

  it("hands one project what is in it, found by id or by name", async () => {
    let project = { id: "", name: "" };
    const team = await harness({
      // Standing in for the reader, which needs a running loreserver to say
      // either of these. What matters is the shape a read has landed in.
      readings: {
        get: (id: string) =>
          id === project.id
            ? {
                history: { revisions: 3 },
                file: {
                  readable: true,
                  title: "Lighthouse",
                  stageWidth: 1920,
                  stageHeight: 1080,
                  scenes: 4,
                  assets: 12,
                  assetBytes: 3400,
                },
              }
            : undefined,
      },
    });
    const maker = await account(team.database, "ada");
    project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: maker,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const byId = await client.value(TEAM_METHODS.projectsGet, { project: project.id });
    expect((byId["project"] as { name: string }).name).toBe("lighthouse");
    // The whole file, matched field for field rather than in part: this is the
    // shape a client draws a project's front page from.
    expect(byId["file"]).toEqual({
      readable: true,
      title: "Lighthouse",
      stageWidth: 1920,
      stageHeight: 1080,
      scenes: 4,
      assets: 12,
      assetBytes: 3400,
    });
    // The name resolves the same project, because the remote address ends with
    // the name and that is what a client has after a clone.
    const byName = await client.value(TEAM_METHODS.projectsGet, { project: "lighthouse" });
    expect((byName["project"] as { id: string }).id).toBe(project.id);
  });

  it("degrades the file cleanly for a project it has not read, never a refusal", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsGet, { project: project.id });
    // Absent-reading is `readable: false` with a sentence, rather than an error
    // the caller can do nothing about.
    expect((answer["file"] as { readable: boolean }).readable).toBe(false);
    expect((answer["file"] as { reason?: string }).reason).toBeTypeOf("string");
  });
});

describe("what a project row says about its repository", () => {
  /** What a repository that has been read says about itself. */
  const READ_HARBOUR = {
    revisions: 41,
    branch: "main",
    bytes: 8_388_608,
    lastAt: 1_700_000_000_000,
    lastBy: "ada",
    lastMessage: "the harbour scene, lit",
  };

  it("says nothing at all about one nobody has read yet", async () => {
    // The whole of the discipline in one assertion. A project cloned minutes ago
    // has no history to report, and a zeroed one would say nobody had ever
    // worked on it.
    const team = await harness({ readings: { get: () => undefined } });
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsList);
    const [project] = answer["projects"] as Record<string, unknown>[];

    expect(project).toBeDefined();
    expect(project).not.toHaveProperty("history");
  });

  it("carries what the repository last said, once it has been read", async () => {
    const id = newProjectId();
    const team = await harness({
      readings: {
        get: (projectId: string) =>
          projectId === id
            ? { history: READ_HARBOUR, file: { readable: true, title: "Harbour" } }
            : undefined,
      },
    });
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsList);

    expect(answer["projects"]).toMatchObject([{ name: "harbour", history: READ_HARBOUR }]);
  });
});

describe("the people on this server", () => {
  it("is every account, with the address a revision is signed with", async () => {
    const team = await harness();
    await account(team.database, "ada", {
      displayName: "Ada Lovelace",
      email: "ada@example.lan",
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.membersList);

    // The address is on every revision this person authored, so within this
    // server it is not a secret - and a member list that could not be matched
    // against a history would not be much of a member list.
    expect(answer["members"]).toEqual([
      {
        username: "ada",
        displayName: "Ada Lovelace",
        email: "ada@example.lan",
        operator: false,
        disabled: false,
        serviceAccount: false,
        createdAt: expect.any(Number) as unknown as number,
      },
    ]);
  });

  it("lists somebody who has left, so their revisions still have a name on them", async () => {
    const team = await harness();
    await account(team.database, "ada");
    await account(team.database, "grace");
    disableUser(team.database, "grace");
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.membersList);
    const members = answer["members"] as { username: string; disabled: boolean }[];

    // Listed rather than dropped. Somebody who wrote half of a project's history
    // and then left is still the person that history names, and a list they had
    // fallen out of would leave those revisions signed by a stranger.
    expect(members.map((member) => member.username)).toEqual(["ada", "grace"]);
    expect(members[1]).toMatchObject({ username: "grace", disabled: true });
  });

  it("keeps an operator's business out of it", async () => {
    const team = await harness();
    await account(team.database, "ada", { groups: [ADMIN_ROLE] });
    await account(team.database, "bob");
    revokeUserTokens(team.database, "bob");
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.membersList);
    const members = answer["members"] as Record<string, unknown>[];

    // `operator` is a label saying this account may administer the server, and it
    // is not a permission over any project. What the management plane keeps about
    // an account - when its tokens were last refused, what else it is in - is not
    // a name beside a piece of work.
    expect(members[0]?.["operator"]).toBe(true);
    expect(members[1]?.["operator"]).toBe(false);
    for (const member of members) {
      expect(member).not.toHaveProperty("tokensInvalidatedAt");
      expect(member).not.toHaveProperty("role");
      expect(member).not.toHaveProperty("id");
    }
  });
});

describe("a project's history over the socket", () => {
  /** A reader that has whole histories for some projects and none for others. */
  function pagedReader(
    pages: Record<string, { id: string; at?: number }[]>,
  ): Partial<TeamService> {
    return {
      readings: {
        get: () => undefined,
        revisions: (projectId, page) => {
          const whole = pages[projectId];
          if (whole === undefined) {
            return Promise.resolve(undefined);
          }
          const start =
            page.before === undefined
              ? 0
              : whole.findIndex((revision) => revision.id === page.before) + 1;
          const taken = whole.slice(start, start + page.limit);
          return Promise.resolve({
            revisions: taken,
            more: start + taken.length < whole.length,
          });
        },
      },
    };
  }

  it("pages the revisions, handing back a cursor while there is more", async () => {
    // The reader reads this map when it is asked, so it is filled in once the
    // project has an id rather than at harness time.
    const pages: Record<string, { id: string }[]> = {};
    const team = await harness(pagedReader(pages));
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    pages[project.id] = [{ id: "r3" }, { id: "r2" }, { id: "r1" }];
    const client = await team.connect(team.tokenFor("ada"));

    const first = await client.value(TEAM_METHODS.projectsHistory, {
      project: project.id,
      limit: 2,
    });
    expect((first["revisions"] as { id: string }[]).map((revision) => revision.id)).toEqual([
      "r3",
      "r2",
    ]);
    // A cursor because there is a page after this one, and it is the last id on
    // this page - a revision id, not a time-and-id pair.
    expect(first["cursor"]).toBe("r2");

    const second = await client.value(TEAM_METHODS.projectsHistory, {
      project: project.id,
      limit: 2,
      cursor: first["cursor"],
    });
    expect((second["revisions"] as { id: string }[]).map((revision) => revision.id)).toEqual([
      "r1",
    ]);
    // The end of the history carries no cursor.
    expect(second).not.toHaveProperty("cursor");
  });

  it("answers an empty page for a project it has no checkout of", async () => {
    const team = await harness(pagedReader({}));
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsHistory, { project: project.id });
    // "Not read yet", which is a different thing from "no revisions": an empty
    // page and no cursor, never a refusal.
    expect(answer["revisions"]).toEqual([]);
    expect(answer).not.toHaveProperty("cursor");
  });

  it("answers an empty page on a build that reads no repositories", async () => {
    // No reader at all - the ordinary test harness. The method is there because
    // it is gated by `session`, and it says the honest thing rather than refusing.
    const team = await harness();
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsHistory, { project: project.id });
    expect(answer["revisions"]).toEqual([]);
  });

  it("refuses a project that is not on this server as not-found", async () => {
    const team = await harness(pagedReader({}));
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.call(TEAM_METHODS.projectsHistory, { project: "nope" })).code).toBe(
      "not-found",
    );
  });

  it("reads through a reader that is a class, keeping its `this`", async () => {
    // The real reader is a class whose `revisions` finds its state on `this`, so
    // a handler that lifted the method off it and called it on its own would
    // throw where the server runs and pass on every object-literal stand-in. This
    // reader is a class for exactly that reason: it is the shape that catches it.
    const pages: Record<string, { id: string }[]> = {};
    class ClassReader {
      // The state lives on the instance, so `revisions` has to reach it through
      // `this` - which a method lifted off the object and called on its own no
      // longer has.
      readonly pages = pages;
      get(): undefined {
        return undefined;
      }
      revisions(
        projectId: string,
        page: { limit: number; before?: string },
      ): Promise<{ revisions: { id: string }[]; more: boolean } | undefined> {
        const whole = this.pages[projectId];
        if (whole === undefined) {
          return Promise.resolve(undefined);
        }
        const start =
          page.before === undefined
            ? 0
            : whole.findIndex((revision) => revision.id === page.before) + 1;
        const taken = whole.slice(start, start + page.limit);
        return Promise.resolve({ revisions: taken, more: start + taken.length < whole.length });
      }
    }
    const team = await harness({ readings: new ClassReader() });
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    pages[project.id] = [{ id: "r1" }];
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsHistory, { project: project.id });
    expect((answer["revisions"] as { id: string }[]).map((revision) => revision.id)).toEqual([
      "r1",
    ]);
  });
});

describe("making a project over the socket", () => {
  it("adopts a repository the author already has, and tells whoever holds the list", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const repositoryId = newProjectId();

    // Somebody else watching the list, on a connection that did not make the
    // write - the one thing a request-and-response API could never show.
    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_PROJECTS });

    const maker = await team.connect(team.tokenFor("ada"));
    const answer = await maker.value(TEAM_METHODS.projectsCreate, {
      name: "driftwood",
      description: "eight months of it",
      repositoryId,
    });
    // Adopting asks loreserver for nothing - the harness dials a port it made
    // sure nothing answers on, so an answer at all is the assertion that none
    // was asked for.
    const project = answer["project"] as { id: string; name: string };
    expect(project).toMatchObject({ id: repositoryId, name: "driftwood" });

    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as { kind: string; project: string };
    expect(event.kind).toBe("project-created");
    expect(event.project).toBe(repositoryId);
  });

  it("hands a repeated create back the same project, and announces nothing again", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const repositoryId = newProjectId();

    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_PROJECTS });

    const maker = await team.connect(team.tokenFor("ada"));
    const first = await maker.value(TEAM_METHODS.projectsCreate, {
      name: "driftwood",
      repositoryId,
      clientId: "make-once",
    });
    await watcher.until(() => watcher.events.length >= 1);

    // The same client id, replayed as after a dropped socket: the row it already
    // made, not a second project and not a name-taken refusal.
    const second = await maker.value(TEAM_METHODS.projectsCreate, {
      name: "driftwood",
      repositoryId,
      clientId: "make-once",
    });
    expect((second["project"] as { id: string }).id).toBe(
      (first["project"] as { id: string }).id,
    );
    expect(listProjects(team.database)).toHaveLength(1);
    // The event went out when the write really happened; a repeat announces
    // nothing, or every other client would redraw a list that did not move.
    expect(watcher.events).toHaveLength(1);
  });

  it("refuses a repository this server already holds as a conflict", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    const repositoryId = newProjectId();
    createProject(team.database, {
      id: repositoryId,
      name: "driftwood",
      description: "",
      createdBy: ada,
    });
    const maker = await team.connect(team.tokenFor("ada"));

    const answer = await maker.call(TEAM_METHODS.projectsCreate, {
      name: "driftwood-again",
      repositoryId,
    });
    expect(answer.code).toBe("conflict");
  });

  it("refuses something that is not a repository id as bad-params", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const maker = await team.connect(team.tokenFor("ada"));

    const answer = await maker.call(TEAM_METHODS.projectsCreate, {
      name: "driftwood",
      repositoryId: "not-a-repository-id",
    });
    expect(answer.code).toBe("bad-params");
  });

  it("refuses a name that is already taken as a conflict", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "driftwood",
      description: "",
      createdBy: ada,
    });
    const maker = await team.connect(team.tokenFor("ada"));

    const answer = await maker.call(TEAM_METHODS.projectsCreate, {
      name: "driftwood",
      repositoryId: newProjectId(),
    });
    expect(answer.code).toBe("conflict");
  });

  it("rolls the row back when loreserver will not make the repository", async () => {
    // No repository id, so this is a create from nothing: it asks loreserver,
    // which nothing answers on the data port in these tests. The row must not
    // survive a create that could not be finished.
    const team = await harness();
    await account(team.database, "ada");
    const maker = await team.connect(team.tokenFor("ada"));

    const answer = await maker.call(TEAM_METHODS.projectsCreate, { name: "driftwood" });
    expect(answer.code).toBe("unavailable");
    expect(listProjects(team.database)).toEqual([]);
  });
});

describe("forgetting a project over the socket", () => {
  it("takes it off the list, and tells whoever is watching", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });

    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_PROJECTS });

    const forgetter = await team.connect(team.tokenFor("ada"));
    // An object, not null: a method with nothing to report answers with {}.
    expect(await forgetter.value(TEAM_METHODS.projectsForget, { project: project.id })).toEqual({});
    // The row is gone, and a fresh read of the list over the socket no longer
    // shows it.
    expect(listProjects(team.database)).toEqual([]);
    const listed = (await forgetter.value(TEAM_METHODS.projectsList))["projects"] as unknown[];
    expect(listed).toEqual([]);

    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as { kind: string; project: string };
    expect(event.kind).toBe("project-forgotten");
    expect(event.project).toBe(project.id);
  });

  it("drops what the reader held about it, so a re-registration starts clean", async () => {
    const held: Record<string, boolean> = {};
    let project = { id: "" };
    const team = await harness({
      readings: {
        get: () => undefined,
        forget: (projectId: string) => {
          held[projectId] = true;
        },
      },
    });
    const ada = await account(team.database, "ada");
    project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    await client.value(TEAM_METHODS.projectsForget, { project: project.id });
    // The reading was told to forget the project too, keyed by the repository id
    // a re-registration would keep.
    expect(held[project.id]).toBe(true);
  });

  it("forgets by name as readily as by id", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    expect(await client.value(TEAM_METHODS.projectsForget, { project: "lighthouse" })).toEqual({});
    expect(listProjects(team.database)).toEqual([]);
  });

  it("is idempotent: forgetting one that is already gone is an answer, not a refusal", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    // Nothing by that name was ever here. The state the caller wanted is the
    // state there is, so this is {} rather than not-found.
    const answer = await client.call(TEAM_METHODS.projectsForget, { project: "never-here" });
    expect(answer.code).toBeUndefined();
    expect(answer.value).toEqual({});
  });

  it("drops the reading through the reader this server actually runs", async () => {
    // Every other stand-in here is an object literal, whose `forget` is a
    // function that never wanted a `this`. The reader a running server is handed
    // is a class keeping two maps, so a handler that lifted the method off it and
    // called the copy would fail on every deployment while this file stayed
    // green. Nothing is cloned: what is asserted is that the call goes through
    // the real object and the row goes with it.
    const id = newProjectId();
    const team = await harness((of) => ({ readings: new ProjectReadings(of) }));
    const ada = await account(team.database, "ada");
    createProject(team.database, { id, name: "harbour", description: "", createdBy: ada });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.call(TEAM_METHODS.projectsForget, { project: id });

    expect(answer.code).toBeUndefined();
    expect(listProjects(team.database)).toEqual([]);
  });
});

describe("subscribing", () => {
  it("says where a topic stands, and refuses one nobody publishes", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    const good = await client.send("subscribe", { topic: TOPIC_PROJECTS });
    expect(good.seq).toBe(0);
    expect((await client.send("subscribe", { topic: "weather" })).code).toBe("not-found");
    // The people list is read on demand, not watched: `members` is not a topic,
    // so subscribing to it is refused rather than left waiting for an event
    // nobody publishes.
    expect((await client.send("subscribe", { topic: "members" })).code).toBe("not-found");
  });

  it("refuses a project topic for a project that is not here", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.send("subscribe", { topic: "project:nope" })).code).toBe("not-found");
  });

  it("carries what somebody else did to whoever asked to be told", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });

    const watcher = await team.connect(team.tokenFor("bob"));
    await watcher.send("subscribe", { topic: projectThreadsTopic(project.id) });

    const writer = await team.connect(team.tokenFor("ada"));
    await writer.value(TEAM_METHODS.threadsCreate, {
      project: project.id,
      anchor: { document: "story/act-one.json", element: "row-14" },
      body: "this line lands flat",
    });

    await watcher.until(() => watcher.events.length > 0);
    expect(watcher.events).toHaveLength(1);
    expect(watcher.events[0]?.seq).toBe(1);
    const payload = watcher.events[0]?.payload as { kind: string; thread: { anchor: unknown } };
    expect(payload.kind).toBe("thread-created");
    // The anchor comes back exactly as it went in. This server stores those
    // strings and never reads them.
    expect(payload.thread.anchor).toEqual({
      document: "story/act-one.json",
      element: "row-14",
    });
  });

  it("does not carry it to a session that did not ask", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });

    const quiet = await team.connect(team.tokenFor("bob"));
    const writer = await team.connect(team.tokenFor("ada"));
    await writer.value(TEAM_METHODS.threadsCreate, {
      project: project.id,
      anchor: { document: "story/act-one.json" },
      body: "nobody is listening",
    });

    expect(quiet.events).toEqual([]);
  });
});

describe("conversations", () => {
  async function withProject(): Promise<{
    team: Harness;
    project: string;
    ada: Client;
    bob: Client;
  }> {
    const team = await harness();
    const adaId = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: adaId,
    });
    return {
      team,
      project: project.id,
      ada: await team.connect(team.tokenFor("ada")),
      bob: await team.connect(team.tokenFor("bob")),
    };
  }

  it("opens a thread, and lists it back with its opening comment", async () => {
    const { project, ada } = await withProject();
    await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14", revision: "abc123" },
      body: "this line lands flat",
    });

    const listed = await ada.value(TEAM_METHODS.threadsList, { project });
    const threads = listed["threads"] as {
      status: string;
      comments: number;
      opening: { body: string };
      anchor: { revision?: string };
    }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.comments).toBe(1);
    expect(threads[0]?.opening.body).toBe("this line lands flat");
    expect(threads[0]?.anchor.revision).toBe("abc123");
  });

  it("names whoever said it, rather than handing back an account id", async () => {
    const { project, ada } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: {},
      body: "about this project",
    });
    expect((opened["thread"] as { createdBy: string }).createdBy).toBe("ada");
    expect((opened["comment"] as { author: string }).author).toBe("ada");
  });

  it("takes a thread about the project itself, with nothing anchored", async () => {
    const { project, ada } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: {},
      body: "where should this go",
    });
    // Absent rather than a path standing in for one: a note about the project has no
    // document, and inventing one would put a string on screen nobody wrote.
    expect((opened["thread"] as { anchor: Record<string, unknown> }).anchor).toEqual({});

    const listed = await ada.value(TEAM_METHODS.threadsList, { project });
    expect((listed["threads"] as unknown[]).length).toBe(1);
  });

  it("narrows a list to one place inside a document", async () => {
    const { project, ada } = await withProject();
    for (const element of ["row-1", "row-2"]) {
      await ada.value(TEAM_METHODS.threadsCreate, {
        project,
        anchor: { document: "story/act-one.json", element },
        body: `about ${element}`,
      });
    }
    const listed = await ada.value(TEAM_METHODS.threadsList, {
      project,
      document: "story/act-one.json",
      element: "row-2",
    });
    expect((listed["threads"] as unknown[]).length).toBe(1);
  });

  it("makes one thread out of a write that was sent twice", async () => {
    const { project, ada } = await withProject();
    const params = {
      project,
      anchor: { document: "story/act-one.json", element: "row-14" },
      body: "said once",
      clientId: "aa11",
    };
    const first = await ada.value(TEAM_METHODS.threadsCreate, params);
    const again = await ada.value(TEAM_METHODS.threadsCreate, params);
    expect((again["thread"] as { id: string }).id).toBe((first["thread"] as { id: string }).id);

    const listed = await ada.value(TEAM_METHODS.threadsList, { project });
    expect((listed["threads"] as unknown[]).length).toBe(1);
  });

  it("keeps a reply's idempotency apart from a thread's opening comment", async () => {
    const { project, ada } = await withProject();
    // A created thread stores its opening comment under the client id the create
    // was given; a reply stores its comment under the client id the reply was
    // given. With the method in the idempotency key those live in separate
    // namespaces, so a reply whose client id coincides with a created thread's
    // adds its own comment rather than being handed that thread's opening one.
    const first = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "first thread",
      clientId: "shared",
    });
    const firstThread = (first["thread"] as { id: string }).id;
    const other = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-two.json" },
      body: "second thread",
    });
    const target = (other["thread"] as { id: string }).id;

    const replied = await ada.value(TEAM_METHODS.threadsReply, {
      thread: target,
      body: "a reply of its own",
      clientId: "shared:opening",
    });
    const comment = replied["comment"] as { thread: string; body: string };
    expect(comment.thread).toBe(target);
    expect(comment.thread).not.toBe(firstThread);
    expect(comment.body).toBe("a reply of its own");
  });

  it("publishes nothing when a resolve does not change the thread", async () => {
    const { project, ada, bob } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });
    const thread = (opened["thread"] as { id: string }).id;

    await bob.send("subscribe", { topic: projectThreadsTopic(project) });

    // The first resolve is a real change, and is announced.
    await ada.value(TEAM_METHODS.threadsResolve, { thread });
    await bob.until(() => bob.events.length > 0);
    expect(bob.events).toHaveLength(1);
    expect((bob.events[0]?.payload as { kind: string }).kind).toBe("thread-updated");

    // Resolving an already-resolved thread moves nothing, so it announces
    // nothing: a client that redraws on every event must not be made to redraw
    // for a write that changed no state.
    await ada.value(TEAM_METHODS.threadsResolve, { thread });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.events).toHaveLength(1);
  });

  it("lets anybody reply and anybody resolve", async () => {
    const { project, ada, bob } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });
    const thread = (opened["thread"] as { id: string }).id;

    await bob.value(TEAM_METHODS.threadsReply, { thread, body: "agreed" });
    const resolved = await bob.value(TEAM_METHODS.threadsResolve, { thread });
    expect((resolved["thread"] as { status: string }).status).toBe("resolved");

    const whole = await ada.value(TEAM_METHODS.threadsGet, { thread });
    expect((whole["comments"] as unknown[]).length).toBe(2);
  });

  it("refuses to let one person edit another's words", async () => {
    const { project, ada, bob } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "mine",
    });
    const comment = (opened["comment"] as { id: string }).id;

    const refusal = await bob.call(TEAM_METHODS.commentsEdit, { comment, body: "not mine" });
    expect(refusal.code).toBe("refused");
    const deletion = await bob.call(TEAM_METHODS.commentsDelete, { comment });
    expect(deletion.code).toBe("refused");
  });

  it("keeps a withdrawn comment in its place, without its body", async () => {
    const { project, ada } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });
    const thread = (opened["thread"] as { id: string }).id;
    await ada.value(TEAM_METHODS.threadsReply, { thread, body: "second thoughts" });
    const reply = await ada.value(TEAM_METHODS.threadsGet, { thread });
    const second = (reply["comments"] as { id: string }[])[1];

    await ada.value(TEAM_METHODS.commentsDelete, { comment: second?.id });

    const after = await ada.value(TEAM_METHODS.threadsGet, { thread });
    const comments = after["comments"] as { body: string; deletedAt?: number }[];
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toBe("");
    expect(comments[1]?.deletedAt).toBeGreaterThan(0);
  });

  it("insists a suggestion carries what it suggests", async () => {
    const { project, ada } = await withProject();
    const refusal = await ada.call(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      kind: "suggestion",
      body: "try this instead",
    });
    expect(refusal.code).toBe("bad-params");
  });

  it("hands a suggestion back exactly as it arrived, having read none of it", async () => {
    const { project, ada } = await withProject();
    const proposal = JSON.stringify({ text: "The lighthouse went dark.", speaker: "narrator" });
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14" },
      kind: "suggestion",
      body: "try this instead",
      suggestion: proposal,
    });
    expect((opened["comment"] as { suggestion: string }).suggestion).toBe(proposal);
    expect((opened["thread"] as { kind: string }).kind).toBe("suggestion");
  });

  it("takes a project's conversations off with the project", async () => {
    const { team, project, ada } = await withProject();
    await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });

    forgetProject(team.database, project);

    const rows = team.database
      .prepare("SELECT COUNT(*) AS total FROM threads WHERE project_id = ?")
      .get(project) as { total: number };
    expect(rows.total).toBe(0);
    const orphans = team.database
      .prepare("SELECT COUNT(*) AS total FROM comments")
      .get() as { total: number };
    expect(orphans.total).toBe(0);
  });
});

describe("what a session refuses to carry on with", () => {
  it("ends on a frame that is not JSON", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    client.send_raw("not json");
    await client.until(() => client.byes.length > 0);
    expect(client.byes[0]?.code).toBe("bad-params");
  });

  it("ends on a frame of a kind it does not speak", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    client.send_raw(JSON.stringify({ t: "shout", id: 1 }));
    await client.until(() => client.byes.length > 0);
    expect(client.byes[0]?.code).toBe("bad-params");
  });
});

describe("the code a session closes with says why", () => {
  it("closes 1002 on a frame the protocol does not allow", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    // A well-formed WebSocket message carrying a frame this protocol has no kind
    // for. The close code is what tells a client author their frame was wrong,
    // rather than reading as a clean goodbye.
    client.send_raw(JSON.stringify({ t: "shout", id: 1 }));
    await client.until(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(1002);
  });

  it("closes 1002 on a frame that is not JSON", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    client.send_raw("not json at all");
    await client.until(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(1002);
  });
});

describe("what an answer with nothing to report carries", () => {
  it("is an empty object, so every result.value is an object rather than null", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    // A method whose whole result is that it worked, answered whether or not
    // there was anything to withdraw.
    const withdrawn = await client.call(TEAM_METHODS.clientsWithdraw, { project: "whatever" });
    expect(withdrawn.code).toBeUndefined();
    expect(withdrawn.value).toEqual({});

    // The unsubscribe acknowledgement, which is not a method but answers the
    // same way. Dropping a topic that was never held is a success.
    const dropped = await client.send("unsubscribe", { topic: TOPIC_PROJECTS });
    expect(dropped.value).toEqual({});
  });
});

/* ------------------------------------------- instances, rooms and overlay */

/**
 * A project with two connected sessions, and nothing announced on either.
 *
 * Announcing is deliberately left to each test: what an installation says about
 * itself is half of what these methods are, and a helper that did it would hide
 * the one refusal that matters - a call about a machine, from a session that
 * never said which machine it is.
 */
async function withTwo(extra: Partial<TeamService> = {}): Promise<{
  team: Harness;
  project: string;
  ada: Client;
  bob: Client;
}> {
  const team = await harness(extra);
  const adaId = await account(team.database, "ada");
  await account(team.database, "bob");
  const project = createProject(team.database, {
    id: newProjectId(),
    name: "lighthouse",
    description: "",
    createdBy: adaId,
  });
  return {
    team,
    project: project.id,
    ada: await team.connect(team.tokenFor("ada")),
    bob: await team.connect(team.tokenFor("bob")),
  };
}

/** What a client says about itself, with only the interesting field varying. */
function announcement(instance: string, project?: string): Record<string, unknown> {
  return {
    instance,
    label: instance === "nomen" ? "Nomen" : "the studio iMac",
    agent: "NarraLeaf Studio 0.0.0-test",
    ...(project === undefined ? {} : { project }),
  };
}

describe("which installation is on the other end", () => {
  it("is nobody until a session says so", async () => {
    const { ada, project } = await withTwo();
    const listed = await ada.value(TEAM_METHODS.clientsList, { project });
    expect(listed["clients"]).toEqual([]);
  });

  it("is the id the client chose, not one this server made up", async () => {
    const { ada, project } = await withTwo();
    const said = await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    expect((said["client"] as { id: string }).id).toBe("nomen");
    expect((said["client"] as { account: string }).account).toBe("ada");
  });

  it("lists two machines of one project, and narrows to a project", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));

    const here = (await ada.value(TEAM_METHODS.clientsList, { project }))["clients"] as {
      id: string;
    }[];
    expect(here.map((each) => each.id).sort()).toEqual(["imac", "nomen"]);

    const elsewhere = (await ada.value(TEAM_METHODS.clientsList, { project: newProjectId() }))[
      "clients"
    ] as unknown[];
    expect(elsewhere).toEqual([]);
  });

  it("carries one entry per window of a machine that has two projects open", async () => {
    const { ada, team, project } = await withTwo();
    const second = createProject(team.database, {
      id: newProjectId(),
      name: "driftwood",
      description: "",
      createdBy: requireUser(team.database, "ada").id,
    });
    // What Studio composes: one installation, a window per project, and an
    // instance id made of both - all of it down one socket, because Studio holds
    // one per server rather than one per window.
    const window = (id: string): Record<string, unknown> => ({
      instance: `nomen.${id}`,
      label: "Nomen",
      agent: "NarraLeaf Studio 0.0.0-test",
      project: id,
    });
    await ada.value(TEAM_METHODS.clientsAnnounce, window(project));
    await ada.value(TEAM_METHODS.clientsAnnounce, window(second.id));

    const on = async (id: string): Promise<number> =>
      ((await ada.value(TEAM_METHODS.clientsList, { project: id }))["clients"] as unknown[]).length;
    expect(await on(project)).toBe(1);
    expect(await on(second.id)).toBe(1);
    // Neither overwrote the other, which is what a model of one instance per
    // connection would have done.
    expect(((await ada.value(TEAM_METHODS.clientsList, {}))["clients"] as unknown[]).length).toBe(2);

    // And a room opened from one window belongs to that window rather than to
    // the machine: the instance is resolved by the project the call is about.
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    expect((opened["session"] as { openedByInstance: string }).openedByInstance).toBe(
      `nomen.${project}`,
    );
  });

  it("tells a project's watchers when a machine arrives", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.send("subscribe", { topic: projectClientsTopic(project) });

    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));

    await ada.until(() => ada.events.length > 0);
    expect(ada.events[0]?.topic).toBe(projectClientsTopic(project));
    expect((ada.events[0]?.payload as { kind: string }).kind).toBe("client-here");
  });

  it("moves a machine that opened a different project, saying so on both", async () => {
    const { ada, bob, team, project } = await withTwo();
    const second = createProject(team.database, {
      id: newProjectId(),
      name: "driftwood",
      description: "",
      createdBy: requireUser(team.database, "ada").id,
    });
    await ada.send("subscribe", { topic: projectClientsTopic(project) });
    await ada.send("subscribe", { topic: projectClientsTopic(second.id) });

    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", second.id));

    await ada.until(() => ada.events.length >= 3);
    const kinds = ada.events.map((each) => ({
      topic: each.topic,
      kind: (each.payload as { kind: string }).kind,
    }));
    expect(kinds).toContainEqual({ topic: projectClientsTopic(project), kind: "client-gone" });
    expect(kinds).toContainEqual({ topic: projectClientsTopic(second.id), kind: "client-here" });
    expect(
      ((await ada.value(TEAM_METHODS.clientsList, { project }))["clients"] as unknown[]).length,
    ).toBe(0);
  });

  it("forgets a machine whose socket closed, without being told goodbye", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.send("subscribe", { topic: projectClientsTopic(project) });
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    await ada.until(() => ada.events.length > 0);

    bob.close();

    await ada.until(() =>
      ada.events.some((each) => (each.payload as { kind: string }).kind === "client-gone"),
    );
    const left = (await ada.value(TEAM_METHODS.clientsList, { project }))["clients"] as unknown[];
    expect(left).toEqual([]);
  });

  it("takes a window's presence back when it closes, without the socket closing", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.send("subscribe", { topic: projectClientsTopic(project) });
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    await ada.until(() => ada.events.length > 0);

    await bob.value(TEAM_METHODS.clientsWithdraw, { project });

    expect((await ada.value(TEAM_METHODS.clientsList, { project }))["clients"]).toEqual([]);
    expect(
      ada.events.some((each) => (each.payload as { kind: string }).kind === "client-gone"),
    ).toBe(true);
    // The session is still perfectly good: what closed was a window.
    expect((await bob.call(TEAM_METHODS.clientsList, { project })).code).toBeUndefined();
  });

  it("says nothing went wrong withdrawing a project nothing was announced about", async () => {
    const { ada, project } = await withTwo();
    expect((await ada.call(TEAM_METHODS.clientsWithdraw, { project })).code).toBeUndefined();
  });

  it("refuses an announcement about a project this server has not got", async () => {
    const { ada } = await withTwo();
    const refusal = await ada.call(
      TEAM_METHODS.clientsAnnounce,
      announcement("nomen", newProjectId()),
    );
    expect(refusal.code).toBe("not-found");
  });

  it("stays with the account that announced it, over a reconnect and against anybody else", async () => {
    const { ada, bob, team, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    // The case the rule exists for: one installation, a new socket, the same
    // id. It moves to the new connection and it is still ada's.
    const reconnected = await team.connect(team.tokenFor("ada"));
    const moved = await reconnected.value(
      TEAM_METHODS.clientsAnnounce,
      announcement("nomen", project),
    );
    expect((moved["client"] as { account: string }).account).toBe("ada");

    // And bob may not have it, whatever he knows about it.
    const refusal = await bob.call(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    expect(refusal.code).toBe("conflict");
    const here = (await ada.value(TEAM_METHODS.clientsList, { project }))["clients"] as {
      id: string;
      account: string;
    }[];
    expect(here).toEqual([expect.objectContaining({ id: "nomen", account: "ada" })]);
  });

  it("is what a room is controlled by, so taking one would be taking the rooms it opened", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
    });
    const session = (opened["session"] as { id: string }).id;

    // A room's opener is an instance id rather than an account, so an id that
    // could change hands would be a room that could. Bob cannot announce ada's,
    // and under his own he is a passer-by.
    expect(
      (await bob.call(TEAM_METHODS.clientsAnnounce, announcement("nomen", project))).code,
    ).toBe("conflict");
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    expect((await bob.call(TEAM_METHODS.liveClose, { session })).code).toBe("refused");
  });
});

describe("a live session", () => {
  it("cannot be opened by a session that never said what it is", async () => {
    const { ada, project } = await withTwo();
    const refusal = await ada.call(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    expect(refusal.code).toBe("refused");
  });

  it("cannot be opened without the revision its members are to start from", async () => {
    const { ada, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    const refusal = await ada.call(TEAM_METHODS.liveOpen, { project });

    // Bad parameters rather than a refusal: the caller may open a room here, it
    // simply did not say where everybody is starting from, and a room whose
    // members cannot tell whether their documents agree is not one.
    expect(refusal.code).toBe("bad-params");
  });

  it("cannot be opened without saying which document it is about", async () => {
    const { ada, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    const refusal = await ada.call(TEAM_METHODS.liveOpen, { project, revision: "rev-1" });

    // The second half of the same rule the revision is subject to, and not a
    // repetition of it: the revision says which text everybody began from, this
    // says which document of it they are editing. A room carrying only the
    // first leaves a joiner to guess, and the only thing it can guess is a
    // document it already has - which shuts out the person for whom joining is
    // how they get the project at all.
    expect(refusal.code).toBe("bad-params");
  });

  it("carries the document it is about to everyone who asks", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-éé",
    });
    // Carried whole and unparsed, as every anchor on this server is: the string
    // is Studio's, and this test is here to say that nothing looks inside it.
    expect((opened["session"] as { story: string }).story).toBe("story-éé");

    const listed = (await bob.value(TEAM_METHODS.liveList, { project }))["sessions"] as {
      story: string;
    }[];
    expect(listed.map((each) => each.story)).toEqual(["story-éé"]);

    await bob.until(() => bob.events.length > 0);
    const announced = bob.events[0]?.payload as { session: { story: string } };
    expect(announced.session.story).toBe("story-éé");
  });

  it("carries the revision it started from to everyone who asks", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-7", story: "story-1" });
    expect((opened["session"] as { revision: string }).revision).toBe("rev-7");

    // The same string on the list a client reads to find a room to join, and on
    // the event a client hears instead of reading the list.
    const listed = (await bob.value(TEAM_METHODS.liveList, { project }))["sessions"] as {
      revision: string;
    }[];
    expect(listed.map((each) => each.revision)).toEqual(["rev-7"]);

    await bob.until(() => bob.events.length > 0);
    const announced = bob.events[0]?.payload as {
      kind: string;
      session: { revision: string };
    };
    expect(announced.kind).toBe("live-opened");
    expect(announced.session.revision).toBe("rev-7");
  });

  it("has its opener in it already, because the last one out closes it", async () => {
    const { ada, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      title: "act one",
    });
    const session = opened["session"] as {
      id: string;
      title: string;
      members: { instance: string }[];
    };
    expect(session.title).toBe("act one");
    expect(session.members.map((each) => each.instance)).toEqual(["nomen"]);
  });

  it("mints four digits for every room, and answers them only to whoever opened it", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    // Minted for every room and not only the ones that need it: the rule can be
    // changed while the room runs, and a code minted at that moment would be a
    // different code every time somebody flipped the switch.
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    expect(opened["code"]).toMatch(/^\d{4}$/);

    // ⚠ And nowhere else. The room record goes out on the project's topic to
    // everybody watching the project, so a code on it is a code that has said
    // nothing.
    expect(JSON.stringify(opened["session"])).not.toContain(opened["code"] as string);
    await bob.until(() => bob.events.length > 0);
    expect(JSON.stringify(bob.events[0]?.payload)).not.toContain(opened["code"] as string);
  });

  it("keeps a room joined by its code out of everybody else's list", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));

    await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "code",
    });

    // Not discoverable is a fact about this server's answer, not about what a
    // client chooses to draw.
    expect((await bob.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);
    // And still there for the window that is in it, which is how a reload finds
    // the room it never left.
    const mine = (await ada.value(TEAM_METHODS.liveList, { project }))["sessions"] as {
      rule: string;
    }[];
    expect(mine.map((each) => each.rule)).toEqual(["code"]);
  });

  it("refuses a code room to somebody who has its id but not its digits", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "code",
    });
    const id = (opened["session"] as { id: string }).id;

    // Being kept off the list is what stops the room being stumbled upon; this is
    // what stops an id being enough, and without it the rule would be a rule about
    // listings rather than about joining.
    expect((await bob.call(TEAM_METHODS.liveJoin, { session: id })).code).toBe("refused");
    expect((await bob.call(TEAM_METHODS.liveJoin, { session: id, code: "0000" })).code)
      .not.toBe(undefined);

    const joined = await bob.value(TEAM_METHODS.liveJoin, { code: opened["code"] });
    expect((joined["session"] as { id: string }).id).toBe(id);
  });

  it("tells a machine with no project which project a code names", async () => {
    // ⚠ The case the whole idea is for, and the one every other live method
    // cannot serve: somebody was read four digits and has never had this project.
    // Measured before this existed - `live.join` answered "this session has not
    // said which installation has that project open", which is a true sentence
    // about a step they could not take, because the step needs a project id they
    // had no way to learn.
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "code",
    });

    // bob announces nothing, and still gets an answer.
    const found = await bob.value(TEAM_METHODS.liveByCode, { code: opened["code"] });
    const session = found["session"] as { id: string; project: string; revision: string; story: string };
    expect(session.project).toBe(project);
    expect(session.revision).toBe("rev-1");
    expect(session.story).toBe("story-1");
    // And nothing it did not have to give away: no field of the record is the
    // digits. Field by field rather than against the whole serialisation, which
    // was measured failing on a run that had nothing wrong with it: four decimal
    // digits turn up inside a random project id about once in two thousand runs,
    // and a test that fails at random is a test nobody can read a failure from.
    expect(Object.values(found["session"] as Record<string, unknown>)).not.toContain(
      opened["code"],
    );

    // With the project known, the ordinary steps work: say which installation has
    // it, then join by the code.
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const joined = await bob.value(TEAM_METHODS.liveJoin, { code: opened["code"] });
    expect((joined["session"] as { id: string }).id).toBe(session.id);
  });

  it("says nothing about a code nobody is using, however it is asked", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1", rule: "code" });

    expect((await bob.call(TEAM_METHODS.liveByCode, { code: "0000" })).code).toBe("not-found");
  });

  it("answers a wrong code the way it answers a code nobody is using", async () => {
    // Telling the two apart would turn ten thousand guesses into a map of which
    // rooms exist, which is the one thing the shortness of a code would then cost.
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "code",
    });
    const wrong = String((Number(opened["code"]) + 1) % 10_000).padStart(4, "0");

    expect((await bob.call(TEAM_METHODS.liveJoin, { code: wrong })).code).toBe("not-found");
    expect((await bob.call(TEAM_METHODS.liveJoin, { code: "9999" })).code).toBe("not-found");
  });

  it("changes how a running room is joined without changing its code", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;

    expect(await ada.value(TEAM_METHODS.liveRule, { session: id, rule: "code" })).toEqual({ rule: "code" });
    expect((await bob.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);

    // One room, one code: a host who flips the switch and flips it back has not
    // invalidated what they read out to somebody a minute ago.
    await ada.value(TEAM_METHODS.liveRule, { session: id, rule: "open" });
    await ada.value(TEAM_METHODS.liveRule, { session: id, rule: "code" });
    const joined = await bob.value(TEAM_METHODS.liveJoin, { code: opened["code"] });
    expect((joined["session"] as { id: string }).id).toBe(id);
  });

  it("lets nobody but the opener say how a room is joined", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveJoin, { session: id });

    // A member, and still not the author. The same answer closing somebody else's
    // room gets, and the same reason: the room belongs to whoever opened it.
    expect((await bob.call(TEAM_METHODS.liveRule, { session: id, rule: "code" })).code).toBe("refused");
    expect((await ada.call(TEAM_METHODS.liveRule, { session: id, rule: "sideways" })).code)
      .toBe("bad-params");
  });

  it("keeps a room that is joined by asking out of nobody's list, and out of the room", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "request",
    });
    const id = (opened["session"] as { id: string }).id;

    // Listed, unlike a code room: being found is not the question this rule asks.
    const listed = (await bob.value(TEAM_METHODS.liveList, { project }))["sessions"] as { id: string }[];
    expect(listed.map((each) => each.id)).toEqual([id]);
    // And still not walk-in-able, or the rule would be a decoration on a room
    // anybody could join by pressing the same button.
    expect((await bob.call(TEAM_METHODS.liveJoin, { session: id })).code).toBe("refused");
  });

  it("carries a request to whoever opened the room, and the answer back", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.send("subscribe", { topic: projectLiveTopic(project) });
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "request",
    });
    const id = (opened["session"] as { id: string }).id;
    ada.events.length = 0;

    await bob.value(TEAM_METHODS.liveRequestJoin, { session: id });

    await ada.until(() => ada.events.some((each) =>
      (each.payload as { kind: string }).kind === "live-requested"));
    const asked = ada.events.find((each) =>
      (each.payload as { kind: string }).kind === "live-requested")?.payload as {
        session: string;
        member: { instance: string; account: string };
      };
    expect(asked.session).toBe(id);
    // A person, not an id: what the host is about to decide about is somebody.
    expect(asked.member).toMatchObject({ instance: "imac", account: "bob" });

    bob.events.length = 0;
    await ada.value(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac", admit: true });

    // Yes has no event of its own: being let in is a change to the roster, and a
    // change to the roster is already announced.
    await bob.until(() => bob.events.some((each) =>
      (each.payload as { kind: string }).kind === "live-changed"));
    const changed = bob.events.find((each) =>
      (each.payload as { kind: string }).kind === "live-changed")?.payload as {
        session: { members: { instance: string }[] };
      };
    expect(changed.session.members.map((each) => each.instance)).toContain("imac");
  });

  it("says no in a way the machine that asked can hear", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "request",
    });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveRequestJoin, { session: id });
    bob.events.length = 0;

    await ada.value(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac", admit: false });

    // On the project's topic, because the machine that asked is not in the room
    // and has nothing else to listen to.
    await bob.until(() => bob.events.some((each) =>
      (each.payload as { kind: string }).kind === "live-refused"));
    const refused = bob.events.find((each) =>
      (each.payload as { kind: string }).kind === "live-refused")?.payload as {
        session: string;
        instance: string;
      };
    expect(refused).toMatchObject({ session: id, instance: "imac" });
    // And still outside.
    expect((await bob.call(TEAM_METHODS.liveJoin, { session: id })).code).toBe("refused");
  });

  it("lets nobody but the opener answer for a room, and takes no for an answer twice", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, {
      project,
      revision: "rev-1",
      story: "story-1",
      rule: "request",
    });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveRequestJoin, { session: id });

    expect((await bob.call(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac", admit: true })).code)
      .toBe("refused");
    expect((await ada.call(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac" })).code)
      .toBe("bad-params");

    await ada.value(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac", admit: true });
    // Answering a request that is not outstanding is the state the caller wanted,
    // which is the state there is - the same rule leaving an empty room follows.
    await ada.value(TEAM_METHODS.liveAnswerJoin, { session: id, instance: "imac", admit: false });
  });

  it("is announced on the project it belongs to", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectLiveTopic(project) });
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));

    await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });

    await bob.until(() => bob.events.length > 0);
    expect((bob.events[0]?.payload as { kind: string }).kind).toBe("live-opened");
  });

  it("gains a second machine when it joins", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;

    const joined = await bob.value(TEAM_METHODS.liveJoin, { session: id });
    const members = (joined["session"] as { members: { instance: string }[] }).members;
    expect(members.map((each) => each.instance).sort()).toEqual(["imac", "nomen"]);
  });

  it("carries what one machine says to the others, the speaker included", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveJoin, { session: id });
    await ada.send("subscribe", { topic: liveTopic(id) });
    await bob.send("subscribe", { topic: liveTopic(id) });

    await ada.value(TEAM_METHODS.liveSay, { session: id, payload: { caret: "row-14" } });

    await bob.until(() => bob.events.some((each) => each.topic === liveTopic(id)));
    await ada.until(() => ada.events.some((each) => each.topic === liveTopic(id)));
    const heard = bob.events.find((each) => each.topic === liveTopic(id))?.payload as {
      from: string;
      payload: { caret: string };
    };
    expect(heard.from).toBe("nomen");
    // Handed on exactly as it arrived: this server has read none of it.
    expect(heard.payload).toEqual({ caret: "row-14" });
  });

  it("refuses to carry anything from a machine that is not in it", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;

    const refusal = await bob.call(TEAM_METHODS.liveSay, { session: id, payload: null });
    expect(refusal.code).toBe("refused");
  });

  it("is closed by its opener and by nobody else", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveJoin, { session: id });

    expect((await bob.call(TEAM_METHODS.liveClose, { session: id })).code).toBe("refused");
    await ada.value(TEAM_METHODS.liveClose, { session: id });
    expect((await ada.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);
  });

  it("outlives a guest leaving, and ends when its opener does", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveJoin, { session: id });

    await bob.value(TEAM_METHODS.liveLeave, { session: id });
    expect(
      ((await ada.value(TEAM_METHODS.liveList, { project }))["sessions"] as unknown[]).length,
    ).toBe(1);

    await ada.value(TEAM_METHODS.liveLeave, { session: id });
    expect((await ada.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);
  });

  it("ends when its opener leaves, with somebody else still in it", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    const id = (opened["session"] as { id: string }).id;
    await bob.value(TEAM_METHODS.liveJoin, { session: id });

    await ada.value(TEAM_METHODS.liveLeave, { session: id });

    expect((await bob.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);
  });

  it("ends when its opener's window closes, with somebody else still in it", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    await bob.value(TEAM_METHODS.liveJoin, {
      session: (opened["session"] as { id: string }).id,
    });

    await ada.value(TEAM_METHODS.clientsWithdraw, { project });

    expect((await bob.value(TEAM_METHODS.liveList, { project }))["sessions"]).toEqual([]);
  });

  it("ends when the last machine's socket dies, which is the same thing", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await bob.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    expect((opened["session"] as { id: string }).id).toBeTruthy();

    bob.close();

    // Polled rather than waited on as an event: what proves the room is gone is
    // that the list no longer holds it, and the list is a call.
    const started = Date.now();
    let open = 1;
    while (open > 0 && Date.now() - started < 4000) {
      open = ((await ada.value(TEAM_METHODS.liveList, { project }))["sessions"] as unknown[]).length;
    }
    expect(open).toBe(0);
  });

  it("ends when its opener's socket dies, with somebody else still in it", async () => {
    const { ada, bob, project } = await withTwo();
    await ada.value(TEAM_METHODS.clientsAnnounce, announcement("nomen", project));
    await bob.value(TEAM_METHODS.clientsAnnounce, announcement("imac", project));
    const opened = await ada.value(TEAM_METHODS.liveOpen, { project, revision: "rev-1", story: "story-1" });
    await bob.value(TEAM_METHODS.liveJoin, {
      session: (opened["session"] as { id: string }).id,
    });

    ada.close();

    const started = Date.now();
    let open = 1;
    while (open > 0 && Date.now() - started < 4000) {
      open = ((await bob.value(TEAM_METHODS.liveList, { project }))["sessions"] as unknown[]).length;
    }
    expect(open).toBe(0);
  });

  it("refuses a subscription to a room that is not open", async () => {
    const { ada } = await withTwo();
    const answer = await ada.send("subscribe", { topic: liveTopic("not-a-session") });
    expect(answer.code).toBe("not-found");
  });
});

describe("what is attached to a project without being in it", () => {
  it("comes back with the revision it was written against", async () => {
    const { ada, project } = await withTwo();
    await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14", revision: "rev-1" },
      kind: "review",
      body: JSON.stringify({ state: "needs-work" }),
    });

    const listed = await ada.value(TEAM_METHODS.overlayList, { project });
    const records = listed["records"] as {
      anchor: { revision: string; element: string };
      kind: string;
      author: string;
    }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.anchor.revision).toBe("rev-1");
    expect(records[0]?.anchor.element).toBe("row-14");
    expect(records[0]?.author).toBe("ada");
  });

  it("insists a record says which revision it is about", async () => {
    const { ada, project } = await withTwo();
    const refusal = await ada.call(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json" },
      kind: "review",
      body: "{}",
    });
    expect(refusal.code).toBe("bad-params");
  });

  it("leaves the head absent where this server has read no repository", async () => {
    const { ada, project } = await withTwo();
    const listed = await ada.value(TEAM_METHODS.overlayList, { project });
    // Absent, and it must not be an empty string or a zero: a client that read
    // "not read yet" as "there are no revisions" would mark every record stale.
    expect(listed["head"]).toBeUndefined();
  });

  it("hands back the head this server last read, so a client can age a record", async () => {
    const { ada, project } = await withTwo({
      readings: {
        get: () => ({
          history: { revisions: 3, head: "rev-3" },
          file: { readable: false, reason: "not read in this test" },
        }),
      },
    });
    await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
    });

    const listed = await ada.value(TEAM_METHODS.overlayList, { project });
    expect(listed["head"]).toBe("rev-3");
    // The comparison is the client's. This server says both numbers and no more.
    expect((listed["records"] as { anchor: { revision: string } }[])[0]?.anchor.revision).toBe(
      "rev-1",
    );
  });

  it("is one row however many times the same write arrives", async () => {
    const { ada, project } = await withTwo();
    const write = {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
      clientId: "the-same-write",
    };
    const first = await ada.value(TEAM_METHODS.overlayPut, write);
    const second = await ada.value(TEAM_METHODS.overlayPut, write);

    expect((second["record"] as { id: string }).id).toBe((first["record"] as { id: string }).id);
    expect(second["repeated"]).toBe(true);
    expect(
      ((await ada.value(TEAM_METHODS.overlayList, { project }))["records"] as unknown[]).length,
    ).toBe(1);
  });

  it("narrows to a document, an element and a kind", async () => {
    const { ada, project } = await withTwo();
    const base = { project, kind: "review", body: "{}" };
    await ada.value(TEAM_METHODS.overlayPut, {
      ...base,
      anchor: { document: "story/act-one.json", element: "row-14", revision: "rev-1" },
    });
    await ada.value(TEAM_METHODS.overlayPut, {
      ...base,
      anchor: { document: "story/act-one.json", element: "row-15", revision: "rev-1" },
    });
    await ada.value(TEAM_METHODS.overlayPut, {
      ...base,
      kind: "playtest",
      anchor: { document: "story/act-two.json", revision: "rev-1" },
    });

    const one = await ada.value(TEAM_METHODS.overlayList, {
      project,
      document: "story/act-one.json",
      element: "row-14",
    });
    expect((one["records"] as unknown[]).length).toBe(1);
    // The whole project's count travels with a narrowed read, so a screen
    // showing one row can still say how much else there is.
    expect(one["total"]).toBe(3);

    const kind = await ada.value(TEAM_METHODS.overlayList, { project, kind: "playtest" });
    expect((kind["records"] as unknown[]).length).toBe(1);
  });

  it("tells a project's watchers, once, and not for a repeat", async () => {
    const { ada, bob, project } = await withTwo();
    await bob.send("subscribe", { topic: projectOverlayTopic(project) });
    const write = {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
      clientId: "once",
    };

    await ada.value(TEAM_METHODS.overlayPut, write);
    await bob.until(() => bob.events.length > 0);
    await ada.value(TEAM_METHODS.overlayPut, write);

    // Nothing to wait for, so the check is that a second one has not turned up
    // by the time another round trip has been and gone.
    await ada.value(TEAM_METHODS.overlayList, { project });
    expect(bob.events).toHaveLength(1);
    expect((bob.events[0]?.payload as { kind: string }).kind).toBe("overlay-put");
  });

  it("moves a record forward onto a new revision, which is what following the head is", async () => {
    const { ada, project } = await withTwo();
    const written = await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14", revision: "rev-1" },
      kind: "review",
      body: JSON.stringify({ state: "needs-work" }),
    });
    const id = (written["record"] as { id: string }).id;

    const moved = await ada.value(TEAM_METHODS.overlayPut, {
      id,
      anchor: { revision: "rev-2" },
      body: JSON.stringify({ state: "looked-again" }),
    });
    const record = moved["record"] as {
      anchor: { revision: string; element: string };
      body: string;
    };
    expect(record.anchor.revision).toBe("rev-2");
    // The place did not move. A record that changed which element it was about
    // would be a different record.
    expect(record.anchor.element).toBe("row-14");
    expect(JSON.parse(record.body)).toEqual({ state: "looked-again" });
    expect(
      ((await ada.value(TEAM_METHODS.overlayList, { project }))["records"] as unknown[]).length,
    ).toBe(1);
  });

  it("is replaced and taken off by its author and by nobody else", async () => {
    const { ada, bob, project } = await withTwo();
    const written = await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
    });
    const id = (written["record"] as { id: string }).id;

    const refused = await bob.call(TEAM_METHODS.overlayPut, {
      id,
      anchor: { revision: "rev-2" },
      body: "{}",
    });
    expect(refused.code).toBe("refused");
    expect((await bob.call(TEAM_METHODS.overlayDrop, { id })).code).toBe("refused");

    await ada.value(TEAM_METHODS.overlayDrop, { id });
    expect((await ada.value(TEAM_METHODS.overlayList, { project }))["records"]).toEqual([]);
  });

  it("says nothing went wrong when what was dropped is already gone", async () => {
    const { ada, project } = await withTwo();
    const written = await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
    });
    const id = (written["record"] as { id: string }).id;
    await ada.value(TEAM_METHODS.overlayDrop, { id });
    expect((await ada.call(TEAM_METHODS.overlayDrop, { id })).code).toBeUndefined();
  });

  it("goes with the project when the project is taken off this server", async () => {
    const { ada, team, project } = await withTwo();
    await ada.value(TEAM_METHODS.overlayPut, {
      project,
      anchor: { document: "story/act-one.json", revision: "rev-1" },
      kind: "review",
      body: "{}",
    });

    forgetProject(team.database, project);

    const rows = team.database.prepare("SELECT COUNT(*) AS total FROM overlay").get() as {
      total: number;
    };
    expect(rows.total).toBe(0);
  });
});

/* ------------------------------------------------------ administration */

/**
 * A loreserver health check, stood in for, counting what asks it.
 *
 * The status is the one answer on this server that reaches off the process, and
 * the whole of what its cache is for is that asking twice does not ask twice.
 * Nothing but a real listener can be counted, so there is one.
 */
async function healthCheck(): Promise<{ port: number; asked: () => number }> {
  let asked = 0;
  const server = createServer((_request, response) => {
    asked += 1;
    response.writeHead(200).end("ok");
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { port, asked: () => asked };
}

/**
 * A port number nothing is listening on.
 *
 * Taken by binding to whatever the system offers and letting go of it again, so
 * that the number is one this machine had free a moment ago rather than one the
 * test hopes is free. Naming a fixed port would make every test that wants a
 * closed one fail on a machine that happens to be running the thing that
 * ordinarily listens there - which, for a Team server's own suite, is the
 * machine of anybody working on it.
 *
 * There is a moment between letting go and using it in which something else
 * could take it. Nothing can close that window, and this is the narrow version
 * of it: the alternative is a constant that is wrong for a whole class of
 * machines rather than for an instant.
 */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A server with an operator and somebody who is not one, both connected. */
async function administered(extra: Partial<TeamService> = {}): Promise<{
  team: Harness;
  ada: Client;
  bob: Client;
}> {
  const team = await harness(extra);
  await account(team.database, "ada", { groups: [ADMIN_ROLE] });
  await account(team.database, "bob");
  return {
    team,
    ada: await team.connect(team.tokenFor("ada")),
    bob: await team.connect(team.tokenFor("bob")),
  };
}

/** Every method of the family that only reads, named once. */
const ADMIN_READS = [
  TEAM_METHODS.adminUsersList,
  TEAM_METHODS.adminSettingsList,
  TEAM_METHODS.adminKeysList,
  TEAM_METHODS.adminAuditList,
  TEAM_METHODS.adminServerStatus,
];

/** Every method of the family that changes something. */
const ADMIN_WRITES = [
  TEAM_METHODS.adminUsersCreate,
  TEAM_METHODS.adminUsersDisable,
  TEAM_METHODS.adminUsersEnable,
  TEAM_METHODS.adminUsersGrantAdmin,
  TEAM_METHODS.adminUsersRevokeAdmin,
  TEAM_METHODS.adminUsersRevokeTokens,
  TEAM_METHODS.adminTokensMint,
  TEAM_METHODS.adminSettingsSet,
  TEAM_METHODS.adminKeysRotate,
];

/** Both halves, which is what the gate has to cover. */
const ADMIN_METHODS = [...ADMIN_READS, ...ADMIN_WRITES];

describe("who may administer a server", () => {
  it("names every method of the family in the lists the gate is tested against", () => {
    // The lists above are written by hand, and a method added to the family and
    // not to them would be a method nothing here proves is gated at all. This is
    // what makes forgetting one a failing test rather than an open door.
    const family = Object.values(TEAM_METHODS).filter((name) => name.startsWith("admin."));

    expect([...ADMIN_METHODS].sort()).toEqual([...family].sort());
  });

  it("refuses every one of these methods to somebody who is not an operator", async () => {
    const { bob } = await administered();

    for (const method of ADMIN_METHODS) {
      // No parameters, on the writes as well: the gate is in front of the
      // handler, so a caller who may not do this is refused before anything it
      // sent is read. A `bad-params` here would mean the order was the other way
      // round, and a client would be learning what a method takes by being told
      // off for getting it wrong.
      expect((await bob.call(method)).code, method).toBe("refused");
    }
  });

  it("answers every read to an operator", async () => {
    const { ada } = await administered();

    for (const method of ADMIN_READS) {
      expect((await ada.call(method)).code, method).toBeUndefined();
    }
  });

  it("stops an account administering the moment it is taken out of the group", async () => {
    // The caller is identified for every call rather than when the session
    // opened, which is what makes this true: an account demoted while its
    // socket is open stops being able to administer at once, not when its token
    // expires.
    const { team, ada } = await administered();
    expect((await ada.call(TEAM_METHODS.adminUsersList)).code).toBeUndefined();

    setAdmin(team.database, "ada", false);

    expect((await ada.call(TEAM_METHODS.adminUsersList)).code).toBe("refused");
  });

  it("lets an account administer the moment it is put in the group", async () => {
    const { team, bob } = await administered();
    expect((await bob.call(TEAM_METHODS.adminUsersList)).code).toBe("refused");

    setAdmin(team.database, "bob", true);

    expect((await bob.call(TEAM_METHODS.adminUsersList)).code).toBeUndefined();
  });

  it("tells everybody this server can be administered, and each of them whether they may", async () => {
    // Two facts, deliberately kept apart. The capability says this build has a
    // management surface; the account says whether whoever holds the socket may
    // draw it. Folding them together would leave a client unable to tell an
    // older server from a refusal, which are different sentences to show a
    // person and only one of them is about them.
    const { ada, bob } = await administered();

    expect(ada.hello?.capabilities).toContain("admin");
    expect(bob.hello?.capabilities).toContain("admin");
    expect(ada.hello?.account.operator).toBe(true);
    expect(bob.hello?.account.operator).toBe(false);
    expect(bob.hello?.methods).toContain(TEAM_METHODS.adminUsersList);
  });
});

describe("the accounts, as an operator reads them", () => {
  it("carries what an operator needs and a member list deliberately does not", async () => {
    const { team, ada } = await administered();
    revokeUserTokens(team.database, "bob");

    const users = (await ada.value(TEAM_METHODS.adminUsersList))["users"] as Record<
      string,
      unknown
    >[];
    const bob = users.find((user) => user["username"] === "bob");

    expect(bob).toMatchObject({
      username: "bob",
      displayName: "bob",
      groups: [],
      operator: false,
      disabled: false,
      serviceAccount: false,
    });
    expect(bob?.["id"]).toBeTypeOf("string");
    expect(bob?.["createdAt"]).toBeTypeOf("number");
    // Which is exactly what a member list leaves out.
    expect(bob?.["tokensInvalidatedAt"]).toBeTypeOf("number");
  });

  it("says which groups an account is in, as a list rather than as one string", async () => {
    // A role is however many groups an account is in. A joined string would
    // make every reader take it apart again, and would break the first time a
    // group name held the separator.
    const { ada } = await administered();

    const users = (await ada.value(TEAM_METHODS.adminUsersList))["users"] as Record<
      string,
      unknown
    >[];

    expect(users.find((user) => user["username"] === "ada")?.["groups"]).toEqual([ADMIN_ROLE]);
    expect(users.find((user) => user["username"] === "bob")?.["groups"]).toEqual([]);
  });

  it("leaves out what it does not know rather than sending a nought for it", async () => {
    const { ada } = await administered();

    const users = (await ada.value(TEAM_METHODS.adminUsersList))["users"] as Record<
      string,
      unknown
    >[];

    for (const user of users) {
      expect(user).not.toHaveProperty("tokensInvalidatedAt");
      expect(user).not.toHaveProperty("email");
    }
  });

  it("pages, and the cursor it hands back carries on where the page ended", async () => {
    const team = await harness();
    await account(team.database, "ada", { groups: [ADMIN_ROLE] });
    for (const name of ["bee", "cleo", "dee", "eve"]) {
      await account(team.database, name);
    }
    const ada = await team.connect(team.tokenFor("ada"));

    const seen: string[] = [];
    let cursor: unknown;
    for (;;) {
      const page = await ada.value(TEAM_METHODS.adminUsersList, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...(page["users"] as { username: string }[]).map((user) => user.username));
      if (page["cursor"] === undefined) {
        break;
      }
      cursor = page["cursor"];
    }

    // Neither repeated nor skipped, which is the whole of what the id in the
    // cursor is there for: these five were made within a millisecond or two of
    // each other.
    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(["ada", "bee", "cleo", "dee", "eve"]);
  });

  it("says nothing follows the last page", async () => {
    const { ada } = await administered();

    const page = await ada.value(TEAM_METHODS.adminUsersList, { limit: 50 });

    expect((page["users"] as unknown[]).length).toBe(2);
    expect(page["cursor"]).toBeUndefined();
  });

  it("caps a page at what this server will read rather than at what was asked for", async () => {
    const { ada } = await administered();

    // Answered rather than refused: a caller asking for everything gets a page
    // it can draw, and the cursor is how it gets the rest.
    expect((await ada.call(TEAM_METHODS.adminUsersList, { limit: 100_000 })).code).toBeUndefined();
  });

  it("refuses a limit that is not a whole number of at least one", async () => {
    const { ada } = await administered();

    expect((await ada.call(TEAM_METHODS.adminUsersList, { limit: 0 })).code).toBe("bad-params");
    expect((await ada.call(TEAM_METHODS.adminUsersList, { limit: "lots" })).code).toBe(
      "bad-params",
    );
  });

  it("starts again from the top for a cursor it cannot read", async () => {
    const { ada } = await administered();

    const page = await ada.value(TEAM_METHODS.adminUsersList, { cursor: "not a cursor" });

    expect((page["users"] as unknown[]).length).toBe(2);
  });
});

describe("the decisions, as an operator reads them", () => {
  it("hands them over newest first, and pages without repeating or skipping one", async () => {
    const { team, ada } = await administered();
    for (let index = 0; index < 5; index += 1) {
      recordDecision(team.database, {
        at: Date.parse("2026-08-11T09:00:00Z") + index,
        username: "ada",
        resource: "harbour",
        allowed: index % 2 === 0,
        detail: `reason ${index}`,
      });
    }

    const first = await ada.value(TEAM_METHODS.adminAuditList, { limit: 2 });
    expect((first["decisions"] as { detail: string }[]).map((row) => row.detail)).toEqual([
      "reason 4",
      "reason 3",
    ]);

    const second = await ada.value(TEAM_METHODS.adminAuditList, {
      limit: 2,
      cursor: first["cursor"],
    });
    expect((second["decisions"] as { detail: string }[]).map((row) => row.detail)).toEqual([
      "reason 2",
      "reason 1",
    ]);

    const third = await ada.value(TEAM_METHODS.adminAuditList, {
      limit: 2,
      cursor: second["cursor"],
    });
    expect((third["decisions"] as { detail: string }[]).map((row) => row.detail)).toEqual([
      "reason 0",
    ]);
    expect(third["cursor"]).toBeUndefined();
  });

  it("carries every part of a decision as a named field", async () => {
    const { team, ada } = await administered();
    recordDecision(team.database, {
      at: Date.parse("2026-08-11T09:00:00Z"),
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });

    const [only] = (await ada.value(TEAM_METHODS.adminAuditList))["decisions"] as Record<
      string,
      unknown
    >[];

    expect(only).toMatchObject({
      at: Date.parse("2026-08-11T09:00:00Z"),
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });
    // The row key, so that a list of rows which are otherwise identical can be
    // keyed on something.
    expect(only?.["id"]).toBeTypeOf("number");
  });

  it("says a server nothing has been asked of has been asked nothing", async () => {
    const { ada } = await administered();

    const page = await ada.value(TEAM_METHODS.adminAuditList);

    expect(page["decisions"]).toEqual([]);
    expect(page["cursor"]).toBeUndefined();
  });
});

describe("the settings, as an operator reads them", () => {
  it("answers whole rather than a page at a time", async () => {
    // The rows are a literal in the function that builds them, so there is no
    // query behind this that could return more of them and nothing for a cursor
    // to be a cursor over.
    const { ada } = await administered();

    const answer = await ada.value(TEAM_METHODS.adminSettingsList);

    expect((answer["settings"] as unknown[]).length).toBeGreaterThan(0);
    expect(answer).not.toHaveProperty("cursor");
  });

  it("marks a row editable only where this server has somewhere to put the value", async () => {
    const { ada } = await administered();

    const settings = (await ada.value(TEAM_METHODS.adminSettingsList))["settings"] as {
      label: string;
      editable: boolean;
    }[];

    expect(settings.filter((row) => row.editable).map((row) => row.label)).toEqual([
      "name",
      "collaboration",
      "repeat publishes",
      "sign-in token",
      "repository token",
    ]);
  });

  it("sends each row as an object with named fields", async () => {
    const { ada } = await administered();

    const settings = (await ada.value(TEAM_METHODS.adminSettingsList))["settings"] as Record<
      string,
      unknown
    >[];

    for (const row of settings) {
      expect(row["group"]).toBeTypeOf("string");
      expect(row["label"]).toBeTypeOf("string");
      expect(row["value"]).toBeTypeOf("string");
      expect(row["editable"]).toBeTypeOf("boolean");
    }
  });
});

describe("the signing keys, as an operator reads them", () => {
  it("names the key that signs, and every key that is kept", async () => {
    const { team, ada } = await administered();
    const first = team.keys.signingKey.kid;
    const second = await team.keys.rotate();

    const keys = (await ada.value(TEAM_METHODS.adminKeysList))["keys"] as Record<
      string,
      unknown
    >[];

    expect(keys.map((key) => key["kid"])).toContain(first);
    expect(keys.find((key) => key["kid"] === second.kid)?.["signing"]).toBe(true);
    expect(keys.find((key) => key["kid"] === first)?.["signing"]).toBe(false);
    expect(keys.every((key) => key["retired"] === false)).toBe(true);
  });

  it("keeps a retired key on the list rather than letting it disappear", async () => {
    // Rotated and retired before anybody signs in, because retiring a key ends
    // every session whose token it signed - which is the point of retiring one,
    // and not what this test is about.
    const team = await harness();
    await account(team.database, "ada", { groups: [ADMIN_ROLE] });
    const retiring = team.keys.signingKey.kid;
    await team.keys.rotate();
    await team.keys.retire(retiring);
    const ada = await team.connect(team.tokenFor("ada"));

    const keys = (await ada.value(TEAM_METHODS.adminKeysList))["keys"] as Record<
      string,
      unknown
    >[];

    expect(keys.find((key) => key["kid"] === retiring)?.["retired"]).toBe(true);
    expect(keys.find((key) => key["kid"] === retiring)?.["signing"]).toBe(false);
  });

  it("carries the public half of a key and nothing else", async () => {
    const { ada } = await administered();

    const keys = (await ada.value(TEAM_METHODS.adminKeysList))["keys"] as Record<
      string,
      unknown
    >[];

    for (const key of keys) {
      expect(Object.keys(key).sort()).toEqual(["kid", "retired", "serial", "signing"]);
    }
  });
});

describe("what this server is", () => {
  it("says what it is, what it can reach, and how much of each thing it holds", async () => {
    const health = await healthCheck();
    const { team, ada } = await administered({ healthPort: health.port });
    recordDecision(team.database, {
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });

    const status = await ada.value(TEAM_METHODS.adminServerStatus);

    expect(status["version"]).toBeTypeOf("string");
    expect(status["root"]).toBe(team.service.root);
    expect(status["accounts"]).toBe(2);
    expect(status["projects"]).toBe(0);
    expect(status["decisions"]).toBe(1);
    expect(status["signingKeys"]).toBe(1);
    expect(status["loreserver"]).toMatchObject({ healthy: true });
    // The health check and the keys. The plaintext authorization listener that
    // was the third of these is gone, and nothing was ever pointed at it.
    expect((status["reach"] as { loopback: unknown[] }).loopback).toHaveLength(2);
  });

  it("says a loreserver that is not answering is not answering", async () => {
    // Nothing listens on the harness health port, and from outside the process
    // that supervises it a server which does not answer cannot be told from one
    // that is not running. See unusedPort for why the harness does not simply
    // point at the port loreserver ordinarily uses.
    const { ada } = await administered();

    const status = await ada.value(TEAM_METHODS.adminServerStatus);

    expect(status["loreserver"]).toMatchObject({ healthy: false });
  });

  it("says when it was worked out and how long an answer is kept", async () => {
    const { ada } = await administered();

    const status = await ada.value(TEAM_METHODS.adminServerStatus);

    expect(status["gatheredAt"]).toBeTypeOf("number");
    expect(status["gatheredAt"] as number).toBeLessThanOrEqual(Date.now());
    // Sent rather than assumed, so a panel deciding how often to ask reads this
    // number instead of guessing at one.
    expect(status["freshnessMs"]).toBe(STATUS_FRESHNESS_MS);
  });

  it("is worked out once for callers that ask at the same moment", async () => {
    const health = await healthCheck();
    const { ada } = await administered({ healthPort: health.port });

    const answers = await Promise.all([
      ada.value(TEAM_METHODS.adminServerStatus),
      ada.value(TEAM_METHODS.adminServerStatus),
      ada.value(TEAM_METHODS.adminServerStatus),
    ]);

    expect(health.asked()).toBe(1);
    expect(new Set(answers.map((answer) => answer["gatheredAt"])).size).toBe(1);
  });

  it("is not worked out again inside the time an answer is kept for", async () => {
    const health = await healthCheck();
    const { ada, bob, team } = await administered({ healthPort: health.port });
    setAdmin(team.database, "bob", true);

    const first = await ada.value(TEAM_METHODS.adminServerStatus);
    // Asked on a second session, so this is a fact about the server rather than
    // about one connection remembering something.
    const second = await bob.value(TEAM_METHODS.adminServerStatus);

    expect(health.asked()).toBe(1);
    expect(second["gatheredAt"]).toBe(first["gatheredAt"]);
  });

  it("works it out again once what it kept has gone stale", async () => {
    const health = await healthCheck();
    const team = await harness({ healthPort: health.port });

    const first = await serverStatus(team.service);
    const later = await serverStatus(team.service, first.gatheredAt + STATUS_FRESHNESS_MS);

    expect(health.asked()).toBe(2);
    expect(later.gatheredAt).toBeGreaterThanOrEqual(first.gatheredAt);
  });

  it("costs nothing at all while nobody is asking", async () => {
    // The whole of why this is no longer on a timer. A server that has been up
    // and unasked has made no health check and walked no store.
    const health = await healthCheck();
    await administered({ healthPort: health.port });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(health.asked()).toBe(0);
  });
});

/**
 * A server with an operator, somebody who is not one, and a third session of
 * the operator's watching the accounts.
 *
 * A watcher of its own rather than subscribing the session that does the work,
 * because what is being asserted is that everybody holding the topic is told —
 * a client hearing its own write back is the easy half.
 */
async function watchingAccounts(): Promise<{
  team: Harness;
  ada: Client;
  bob: Client;
  watcher: Client;
}> {
  const made = await administered();
  const watcher = await made.team.connect(made.team.tokenFor("ada"));
  await watcher.send("subscribe", { topic: TOPIC_ADMIN_USERS });
  return { ...made, watcher };
}

/** How long a test that hashes a real password is given. */
const HASHING = 20_000;

/** The account inside an answer that carries one. */
function answered(value: Record<string, unknown>): Record<string, unknown> {
  return value["user"] as Record<string, unknown>;
}

describe("making an account over the session", () => {
  it(
    "answers with the account it made, and says so on the accounts topic",
    async () => {
      const { ada, watcher, team } = await watchingAccounts();

      const made = answered(
        await ada.value(TEAM_METHODS.adminUsersCreate, {
          username: "cleo",
          password: "a password nobody guesses",
          displayName: "Cleo",
          email: "cleo@example.test",
        }),
      );

      // The record, not an acknowledgement: a panel updates the row it is
      // holding from this rather than re-reading the page to find out what it
      // just did.
      expect(made).toMatchObject({
        username: "cleo",
        displayName: "Cleo",
        email: "cleo@example.test",
        groups: ["member"],
        operator: false,
        disabled: false,
      });
      expect(findUser(team.database, "cleo")).toBeDefined();

      await watcher.until(() => watcher.events.length > 0);
      expect(watcher.events).toHaveLength(1);
      expect(watcher.events[0]?.topic).toBe(TOPIC_ADMIN_USERS);
      const event = watcher.events[0]?.payload as { kind: string; user: { username: string } };
      expect(event.kind).toBe("user-created");
      expect(event.user.username).toBe("cleo");
    },
    HASHING,
  );

  it(
    "puts one in the admin group when it is asked to",
    async () => {
      const { ada } = await administered();

      const made = answered(
        await ada.value(TEAM_METHODS.adminUsersCreate, {
          username: "cleo",
          password: "a password nobody guesses",
          operator: true,
        }),
      );

      expect(made["groups"]).toEqual([ADMIN_ROLE]);
      expect(made["operator"]).toBe(true);
    },
    HASHING,
  );

  it("refuses a name somebody on this server already has", async () => {
    const { ada } = await administered();

    const answer = await ada.call(TEAM_METHODS.adminUsersCreate, {
      username: "bob",
      password: "a password nobody guesses",
    });

    expect(answer.code).toBe("conflict");
  });

  it("refuses a name that could not be a username, and a password too short to store", async () => {
    const { ada } = await administered();

    // The sentences come from the one place that decides what a name and a
    // password may be, so a person retyping either is reading the same rule the
    // command line prints.
    const named = await ada.call(TEAM_METHODS.adminUsersCreate, {
      username: "not a username",
      password: "a password nobody guesses",
    });
    const weak = await ada.call(TEAM_METHODS.adminUsersCreate, {
      username: "cleo",
      password: "short",
    });

    expect(named.code).toBe("bad-params");
    expect(weak.code).toBe("bad-params");
  });

  it("refuses a call that named no password at all", async () => {
    const { ada } = await administered();

    expect((await ada.call(TEAM_METHODS.adminUsersCreate, { username: "cleo" })).code).toBe(
      "bad-params",
    );
  });

  it(
    "hands a repeated create back the account it made, and announces nothing again",
    async () => {
      const { ada, watcher, team } = await watchingAccounts();
      const first = answered(
        await ada.value(TEAM_METHODS.adminUsersCreate, {
          username: "cleo",
          password: "a password nobody guesses",
          clientId: "make-cleo",
        }),
      );
      await watcher.until(() => watcher.events.length > 0);

      // The same client id, replayed as after a socket that dropped between the
      // call and its answer: the account it already made, not a name-taken
      // refusal, which is what a plain retry would have been told.
      const second = answered(
        await ada.value(TEAM_METHODS.adminUsersCreate, {
          username: "cleo",
          password: "a password nobody guesses",
          clientId: "make-cleo",
        }),
      );

      expect(second["id"]).toBe(first["id"]);
      expect(listUsers(team.database).map((user) => user.username)).toEqual(["ada", "bob", "cleo"]);
      expect(watcher.events).toHaveLength(1);
    },
    HASHING,
  );
});

describe("changing an account over the session", () => {
  it("disables one, answers with it, and says so", async () => {
    const { ada, watcher, team } = await watchingAccounts();

    const changed = answered(await ada.value(TEAM_METHODS.adminUsersDisable, { username: "bob" }));

    expect(changed["disabled"]).toBe(true);
    expect(requireUser(team.database, "bob").disabledAt).toBeTypeOf("number");
    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as { kind: string; user: { disabled: boolean } };
    expect(event.kind).toBe("user-disabled");
    expect(event.user.disabled).toBe(true);
  });

  it("says nothing when the account is already disabled, and does not move the epoch", async () => {
    const { ada, watcher, team } = await watchingAccounts();
    await ada.value(TEAM_METHODS.adminUsersDisable, { username: "bob" });
    await watcher.until(() => watcher.events.length > 0);
    const epoch = requireUser(team.database, "bob").tokenEpoch;

    const again = answered(await ada.value(TEAM_METHODS.adminUsersDisable, { username: "bob" }));

    // Already disabled is the state that was asked for. Doing it again would not
    // be free — disabling bumps the epoch — and announcing it would make every
    // panel redraw a row that did not move.
    expect(again["disabled"]).toBe(true);
    expect(requireUser(team.database, "bob").tokenEpoch).toBe(epoch);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.events).toHaveLength(1);
  });

  it("enables one again, and says nothing about an account that was never disabled", async () => {
    const { ada, watcher, team } = await watchingAccounts();
    disableUser(team.database, "bob");

    const enabled = answered(await ada.value(TEAM_METHODS.adminUsersEnable, { username: "bob" }));
    await watcher.until(() => watcher.events.length > 0);
    await ada.value(TEAM_METHODS.adminUsersEnable, { username: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(enabled["disabled"]).toBe(false);
    expect(watcher.events).toHaveLength(1);
    expect((watcher.events[0]?.payload as { kind: string }).kind).toBe("user-enabled");
  });

  it("grants administration, and says nothing granting it to an operator", async () => {
    const { ada, watcher } = await watchingAccounts();

    const granted = answered(
      await ada.value(TEAM_METHODS.adminUsersGrantAdmin, { username: "bob" }),
    );
    await watcher.until(() => watcher.events.length > 0);
    await ada.value(TEAM_METHODS.adminUsersGrantAdmin, { username: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(granted["operator"]).toBe(true);
    expect(granted["groups"]).toContain(ADMIN_ROLE);
    expect(watcher.events).toHaveLength(1);
    expect((watcher.events[0]?.payload as { kind: string }).kind).toBe("user-granted-admin");
  });

  it("revokes it again", async () => {
    const { ada, watcher, team } = await watchingAccounts();
    setAdmin(team.database, "bob", true);

    const revoked = answered(
      await ada.value(TEAM_METHODS.adminUsersRevokeAdmin, { username: "bob" }),
    );

    expect(revoked["operator"]).toBe(false);
    await watcher.until(() => watcher.events.length > 0);
    expect((watcher.events[0]?.payload as { kind: string }).kind).toBe("user-revoked-admin");
  });

  it("refuses every token an account holds, and answers with when that was", async () => {
    const { ada, watcher, team } = await watchingAccounts();
    const before = requireUser(team.database, "bob").tokenEpoch;

    const revoked = answered(
      await ada.value(TEAM_METHODS.adminUsersRevokeTokens, { username: "bob" }),
    );

    expect(revoked["tokensInvalidatedAt"]).toBeTypeOf("number");
    expect(requireUser(team.database, "bob").tokenEpoch).toBe(before + 1);
    await watcher.until(() => watcher.events.length > 0);
    expect((watcher.events[0]?.payload as { kind: string }).kind).toBe("user-tokens-revoked");
  });

  it("does not refuse them a second time for one client id", async () => {
    // The sharpest of the repeats, because this write is the one that is never a
    // no-op on its own: the epoch moves every time it is called, and a second
    // one would refuse whatever had been minted in between.
    const { ada, watcher, team } = await watchingAccounts();
    await ada.value(TEAM_METHODS.adminUsersRevokeTokens, { username: "bob", clientId: "once" });
    await watcher.until(() => watcher.events.length > 0);
    const epoch = requireUser(team.database, "bob").tokenEpoch;

    await ada.value(TEAM_METHODS.adminUsersRevokeTokens, { username: "bob", clientId: "once" });

    expect(requireUser(team.database, "bob").tokenEpoch).toBe(epoch);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.events).toHaveLength(1);
  });

  it("keeps one client id apart from another, and from the same id on another method", async () => {
    const { ada, team } = await administered();
    await ada.value(TEAM_METHODS.adminUsersRevokeTokens, { username: "bob", clientId: "one" });
    const after = requireUser(team.database, "bob").tokenEpoch;

    // A different id is a different write and really happens.
    await ada.value(TEAM_METHODS.adminUsersRevokeTokens, { username: "bob", clientId: "two" });
    expect(requireUser(team.database, "bob").tokenEpoch).toBe(after + 1);

    // The same id on a different method is also a different write. A key that
    // left the method out would answer this one about the revoke.
    const disabled = answered(
      await ada.value(TEAM_METHODS.adminUsersDisable, { username: "bob", clientId: "one" }),
    );
    expect(disabled["disabled"]).toBe(true);
  });

  it("says there is no such account rather than inventing one", async () => {
    const { ada } = await administered();

    expect((await ada.call(TEAM_METHODS.adminUsersDisable, { username: "nobody" })).code).toBe(
      "not-found",
    );
  });
});

describe("the last operator of a server", () => {
  it("cannot be demoted over the protocol, and the refusal names the way back", async () => {
    // A management surface that lets a person lock themselves out with one click
    // is a trap. The way back is on the machine that holds the storage root, so
    // the refusal says which command it is.
    const { ada } = await administered();

    const answer = await ada.call(TEAM_METHODS.adminUsersRevokeAdmin, { username: "ada" });

    expect(answer.code).toBe("refused");
    expect((answer as { message: string }).message).toContain("nlteam user grant-admin ada");
  });

  it("cannot be disabled over the protocol either", async () => {
    // Disabling the only operator's account leaves exactly the same server:
    // one nobody can administer over this protocol. The rescue is a different
    // command, so that is the one named.
    const { ada } = await administered();

    const answer = await ada.call(TEAM_METHODS.adminUsersDisable, { username: "ada" });

    expect(answer.code).toBe("refused");
    expect((answer as { message: string }).message).toContain("nlteam user enable ada");
  });

  it("may be demoted once there is another who can sign in", async () => {
    const { ada, team } = await administered();
    setAdmin(team.database, "bob", true);

    expect((await ada.call(TEAM_METHODS.adminUsersRevokeAdmin, { username: "ada" })).code)
      .toBeUndefined();
  });

  it("is not made up of operators who cannot sign in", async () => {
    // Two accounts in the group and one of them disabled is one operator, not
    // two: a disabled account is refused a sign-in and every token it holds.
    const { ada, team } = await administered();
    setAdmin(team.database, "bob", true);
    disableUser(team.database, "bob");

    expect((await ada.call(TEAM_METHODS.adminUsersRevokeAdmin, { username: "ada" })).code).toBe(
      "refused",
    );
  });
});

describe("minting a token for somebody", () => {
  it("answers a token that account can open a session with", async () => {
    const { ada, team } = await administered();

    const minted = (await ada.value(TEAM_METHODS.adminTokensMint, { username: "bob" }))[
      "minted"
    ] as { username: string; expiresAt: number; token: string };

    expect(minted.username).toBe("bob");
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    // The whole point of the method: somebody who never told this server their
    // password is now signed in as themselves.
    const opened = await team.connect(minted.token);
    expect(opened.hello?.account.username).toBe("bob");
  });

  it("keeps nothing anywhere that would let the token be read a second time", async () => {
    const { ada, team } = await administered();

    const minted = (await ada.value(TEAM_METHODS.adminTokensMint, {
      username: "bob",
      clientId: "for-bob",
    }))["minted"] as { token: string };

    // The note of the write is the only record a mint leaves, and what it holds
    // is which account and until when. A token written down is a credential
    // sitting in a file that is worth stealing.
    const notes = team.database.prepare("SELECT account, method, answer FROM client_writes").all();
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain(minted.token);
  });

  it("answers a repeat with the mint that happened, and no token", async () => {
    const { ada } = await administered();
    const first = (await ada.value(TEAM_METHODS.adminTokensMint, {
      username: "bob",
      clientId: "for-bob",
    }))["minted"] as { expiresAt: number; token: string };

    const second = (await ada.value(TEAM_METHODS.adminTokensMint, {
      username: "bob",
      clientId: "for-bob",
    }))["minted"] as Record<string, unknown>;

    // Nothing was minted the second time, which is the point: a token nobody
    // received is a live credential nobody can account for. What comes back is
    // the mint that did happen, and no token, because this server kept none.
    expect(second["expiresAt"]).toBe(first.expiresAt);
    expect(second).not.toHaveProperty("token");
  });

  it("refuses to mint for an account that has been disabled", async () => {
    const { ada, team } = await administered();
    disableUser(team.database, "bob");

    expect((await ada.call(TEAM_METHODS.adminTokensMint, { username: "bob" })).code).toBe(
      "refused",
    );
  });

  it("says nothing on any topic: a mint changes no record anybody is watching", async () => {
    const { ada, watcher } = await watchingAccounts();

    await ada.value(TEAM_METHODS.adminTokensMint, { username: "bob" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.events).toHaveLength(0);
  });
});

describe("changing a setting over the session", () => {
  /** An operator and a session of theirs watching the settings. */
  async function watchingSettings(): Promise<{ team: Harness; ada: Client; watcher: Client }> {
    const { team, ada } = await administered();
    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_ADMIN_SETTINGS });
    return { team, ada, watcher };
  }

  it("answers with the row it changed, in the shape the list carries", async () => {
    const { ada, watcher } = await watchingSettings();

    const changed = (await ada.value(TEAM_METHODS.adminSettingsSet, {
      label: "sign-in token",
      value: "7 days",
    }))["setting"] as Record<string, unknown>;

    expect(changed).toMatchObject({
      group: "tokens",
      label: "sign-in token",
      value: "7 days",
      seconds: 7 * 24 * 60 * 60,
      editable: true,
    });
    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as { kind: string; setting: { value: string } };
    expect(event.kind).toBe("setting-changed");
    expect(event.setting.value).toBe("7 days");
  });

  it("takes the seconds a row carries as readily as the words it shows", async () => {
    // A row carries both, so that nobody has to take a duration apart in
    // whatever language it was written in. Either one is what somebody meant.
    const { ada } = await administered();

    const changed = (await ada.value(TEAM_METHODS.adminSettingsSet, {
      label: "repository token",
      value: "900",
    }))["setting"] as Record<string, unknown>;

    expect(changed["seconds"]).toBe(900);
  });

  it("says nothing when the value is the one that was already there", async () => {
    const { ada, watcher } = await watchingSettings();
    await ada.value(TEAM_METHODS.adminSettingsSet, { label: "name", value: "moonlit" });
    await watcher.until(() => watcher.events.length > 0);

    await ada.value(TEAM_METHODS.adminSettingsSet, { label: "name", value: "moonlit" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.events).toHaveLength(1);
  });

  it("refuses a row this server has nowhere to write", async () => {
    // Shown and read-only: the identity settings are named on the command line
    // that started the server, so a value written here would be thrown away, and
    // something that looks like it worked is worse than something that refuses.
    const { ada } = await administered();

    const answer = await ada.call(TEAM_METHODS.adminSettingsSet, {
      label: "issuer",
      value: "somebody else",
    });

    expect(answer.code).toBe("refused");
  });

  it("says there is no such setting rather than making one", async () => {
    const { ada } = await administered();

    expect(
      (await ada.call(TEAM_METHODS.adminSettingsSet, { label: "colour", value: "blue" })).code,
    ).toBe("not-found");
  });

  it("refuses a value that is not a duration, and one outside what may be stored", async () => {
    const { ada } = await administered();

    expect(
      (await ada.call(TEAM_METHODS.adminSettingsSet, { label: "sign-in token", value: "whenever" }))
        .code,
    ).toBe("bad-params");
    expect(
      (await ada.call(TEAM_METHODS.adminSettingsSet, { label: "sign-in token", value: "1s" })).code,
    ).toBe("bad-params");
  });

  it("does not change it twice for one client id", async () => {
    const { ada } = await administered();
    await ada.value(TEAM_METHODS.adminSettingsSet, {
      label: "name",
      value: "moonlit",
      clientId: "name-it",
    });

    // The same id carrying a different value is still the same write. What comes
    // back is the row as it stands, which is what the write that happened left.
    const second = (await ada.value(TEAM_METHODS.adminSettingsSet, {
      label: "name",
      value: "something else",
      clientId: "name-it",
    }))["setting"] as Record<string, unknown>;

    expect(second["value"]).toBe("moonlit");
  });

  it("refuses a word that is not one of the ones a closed set holds", async () => {
    // Both of the settings whose value is a word rather than free text, because
    // a refusal that arrived as `internal` would reach the operator as "something
    // went wrong" with the sentence saying what the words are stripped off it.
    const { ada } = await administered();

    const collaboration = await ada.send("call", {
      method: TEAM_METHODS.adminSettingsSet,
      params: { label: "collaboration", value: "sometimes" },
    });
    const lineage = await ada.send("call", {
      method: TEAM_METHODS.adminSettingsSet,
      params: { label: "repeat publishes", value: "sometimes" },
    });

    expect(collaboration.code).toBe("bad-params");
    expect(collaboration.message).toContain("open or closed");
    expect(lineage.code).toBe("bad-params");
    expect(lineage.message).toContain("merge or refuse");
  });
});

/**
 * Every method under a capability a closed deployment does not have.
 *
 * Read off the method table rather than listed here, so that a method added to
 * any of the four is covered by these tests on the day it is written rather than
 * on the day somebody remembers this constant.
 */
const COORDINATION_METHODS = teamMethods()
  .filter((method) => COORDINATION_CAPABILITIES.includes(method.capability))
  .map((method) => method.name);

/** The methods a closed deployment keeps for its operators: what is on it, and what may go on it. */
const KEPT_FOR_OPERATORS = [
  TEAM_METHODS.projectsList,
  TEAM_METHODS.projectsGet,
  TEAM_METHODS.projectsHistory,
  TEAM_METHODS.projectsCreate,
  TEAM_METHODS.projectsForget,
  TEAM_METHODS.membersList,
];

describe("a server closed to collaboration", () => {
  /** The document `up` composes from that socket, without the listener around it. */
  function documentOf(team: Harness): DiscoveryDocument {
    return discoveryDocument({
      database: team.database,
      host: "127.0.0.1",
      auth: { required: true, url: "https://127.0.0.1:41402" },
      data: { url: "lore://127.0.0.1:41337" },
      // The socket's own function, which is what src/up.ts hands it. What a
      // client reads before it connects and what it is told after have to be one
      // answer rather than two that agree today.
      capabilities: team.socket.capabilities,
      authority: { sha256: "3D:38:9F:E6" },
      version: "0.0.0-test",
    });
  }

  /** Closed the way an operator closes one: over the protocol, on a running server. */
  async function closed(): Promise<{ team: Harness; ada: Client; bob: Client }> {
    // With somewhere to put a file down, so that `blobs` is a capability this
    // build would otherwise announce rather than one absent for want of a store.
    const administration = await administered({ blobs: true });
    await administration.ada.value(TEAM_METHODS.adminSettingsSet, {
      label: "collaboration",
      value: "closed",
    });
    return administration;
  }

  it("announces no coordination plane, before a client connects or after", async () => {
    const { team } = await closed();

    const document = documentOf(team);
    // A session opened after the setting changed, which is the one that is told
    // the truth. The two sessions already open were told something else, and the
    // test below is what happens when one of them acts on it.
    const fresh = await team.connect(team.tokenFor("bob"));

    for (const capability of COORDINATION_CAPABILITIES) {
      expect(document.capabilities).not.toContain(capability);
      expect(fresh.hello?.capabilities).not.toContain(capability);
    }
    // What a closed deployment still is: a socket that answers, and a server
    // that is administered.
    expect(document.capabilities).toContain("session");
    expect(fresh.hello?.capabilities).toContain("session");
    expect(fresh.hello?.capabilities).toContain("admin");
  });

  it("refuses every method under them, to an operator as readily as to anybody", async () => {
    const { ada, bob } = await closed();

    for (const method of COORDINATION_METHODS) {
      // Refused before the parameters are read, which is why a bare call is
      // enough: the gate is in front of the handler rather than inside it.
      expect((await ada.call(method)).code).toBe("refused");
      expect((await bob.call(method)).code).toBe("refused");
    }
    // Both of these sessions were opened while the deployment was still open and
    // were told a capability list that has since changed. They are refused all
    // the same: the list is advice and the gate is the authority.
    expect(ada.hello?.capabilities).toContain("live");
  });

  it("keeps what is on it, and what may go on it, to its operators", async () => {
    const { team, ada, bob } = await administered();
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: requireUser(team.database, "ada").id,
    });
    await ada.value(TEAM_METHODS.adminSettingsSet, { label: "collaboration", value: "closed" });

    for (const method of KEPT_FOR_OPERATORS) {
      expect((await bob.call(method, { project: project.id, name: "harbour" })).code).toBe(
        "refused",
      );
    }
    // Making one is refused as firmly as reading them, and that is the sharper
    // half: a closed server that let an ordinary account put a project on it
    // would be taking a write whose result the same account cannot then see.
    expect(listProjects(team.database)).toHaveLength(1);

    // An operator reads all of it exactly as before, because administering a
    // server includes knowing what is on it, and may still take one off.
    expect(await ada.value(TEAM_METHODS.projectsList)).toHaveProperty("projects");
    expect(await ada.value(TEAM_METHODS.projectsGet, { project: project.id })).toHaveProperty(
      "project",
    );
    expect(await ada.value(TEAM_METHODS.projectsHistory, { project: project.id })).toHaveProperty(
      "revisions",
    );
    expect(await ada.value(TEAM_METHODS.membersList)).toHaveProperty("members");
    await ada.value(TEAM_METHODS.projectsForget, { project: project.id });
    expect(listProjects(team.database)).toHaveLength(0);
  });

  it("says what happened, in a sentence the person refused can act on", async () => {
    const { bob } = await closed();

    const refusal = await bob.send("call", { method: TEAM_METHODS.projectsList });

    // The setting by name, because the person reading this either changes it or
    // asks the person who can - and neither is served by "refused".
    expect(refusal.message).toContain("server.collaboration");
    expect(refusal.message).toContain("closed to collaboration");
  });

  it("goes on being administered, which is how it is opened again", async () => {
    const { ada } = await closed();

    // Every read of the management family, on a deployment that has just had its
    // coordination plane taken away. None of it is that plane's.
    expect(await ada.value(TEAM_METHODS.adminUsersList)).toHaveProperty("users");
    expect(await ada.value(TEAM_METHODS.adminSettingsList)).toHaveProperty("settings");
    expect(await ada.value(TEAM_METHODS.adminKeysList)).toHaveProperty("keys");
    expect(await ada.value(TEAM_METHODS.adminAuditList)).toHaveProperty("decisions");
    expect(await ada.value(TEAM_METHODS.adminServerStatus)).toHaveProperty("gatheredAt");
  });

  it("is opened again on the session that closed it, with nothing restarted", async () => {
    const { team, ada, bob } = await closed();
    expect((await bob.call(TEAM_METHODS.projectsList)).code).toBe("refused");
    expect((await bob.call(TEAM_METHODS.threadsList)).code).toBe("refused");

    await ada.value(TEAM_METHODS.adminSettingsSet, { label: "collaboration", value: "open" });

    // The same process, the same sessions, no reconnection: the capability list
    // and the gate are both worked out when they are used, so a setting written
    // a moment ago is what the next call is judged by.
    expect(await bob.value(TEAM_METHODS.projectsList)).toHaveProperty("projects");
    expect((await bob.call(TEAM_METHODS.threadsList)).code).toBe("bad-params");
    const fresh = await team.connect(team.tokenFor("bob"));
    for (const capability of COORDINATION_CAPABILITIES) {
      expect(documentOf(team).capabilities).toContain(capability);
      expect(fresh.hello?.capabilities).toContain(capability);
    }
  });

  it("says it changed on the settings topic, like every other setting", async () => {
    const { team, ada } = await administered();
    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_ADMIN_SETTINGS });

    await ada.value(TEAM_METHODS.adminSettingsSet, { label: "collaboration", value: "closed" });

    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as {
      kind: string;
      setting: { label: string; value: string };
    };
    expect(event.kind).toBe("setting-changed");
    expect(event.setting).toMatchObject({ label: "collaboration", value: "closed" });
  });
});

describe("rotating the signing keys over the session", () => {
  it("makes a key, signs with it, and answers with the whole list", async () => {
    const { team, ada } = await administered();
    const watcher = await team.connect(team.tokenFor("ada"));
    await watcher.send("subscribe", { topic: TOPIC_ADMIN_KEYS });
    const before = (await ada.value(TEAM_METHODS.adminKeysList))["keys"] as { kid: string }[];

    const after = (await ada.value(TEAM_METHODS.adminKeysRotate))["keys"] as {
      kid: string;
      serial: number;
      signing: boolean;
    }[];

    expect(after).toHaveLength(before.length + 1);
    // The whole list rather than the key that was made: the row for the key that
    // used to sign changed too, and a panel sent one row would be holding two
    // keys that both claim to.
    const signing = after.filter((key) => key.signing);
    expect(signing).toHaveLength(1);
    expect(signing[0]?.serial).toBe(Math.max(...after.map((key) => key.serial)));
    await watcher.until(() => watcher.events.length > 0);
    const event = watcher.events[0]?.payload as { kind: string; keys: unknown[] };
    expect(event.kind).toBe("keys-rotated");
    expect(event.keys).toHaveLength(after.length);
  });

  it("does not rotate twice for one client id", async () => {
    const { ada } = await administered();
    const first = (await ada.value(TEAM_METHODS.adminKeysRotate, { clientId: "once" }))["keys"] as
      unknown[];

    const second = (await ada.value(TEAM_METHODS.adminKeysRotate, { clientId: "once" }))["keys"] as
      unknown[];

    // A key file is written per rotation and never removed, so a repeat that
    // acted would leave this server holding one more key than anybody asked for.
    expect(second).toHaveLength(first.length);
  });
});

/** Every topic this server publishes about itself, named once. */
const MANAGEMENT_TOPICS = [
  TOPIC_ADMIN_USERS,
  TOPIC_ADMIN_SETTINGS,
  TOPIC_ADMIN_KEYS,
  TOPIC_ADMIN_REFUSALS,
];

describe("who may be told what this server is doing", () => {
  it("refuses a management topic to somebody who is not an operator", async () => {
    const { bob } = await administered();

    for (const topic of MANAGEMENT_TOPICS) {
      expect((await bob.send("subscribe", { topic })).code, topic).toBe("refused");
    }
  });

  it("lets an operator hold every one of them", async () => {
    const { ada } = await administered();

    for (const topic of MANAGEMENT_TOPICS) {
      const answer = await ada.send("subscribe", { topic });
      expect(answer.code, topic).toBeUndefined();
      expect(answer.seq, topic).toBeTypeOf("number");
    }
  });

  it("says a name under the prefix that nothing publishes on does not exist", async () => {
    // Existence before permission: somebody asking for a topic this server does
    // not have has a typo, and telling them they may not have it would send them
    // looking for a role instead.
    const { ada, bob } = await administered();

    expect((await ada.send("subscribe", { topic: "admin/nonsense" })).code).toBe("not-found");
    expect((await bob.send("subscribe", { topic: "admin/nonsense" })).code).toBe("not-found");
  });
});

describe("a refusal, as it reaches a session", () => {
  it("arrives on the topic named for refusals, with the decision that was made", async () => {
    // The authorization service pushes a refusal into this from the path that
    // answers every repository access - see tests/authservice.test.ts for the
    // half that decides which decisions go. What is asserted here is the other
    // half: that a session holding the topic is handed one.
    const { team, ada } = await administered();
    await ada.send("subscribe", { topic: TOPIC_ADMIN_REFUSALS });

    team.socket.hub.publish(TOPIC_ADMIN_REFUSALS, {
      kind: "decision-refused",
      decision: {
        id: 1,
        at: Date.now(),
        username: "unknown",
        resource: "harbour",
        allowed: false,
        detail: "expired",
      },
    });

    await ada.until(() => ada.events.length > 0);
    const event = ada.events[0]?.payload as { kind: string; decision: { detail: string } };
    expect(ada.events[0]?.topic).toBe(TOPIC_ADMIN_REFUSALS);
    expect(event.kind).toBe("decision-refused");
    expect(event.decision.detail).toBe("expired");
  });
});

describe("a management subscription and the operator who took it", () => {
  it("goes when the account stops being an operator, and says so on the topic", async () => {
    const { team, ada } = await administered();
    for (const topic of MANAGEMENT_TOPICS) {
      await ada.send("subscribe", { topic });
    }

    setAdmin(team.database, "ada", false);
    // Any call at all. Every one of them identifies its caller as it arrives, so
    // this is where a session that is doing anything finds out; a session saying
    // nothing is told within one revalidation interval instead.
    await ada.call(TEAM_METHODS.projectsList);

    await ada.until(() => ada.events.length >= MANAGEMENT_TOPICS.length);
    expect(ada.events.map((event) => event.topic).sort()).toEqual([...MANAGEMENT_TOPICS].sort());
    for (const event of ada.events) {
      const payload = event.payload as { kind: string; topic: string; why: string };
      expect(payload.kind).toBe("subscription-withdrawn");
      expect(payload.topic).toBe(event.topic);
      expect(payload.why).toContain("operator");
    }
  });

  it("stops being delivered to, while everything else it holds carries on", async () => {
    const { team, ada } = await administered();
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: requireUser(team.database, "ada").id,
    });
    await ada.send("subscribe", { topic: TOPIC_ADMIN_USERS });
    await ada.send("subscribe", { topic: projectTopic(project.id) });

    setAdmin(team.database, "ada", false);
    await ada.call(TEAM_METHODS.projectsList);
    await ada.until(() => ada.events.length > 0);

    team.socket.hub.publish(TOPIC_ADMIN_USERS, { kind: "user-created" });
    team.socket.hub.publish(projectTopic(project.id), {
      kind: "project-read",
      project: project.id,
    });

    // The project event arrives and the management one does not. A demotion is
    // no reason to stop telling somebody about the work they are still doing.
    await ada.until(() => ada.events.length > 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ada.events).toHaveLength(2);
    expect(ada.events[1]?.topic).toBe(projectTopic(project.id));
  });

  it("leaves the session open rather than closing it", async () => {
    const { team, ada } = await administered();
    await ada.send("subscribe", { topic: TOPIC_ADMIN_USERS });

    setAdmin(team.database, "ada", false);
    await ada.call(TEAM_METHODS.projectsList);
    await ada.until(() => ada.events.length > 0);

    expect(ada.byes).toEqual([]);
    expect(ada.closes).toEqual([]);
    // Still an account of this server, and still reaches every project on it.
    expect((await ada.call(TEAM_METHODS.projectsList)).code).toBeUndefined();
  });

  it("does not move the sequence for the operators who are still listening", async () => {
    // The topic did not change; one session stopped holding it. A sequence that
    // moved would tell every other panel to re-read a list nothing touched.
    const { team, ada, bob } = await administered();
    setAdmin(team.database, "bob", true);
    const held = await bob.send("subscribe", { topic: TOPIC_ADMIN_USERS });
    await ada.send("subscribe", { topic: TOPIC_ADMIN_USERS });

    setAdmin(team.database, "ada", false);
    await ada.call(TEAM_METHODS.projectsList);
    await ada.until(() => ada.events.length > 0);

    const again = await bob.send("subscribe", { topic: TOPIC_ADMIN_USERS });
    expect(again.seq).toBe(held.seq);
    expect(bob.events).toEqual([]);
  });

  it("takes nothing from an operator who is still one", async () => {
    const { ada } = await administered();
    await ada.send("subscribe", { topic: TOPIC_ADMIN_USERS });

    await ada.call(TEAM_METHODS.projectsList);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ada.events).toEqual([]);
  });
});
