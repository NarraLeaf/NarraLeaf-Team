import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { withTheWayOut } from "../src/project.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, type UserRecord } from "../src/identity/users.js";
import {
  makeOrAdoptProject,
  type ProjectCreationSource,
} from "../src/projects/create.js";
import {
  createProject,
  forgetProject,
  InvalidProjectNameError,
  listProjects,
  newProjectId,
  PROJECT_PERMISSIONS,
  ProjectNameTakenError,
  projectIdFromResourceId,
  requireProject,
  resourceIdOf,
  UnknownProjectError,
} from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-projects-");

/** Cheap parameters: these tests are about the rows, not the cost of a hash. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

async function account(connection: DatabaseSync, username: string): Promise<string> {
  return (await member(connection, username)).id;
}

/** The whole account, for the tests that hand one to a create. */
async function member(connection: DatabaseSync, username: string): Promise<UserRecord> {
  return await createUser(connection, hasher, {
    username,
    password: "a password nobody guesses",
  });
}

/**
 * A port number nothing is listening on, borrowed and given straight back.
 *
 * The same reasoning as its twin in tests/client.test.ts: loreserver's usual
 * port is one a machine with a Team server running answers on, so a test naming
 * it would be asserting about whatever happened to be there. What these tests
 * want is a port that refuses at once, so that "loreserver was asked" and
 * "loreserver was not asked" are told apart by an outcome rather than a wait.
 */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * What a create is done with, pointed at a loreserver that is not there.
 *
 * The narrowed source `makeOrAdoptProject` takes, assembled the way a command
 * line holding a storage root assembles one: a database, the signing keys
 * beside it, the settings a token is minted from, and the port loreserver would
 * be on.
 */
async function creationSource(): Promise<{
  source: ProjectCreationSource;
  database: DatabaseSync;
}> {
  const layout = identityLayout(await temporaryRoot());
  const connection = await openMigratedDatabase(layout.databasePath);
  open.push(connection);
  const dataPort = await unusedPort();
  return {
    database: connection,
    source: {
      database: connection,
      keys: await KeyStore.open(layout.keysDir),
      config: identityConfig({ dataPort }),
      dataPort,
    },
  };
}

describe("resource ids", () => {
  it("is the repository id with the prefix loreserver asks with", () => {
    const id = newProjectId();

    expect(resourceIdOf(id)).toBe(`urc-${id}`);
    expect(projectIdFromResourceId(resourceIdOf(id))).toBe(id);
    // Hex is hex in either case, so a shouted resource id names the same
    // project. What it does not do is change the string that goes back in the
    // answer, which loreserver compares character by character.
    expect(projectIdFromResourceId(resourceIdOf(id).toUpperCase())).toBe(id);
  });

  it("generates sixteen bytes, as hex, and a different one every time", () => {
    const first = newProjectId();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(newProjectId()).not.toBe(first);
  });

  it("recognises nothing else as one of Team's", () => {
    // A resource loreserver invented for something other than a repository has
    // to answer "not a project here" rather than fall through to a lookup.
    expect(projectIdFromResourceId("urc-not-hex")).toBeUndefined();
    expect(projectIdFromResourceId(newProjectId())).toBeUndefined();
    expect(projectIdFromResourceId(`urc-${newProjectId()}extra`)).toBeUndefined();
    expect(projectIdFromResourceId("")).toBeUndefined();
  });
});

describe("createProject", () => {
  it("records the project and who made it", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");

    const project = createProject(connection, {
      id: newProjectId(),
      name: "moonlit-harbour",
      description: "a game about a port at night",
      createdBy: ada,
    });

    expect(project.name).toBe("moonlit-harbour");
    // Who made it, and nothing more: it is shown, and it is not consulted when
    // somebody asks to open the repository.
    expect(project.createdBy).toBe(ada);
    expect(listProjects(connection).map((entry) => entry.name)).toEqual(["moonlit-harbour"]);
  });

  it("refuses a second project of the same name", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    createProject(connection, { id: newProjectId(), name: "harbour", createdBy: ada });

    expect(() =>
      createProject(connection, { id: newProjectId(), name: "harbour", createdBy: ada }),
    ).toThrow(ProjectNameTakenError);
    expect(listProjects(connection)).toHaveLength(1);
  });

  it("refuses a name loreserver would not take", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");

    expect(() =>
      createProject(connection, { id: newProjectId(), name: "a name with spaces", createdBy: ada }),
    ).toThrow(InvalidProjectNameError);
  });

  it("finds a project by its name or by its repository id", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(requireProject(connection, "harbour").id).toBe(project.id);
    expect(requireProject(connection, project.id).name).toBe("harbour");
    expect(() => requireProject(connection, "nothing")).toThrow(UnknownProjectError);
  });
});

