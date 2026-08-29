/**
 * Where everything belonging to one loreserver instance lives, and the
 * configuration file Team writes for it.
 *
 * An operator supplies one path — the storage root — and every other location
 * is derived from it, so that a Team server instance can be moved, backed up or
 * deleted by acting on a single directory.
 *
 * The executable is the one thing that is not under it. A downloaded release is
 * about a version rather than about this Team server, and ./cache.ts sets out what
 * having a copy per storage root cost.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cachedInstallDir, storedInstallDir } from "./cache.js";
import { LORESERVER_VERSION, LICENSE_FILE_NAME, NOTICES_FILE_NAME } from "./pin.js";

/** The name of the program whose releases these paths are for. */
const PROGRAM = "loreserver";

/** One place a release can be unpacked, and the three files it leaves there. */
export interface InstallLocation {
  readonly binDir: string;
  readonly binaryPath: string;
  readonly licensePath: string;
  readonly noticesPath: string;
}

/** The three paths a release leaves inside `binDir`. */
function installLocation(binDir: string, binaryName: string): InstallLocation {
  return {
    binDir,
    binaryPath: join(binDir, binaryName),
    licensePath: join(binDir, LICENSE_FILE_NAME),
    noticesPath: join(binDir, NOTICES_FILE_NAME),
  };
}

/** Port numbers loreserver listens on. */
export interface LoreserverPorts {
  /**
   * The gRPC and QUIC port. loreserver takes two settings, but one number
   * serves both: gRPC listens on TCP and QUIC on UDP, so they do not collide.
   */
  readonly dataPort: number;
  /** The HTTP port carrying the health check endpoint. */
  readonly healthPort: number;
}

/** The ports used when an operator names none. */
export const DEFAULT_PORTS: LoreserverPorts = {
  dataPort: 41337,
  healthPort: 41339,
};

/** Absolute paths belonging to one storage root. */
export interface InstanceLayout extends InstallLocation {
  /** The storage root itself, absolute. */
  readonly root: string;
  /**
   * The same three paths under the storage root, where a Team server from before the
   * binaries moved into the per-user cache put them.
   *
   * Derived for every layout whether or not anything is there, because it is
   * the first place an install looks: a Team server that has already run must not
   * download a second copy of a binary it has, and must not be made to move one
   * it may be running.
   */
  readonly stored: InstallLocation;
  /** Directory loreserver is pointed at with `--config`. */
  readonly configDir: string;
  /** The file Team generates inside `configDir`. */
  readonly configPath: string;
  readonly immutableStoreDir: string;
  readonly mutableStoreDir: string;
  readonly logDir: string;
  /** File collecting loreserver's stdout and stderr. */
  readonly logPath: string;
}

/**
 * Derive every path from a storage root.
 *
 * The root is resolved against the working directory, so a relative path on a
 * command line becomes absolute here rather than being resolved again, and
 * differently, by a child process with a different working directory.
 */
export function instanceLayout(
  root: string,
  binaryName: string,
  version: string = LORESERVER_VERSION,
): InstanceLayout {
  const absoluteRoot = resolve(root);
  const instanceDir = join(absoluteRoot, "loreserver");
  const configDir = join(instanceDir, "config");
  const logDir = join(absoluteRoot, "logs");

  return {
    root: absoluteRoot,
    // Read as the layout is built rather than held from the start of the
    // process, so that a container setting NLTEAM_CACHE_DIR is obeyed by
    // whatever is running now, not by whatever loaded this module first.
    ...installLocation(cachedInstallDir(PROGRAM, version), binaryName),
    stored: installLocation(storedInstallDir(absoluteRoot, PROGRAM, version), binaryName),
    configDir,
    configPath: join(configDir, "local.toml"),
    immutableStoreDir: join(instanceDir, "store", "immutable"),
    mutableStoreDir: join(instanceDir, "store", "mutable"),
    logDir,
    logPath: join(logDir, "loreserver.log"),
  };
}

/**
 * What loreserver has to be told before it will demand a token from a client.
 *
 * Every value here has a counterpart in the tokens Team mints; src/identity's
 * configuration is where both come from, so that the two copies cannot drift.
 */
