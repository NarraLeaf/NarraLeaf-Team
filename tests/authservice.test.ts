import { connect } from "node:http2";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { GrpcCallError, unaryCall } from "../src/grpc/client.js";
import { encodeFrame } from "../src/grpc/framing.js";
import {
  decodeCheckUserPermissionResponse,
  decodeLookupUserPermissionsResponse,
  encodeCheckUserPermissionRequest,
  encodeCreateResourceRequest,
  encodeDeleteResourceRequest,
  encodeLookupUserPermissionsRequest,
  METHOD_CHECK_USER_PERMISSION,
  METHOD_CREATE_RESOURCE,
  METHOD_DELETE_RESOURCE,
  METHOD_LOOKUP_USER_PERMISSIONS,
} from "../src/grpc/messages.js";
import type { GrpcServer } from "../src/grpc/server.js";
import {
  decodeStatusMessage,
  GRPC_INVALID_ARGUMENT,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNIMPLEMENTED,
} from "../src/grpc/status.js";
import { listDecisions, type RecordedDecision } from "../src/identity/audit.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  enableUser,
  requireUser,
  type UserRecord,
} from "../src/identity/users.js";
import {
  createProject,
  findProject,
  newProjectId,
  resourceIdOf,
} from "../src/projects/registry.js";
import { startAuthorizationService } from "../src/projects/service.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-auth-");

const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const config = identityConfig();

/**
 * A running authorization service with a database behind it.
 *
 * The service is driven over a real socket rather than by calling its handlers:
 * the framing, the headers and the trailers are as much of the mechanism as the
 * decision is, and a handler called directly exercises none of them.
 */
interface Harness {
  readonly database: DatabaseSync;
  readonly server: GrpcServer;
  readonly keys: KeyStore;
  /** Every line the service wrote, in order. */
  readonly log: string[];
  /**
   * Every decision the service pushed out as a refusal, in order.
   *
   * Kept apart from the log because they are two different channels with two
   * different rules: the log takes every decision, and this takes the refusals
   * alone. A test that watched only the log could not tell the difference.
   */
  readonly refusals: RecordedDecision[];
  user(username: string): Promise<UserRecord>;
  /** A token for `user`, as an `authorization` header value. */
  bearer(user: UserRecord, options?: { readonly now?: Date }): string;
  check(authorization: string | undefined, resourceIds: readonly string[]): Promise<string[]>;
  lookup(authorization: string | undefined): Promise<string[]>;
}

const started: Harness[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const harness = started.pop();
    if (harness === undefined) {
      continue;
    }
    await harness.server.close();
    harness.database.close();
  }
});

async function harness(): Promise<Harness> {
  const layout = identityLayout(await temporaryRoot());
  const database = await openMigratedDatabase(layout.databasePath);
  const keys = await KeyStore.open(layout.keysDir);
  const log: string[] = [];
  const refusals: RecordedDecision[] = [];
  // Port 0: the operating system picks one that is free, so a test run cannot
  // collide with a Team server the machine is already running.
  const server = await startAuthorizationService({
    port: 0,
    database,
    keys,
    config,
    log: (line) => log.push(line),
    refused: (decision) => refusals.push(decision),
  });

  const call = async (
    path: string,
    message: Uint8Array,
    authorization: string | undefined,
  ): Promise<Buffer> =>
    await unaryCall({
      url: server.url,
      path,
      message,
      ...(authorization === undefined ? {} : { authorization }),
      timeoutMs: 5000,
    });

  const instance: Harness = {
    database,
    server,
    keys,
    log,
    refusals,
    async user(username: string): Promise<UserRecord> {
      await createUser(database, hasher, { username, password: "a password nobody guesses" });
      return requireUser(database, username);
    },
    bearer(user: UserRecord, options = {}): string {
      return `Bearer ${mintToken(user, keys.signingKey, config, options).token}`;
    },
    async check(authorization, resourceIds): Promise<string[]> {
      const reply = await call(
        METHOD_CHECK_USER_PERMISSION,
        encodeCheckUserPermissionRequest({ resourceIds }),
        authorization,
      );
      return decodeCheckUserPermissionResponse(reply).allowed.map((entry) => entry.resourceId);
    },
    async lookup(authorization): Promise<string[]> {
      const reply = await call(
        METHOD_LOOKUP_USER_PERMISSIONS,
        encodeLookupUserPermissionsRequest({ resourceFilter: "" }),
        authorization,
      );
      return decodeLookupUserPermissionsResponse(reply).permissions.map(
        (entry) => entry.resourceId,
      );
    },
  };

  started.push(instance);
  return instance;
}

/**
 * Make one call carrying whatever frames it is given, and report how it ended.
 *
 * `unaryCall` sends exactly one message, which is the whole of what a caller of
 * this service ever should. What is being checked below is what happens when
 * something sends more, so the frames are written by hand.
 */
