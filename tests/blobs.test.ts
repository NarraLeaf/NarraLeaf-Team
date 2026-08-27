/**
 * The addresses a live session's bytes travel over.
 *
 * What is worth asserting here is the four things this replaced a message channel to get: that a
 * file larger than any message limit goes across whole and byte for byte, that an interrupted
 * transfer resumes from where it stopped rather than from nothing, that a reader held at the end of
 * a growing file is woken by the writer rather than by a poll, and that neither side has to hold
 * the file - which is asserted the only way it can be, by moving one that is far larger than the
 * old limit through a process nobody gave any more memory to.
 *
 * The door is asserted for the same reason tests/studio.test.ts asserts its own: the token and the
 * instance header are the whole of who may read these bytes, and a request this admitted wrongly
 * would be one machine reading another project's files.
 */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig, type IdentityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { BLOB_PROJECT_BYTES, TeamBlobStore, blobBytesOnDisk } from "../src/team/blobs.js";
import { TeamPresence } from "../src/team/presence.js";
import { type TeamService } from "../src/team/service.js";
import { serverCapabilities, methodTable } from "../src/team/methods.js";
import { teamMethods } from "../src/team/endpoint.js";
import { webHandler } from "../src/web/router.js";
import { DISCOVERY_PATH, type DiscoveryDocument } from "../src/identity/discovery.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-blobs-");

/** A port number nothing is listening on, borrowed and given straight back. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}


const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const PASSWORD = "a password nobody guesses";

const DISCOVERY: DiscoveryDocument = {
  protocol: 1,
  name: "127.0.0.1",
  auth: { required: true, url: "https://127.0.0.1:41402" },
  data: { url: "lore://127.0.0.1:41337" },
  policy: { publishLineage: "merge" },
  capabilities: [],
  authority: { sha256: "" },
  version: "0.0.0-test",
};

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];
const openStores: TeamBlobStore[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

interface Harness {
  readonly origin: string;
  readonly root: string;
  readonly project: string;
  readonly store: TeamBlobStore;
  readonly presence: TeamPresence;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  /** Ada's token and the instance she has this project open on. */
  readonly token: string;
  readonly instance: string;
  /** Somebody else, signed in, with nothing open. */
  readonly outsider: string;
}

async function harness(): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const ada = await createUser(database, hasher, { username: "ada", password: PASSWORD });
  await createUser(database, hasher, { username: "bob", password: PASSWORD });
  const project = createProject(database, {
    id: newProjectId(),
    name: "lighthouse",
    createdBy: ada.id,
  });

  const store = await TeamBlobStore.open(root);
  openStores.push(store);
  const presence = new TeamPresence(() => {});
  const instance = "nomen.7f3a";
  presence.announce("connection-1", "ada", {
    id: instance,
    label: "Nomen",
    agent: "NarraLeaf Studio 0.0.0-test",
    project: project.id,
  });

  const studio: TeamService = {
    database,
    keys,
    config,
    root,
    // Nothing here asks this server what it is, so this names a port borrowed
    // and given straight back rather than the one loreserver ordinarily
    // answers on: a number this machine said was free beats one this suite
    // hopes is.
    healthPort: await unusedPort(),
    dataPort: config.dataPort,
    blobs: true,
  };
  const server = createServer(
    webHandler(() => ({ ...DISCOVERY, capabilities: serverCapabilities(methodTable(teamMethods()), studio) }), {
      studio,
      blobs: { store, presence, service: studio },
    }),
  );
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  const tokenFor = (username: string): string =>
    mintToken(requireUser(database, username), keys.signingKey, config, { purpose: "sign-in" })
      .token;

  return {
    origin: `http://127.0.0.1:${port}`,
    root,
    project: project.id,
    store,
    presence,
    database,
    config,
    token: tokenFor("ada"),
    instance,
    outsider: tokenFor("bob"),
  };
}

function address(harness: Harness, transfer: string): string {
  return `${harness.origin}/api/team/v1/blobs/${harness.project}/${transfer}`;
}

