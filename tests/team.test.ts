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
import { createUser, disableUser, requireUser } from "../src/identity/users.js";
import { createProject, forgetProject, newProjectId } from "../src/projects/registry.js";
import { createTeamSocket, type TeamSocket } from "../src/team/endpoint.js";
import {
  TEAM_METHODS,
  TEAM_SOCKET_PATH,
  liveTopic,
  projectClientsTopic,
  projectLiveTopic,
  projectOverlayTopic,
  projectThreadsTopic,
  TOPIC_PROJECTS,
  type TeamHelloFrame,
} from "../src/team/protocol.js";
import type { StudioApiOptions } from "../src/web/studio.js";
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
  readonly service: StudioApiOptions;
  readonly socket: TeamSocket;
  readonly tokenFor: (username: string) => string;
  readonly connect: (token: string) => Promise<Client>;
}

async function harness(extra: Partial<StudioApiOptions> = {}): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const service: StudioApiOptions = {
    database,
    keys,
    config,
    dataPort: config.dataPort,
    // Whatever a test wants this server to have read out of a repository. Most
    // want none, which is a server that has not got round to one yet - a state
    // the overlay methods have to answer honestly rather than as "empty".
    ...extra,
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

async function account(database: DatabaseSync, username: string): Promise<string> {
  const user = await createUser(database, hasher, {
    username,
    password: "a password nobody guesses",
    displayName: username,
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
  hello: TeamHelloFrame | undefined;

  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly ws: WebSocket) {
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
  it("answers the same projects the REST route lists", async () => {
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
});

describe("subscribing", () => {
  it("says where a topic stands, and refuses one nobody publishes", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    const good = await client.send("subscribe", { topic: TOPIC_PROJECTS });
    expect(good.seq).toBe(0);
    expect((await client.send("subscribe", { topic: "weather" })).code).toBe("not-found");
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

/* ------------------------------------------- instances, rooms and overlay */

/**
 * A project with two connected sessions, and nothing announced on either.
 *
 * Announcing is deliberately left to each test: what an installation says about
 * itself is half of what these methods are, and a helper that did it would hide
 * the one refusal that matters - a call about a machine, from a session that
 * never said which machine it is.
 */
async function withTwo(extra: Partial<StudioApiOptions> = {}): Promise<{
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
