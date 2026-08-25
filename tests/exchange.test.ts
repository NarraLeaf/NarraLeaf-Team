import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { GrpcCallError, unaryCall } from "../src/grpc/client.js";
import {
  decodeExchangeExternalTokenForUserTokenResponse,
  decodeExchangeUserTokenForMultiresourceTokenResponse,
  encodeExchangeExternalTokenForUserTokenRequest,
  encodeExchangeUserTokenForMultiresourceTokenRequest,
  METHOD_EXCHANGE_EXTERNAL_TOKEN,
  METHOD_EXCHANGE_MULTIRESOURCE_TOKEN,
  type UserToken,
} from "../src/grpc/messages.js";
import type { GrpcServer } from "../src/grpc/server.js";
import {
  GRPC_PERMISSION_DENIED,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAUTHENTICATED,
} from "../src/grpc/status.js";
import { authUrl, identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { setTokenLifetimes } from "../src/identity/settings.js";
import { mintToken, verifyToken } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  enableUser,
  requireUser,
  revokeUserTokens,
  type UserRecord,
} from "../src/identity/users.js";
import { createProject, newProjectId, resourceIdOf } from "../src/projects/registry.js";
import { startAuthorizationService } from "../src/projects/service.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-exchange-");

const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

/** A running service and the pieces a test needs to talk to it. */
interface Harness {
  readonly database: DatabaseSync;
  readonly server: GrpcServer;
  readonly keys: KeyStore;
  readonly log: string[];
  /** The certificate authority, when this harness is serving TLS. */
  readonly caPem: string | undefined;
  user(username: string): Promise<UserRecord>;
  /** A token for `user`, as its own client library would present it. */
  tokenFor(user: UserRecord, options?: { readonly now?: Date }): string;
  exchange(externalToken: string): Promise<UserToken | undefined>;
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

/**
 * A service on a free port, in plaintext or over TLS.
 *
 * The TLS form is driven through the same client with the Team server's own authority
 * as its `ca`, which is what a Studio installation does once a person has run
 * `nlteam trust --install` — with the difference that this test hands the
 * certificate over rather than asking the operating system for it.
 */
async function harness(options: { readonly tls?: boolean } = {}): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  const keys = await KeyStore.open(layout.keysDir);
  const log: string[] = [];
  const certificates = options.tls === true ? await ensureCertificates(root) : undefined;
  const config = identityConfig();

  const server = await startAuthorizationService({
    // Port 0: the operating system picks one that is free, so a test run cannot
    // collide with a Team server the machine is already running.
    port: 0,
    database,
    keys,
    config,
    log: (line) => log.push(line),
    ...(certificates === undefined
      ? {}
      : { tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem } }),
  });

  const instance: Harness = {
    database,
    server,
    keys,
    log,
    caPem: certificates?.authority.pem,
    async user(username: string): Promise<UserRecord> {
      await createUser(database, hasher, { username, password: "a password nobody guesses" });
      return requireUser(database, username);
    },
    tokenFor(user: UserRecord, mintOptions = {}): string {
      return mintToken(user, keys.signingKey, config, mintOptions).token;
    },
    async exchange(externalToken: string): Promise<UserToken | undefined> {
      const reply = await unaryCall({
        url: server.url,
        path: METHOD_EXCHANGE_EXTERNAL_TOKEN,
        message: encodeExchangeExternalTokenForUserTokenRequest({
          externalToken,
          // Passed through by the client and read by nobody: Team knows one kind
          // of token.
          tokenType: "jwt",
        }),
        ...(certificates === undefined ? {} : { ca: certificates.authority.pem }),
        timeoutMs: 5000,
      });
      return decodeExchangeExternalTokenForUserTokenResponse(reply).userToken;
    },
  };

  started.push(instance);
  return instance;
}