export interface LoreserverAuth {
  /** Compared with a token's `iss`, exactly. */
  readonly issuer: string;
  /**
   * The audiences loreserver accepts. A token is accepted when its `aud` array
   * holds one of these.
   */
  readonly audience: readonly string[];
  /** Where loreserver fetches Team's public keys. */
  readonly jwksUrl: string;
  /**
   * Where loreserver asks Team who a caller is. Rendered as `auth_url`.
   *
   * Not the address a client is told to sign in at, though the two were one
   * value once. loreserver connects here over gRPC, forwarding the caller's own
   * `authorization` header, before it lets anybody near a repository, and it
   * verifies the certificate, refusing an unknown authority with `tlsv1 alert
   * unknown ca`. Because it runs on the same machine as Team — always — this
   * is the loopback, and `callbackUrl` in src/identity/config.ts says what
   * happened on the deployment where it was not.
   */
  readonly callbackUrl: string;
}

/**
 * Render a path for a TOML basic string.
 *
 * Backslash begins an escape sequence inside TOML's double-quoted strings, so
 * a Windows path written verbatim is either a parse error or a different path.
 * Forward slashes avoid the question: loreserver is a Rust program, and the
 * Windows file APIs behind Rust's `Path` accept either separator.
 */
function tomlPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Render an arbitrary value as a TOML basic string.
 *
 * Unlike a path, an issuer or an audience is a value an operator typed, so the
 * two characters TOML gives meaning to inside quotes are escaped rather than
 * substituted.
 */
function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The `[server.auth]` and `[environment.endpoint]` blocks.
 *
 * Both are needed, and the second is the one that is easy to leave out.
 * `[server.auth]` alone makes the server demand a token while it has nowhere to
 * ask about one, and every repository access is then refused with "Failed to
 * connect to lore auth service" — which looks like a broken client rather than
 * a missing setting.
 *
 * `jwt_audience` is an array. A bare string there makes loreserver refuse to
 * start.
 */
function renderAuth(auth: LoreserverAuth): string[] {
  return [
    "",
    "[server.auth]",
    `jwt_issuer = ${tomlString(auth.issuer)}`,
    `jwt_audience = [${auth.audience.map(tomlString).join(", ")}]`,
    "[server.auth.jwk]",
    `endpoint = ${tomlString(auth.jwksUrl)}`,
    "",
    "[environment.endpoint]",
    `auth_url = ${tomlString(auth.callbackUrl)}`,
  ];
}

/**
 * The contents of `local.toml`.
 *
 * The table and key names come from the settings loreserver actually reads;
 * an unrecognised key is ignored silently rather than reported, so a mistake
 * here surfaces as a server that listens somewhere unexpected or stores data
 * somewhere unexpected.
 *
 * Without `auth`, the file is the one Team server has always written: a server that
 * asks nobody who they are.
 */
export function renderConfig(
  layout: InstanceLayout,
  ports: LoreserverPorts,
  auth?: LoreserverAuth,
): string {
  return [
    "[immutable_store.local]",
    `path = "${tomlPath(layout.immutableStoreDir)}"`,
    "[mutable_store.local]",
    `path = "${tomlPath(layout.mutableStoreDir)}"`,
    "[server.grpc]",
    `port = ${ports.dataPort}`,
    "[server.quic]",
    `port = ${ports.dataPort}`,
    "[server.http]",
    `port = ${ports.healthPort}`,
    ...(auth === undefined ? [] : renderAuth(auth)),
    "",
  ].join("\n");
}

/**
 * Create the directories loreserver needs and write its configuration.
 *
 * The file is rewritten on every run: it is Team's output, not an operator's,
 * and an edit made to it by hand would otherwise survive a change of ports
 * made on the command line.
 */
export async function writeInstance(
  layout: InstanceLayout,
  ports: LoreserverPorts,
  auth?: LoreserverAuth,
): Promise<void> {
  for (const directory of [
    layout.configDir,
    layout.immutableStoreDir,
    layout.mutableStoreDir,
    layout.logDir,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(layout.configPath, renderConfig(layout, ports, auth), "utf8");
}
