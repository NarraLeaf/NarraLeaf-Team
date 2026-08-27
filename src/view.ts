/**
 * Gathering one whole account of this server, from the database and the disk.
 *
 * This is the half that owns the database, the certificate authority and the
 * health check. It hands over a finished {@link TeamView} and nothing else, so
 * that whatever answers a question out of one is a thing that reads rather than
 * a second implementation of the rules.
 *
 * Everything gathered here is read from the database or from a file, and
 * nothing here waits on the network. What a project's revision history and its
 * project file say is not in the database at all: it is inside a repository,
 * which is read by a client over the network — see src/projects/cache.ts for
 * why it must be, and src/projects/refresh.ts for how it arrives. Whatever has
 * been read is handed in and used; whatever has not is absent and reported as
 * "unknown", which is the same thing this says about a project written by a
 * newer Studio.
 *
 * What Team cannot work out is left out, not guessed at.
 */
import { stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describeDuration } from "./duration.js";
import { listDecisions } from "./identity/audit.js";
import {
  audienceHosts,
  authUrl,
  dataRemoteUrl,
  hostOf,
  type IdentityConfig,
} from "./identity/config.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import {
  REPOSITORY_LIFETIME_CAUTION,
  REPOSITORY_LIFETIME_KEY,
  PUBLISH_LINEAGE_KEY,
  SERVER_NAME_KEY,
  storedPublishLineage,
  SIGN_IN_LIFETIME_KEY,
  storedServerName,
  storedTokenLifetimes,
  type SettingKey,
} from "./identity/settings.js";
import { findUserById, listUsers } from "./identity/users.js";
import { checkHealth } from "./loreserver/health.js";
import { instanceLayout } from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import { listProjects } from "./projects/registry.js";
import { NOT_READ_YET } from "./teamview.js";
import type {
  TeamView,
  ProjectFileView,
  ProjectView,
  RevisionView,
  SettingView,
  UserView,
} from "./teamview.js";
import { VERSION } from "./version.js";

import type { DatabaseSync } from "node:sqlite";

/** What a view is gathered from. */
export interface ViewContext {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  readonly healthPort: number;
  /** The fingerprint of this Team server's authority, absent until one exists. */
  readonly fingerprint: string | undefined;
  /**
   * What has been read out of the repositories so far.
   *
   * Deliberately only a lookup, and deliberately optional. Gathering a view
   * must not start a read, wait for one, or be able to: a command that prints
   * a view and a screen that refreshes itself are both callers here, and
   * neither should stop on a loreserver that is not answering.
   */
  readonly readings?: ProjectReadingLookup;
}

/** Whatever holds what the repositories last said. */
export interface ProjectReadingLookup {
  get(projectId: string): { history: RevisionView; file: ProjectFileView } | undefined;
}

/**
 * How many files a storage measurement will stat before giving up on it.
 *
 * A size is worth having and not worth waiting for: past this the view says
 * "unknown" rather than holding up the screen while it walks a store with
 * half a million objects in it.
 */
const STORAGE_FILE_LIMIT = 50_000;

/**
 * How many decisions a view carries.
 *
 * Far fewer than the database keeps. Enough to say what this server has been
 * asked lately, which is the question a view is gathered to answer — not the
 * whole bound, which is a different question with an answer of its own.
 */
const AUDIT_LIMIT = 100;

/**
 * The labels of the three rows Team has somewhere to write.
 *
 * Named here rather than typed twice, because the settings surface finds a row
 * by its position and the writer finds it by its label; two spellings of the
 * same string would put a new value in the wrong place.
 */
export const SERVER_NAME_SETTING = "name";
export const PUBLISH_LINEAGE_SETTING = "repeat publishes";
export const SIGN_IN_SETTING = "sign-in token";
export const REPOSITORY_SETTING = "repository token";

/**
 * The setting one of those labels stands for, or undefined for a row nothing
 * is stored for.
 *
 * The row a person edits is found by its position on the screen and written by
 * its key in the table, and this is the one place the two are put together. A
 * writer that worked it out for itself would be a second answer to "which
 * setting is this row", and the two would disagree the first time a row was
 * added above another.
 */
export function settingKeyOf(label: string): SettingKey | undefined {
  switch (label) {
    case SERVER_NAME_SETTING:
      return SERVER_NAME_KEY;
    case PUBLISH_LINEAGE_SETTING:
      return PUBLISH_LINEAGE_KEY;
    case SIGN_IN_SETTING:
      return SIGN_IN_LIFETIME_KEY;
    case REPOSITORY_SETTING:
      return REPOSITORY_LIFETIME_KEY;
    default:
      return undefined;
  }
}

/** The word for a value Team has but cannot show. */
const UNKNOWN_FINGERPRINT = "unknown";

/**
 * Add up what a directory holds.
 *
 * Returns nothing rather than a number it is not sure of: a partial total
 * looks exactly like a real one, and a store that shrank by half would be read
 * as a store that lost half its objects.
 */