describe("ExchangeExternalTokenForUserToken", () => {
  it("hands back a token issued now, not the one it was given", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const config = identityConfig();
    // Minted five minutes ago, so the one that comes back can be told apart
    // from it by when it expires. A token minted twice in the same second is
    // byte-identical — the claims are the same and RS256 is deterministic — so
    // comparing the strings would prove nothing either way.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const presented = team.tokenFor(ada, { now: fiveMinutesAgo });

    const issued = await team.exchange(presented);
    const verified = verifyToken(issued?.userToken ?? "", team.keys, config);
    const before = verifyToken(presented, team.keys, config);

    // Issued now, which is what makes an exchange a check rather than a
    // renewal: the new token carries the account's state as it stands now.
    expect(verified.kind).toBe("verified");
    expect(verified.kind === "verified" && verified.claims.iat).toBeGreaterThan(
      before.kind === "verified" ? before.claims.iat : 0,
    );
    expect(issued?.expiresAt).toBe(verified.kind === "verified" ? verified.claims.exp : 0);
  });

  it("puts the origin of the auth endpoint in the token's audience", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const config = identityConfig();

    const issued = await team.exchange(team.tokenFor(ada));
    const verified = verifyToken(issued?.userToken ?? "", team.keys, config);

    // A client refuses a token whose `aud` does not name the endpoint it is
    // talking to, calling it a leak risk. Both spellings of the origin are
    // there, because the two sides of that comparison are not known to
    // normalise a trailing slash the same way.
    expect(verified.kind === "verified" && verified.claims.aud).toContain(authUrl(config));
    expect(verified.kind === "verified" && verified.claims.aud).toContain(`${authUrl(config)}/`);
    expect(verified.kind === "verified" && verified.claims.aud).toContain(config.audience);
  });

  it("names the account in the fields a client keys its state by", async () => {
    const team = await harness();
    await createUser(team.database, hasher, {
      username: "ada",
      password: "a password nobody guesses",
      displayName: "Ada Lovelace",
    });
    const ada = requireUser(team.database, "ada");

    const issued = await team.exchange(team.tokenFor(ada));

    expect(issued?.userId).toBe(ada.id);
    expect(issued?.userName).toBe("Ada Lovelace");
    // Seconds since the epoch, as an int64 — not milliseconds, and not text.
    // Milliseconds would be past this bound by three orders of magnitude even
    // with the sign-in token's thirty days allowed for.
    expect(issued?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(issued?.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000) + 31 * 24 * 60 * 60);
  });

  it("refuses a token for an account that has been disabled", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const presented = team.tokenFor(ada);
    disableUser(team.database, ada.username);

    // A status, not an empty success: an absent token on an OK reply looks to a
    // client like a server fault rather than a refusal.
    await expect(team.exchange(presented)).rejects.toThrow(GrpcCallError);
    await expect(team.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(team.log.some((line) => line.includes("the account is disabled"))).toBe(true);
  });

  it("refuses a token that has expired", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const presented = team.tokenFor(ada, { now: lastYear });

    await expect(team.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(team.log.some((line) => line.includes("the token has expired"))).toBe(true);
  });

  it("refuses a token signed by a key this Team server does not publish", async () => {
    const team = await harness();
    const stranger = await harness();
    const ada = await team.user("ada");
    await stranger.user("ada");

    // The same claims, signed by another Team server's key. Nothing but the signature
    // distinguishes it, which is the point.
    const presented = mintToken(ada, stranger.keys.signingKey, identityConfig()).token;

    await expect(team.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(team.log.some((line) => line.includes("no published key"))).toBe(true);
  });

  it("refuses a token issued before the account's access was revoked", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const presented = team.tokenFor(ada);
    // Disabling bumps the epoch as well as setting disabled_at, so the account
    // is enabled again to leave the epoch as the only thing refusing this.
    disableUser(team.database, ada.username);
    enableUser(team.database, ada.username);

    await expect(team.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(team.log.some((line) => line.includes("before the account's access was revoked"))).toBe(
      true,
    );
  });

  it("refuses a token that revoking made stale, and takes a fresh one from that account", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const presented = team.tokenFor(ada);

    revokeUserTokens(team.database, ada.username);

    await expect(team.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(team.log.some((line) => line.includes("before the account's access was revoked"))).toBe(
      true,
    );

    // Nothing about the account changed but the epoch, so a token minted after
    // it is taken. That is what makes revoking cost the person one sign-in
    // rather than costing an operator two commands and a decision in between.
    const issued = await team.exchange(team.tokenFor(requireUser(team.database, ada.username)));

    expect(verifyToken(issued?.userToken ?? "", team.keys, identityConfig()).kind).toBe("verified");
  });

  it("refuses a request carrying no token at all", async () => {
    const team = await harness();

    await expect(team.exchange("")).rejects.toMatchObject({ status: GRPC_UNAUTHENTICATED });
  });

  it("says nothing about which check failed", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    disableUser(team.database, ada.username);

    const failure = await team.exchange(team.tokenFor(ada)).catch((error: unknown) => error);

    // The distinctions are in Team's log and nowhere else: this is the one
    // method reachable by anybody who can open a socket to the endpoint.
    expect(failure).toBeInstanceOf(GrpcCallError);
    expect((failure as GrpcCallError).statusMessage).toBe(
      "the token presented for exchange was not accepted",
    );
  });
});