function asAda(harness: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${harness.token}`,
    "nl-instance": harness.instance,
    ...extra,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function reserve(
  harness: Harness,
  transfer: string,
  length: number,
  digest: string,
): Promise<Response> {
  return fetch(`${address(harness, transfer)}?length=${length}&digest=${digest}`, {
    method: "POST",
    headers: asAda(harness),
  });
}

async function put(
  harness: Harness,
  transfer: string,
  offset: number,
  bytes: Uint8Array,
): Promise<Response> {
  return fetch(address(harness, transfer), {
    method: "PATCH",
    headers: asAda(harness, { "nl-blob-offset": String(offset) }),
    body: bytes,
  });
}

describe("carrying a file across", () => {
  it("takes a file far larger than any message this protocol has, and gives it back byte for byte", async () => {
    const held = await harness();
    // Well past the thirty-two megabytes the message channel this replaced could carry, and past
    // the sixteen kilobytes one message is: the point of the whole exercise is that neither figure
    // is a limit on a file any more.
    const bytes = randomBytes(48 * 1024 * 1024);
    const digest = sha256(bytes);

    expect((await reserve(held, "t-1", bytes.length, digest)).status).toBe(201);
    expect((await put(held, "t-1", 0, bytes)).status).toBe(200);

    const read = await fetch(address(held, "t-1"), { headers: asAda(held) });
    expect(read.status).toBe(200);
    const came = new Uint8Array(await read.arrayBuffer());
    expect(came.length).toBe(bytes.length);
    expect(sha256(came)).toBe(digest);
  });

  it("says how much of a file it holds, which is what a resumption asks first", async () => {
    const held = await harness();
    const bytes = randomBytes(4096);
    await reserve(held, "t-2", bytes.length, sha256(bytes));
    await put(held, "t-2", 0, bytes.subarray(0, 1000));

    const asked = await fetch(address(held, "t-2"), { method: "HEAD", headers: asAda(held) });
    expect(asked.status).toBe(200);
    expect(asked.headers.get("nl-blob-length")).toBe("4096");
    expect(asked.headers.get("nl-blob-received")).toBe("1000");
    expect(asked.headers.get("nl-blob-complete")).toBe("false");
    expect(asked.headers.get("nl-blob-digest")).toBe(sha256(bytes));
  });

  it("goes on from where a sender stopped rather than from nothing", async () => {
    const held = await harness();
    const bytes = randomBytes(30_000);
    const digest = sha256(bytes);
    await reserve(held, "t-3", bytes.length, digest);
    await put(held, "t-3", 0, bytes.subarray(0, 12_345));

    // Asking again with the same length and digest is the same reservation: a sender that lost its
    // connection between reserving and finishing must be able to say it again.
    expect((await reserve(held, "t-3", bytes.length, digest)).status).toBe(201);
    expect((await put(held, "t-3", 12_345, bytes.subarray(12_345))).status).toBe(200);

    const read = await fetch(address(held, "t-3"), { headers: asAda(held) });
    expect(sha256(new Uint8Array(await read.arrayBuffer()))).toBe(digest);
  });

  it("refuses an append that does not start where the file ends, and says where that is", async () => {
    const held = await harness();
    const bytes = randomBytes(2048);
    await reserve(held, "t-4", bytes.length, sha256(bytes));
    await put(held, "t-4", 0, bytes.subarray(0, 500));

    const wrong = await put(held, "t-4", 900, bytes.subarray(900));
    expect(wrong.status).toBe(409);
    expect(wrong.headers.get("nl-blob-received")).toBe("500");
  });

  it("refuses more bytes than were reserved, because that is a different file", async () => {
    const held = await harness();
    await reserve(held, "t-5", 100, sha256(randomBytes(100)));
    expect((await put(held, "t-5", 0, randomBytes(101))).status).toBe(400);
  });

  it("reads forward from where a receiver got to", async () => {
    const held = await harness();
    const bytes = randomBytes(9000);
    await reserve(held, "t-6", bytes.length, sha256(bytes));
    await put(held, "t-6", 0, bytes);

    const read = await fetch(address(held, "t-6"), {
      headers: asAda(held, { range: "bytes=4000-" }),
    });
    expect(read.status).toBe(206);
    const rest = new Uint8Array(await read.arrayBuffer());
    expect(rest.length).toBe(5000);
    expect(Buffer.from(rest).equals(bytes.subarray(4000))).toBe(true);
  });

  it("holds a reader at the end of a file that is still arriving, and wakes it when it grows", async () => {
    const held = await harness();
    const first = randomBytes(2000);
    const second = randomBytes(3000);
    const whole = Buffer.concat([first, second]);
    await reserve(held, "t-7", whole.length, sha256(whole));
    await put(held, "t-7", 0, first);

    // Started while the file is short. Nothing polls: this resolves because the append below wakes
    // it, which is what makes a file arrive on the far machine as it arrives here.
    const reading = fetch(address(held, "t-7"), { headers: asAda(held) }).then(async (response) =>
      new Uint8Array(await response.arrayBuffer()),
    );
    await new Promise<void>((settle) => setTimeout(settle, 50));
    await put(held, "t-7", 2000, second);

    expect(Buffer.from(await reading).equals(whole)).toBe(true);
  });
});

describe("what a project may have in flight", () => {
  it("refuses a reservation past the project's own budget, by name and before anything is sent", async () => {
    const held = await harness();
    const refused = await reserve(held, "t-8", BLOB_PROJECT_BYTES + 1, "abc");
    expect(refused.status).toBe(507);
    const body = (await refused.json()) as { limit: number };
    expect(body.limit).toBe(BLOB_PROJECT_BYTES);
    // Nothing was written, so nothing has to be swept: the refusal happens before the operation
    // naming the file is ever stated.
    expect(await blobBytesOnDisk(held.root, held.project, "t-8")).toBe(-1);
  });

  it("refuses a second reservation of the same name for a different file", async () => {
    const held = await harness();
    await reserve(held, "t-9", 10, "aaa");
    expect((await reserve(held, "t-9", 20, "bbb")).status).toBe(409);
  });

  it("counts what is reserved rather than what has arrived", async () => {
    const held = await harness();
    await reserve(held, "t-10", 5_000_000, "aaa");
    expect(held.store.reservedFor(held.project)).toBe(5_000_000);
    expect(held.store.reservedFor("some other project")).toBe(0);
  });
});

describe("dropping", () => {
  it("deletes the bytes a cancelled transfer had already put down", async () => {
    const held = await harness();
    const bytes = randomBytes(4000);
    await reserve(held, "t-11", bytes.length, sha256(bytes));
    await put(held, "t-11", 0, bytes);
    expect(await blobBytesOnDisk(held.root, held.project, "t-11")).toBe(4000);

    const dropped = await fetch(address(held, "t-11"), { method: "DELETE", headers: asAda(held) });
    expect(dropped.status).toBe(204);
    expect(await blobBytesOnDisk(held.root, held.project, "t-11")).toBe(-1);
    expect(held.store.reservedFor(held.project)).toBe(0);
  });

  it("answers a second cancel the same way, because every machine in a room sends one", async () => {
    const held = await harness();
    await reserve(held, "t-12", 10, "aaa");
    expect((await fetch(address(held, "t-12"), { method: "DELETE", headers: asAda(held) })).status)
      .toBe(204);
    expect((await fetch(address(held, "t-12"), { method: "DELETE", headers: asAda(held) })).status)
      .toBe(204);
  });

  it("takes what nobody has touched for a day, which is the backstop for a machine that never said", async () => {
    const held = await harness();
    await reserve(held, "t-13", 10, "aaa");
    expect(held.store.count).toBe(1);

    expect(await held.store.sweep(Date.now())).toBe(0);
    expect(await held.store.sweep(Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    expect(held.store.count).toBe(0);
    expect(await blobBytesOnDisk(held.root, held.project, "t-13")).toBe(-1);
  });

  it("empties the directory when it is opened, because every room it held has ended", async () => {
    const held = await harness();
    const bytes = randomBytes(1000);
    await reserve(held, "t-14", bytes.length, sha256(bytes));
    await put(held, "t-14", 0, bytes);
    expect(await blobBytesOnDisk(held.root, held.project, "t-14")).toBe(1000);

    const second = await TeamBlobStore.open(held.root);
    openStores.push(second);
    expect(second.count).toBe(0);
    expect(await blobBytesOnDisk(held.root, held.project, "t-14")).toBe(-1);
  });
});

describe("who may", () => {
  it("refuses a request with no token", async () => {
    const held = await harness();
    const refused = await fetch(address(held, "t-15"), {
      method: "HEAD",
      headers: { "nl-instance": held.instance },
    });
    expect(refused.status).toBe(401);
  });

  it("refuses a signed-in account whose installation does not have this project open", async () => {
    const held = await harness();
    const refused = await fetch(address(held, "t-15"), {
      method: "HEAD",
      headers: { authorization: `Bearer ${held.outsider}`, "nl-instance": held.instance },
    });
    // The instance named is real, and it is not this account's.
    expect(refused.status).toBe(403);
  });

  it("refuses a request that names no installation", async () => {
    const held = await harness();
    const refused = await fetch(address(held, "t-15"), {
      method: "HEAD",
      headers: { authorization: `Bearer ${held.token}` },
    });
    expect(refused.status).toBe(403);
  });

  it("refuses once the installation has gone, which is what closing a window is", async () => {
    const held = await harness();
    held.presence.dropConnection("connection-1");
    const refused = await fetch(address(held, "t-15"), { method: "HEAD", headers: asAda(held) });
    expect(refused.status).toBe(403);
  });

  it("refuses a project this server does not have", async () => {
    const held = await harness();
    const refused = await fetch(`${held.origin}/api/team/v1/blobs/nosuchproject/t-15`, {
      method: "HEAD",
      headers: asAda(held),
    });
    expect(refused.status).toBe(404);
  });

  it("refuses a name that could be a path rather than a name", async () => {
    const held = await harness();
    const refused = await fetch(
      `${held.origin}/api/team/v1/blobs/${held.project}/${encodeURIComponent("../../secrets")}`,
      { method: "HEAD", headers: asAda(held) },
    );
    expect(refused.status).toBe(404);
  });
});

describe("what the server says it can do", () => {
  it("announces the capability only where there is somewhere to put a file", async () => {
    const held = await harness();
    const document = (await (await fetch(`${held.origin}${DISCOVERY_PATH}`)).json()) as {
      capabilities: string[];
    };
    expect(document.capabilities).toContain("blobs");
  });
});
