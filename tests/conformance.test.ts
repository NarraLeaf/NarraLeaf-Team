/**
 * What the contract module, the generated JSON and the registered handlers all
 * have to agree about.
 *
 * The names on the wire live once, as ordinary constants in the canonical
 * package `@narraleaf/team-protocol` under `protocol/`. `protocol/contract.json`
 * is generated from that package rather than authored beside it, so the two
 * cannot drift: the checks below pin the constants and the registered handlers
 * to the generated file, and pin the generated file to the module it was written
 * from, so that a change to the contract that forgot to regenerate the JSON is a
 * failing test rather than a stale artifact.
 *
 * A client that ships separately - Studio today, and any other tomorrow -
 * consumes this same package, so there is no second hand-kept copy for a rename
 * to slip past.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANCHOR_FIELD_LIMIT,
  COMMENT_BODY_LIMIT,
  CONTRACT,
  INSTANCE_FIELD_LIMIT,
  LIVE_PAYLOAD_LIMIT,
  OVERLAY_BODY_LIMIT,
  PAGE_BYTES_LIMIT,
  SUGGESTION_LIMIT,
  TEAM_METHODS,
  TEAM_PROTOCOL_VERSION,
  TEAM_SOCKET_PATH,
  TOPIC_PROJECTS,
  liveTopic,
  projectClientsTopic,
  projectLiveTopic,
  projectOverlayTopic,
  projectThreadsTopic,
  projectTopic,
} from "../src/team/protocol.js";
import {
  assertProtocolConsistency,
  methodTable,
  serverCapabilities,
} from "../src/team/methods.js";
import { teamMethods } from "../src/team/endpoint.js";
import type { TeamService } from "../src/team/service.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-conformance-");

interface Contract {
  protocol: number;
  socketPath: string;
  capabilities: string[];
  errorCodes: string[];
  methods: string[];
  topics: Record<string, string>;
  limits: Record<string, number>;
  frames: { fromServer: string[]; fromClient: string[] };
}

const generated = JSON.parse(
  readFileSync(fileURLToPath(new URL("../protocol/contract.json", import.meta.url)), "utf-8"),
) as Contract & { _generated: string };

// Everything below reads the same set of fields the module carries, so the
// header the generator writes is dropped before either is compared.
const { _generated: _header, ...contract } = generated;

describe("the protocol contract", () => {
  it("is the version this build speaks", () => {
    expect(TEAM_PROTOCOL_VERSION).toBe(contract.protocol);
    expect(TEAM_SOCKET_PATH).toBe(contract.socketPath);
  });

  it("has a JSON that is in step with the module it was generated from", () => {
    // The module is the source and the JSON is the product. Compared through a
    // round trip so that the tuples the module freezes read as the arrays the
    // file holds; a mismatch is a contract.json that was not regenerated after
    // the module changed.
    expect(contract).toEqual(JSON.parse(JSON.stringify(CONTRACT)));
  });

  it("serves every method the contract names, and no others", () => {
    // Sorted rather than compared in order: the contract is a set, and a method moved
    // up the list is not a change to what a client can call.
    expect([...methodTable(teamMethods()).keys()].sort()).toEqual([...contract.methods].sort());
    expect(Object.values(TEAM_METHODS).sort()).toEqual([...contract.methods].sort());
  });

  it("advertises every capability the contract names, when the build serves them all", async () => {
    // The socket capabilities the method table implies, and the three the HTTP
    // routes add when there is a reader to page a history and somewhere to put a
    // file down. A build serving all of it advertises exactly the contract's
    // vocabulary and no more.
    //
    // A real database, because what is announced is worked out against the
    // deployment as well as the build: a server closed to collaboration
    // announces no coordination plane. Nothing is stored in this one, which is a
    // deployment nobody has closed.
    const database = await openMigratedDatabase(
      identityLayout(await temporaryRoot()).databasePath,
    );
    try {
      const everything = {
        database,
        readings: { get: () => undefined, revisions: async () => undefined },
        blobs: true,
      } as unknown as TeamService;
      expect(serverCapabilities(methodTable(teamMethods()), everything).sort()).toEqual(
        [...contract.capabilities].sort(),
      );
    } finally {
      database.close();
    }
  });

  it("builds the topics the contract spells out", () => {
    expect(TOPIC_PROJECTS).toBe(contract.topics["projects"]);
    expect(projectTopic("abc")).toBe(contract.topics["project"]?.replace("{project}", "abc"));
    expect(projectThreadsTopic("abc")).toBe(
      contract.topics["projectThreads"]?.replace("{project}", "abc"),
    );
    expect(projectOverlayTopic("abc")).toBe(
      contract.topics["projectOverlay"]?.replace("{project}", "abc"),
    );
    expect(projectClientsTopic("abc")).toBe(
      contract.topics["projectClients"]?.replace("{project}", "abc"),
    );
    expect(projectLiveTopic("abc")).toBe(
      contract.topics["projectLive"]?.replace("{project}", "abc"),
    );
    expect(liveTopic("xyz")).toBe(contract.topics["live"]?.replace("{session}", "xyz"));
  });

  it("bounds what it stores at the sizes the contract states", () => {
    expect(ANCHOR_FIELD_LIMIT).toBe(contract.limits["anchorField"]);
    expect(COMMENT_BODY_LIMIT).toBe(contract.limits["commentBody"]);
    expect(SUGGESTION_LIMIT).toBe(contract.limits["suggestion"]);
    expect(OVERLAY_BODY_LIMIT).toBe(contract.limits["overlayBody"]);
    expect(LIVE_PAYLOAD_LIMIT).toBe(contract.limits["livePayload"]);
    expect(INSTANCE_FIELD_LIMIT).toBe(contract.limits["instanceField"]);
    expect(PAGE_BYTES_LIMIT).toBe(contract.limits["pageBytes"]);
  });
});

describe("the startup consistency check", () => {
  it("passes for the methods this build actually registers", () => {
    expect(() => assertProtocolConsistency(methodTable(teamMethods()))).not.toThrow();
  });

  it("refuses a build whose handlers and contract have fallen out of step", () => {
    // A handler the contract does not name is exactly the state the check exists
    // to catch: the server would answer a method it never advertised, or - the
    // mirror of it - advertise one it cannot answer. Either is a lie a client
    // acts on, so the server must not start.
    const withPhantom = methodTable([
      ...teamMethods(),
      { name: "phantom.method", capability: "session", handle: () => ({}) },
    ]);
    expect(() => assertProtocolConsistency(withPhantom)).toThrow(/does not agree with itself/);
  });
});