describe("what an account may do", () => {
  it("is the same everywhere, because every account reaches every project", () => {
    // One rule, one answer. The claim is filled in because loreserver's data
    // plane reads it; the repository authorizer never looks at the verbs.
    expect([...PROJECT_PERMISSIONS]).toEqual(["read", "write"]);
  });
});

describe("makeOrAdoptProject", () => {
  it("asks loreserver for a repository when none is named, and takes the row back", async () => {
    // Nothing is listening on the port the source names, so the create cannot
    // get its repository. What is asserted is both halves of the ordering: the
    // outcome says loreserver refused, and the row written before it was asked
    // is gone again.
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");

    const outcome = await makeOrAdoptProject(source, ada, { name: "harbour" });

    expect(outcome.kind).toBe("repository-refused");
    expect(listProjects(database)).toEqual([]);
  });

  it("tells whoever asked for a name that is taken what to do about it", () => {
    // loreserver's own sentence, which names the repository it found. What is
    // added is the one thing loreserver cannot know: that this server has an
    // option for recording a repository it already holds.
    const refusal =
      "/lore.repository.v1.RepositoryService/RepositoryCreate answered ALREADY_EXISTS: " +
      "Repository lantern-hill already exist with id 95e5796ffd594eb7a48c86ba189921f5 " +
      "which does not match e9edcec2e3284b3f96bf8a0b5290db90";

    const said = withTheWayOut(refusal);

    expect(said).toContain(refusal);
    expect(said).toContain("--repository");
    // The id is read out of loreserver's words rather than rebuilt beside them,
    // so there is only ever one of it to be wrong.
    expect(said.match(/95e5796ffd594eb7a48c86ba189921f5/g)).toHaveLength(1);
  });

  it("adds nothing to a refusal that has no way out", () => {
    const refusal = "loreserver could not be reached on port 41337";

    expect(withTheWayOut(refusal)).toBe(refusal);
  });

  it("adopts a repository that already exists, and asks loreserver for nothing", async () => {
    // The same source, pointed at the same absent loreserver. This one succeeds,
    // which is the whole assertion: an adoption cannot have made a call that
    // would have failed.
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");
    const existing = newProjectId();

    const outcome = await makeOrAdoptProject(source, ada, {
      name: "harbour",
      repositoryId: existing,
    });

    expect(outcome).toMatchObject({ kind: "made", adopted: true });
    if (outcome.kind === "made") {
      expect(outcome.project.id).toBe(existing);
      // Nothing asked loreserver anything, so there is no branch to name. A
      // default filled in here would be a claim about a repository this never
      // looked at.
      expect(outcome.defaultBranch).toBeUndefined();
    }
    expect(listProjects(database).map((row) => row.id)).toEqual([existing]);
  });

  it("takes a repository id in either case, and records the one hex is written in", async () => {
    // Hex is hex, and everything downstream compares this character by
    // character: it is the primary key and half the resource id loreserver asks
    // permission questions about.
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");
    const existing = newProjectId();

    const outcome = await makeOrAdoptProject(source, ada, {
      name: "harbour",
      repositoryId: existing.toUpperCase(),
    });

    expect(outcome).toMatchObject({ kind: "made", adopted: true });
    expect(listProjects(database).map((row) => row.id)).toEqual([existing]);
  });

  it("refuses a repository id that is not one, without writing a row", async () => {
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");

    expect(
      await makeOrAdoptProject(source, ada, { name: "harbour", repositoryId: "not-hex" }),
    ).toEqual({ kind: "invalid-repository-id" });
    expect(listProjects(database)).toEqual([]);
  });

  it("refuses a repository this server already holds rather than taking it over", async () => {
    // Somebody is publishing what they believe is theirs alone, and the server
    // already having it means somebody else has it. That has to be said rather
    // than silently adopted.
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");
    const existing = newProjectId();
    createProject(database, { id: existing, name: "harbour", createdBy: ada.id });

    const outcome = await makeOrAdoptProject(source, ada, {
      name: "lighthouse",
      repositoryId: existing,
    });

    expect(outcome).toEqual({ kind: "repository-taken", repositoryId: existing });
    expect(listProjects(database).map((row) => row.name)).toEqual(["harbour"]);
  });

  it("refuses a name loreserver would not take, before anything is adopted", async () => {
    const { source, database } = await creationSource();
    const ada = await member(database, "ada");

    const outcome = await makeOrAdoptProject(source, ada, {
      name: "a name with spaces",
      repositoryId: newProjectId(),
    });

    expect(outcome.kind).toBe("invalid-name");
    expect(listProjects(database)).toEqual([]);
  });
});

describe("forgetProject", () => {
  it("takes the row away, and says so when there was none", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(forgetProject(connection, project.id)).toBe(true);

    expect(listProjects(connection)).toEqual([]);
    expect(forgetProject(connection, project.id)).toBe(false);
  });
});