async function callCarrying(
  url: string,
  path: string,
  frames: readonly Uint8Array[],
): Promise<{ status: number; message: string }> {
  const session = connect(url);
  try {
    return await new Promise<{ status: number; message: string }>((resolve, reject) => {
      session.on("error", reject);
      const request = session.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/grpc",
        te: "trailers",
      });
      let outcome: { status: number; message: string } | undefined;
      const read = (headers: Record<string, unknown>): void => {
        const status = headers["grpc-status"];
        if (status !== undefined) {
          outcome = {
            status: Number(status),
            message: decodeStatusMessage(String(headers["grpc-message"] ?? "")),
          };
        }
      };
      request.on("response", read);
      request.on("trailers", read);
      request.on("data", () => undefined);
      request.on("error", reject);
      request.on("close", () => {
        resolve(outcome ?? { status: Number.NaN, message: "the call ended saying nothing" });
      });
      request.end(Buffer.concat(frames.map((frame) => Buffer.from(frame))));
    });
  } finally {
    session.close();
  }
}

describe("a call to this service", () => {
  it("takes one message, and refuses a stream that carries a second", async () => {
    const team = await harness();
    // Every method here is one message in and one message out. Anything else
    // arriving on the stream was never going to be read, and an unread message
    // held until the stream ends is memory somebody else chose to spend.
    const frame = encodeFrame(encodeCheckUserPermissionRequest({ resourceIds: [] }));

    const outcome = await callCarrying(team.server.url, METHOD_CHECK_USER_PERMISSION, [
      frame,
      frame,
    ]);

    expect(outcome.status).toBe(GRPC_INVALID_ARGUMENT);
    expect(outcome.message).toContain("one message");
  });

  it("answers a call that carries exactly one", async () => {
    const team = await harness();

    const outcome = await callCarrying(team.server.url, METHOD_CHECK_USER_PERMISSION, [
      encodeFrame(encodeCheckUserPermissionRequest({ resourceIds: [] })),
    ]);

    expect(outcome.status).toBe(0);
  });
});

