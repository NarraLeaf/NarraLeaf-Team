/**
 * Where this program keeps what it knows about the servers it has signed in to.
 *
 * Everything else in this repository writes under a **storage root** — the
 * directory a Team server keeps its database, its keys and its certificates in.
 * Nothing here does. A person running `nlteam --server` is a client of somebody
 * else's server, quite possibly on another continent, and the token they hold is
 * theirs rather than that deployment's. So it lives beside their own account's
 * configuration, in the place their operating system keeps such things:
 *
 *     Windows   %APPDATA%\nlteam
 *     macOS     ~/Library/Application Support/nlteam
 *     elsewhere $XDG_CONFIG_HOME/nlteam, or ~/.config/nlteam
 *
 * `NLTEAM_CONFIG_DIR` overrides all three. It is the one variable in this
 * program with no flag beside it, because it does not stand in for something a
 * single run decides — it names where this program's own state is, which has to
 * be settled before a command line means anything. A container that mounts a
 * credential in and a test that must not touch the account running it both need
 * exactly that.
 *
 * **A token is a credential and is held to the same standard as the private keys
 * under a storage root**: the file is 0600 and the directory 0700 on POSIX.
 * Windows has no such bits, which is a fact about that platform rather than a
 * reason to skip this elsewhere.
 */
import { isIP } from "node:net";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_IDENTITY } from "../identity/config.js";

/** The variable that names the configuration directory outright. */
export const CONFIG_DIR_VARIABLE = "NLTEAM_CONFIG_DIR";

/** What the directory is called under whichever parent the platform chooses. */
const DIRECTORY_NAME = "nlteam";

/** The one file in it, holding every server this account has signed in to. */
const CREDENTIALS_FILE = "credentials.json";

/**
 * What is written at the top of the file.
 *
 * A number rather than nothing, so that a file written by a later `nlteam` can
 * be recognised as one rather than read as a broken copy of this shape. Nothing
 * reads it yet beyond refusing what it does not know.
 */
const STORE_VERSION = 1;

/**
 * Where credentials are kept, for this account on this machine.
 *
 * The environment and the platform are parameters rather than read from the
 * globals, so that the choice can be asked about for a platform the test is not
 * running on — which is the only way the Windows answer is ever checked on a
 * Linux builder, and the other way round.
 */
export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const named = env[CONFIG_DIR_VARIABLE];
  // Empty is absent rather than a directory called the empty string, the same
  // reading src/args.ts gives every other variable.
  if (named !== undefined && named !== "") {
    return named;
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    return appData !== undefined && appData !== ""
      ? join(appData, DIRECTORY_NAME)
      : join(home, "AppData", "Roaming", DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", DIRECTORY_NAME);
  }
  const xdg = env["XDG_CONFIG_HOME"];
  return xdg !== undefined && xdg !== ""
    ? join(xdg, DIRECTORY_NAME)
    : join(home, ".config", DIRECTORY_NAME);
}

/** The file itself, under a directory {@link configDirectory} chose. */
export function credentialsPath(directory: string): string {
  return join(directory, CREDENTIALS_FILE);
}

/**
 * One server this account has signed in to.
 *
 * The authority is here rather than in a file of its own for one reason: what
 * makes the token usable and what makes the connection verifiable are the same
 * decision, taken at the same moment, and splitting them across two files is how
 * a token comes to outlive the authority it was obtained under.
 */
export interface ServerCredential {
  /** The address as {@link parseServerAddress} writes it, which is also its key. */
  readonly address: string;
  /** What the sign-in answered with. Opaque here: nothing in this program reads one. */
  readonly token: string;
  /** Which account signed in, for a line saying whose token this is. */
  readonly account: string;
  readonly authority: {
    /** SHA-256 over the authority's DER, colon-separated upper-case hex. */
    readonly sha256: string;
    /** The authority itself, which every connection after this is verified against. */
    readonly pem: string;
  };
  readonly signedInAt: number;
}

