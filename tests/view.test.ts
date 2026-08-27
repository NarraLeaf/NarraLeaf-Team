// The settings surface: which rows it has, which of them may be written, and
// what the two measurements of a server's disk say.
//
// What a person may change about a running server is decided here and nowhere
// else, and a row is found by its position and written by its key - so which
// rows there are, and in what order, is part of the contract rather than a
// detail of how they are drawn.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { defaultPasswordHasher } from "../src/identity/passwords.js";
import {
  REPOSITORY_LIFETIME_KEY,
  SERVER_NAME_KEY,
  setServerName,
  SIGN_IN_LIFETIME_KEY,
} from "../src/identity/settings.js";
import { createUser } from "../src/identity/users.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import {
  directoryBytes,
  settingKeyOf,
  settingRows,
  storageRootOf,
  type ViewContext,
} from "../src/view.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-interface-");

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

/** A Team server with an account and a project on it. */
async function team(): Promise<ViewContext> {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  open.push(database);

  const ada = await createUser(database, defaultPasswordHasher(), {
    username: "ada",
    password: "correct horse battery",
    displayName: "Ada Blackwood",
    groups: ["owner"],
  });
  createProject(database, {
    id: newProjectId(),
    name: "harbour",
    description: "the one everybody is working on",
    createdBy: ada.id,
  });

  return {
    root,
    database,
    config: identityConfig({}),
    fingerprint: "22:3B:65:91:89:41:E6:D7",
  };
}

describe("the settings surface", () => {
  it("marks a row editable only where Team has somewhere to put the value", async () => {
    const rows = settingRows(await team());
    const editable = rows.filter((row) => row.editable).map((row) => row.label);

    // The rest are named on the command line that started up, so an editor
    // over them would be writing somewhere nothing reads.
    expect(editable).toEqual([
      "name",
      "repeat publishes",
      "sign-in token",
      "repository token",
    ]);
  });

  it("says of the repository token the one thing that is not obvious about it", async () => {
    const rows = settingRows(await team());
    const repository = rows.find((row) => row.label === "repository token");

    expect(repository?.caution).toContain("without asking Team");
  });

  it("names a setting for every row that may be written, and none for the rest", async () => {
    // The row a person edits is found by its position and written by its key,
    // and this is the pairing between the two. A row marked editable that no
    // key answers for would be an editor writing where nothing reads.
    const rows = settingRows(await team());

    for (const row of rows) {
      expect(settingKeyOf(row.label) !== undefined).toBe(row.editable);
    }
    expect(settingKeyOf("name")).toBe(SERVER_NAME_KEY);
    expect(settingKeyOf("sign-in token")).toBe(SIGN_IN_LIFETIME_KEY);
    expect(settingKeyOf("repository token")).toBe(REPOSITORY_LIFETIME_KEY);
  });

  it("sends the number a lifetime was written from beside the words", async () => {
    // The value is a duration in words, in whatever language wrote it, and a
    // reader that wanted the number back would have to take those words apart
    // again. Present on the two lifetimes and nowhere else.
    const withSeconds = settingRows(await team())
      .filter((row) => row.seconds !== undefined)
      .map((row) => row.label);

    expect(withSeconds).toEqual(["sign-in token", "repository token"]);
  });

  it("says of each writable row whether its value was chosen or is the default", async () => {
    // The fact a reader cannot recover from the value: a name that happens to
    // equal the host and a name nobody set look the same, and only the second
    // follows a later version of Team when the default moves.
    const context = await team();

    const before = settingRows(context).find((row) => row.label === "name");
    setServerName(context.database, "Winterlight");
    const after = settingRows(context).find((row) => row.label === "name");

    expect(before?.stored).toBe(false);
    expect(after?.stored).toBe(true);
  });

  it("says nothing of the sort about a row with no default behind it", async () => {
    // The identity settings and the ports are named on the command line that
    // started up. There is no default answering for them, so there is no
    // question to answer, and an answer would be one made up.
    const rows = settingRows(await team());

    expect(rows.filter((row) => row.stored !== undefined).map((row) => row.label)).toEqual(
      rows.filter((row) => row.editable).map((row) => row.label),
    );
  });

  it("shows a server nobody has named as the address people already reach it at", async () => {
    const context = await team();
    const name = settingRows(context).find((row) => row.label === "name");

    // What is in effect rather than what is stored, so an unnamed server reads
    // as its host rather than as a blank.
    expect(name?.value).toBe("127.0.0.1");
  });

  it("says the fingerprint is unknown on a server that has no authority yet", async () => {
    const rows = settingRows({ ...(await team()), fingerprint: undefined });

    expect(rows.find((row) => row.label === "fingerprint")?.value).toBe("unknown");
  });
});

describe("what a storage root holds", () => {
  it("adds up every file underneath it", async () => {
    const root = await temporaryRoot();
    const nested = join(root, "one", "two");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "a"), "12345");
    await writeFile(join(nested, "b"), "678");

    expect(await directoryBytes(root)).toBe(8);
  });

  it("answers with nothing rather than a total it is not sure of", async () => {
    // A partial total looks exactly like a real one, so a directory that could
    // not be read at all must not report as an empty one.
    expect(await directoryBytes(join(await temporaryRoot(), "nothing is here"))).toBeUndefined();
  });

  it("puts loreserver's store under the storage root it was given", async () => {
    const root = await temporaryRoot();

    expect(storageRootOf(root).startsWith(root)).toBe(true);
  });
});