/**
 * The claims of a token, as a verifier reads them off the wire.
 *
 * Read from the encoded token rather than from what minted it, because the
 * `resources` claim is one loreserver reads and Team's own verifier does not
 * return — a check against the parsed claim object would not see it.
 */
function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the resources claim", () => {
  it("names every project this server holds, with what an account may do", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    const issued = await team.exchange(team.tokenFor(ada));
    const claims = claimsOf(issued?.userToken ?? "");

    // Not decoration. A client authorizes its data connection with this token,
    // and loreserver refuses one that arrives with no `resources` — the token
    // decodes, is logged as `resources: None`, and the connection answers
    // AuthorizationFailure. The client reports "Not authorized to access
    // repository" and nothing anywhere names the missing claim.
    expect(claims["resources"]).toEqual([
      { resource_id: resourceIdOf(project.id), permission: ["read", "write"] },
    ]);
  });

  it("is a list of objects, because a list of strings will not decode", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    createProject(team.database, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    const issued = await team.exchange(team.tokenFor(ada));
    const resources = claimsOf(issued?.userToken ?? "")["resources"];

    // loreserver deserializes this into Vec<ResourcePermission>, whose fields
    // it names `resource_id` and `permission`. Given plain strings it fails to
    // decode the whole token, and its log shows "Decoding JWT token" with
    // nothing after it.
    expect(Array.isArray(resources)).toBe(true);
    for (const entry of resources as unknown[]) {
      expect(typeof entry).toBe("object");
      expect(Object.keys(entry as object).sort()).toEqual(["permission", "resource_id"]);
    }
  });

  it("is empty on a server with no projects, rather than absent", async () => {
    const team = await harness();
    const bob = await team.user("bob");

    const issued = await team.exchange(team.tokenFor(bob));

    expect(claimsOf(issued?.userToken ?? "")["resources"]).toEqual([]);
  });

  it("is not on a token minted for anything else", async () => {
    const team = await harness();
    const ada = await team.user("ada");

    // `nlteam token mint` opens no data connection, so it names no resources.
    expect(claimsOf(team.tokenFor(ada))).not.toHaveProperty("resources");
  });
});