/** Raised when the file is there and is not something this can read. */
export class UnreadableCredentialsError extends Error {
  constructor(path: string, why: string) {
    super(
      `${path} is not something this version of nlteam can read: ${why}. ` +
        "Move it aside and sign in again.",
    );
    this.name = "UnreadableCredentialsError";
  }
}

/** What the file holds, as it is on disk. */
interface CredentialStore {
  version: number;
  servers: Record<string, ServerCredential>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one entry out of what was parsed, or nothing.
 *
 * A row that is not the shape this writes is dropped rather than refused. The
 * file holds several servers, and one entry a later version wrote differently
 * must not take the others with it — the cost of dropping one is a sign-in, and
 * the cost of refusing the file is every sign-in.
 */
function readCredential(address: string, value: unknown): ServerCredential | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const authority = value["authority"];
  if (!isRecord(authority)) {
    return undefined;
  }
  const token = value["token"];
  const account = value["account"];
  const sha256 = authority["sha256"];
  const pem = authority["pem"];
  const signedInAt = value["signedInAt"];
  if (
    typeof token !== "string" ||
    typeof account !== "string" ||
    typeof sha256 !== "string" ||
    typeof pem !== "string"
  ) {
    return undefined;
  }
  return {
    address,
    token,
    account,
    authority: { sha256, pem },
    signedInAt: typeof signedInAt === "number" ? signedInAt : 0,
  };
}

/**
 * Every server signed in to, keyed by address.
 *
 * A directory that is not there is an account that has never signed in, which is
 * an empty map rather than an error: `nlteam --server` on a fresh machine has to
 * be able to say "log in first" rather than "no such file".
 */
export async function readCredentials(
  directory: string,
): Promise<Map<string, ServerCredential>> {
  const path = credentialsPath(directory);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreadableCredentialsError(path, "it is not JSON");
  }
  if (!isRecord(parsed)) {
    throw new UnreadableCredentialsError(path, "it is not a JSON object");
  }
  const version = parsed["version"];
  if (typeof version === "number" && version > STORE_VERSION) {
    throw new UnreadableCredentialsError(
      path,
      `it was written by a later nlteam (version ${version})`,
    );
  }
  const servers = parsed["servers"];
  const found = new Map<string, ServerCredential>();
  if (!isRecord(servers)) {
    return found;
  }
  for (const [address, value] of Object.entries(servers)) {
    const credential = readCredential(address, value);
    if (credential !== undefined) {
      found.set(address, credential);
    }
  }
  return found;
}

/**
 * Write the whole file, replacing whatever was there.
 *
 * Through a temporary file and a rename, so that a run interrupted halfway
 * leaves the previous file rather than a truncated one. There are several
 * servers in here and only one of them is being changed; losing the rest to a
 * crash would be a cost nobody could see coming.
 */
