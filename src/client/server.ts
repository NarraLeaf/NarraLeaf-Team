/**
 * The seam every command that speaks to a server goes through.
 *
 * One command goes through it — `project list` — and the rest of the
 * administrative commands are meant to. Wiring one must not mean reshaping this:
 * a command names an address, is handed an open session, and calls a method on
 * it. Nothing about which command it is reaches this file, and nothing about
 * credentials, certificates or framing reaches the command.
 *
 * The two halves of the command line stay apart on purpose. `--root` opens a
 * database on this machine, which is how a server is rescued when the protocol
 * is not answering; `--server` opens a session, which is how one is administered
 * from anywhere else. **Neither silently becomes the other**, so there is no
 * fallback here: an address with no credentials is a sentence saying to log in,
 * not a quiet read of some local directory.
 */
import { configDirectory, readCredentials, type ServerCredential } from "./config.js";
import { TeamSessionClient } from "./session.js";

/** Raised when a command names a server this account has no token for. */
export class NotSignedInError extends Error {
  constructor(address: string) {
    super(
      `this account is not signed in to ${address}. Run: nlteam login ${address} <username>`,
    );
    this.name = "NotSignedInError";
  }
}

/**
 * What this account holds for one server.
 *
 * The environment is a parameter for the same reason it is one in ./config.ts:
 * where credentials live has to be answerable for a directory the test is not
 * running out of.
 */
export async function credentialFor(
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerCredential> {
  const credentials = await readCredentials(configDirectory(env));
  const found = credentials.get(address);
  if (found === undefined) {
    throw new NotSignedInError(address);
  }
  return found;
}

/**
 * Open a session to a server this account is signed in to, do something, close.
 *
 * Closed however the work ended, because a command that left a session open
 * would be a command that does not exit: the socket is the only thing holding
 * the process, and an unclosed one holds it until the server's heartbeat gives
 * up on it half a minute later.
 */
export async function withSession<T>(
  address: string,
  work: (session: TeamSessionClient) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const credential = await credentialFor(address, env);
  const session = await TeamSessionClient.open({
    address: credential.address,
    ca: credential.authority.pem,
    token: credential.token,
  });
  try {
    return await work(session);
  } finally {
    session.close();
  }
}
