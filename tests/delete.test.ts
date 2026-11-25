import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeRepositoryDeleteRequest,
  decodeRepositoryGetRequest,
  encodeRepositoryResponse,
  METHOD_REPOSITORY_DELETE,
  METHOD_REPOSITORY_GET,
  type Repository,
} from "../src/grpc/messages.js";
import { GrpcServer } from "../src/grpc/server.js";
import { GRPC_NOT_FOUND, GRPC_PERMISSION_DENIED, GrpcStatusError } from "../src/grpc/status.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser, type UserRecord } from "../src/identity/users.js";
import { authorityWorkingCopyPath, projectCheckoutPath, readyMarkerPath } from "../src/projects/cache.js";
import { heldBy } from "../src/projects/create.js";
import { deleteForever, deletionTarget, type DeletionSource } from "../src/projects/delete.js";
import { createProject, findProjectById, forgetProject, listProjects, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-delete-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const closing: Array<() => unknown> = [];
afterEach(async () => {
  while (closing.length > 0) await closing.pop()?.();
});

function record(id: string, name: string): Repository {
  return { id, name, description: "", defaultBranchId: newProjectId(), defaultBranchName: "main", creator: "ada", created: 1, metadata: "" };
}

/**
 * A loreserver that holds repositories in a map and answers the two calls a
 * deletion makes. `onDelete` stands in for loreserver telling Team over
 * `DeleteResource`, which the real one does before it answers.
 */
async function fakeLoreserver(repositories: Map<string, string>, onDelete?: (id: string) => void) {
  const calls: string[] = [];
  const server = await GrpcServer.start({
    port: 0,
    methods: {
      [METHOD_REPOSITORY_GET]: (call) => {
        const query = decodeRepositoryGetRequest(call.message);
        calls.push(`get ${query?.kind === "id" ? query.id : ""}`);
        const name = query?.kind === "id" ? repositories.get(query.id) : undefined;
        if (query?.kind !== "id" || name === undefined) throw new GrpcStatusError(GRPC_NOT_FOUND, "Repository not found");
        return encodeRepositoryResponse(record(query.id, name));
      },
      [METHOD_REPOSITORY_DELETE]: (call) => {
        const id = decodeRepositoryDeleteRequest(call.message) ?? "";
        calls.push(`delete ${id}`);
        const name = repositories.get(id);
        if (name === undefined) throw new GrpcStatusError(GRPC_NOT_FOUND, "Repository not found");
        repositories.delete(id);
        onDelete?.(id);
        return encodeRepositoryResponse(record(id, name));
      },
    },
  });
  closing.push(() => server.close());
  return { port: server.port, calls };
}

async function setup(repositories: Map<string, string>, options: { callBack?: boolean } = {}) {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database: DatabaseSync = await openMigratedDatabase(layout.databasePath);
  closing.push(() => database.close());
  const lore = await fakeLoreserver(repositories, options.callBack === true ? (id) => forgetProject(database, id) : undefined);
  const source: DeletionSource = {
    database,
    keys: await KeyStore.open(layout.keysDir),
    config: identityConfig({ dataPort: lore.port }),
    dataPort: lore.port,
    root,
  };
  const ada: UserRecord = await createUser(database, hasher, { username: "ada", password: "a password nobody guesses" });
  return { root, database, source, ada, calls: lore.calls };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("deleting a project for good", () => {
  it("deletes the repository of a listed project, the row, and Team's own copies of it", async () => {
    const id = newProjectId();
    const repositories = new Map([[id, "harbour"]]);
    const { root, database, source, ada, calls } = await setup(repositories);
    createProject(database, { id, name: "harbour", createdBy: ada.id });
    for (const path of [projectCheckoutPath(root, id), authorityWorkingCopyPath(root, id)]) await mkdir(path, { recursive: true });
    await mkdir(dirname(readyMarkerPath(root, id)), { recursive: true });
    await writeFile(readyMarkerPath(root, id), "");

    const target = deletionTarget(database, { name: "harbour" });
    expect(target.kind).toBe("project");
    if (target.kind !== "project") return;
    const outcome = await deleteForever(source, ada, target);

    expect(outcome).toEqual({ kind: "deleted", repositoryId: id, name: "harbour", forgotHere: true, alreadyGone: false });
    expect(calls).toEqual([`delete ${id}`]);
    expect(repositories.size).toBe(0);
    expect(listProjects(database)).toEqual([]);
    for (const path of [projectCheckoutPath(root, id), readyMarkerPath(root, id), authorityWorkingCopyPath(root, id)]) {
      expect(await exists(path)).toBe(false);
    }
  });

  it("leaves the announcing to loreserver's DeleteResource when that took the row first", async () => {
    const id = newProjectId();
    const { database, source, ada } = await setup(new Map([[id, "harbour"]]), { callBack: true });
    const project = createProject(database, { id, name: "harbour", createdBy: ada.id });

    const outcome = await deleteForever(source, ada, { kind: "project", project });

    expect(outcome).toMatchObject({ kind: "deleted", forgotHere: false, alreadyGone: false });
    expect(listProjects(database)).toEqual([]);
  });

  it("takes only the row of a project whose repository is already gone", async () => {
    const id = newProjectId();
    const { database, source, ada } = await setup(new Map());
    const project = createProject(database, { id, name: "harbour", createdBy: ada.id });

    expect(await deleteForever(source, ada, { kind: "project", project })).toMatchObject({ kind: "deleted", alreadyGone: true, forgotHere: true });
    expect(listProjects(database)).toEqual([]);
  });

  it("deletes a repository taken off the list earlier, once it has checked its name", async () => {
    const id = newProjectId();
    const repositories = new Map([[id, "sakura-school"]]);
    const { database, source, ada, calls } = await setup(repositories, { callBack: true });

    const target = deletionTarget(database, { name: "sakura-school", repositoryId: id.toUpperCase() });
    expect(target).toEqual({ kind: "leftover", repositoryId: id, name: "sakura-school" });
    if (target.kind !== "leftover") return;
    const outcome = await deleteForever(source, ada, target);

    expect(outcome).toMatchObject({ kind: "deleted", repositoryId: id, name: "sakura-school", alreadyGone: false });
    expect(calls).toEqual([`get ${id}`, `delete ${id}`]);
    expect(repositories.size).toBe(0);
    expect(listProjects(database)).toEqual([]);
  });

  it("deletes nothing when the leftover's repository carries another name, or there is none", async () => {
    const id = newProjectId();
    const repositories = new Map([[id, "lighthouse"]]);
    const { database, source, ada, calls } = await setup(repositories);

    expect(await deleteForever(source, ada, { kind: "leftover", repositoryId: id, name: "sakura-school" })).toEqual({ kind: "name-mismatch", actual: "lighthouse" });
    expect(await deleteForever(source, ada, { kind: "leftover", repositoryId: newProjectId(), name: "sakura-school" })).toEqual({ kind: "no-repository" });

    expect(repositories.get(id)).toBe("lighthouse");
    expect(calls.filter((call) => call.startsWith("delete"))).toEqual([]);
    expect(listProjects(database)).toEqual([]);
  });

  it("keeps the project when loreserver refuses the delete", async () => {
    const id = newProjectId();
    const { database, source, ada } = await setup(new Map([[id, "harbour"]]));
    const project = createProject(database, { id, name: "harbour", createdBy: ada.id });
    // A loreserver that will not: every call refused.
    const refusing = await GrpcServer.start({
      port: 0,
      methods: {
        [METHOD_REPOSITORY_DELETE]: () => {
          throw new GrpcStatusError(GRPC_PERMISSION_DENIED, "no");
        },
      },
    });
    closing.push(() => refusing.close());

    const outcome = await deleteForever({ ...source, dataPort: refusing.port }, ada, { kind: "project", project });

    expect(outcome.kind).toBe("repository-refused");
    expect(findProjectById(database, id)?.name).toBe("harbour");
  });
});

describe("what a deletion names", () => {
  it("needs the name to match exactly, and tells a leftover from a listed project", async () => {
    const { database, ada } = await setup(new Map());
    const id = newProjectId();
    createProject(database, { id, name: "harbour", createdBy: ada.id });

    expect(deletionTarget(database, { name: "Harbour" })).toEqual({ kind: "not-found" });
    expect(deletionTarget(database, { name: id })).toEqual({ kind: "not-found" });
    expect(deletionTarget(database, { name: "lighthouse", repositoryId: id })).toEqual({ kind: "name-mismatch", actual: "harbour" });
    expect(deletionTarget(database, { name: "harbour", repositoryId: newProjectId() }).kind).toBe("name-taken");
    expect(deletionTarget(database, { name: "harbour", repositoryId: "nope" })).toEqual({ kind: "invalid-repository-id" });
    expect(deletionTarget(database, { name: "harbour", repositoryId: id }).kind).toBe("project");
  });

  it("reads the id of the repository holding a name out of loreserver's refusal", () => {
    const asked = "fa4e7b929d6544fa8497493897bd6654";
    const said =
      "Repository sakura-school already exist with id 01a20d522d2776e0bf46f6a2588903a6 which does not match fa4e7b929d6544fa8497493897bd6654";
    expect(heldBy(said, asked)).toBe("01a20d522d2776e0bf46f6a2588903a6");
    expect(heldBy("Repository sakura-school already exists", asked)).toBeUndefined();
    expect(heldBy(`${said} or 95e5796ffd594eb7a48c86ba189921f5`, asked)).toBeUndefined();
  });
});