describe("CheckUserPermission", () => {
  it("answers with the projects the grant table says the caller may reach", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const resource = resourceIdOf(project.id);

    // Both, and bob was given nothing: an account of this server reaches every
    // project on it, and who made one is not part of the question.
    expect(await team.check(team.bearer(ada), [resource])).toEqual([resource]);
    expect(await team.check(team.bearer(bob), [resource])).toEqual([resource]);
  });

  it("returns only the granted subset when asked about several at once", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const hers = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const shared = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      createdBy: bob.id,
    });
    const his = createProject(team.database, {
      id: newProjectId(),
      name: "quayside",
      createdBy: bob.id,
    });
    const asked = [
      resourceIdOf(hers.id),
      resourceIdOf(shared.id),
      resourceIdOf(his.id),
      "urc-not-a-project-of-this-team",
    ];

    // Every project this server holds, and only those: the one resource that is
    // not one of them is refused, which is the whole of what is left to decide.
    expect(await team.check(team.bearer(ada), asked)).toEqual([
      resourceIdOf(hers.id),
      resourceIdOf(shared.id),
      resourceIdOf(his.id),
    ]);
  });

  it("names the resource exactly as it was asked about", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    // loreserver compares the two strings and accepts nothing else, so an
    // answer rebuilt from the project rather than echoed would read as an
    // answer about something else. Asking in upper case is the cheapest way to
    // tell an echo from a reconstruction.
    const shouted = resourceIdOf(project.id).toUpperCase();

    expect(await team.check(team.bearer(ada), [shouted])).toEqual([shouted]);
  });

  it("refuses everything for a token from a disabled account", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    // Minted while the account was still in good standing, which is the only
    // interesting case: a token nobody can obtain proves nothing.
    const token = team.bearer(ada);
    expect(await team.check(token, [resourceIdOf(project.id)])).toEqual([resourceIdOf(project.id)]);

    disableUser(team.database, "ada");

    expect(await team.check(token, [resourceIdOf(project.id)])).toEqual([]);
    expect(team.log.at(-1)).toContain("the account is disabled");
  });

  it("refuses a token issued before the account's access was revoked", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const token = team.bearer(ada);

    // Disabling bumps the epoch; enabling deliberately does not put it back, so
    // this is an account that may sign in again holding a token that is dead.
    disableUser(team.database, "ada");
    enableUser(team.database, "ada");

    expect(await team.check(token, [resourceIdOf(project.id)])).toEqual([]);
    expect(team.log.at(-1)).toContain("before the account's access was revoked");
    // A token minted now is at the new epoch and works.
    expect(await team.check(team.bearer(requireUser(team.database, "ada")), [
      resourceIdOf(project.id),
    ])).toEqual([resourceIdOf(project.id)]);
  });

  it("refuses an expired token", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    // Last year, not an hour ago: a token minted to sign in with lasts thirty
    // days, and the sentence being checked is about a token past its `exp`.
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    expect(await team.check(team.bearer(ada, { now: lastYear }), [resourceIdOf(project.id)])).toEqual(
      [],
    );
    expect(team.log.at(-1)).toContain("the token has expired");
  });

  it("refuses a token whose claims were changed after it was signed", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const [header, , signature] = team.bearer(ada).slice("Bearer ".length).split(".");
    const claims = Buffer.from(
      JSON.stringify({
        iss: config.issuer,
        aud: [config.audience],
        sub: bob.id,
        env: config.env,
        name: bob.displayName,
        preferred_username: bob.username,
        groups: [],
        is_service_account: false,
        idp: config.idp,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
        token_epoch: 1,
      }),
      "utf8",
    ).toString("base64url");

    const forged = `Bearer ${header}.${claims}.${signature}`;

    expect(await team.check(forged, [resourceIdOf(project.id)])).toEqual([]);
    expect(team.log.at(-1)).toContain("signature");
  });

  it("refuses a call carrying no token at all", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    expect(await team.check(undefined, [resourceIdOf(project.id)])).toEqual([]);
    expect(team.log.at(-1)).toContain("no bearer token");
  });

  it("writes one line per decision, with the caller, the resource and the outcome", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    await team.check(team.bearer(ada), [resourceIdOf(project.id), "urc-something-else"]);

    expect(team.log).toEqual([
      `auth: check ada ${resourceIdOf(project.id)}: allowed`,
      "auth: check ada urc-something-else: denied, not a project on this server",
    ]);
  });

  it("keeps the same decisions where something other than this process can read them", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    await team.check(team.bearer(ada), [resourceIdOf(project.id), "urc-something-else"]);

    // Under the project's name, not its resource id: this is what a person
    // reads, and it goes on saying which project it was about after the project
    // is gone. A resource Team knows nothing about keeps the id, because that is
    // all there is to know about it.
    expect(listDecisions(team.database)).toEqual([
      {
        at: expect.any(Number),
        username: "ada",
        resource: "urc-something-else",
        allowed: false,
        detail: "not a project on this server",
      },
      {
        at: expect.any(Number),
        username: "ada",
        resource: "harbour",
        allowed: true,
        detail: "account of this server",
      },
    ]);
  });

  it("keeps a refusal it cannot name anybody for", async () => {
    const team = await harness();

    await team.check(undefined, ["urc-anything"]);

    expect(listDecisions(team.database)).toMatchObject([
      { username: "unknown", resource: "urc-anything", allowed: false },
    ]);
    // The reason the log gave, kept with it. A refusal recorded as a refusal
    // and nothing else would make an expired token look like a missing grant.
    expect(listDecisions(team.database)[0]?.detail).toBe("the call carried no bearer token");
  });

  it("keeps one row for a refused call, however many resources it named", async () => {
    const team = await harness();

    await team.check(undefined, ["urc-one", "urc-two", "urc-three"]);

    // A refused call has one reason, and a row per resource repeats it without
    // saying anything the count does not. It is also the branch an
    // unidentified caller reaches, so its cost is what an unauthenticated
    // request can make this server spend.
    expect(listDecisions(team.database)).toMatchObject([
      { username: "unknown", resource: "3 resources", allowed: false },
    ]);
    expect(team.log).toHaveLength(1);
  });

  it("refuses a call naming more resources than it will answer about", async () => {
    const team = await harness();
    const many = Array.from({ length: 5000 }, (_, index) => `urc-${index}`);

    // Refused before a token is looked at, which is the point: this branch is
    // reached with no credential at all, and every id in it would otherwise
    // cost a lookup and a synchronous insert.
    const refusal = await team
      .check(undefined, many)
      .then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(GrpcCallError);
    expect((refusal as GrpcCallError).status).toBe(GRPC_RESOURCE_EXHAUSTED);
    expect(listDecisions(team.database)).toEqual([]);
    expect(team.log).toEqual([]);
  });
});

describe("LookupUserPermissions", () => {
  it("answers each caller with their own projects", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const hers = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const his = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      createdBy: bob.id,
    });
    // The same list for both, because it is a list of what this server holds.
    const both = [resourceIdOf(hers.id), resourceIdOf(his.id)];
    expect(await team.lookup(team.bearer(ada))).toEqual(both);
    expect(await team.lookup(team.bearer(bob))).toEqual(both);
  });

  it("answers nobody with nothing", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    createProject(team.database, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    expect(await team.lookup(undefined)).toEqual([]);
  });
});