export async function directoryBytes(path: string): Promise<number | undefined> {
  try {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length > STORAGE_FILE_LIMIT) {
      return undefined;
    }
    let total = 0;
    for (const file of files) {
      const stats = await stat(join(file.parentPath, file.name));
      total += stats.size;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** The name loreserver's executable has here, which decides none of the paths read below. */
function binaryName(): string {
  try {
    return resolveArtifact().binaryName;
  } catch {
    // A machine with no pinned build still has a storage root, and the name of
    // an executable it will never run is not what this is reading.
    return "loreserver";
  }
}

/** Where loreserver keeps what it holds, under one storage root. */
export function storageRootOf(root: string): string {
  return dirname(instanceLayout(root, binaryName()).immutableStoreDir);
}

function userView(database: DatabaseSync, user: ReturnType<typeof listUsers>[number]): UserView {
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    role: user.groups.length === 0 ? "none" : user.groups.join(","),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
    // When somebody was last seen is still not written down anywhere, so it
    // stays absent and the interface draws it as unknown. When their tokens
    // were last refused is: it is absent only for an account whose tokens have
    // never been refused, or one whose last refusal was before Team kept the
    // moment.
    ...(user.tokensInvalidatedAt === undefined
      ? {}
      : { tokensInvalidatedAt: user.tokensInvalidatedAt }),
  };
}

function projectView(
  context: ViewContext,
  project: ReturnType<typeof listProjects>[number],
): ProjectView {
  const { database } = context;
  const nameOf = (id: string): string => findUserById(database, id)?.username ?? "unknown";
  const read = context.readings?.get(project.id) ?? NOT_READ_YET;
  return {
    name: project.name,
    description: project.description,
    owner: nameOf(project.createdBy),
    createdAt: project.createdAt,
    history: read.history,
    file: read.file,
  };
}

/**
 * The settings surface, and the one place that decides what may be changed
 * from it.
 *
 * A row is editable only where Team has somewhere to put the new value. The
 * identity settings and the ports are named on the command line that started
 * `up`, so they are shown and marked read-only: offering to change a value that
 * would be thrown away is worse than refusing, because it looks like it worked.
 */
export function settingRows(context: ViewContext): SettingView[] {
  const lifetimes = storedTokenLifetimes(context.database);
  const storageRoot = storageRootOf(context.root);
  const { config } = context;
  return [
    {
      group: "server",
      label: SERVER_NAME_SETTING,
      // The host until somebody chooses otherwise, which is what the discovery
      // document says too. The row shows what is in effect rather than what is
      // stored, so a server nobody has named reads as the address people
      // already reach it at rather than as a blank.
      value: storedServerName(context.database, hostOf(config.authOrigin)),
      editable: true,
    },
    {
      group: "server",
      label: PUBLISH_LINEAGE_SETTING,
      // What Studio does with a repository this server already holds, published
      // again under a name of somebody's choosing. Shown in the server group
      // rather than with the tokens because it is about how this deployment is
      // used, not about what it lets anybody do.
      value: storedPublishLineage(context.database),
      editable: true,
    },
    {
      group: "tokens",
      label: SIGN_IN_SETTING,
      value: describeDuration(lifetimes.signInTokenLifetimeSeconds),
      seconds: lifetimes.signInTokenLifetimeSeconds,
      editable: true,
    },
    {
      group: "tokens",
      label: REPOSITORY_SETTING,
      value: describeDuration(lifetimes.repositoryTokenLifetimeSeconds),
      seconds: lifetimes.repositoryTokenLifetimeSeconds,
      editable: true,
      caution: REPOSITORY_LIFETIME_CAUTION,
    },
    { group: "identity", label: "issuer", value: config.issuer, editable: false },
    { group: "identity", label: "audience", value: config.audience, editable: false },
    {
      group: "identity",
      label: "hostnames",
      value: audienceHosts(config).join(", "),
      editable: false,
    },
    { group: "loreserver", label: "pinned version", value: LORESERVER_VERSION, editable: false },
    {
      group: "loreserver",
      label: "data port",
      value: String(config.dataPort),
      editable: false,
    },
    { group: "loreserver", label: "storage root", value: storageRoot, editable: false },
    {
      group: "authority",
      label: "fingerprint",
      value: context.fingerprint ?? UNKNOWN_FINGERPRINT,
      editable: false,
    },
  ];
}

/** Read everything the interface draws, and answer with it. */
export async function gatherTeamView(context: ViewContext): Promise<TeamView> {
  const { database, config } = context;
  const identity = identityLayout(context.root);
  const storageRoot = storageRootOf(context.root);

  const healthy = await checkHealth(context.healthPort);
  const now = Date.now();
  const storageBytes = await directoryBytes(storageRoot);

  let signingKeys = 0;
  try {
    signingKeys = (await KeyStore.open(identity.keysDir)).published.length;
  } catch {
    // A Team server that has not run `up` yet has no keys directory. Nought is the
    // truth about it, not a failure to read one.
  }

  return {
    teamVersion: VERSION,
    root: identity.root,
    now,
    server: {
      version: LORESERVER_VERSION,
      // From outside the process that supervises it, a loreserver that does
      // not answer its health check cannot be told from one that is not
      // running, and the pid, the start and the restarts belong to that
      // process. What is here is what a second program can see.
      running: healthy,
      restarts: 0,
      healthy,
      healthCheckedAt: now,
      ...(storageBytes === undefined ? {} : { storageBytes }),
      storageRoot,
    },
    reach: {
      signIn: authUrl(config),
      data: dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort),
      fingerprint: context.fingerprint ?? UNKNOWN_FINGERPRINT,
      loopback: [
        { port: context.healthPort, what: "health" },
        { port: config.teamPort, what: "jwks" },
        { port: config.authPort, what: "authz" },
      ],
    },
    users: listUsers(database).map((user) => userView(database, user)),
    projects: listProjects(database).map((project) => projectView(context, project)),
    // The decisions themselves, as src/identity/audit.ts kept them. Empty here
    // now means a Team server that has genuinely not been asked anything — a Team server with
    // no `up` running, or one nobody has reached yet — rather than a Team server that
    // makes decisions and keeps none.
    audit: listDecisions(database, AUDIT_LIMIT),
    settings: settingRows(context),
    signingKeys,
  };
}