async function writeCredentials(
  directory: string,
  servers: ReadonlyMap<string, ServerCredential>,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store: CredentialStore = { version: STORE_VERSION, servers: {} };
  for (const [address, credential] of servers) {
    store.servers[address] = credential;
  }

  const path = credentialsPath(directory);
  const pending = `${path}.writing`;
  // The mode goes to `writeFile` for a file it creates and is set again
  // afterwards, because a file something else made first keeps its own mode —
  // the same care src/tls/authority.ts takes over a private key, and for the
  // same reason: what is in here is a credential.
  await writeFile(pending, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(pending, 0o600);
  await rename(pending, path);
  await chmod(path, 0o600);
}

/** Record a sign-in, leaving every other server alone. */
export async function rememberServer(
  directory: string,
  credential: ServerCredential,
): Promise<void> {
  const servers = await readCredentials(directory);
  servers.set(credential.address, credential);
  await writeCredentials(directory, servers);
}

/**
 * Forget one server, and say whether there was one to forget.
 *
 * False rather than an error for an address nobody is signed in to: logging out
 * twice is not a mistake worth an exit code, and the sentence a caller prints
 * says which it was.
 */
export async function forgetServer(directory: string, address: string): Promise<boolean> {
  const servers = await readCredentials(directory);
  if (!servers.delete(address)) {
    return false;
  }
  await writeCredentials(directory, servers);
  return true;
}

/* --------------------------------------------------------------- addresses */

/** The highest port number a server can be reached on. */
const MAXIMUM_PORT = 65_535;

/**
 * The scheme the one address an author is given is written with.
 *
 * Accepted and dropped rather than required. `nlteam://team.example.lan:41402`
 * is what an operator pastes into a chat window, and refusing the string they
 * already have in order to demand the same string with four characters removed
 * would be pedantry with a cost.
 */
const SCHEME = "nlteam://";

/**
 * Read `host:port` the way it is written, and hand back the one spelling of it.
 *
 * The result is what a credential is filed under, so two spellings of one server
 * must not produce two entries: the host is lower-cased, the port is always
 * present, and an IPv6 address is always bracketed. Raises with a sentence
 * saying what was wrong.
 */
export function parseServerAddress(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return fail("a server address is a host and a port, for example team.example.lan:41402");
  }
  const withoutScheme = trimmed.toLowerCase().startsWith(SCHEME)
    ? trimmed.slice(SCHEME.length)
    : trimmed;
  if (withoutScheme.includes("://")) {
    return fail(
      `a server address has no scheme on it, so ${JSON.stringify(trimmed)} is not one. ` +
        "Write it as host:port, or as nlteam://host:port.",
    );
  }
  if (withoutScheme.includes("/")) {
    return fail(
      `a server address is a host and a port with nothing after it, not ${JSON.stringify(trimmed)}`,
    );
  }

  const split = splitHostPort(withoutScheme);
  if (split === undefined) {
    return fail(`${JSON.stringify(trimmed)} is not a host and a port`);
  }
  const { host, port } = split;
  if (host === "") {
    return fail(`${JSON.stringify(trimmed)} names a port and no host`);
  }
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > MAXIMUM_PORT)) {
    return fail(`${JSON.stringify(port)} is not a port number between 1 and ${MAXIMUM_PORT}`);
  }
  // The port an operator did not write is the one a Team server listens on
  // unless it was moved, which is the same default `--auth-tls-port` carries.
  const chosen = port ?? String(DEFAULT_IDENTITY.authTlsPort);
  // An IPv6 address is bracketed here whether or not it was written that way, so
  // that the stored address is the one a URL takes.
  return isIP(host) === 6 ? `[${host}]:${chosen}` : `${host}:${chosen}`;
}

function fail(message: string): never {
  throw new Error(message);
}

/** The two halves of an address, port included only where one was written. */
function splitHostPort(text: string): { host: string; port: string | undefined } | undefined {
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end === -1) {
      return undefined;
    }
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (isIP(host) !== 6) {
      return undefined;
    }
    if (rest === "") {
      return { host, port: undefined };
    }
    return rest.startsWith(":") ? { host, port: rest.slice(1) } : undefined;
  }
  // A bare IPv6 address is full of colons and none of them separates a port, so
  // it is recognised before the last colon is treated as a separator.
  if (isIP(text) === 6) {
    return { host: text, port: undefined };
  }
  const separator = text.lastIndexOf(":");
  if (separator === -1) {
    return { host: text.toLowerCase(), port: undefined };
  }
  return { host: text.slice(0, separator).toLowerCase(), port: text.slice(separator + 1) };
}

/** The host and the port of an address {@link parseServerAddress} produced. */
export function hostAndPortOf(address: string): { host: string; port: number } {
  const split = splitHostPort(address);
  const host = split?.host ?? address;
  return { host, port: Number(split?.port ?? DEFAULT_IDENTITY.authTlsPort) };
}