describe("ExchangeUserTokenForMultiresourceToken", () => {
  /** Ask for a token covering some resources, as a client does before a clone. */
  async function multiresource(
    team: Harness,
    token: string,
    resourceIds: readonly string[],
  ): Promise<UserToken | undefined> {
    const reply = await unaryCall({
      url: team.server.url,
      path: METHOD_EXCHANGE_MULTIRESOURCE_TOKEN,
      message: encodeExchangeUserTokenForMultiresourceTokenRequest({ resourceIds }),
      authorization: `Bearer ${token}`,
      ...(team.caPem === undefined ? {} : { ca: team.caPem }),
      timeoutMs: 5000,
    });
    return decodeExchangeUserTokenForMultiresourceTokenResponse(reply).token;
  }

  it("hands back a token naming the resources that were asked for", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const resource = resourceIdOf(project.id);

    const issued = await multiresource(team, team.tokenFor(ada), [resource]);

    expect(issued?.userId).toBe(ada.id);
    expect(claimsOf(issued?.userToken ?? "")["resources"]).toEqual([
      { resource_id: resource, permission: ["read", "write"] },
    ]);
  });

  it("hands one to an account that did not make the project", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const bob = await team.user("bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    // Every account of this server reaches every project on it, so who made
    // one is not part of the question being asked here.
    const issued = await multiresource(team, team.tokenFor(bob), [resourceIdOf(project.id)]);

    expect(claimsOf(issued?.userToken ?? "")["resources"]).toEqual([
      { resource_id: resourceIdOf(project.id), permission: ["read", "write"] },
    ]);
    expect(team.log.some((line) => line.includes("multiresource bob"))).toBe(true);
  });

  it("refuses a resource that is not a project on this Team server", async () => {
    const team = await harness();
    const ada = await team.user("ada");

    await expect(multiresource(team, team.tokenFor(ada), ["not-a-resource"])).rejects.toMatchObject({
      status: GRPC_PERMISSION_DENIED,
    });
  });

  it("refuses a caller it cannot identify", async () => {
    const team = await harness();

    await expect(multiresource(team, "not a token", ["urc-whatever"])).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
  });

  it("refuses a request naming more resources than it will mint a token for", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const many = Array.from({ length: 5000 }, (_, index) => `urc-${index}`);

    // Every id in the list would otherwise become a claim in a token this
    // signs, so the length of the list decides how much one request costs.
    await expect(multiresource(team, team.tokenFor(ada), many)).rejects.toMatchObject({
      status: GRPC_RESOURCE_EXHAUSTED,
    });
  });

  it("lasts minutes, where the token signed in with lasts a month", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    const signIn = await team.exchange(team.tokenFor(ada));
    const repository = await multiresource(team, team.tokenFor(ada), [resourceIdOf(project.id)]);

    // Two lifetimes and not one number used twice. Team is asked about the
    // sign-in token every time it matters, so revoking reaches it; this one
    // goes to loreserver's data plane, which checks it for itself, and its
    // expiry is the only thing that ends it.
    const now = Math.floor(Date.now() / 1000);
    expect((signIn?.expiresAt ?? 0) - now).toBeGreaterThan(29 * 24 * 60 * 60);
    expect((repository?.expiresAt ?? 0) - now).toBeGreaterThan(14 * 60);
    expect((repository?.expiresAt ?? 0) - now).toBeLessThanOrEqual(15 * 60);
  });

  it("takes the lifetime from the database as it mints, not from when Team started", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    // The service is already running and has already answered a call. A Team server
    // that read the setting once would go on issuing quarter-hour tokens here,
    // and the only way to find out would be to restart it and watch.
    await multiresource(team, team.tokenFor(ada), [resourceIdOf(project.id)]);
    setTokenLifetimes(team.database, { repositoryTokenLifetimeSeconds: 120 });
    const issued = await multiresource(team, team.tokenFor(ada), [resourceIdOf(project.id)]);

    const now = Math.floor(Date.now() / 1000);
    expect((issued?.expiresAt ?? 0) - now).toBeGreaterThan(60);
    expect((issued?.expiresAt ?? 0) - now).toBeLessThanOrEqual(120);
  });

  it("covers every resource asked for at once", async () => {
    const team = await harness();
    const ada = await team.user("ada");
    const first = createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const second = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      createdBy: ada.id,
    });
    const resources = [resourceIdOf(first.id), resourceIdOf(second.id)];

    const issued = await multiresource(team, team.tokenFor(ada), resources);

    expect(
      (claimsOf(issued?.userToken ?? "")["resources"] as { resource_id: string }[]).map(
        (entry) => entry.resource_id,
      ),
    ).toEqual(resources);
  });
});

describe("the same service over TLS", () => {
  it("completes a handshake and answers an exchange", async () => {
    const team = await harness({ tls: true });
    const ada = await team.user("ada");

    expect(team.server.url.startsWith("https://")).toBe(true);
    const issued = await team.exchange(team.tokenFor(ada));

    expect(issued?.userId).toBe(ada.id);
    expect(verifyToken(issued?.userToken ?? "", team.keys, identityConfig()).kind).toBe("verified");
  });

  it("cannot be reached by a client that does not have the authority", async () => {
    const team = await harness({ tls: true });
    const ada = await team.user("ada");

    // No `ca`, so node falls back to the host's own trust store — which is
    // exactly the state a Studio installation is in before `nlteam trust`.
    await expect(
      unaryCall({
        url: team.server.url,
        path: METHOD_EXCHANGE_EXTERNAL_TOKEN,
        message: encodeExchangeExternalTokenForUserTokenRequest({
          externalToken: team.tokenFor(ada),
          tokenType: "jwt",
        }),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/self-signed|unable to (verify|get)/i);
  });
});