describe("the resource lifecycle calls", () => {
  it("records a repository loreserver says it created", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    const reply = await unaryCall({
      url: team.server.url,
      path: METHOD_CREATE_RESOURCE,
      message: encodeCreateResourceRequest({
        resourceId: resourceIdOf(project.id),
        resourceName: "harbour",
      }),
      timeoutMs: 5000,
    });

    // An empty message, which is what CreateResourceResponse is.
    expect(reply).toHaveLength(0);
    expect(team.log.at(-1)).toContain("the project harbour");
    expect(findProject(team.database, project.id)).toBeDefined();
  });

  it("forgets a project when an account of this server is behind the deletion", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const remove = async (authorization: string | undefined): Promise<void> => {
      await unaryCall({
        url: team.server.url,
        path: METHOD_DELETE_RESOURCE,
        message: encodeDeleteResourceRequest({ resourceId: resourceIdOf(project.id) }),
        ...(authorization === undefined ? {} : { authorization }),
        timeoutMs: 5000,
      });
    };

    // Nobody is nobody, whoever else may be an account here.
    await remove(undefined);
    expect(findProject(team.database, project.id)).toBeDefined();

    // And bob did not make it, which is no longer a reason to keep it.
    await remove(team.bearer(bob));
    expect(findProject(team.database, project.id)).toBeUndefined();
  });
});

describe("the rest of the protocol", () => {
  it("answers UNIMPLEMENTED for a method it does not serve", async () => {
    const team = await harness();

    const failure = await unaryCall({
      url: team.server.url,
      path: "/epic_urc.UrcAuthApi/StartAuthSession",
      message: Buffer.alloc(0),
      timeoutMs: 5000,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GrpcCallError);
    expect((failure as GrpcCallError).status).toBe(GRPC_UNIMPLEMENTED);
  });
});

describe("a refusal, on its way to whoever is watching", () => {
  it("is pushed out with the row it became, key and all", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    disableUser(team.database, ada.username);

    expect(await team.check(team.bearer(ada), ["urc-nothing"])).toEqual([]);

    expect(team.refusals).toHaveLength(1);
    expect(team.refusals[0]).toMatchObject({ allowed: false, username: "unknown" });
    // The key of the row, because a panel that already holds a page of the log
    // has to be able to tell this refusal from the ones around it, which are
    // otherwise identical. It is the row the log now carries.
    expect(team.refusals[0]?.id).toBeTypeOf("number");
    expect(listDecisions(team.database)[0]).toMatchObject({
      at: team.refusals[0]?.at,
      detail: team.refusals[0]?.detail,
    });
  });

  it("is the only kind of decision that is pushed at anybody", async () => {
    // The whole reason this channel is named for refusals. A decision is taken
    // on every repository access, so pushing the allowances would put more
    // frames on the wire than the rest of the protocol together, to say
    // something a panel could only act on by re-reading a page it holds.
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    await team.check(team.bearer(ada), [resourceIdOf(project.id)]);
    await team.lookup(team.bearer(ada));

    // Three decisions were recorded and every one of them was an allowance, so
    // nothing was pushed.
    expect(team.log.length).toBeGreaterThan(0);
    expect(listDecisions(team.database).every((decision) => decision.allowed)).toBe(true);
    expect(team.refusals).toEqual([]);
  });

  it("goes out once for a call that named several resources", async () => {
    // A refusal has one reason and one subject, whoever presented the token, and
    // which resources the request happened to name changes nothing about it. It
    // is recorded once, so it is pushed once - and this is the branch an
    // unauthenticated caller reaches, which is the one that must not be a way to
    // make this server send sixty-four frames.
    const team = await harness();

    await team.check(undefined, ["urc-aa", "urc-bb", "urc-cc"]);

    expect(team.refusals).toHaveLength(1);
    expect(team.refusals[0]?.resource).toBe("3 resources");
  });

  it("is written down and logged just the same where there is nobody to push it to", async () => {
    // A build with no socket, and a refusal decided before one exists, both
    // leave this unset. What that costs is the pushing; the log line and the row
    // are what this server did with every refusal before there was anywhere to
    // push one.
    const layout = identityLayout(await temporaryRoot());
    const database = await openMigratedDatabase(layout.databasePath);
    const keys = await KeyStore.open(layout.keysDir);
    const log: string[] = [];
    const server = await startAuthorizationService({
      port: 0,
      database,
      keys,
      config,
      log: (line) => log.push(line),
    });
    try {
      await unaryCall({
        url: server.url,
        path: METHOD_CHECK_USER_PERMISSION,
        message: encodeCheckUserPermissionRequest({ resourceIds: ["urc-aa"] }),
        timeoutMs: 5000,
      });

      expect(listDecisions(database)).toHaveLength(1);
      expect(listDecisions(database)[0]?.allowed).toBe(false);
      expect(log.some((line) => line.includes("refused"))).toBe(true);
    } finally {
      await server.close();
      database.close();
    }
  });
});
