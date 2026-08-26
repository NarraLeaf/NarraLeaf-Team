// The `token mint` command: what it signs, and where the audience of what it
// signs comes from.
//
// The audience is the whole reason this test exists. A token whose audience
// names an address nothing answers on signs in and then fails every repository
// operation, and the address it should name is a fact about the running
// deployment — its host names and its data port — not about the bare command
// line that happened to mint the token. So a token minted after the server was
// brought up on a host has to carry that host, even when the mint command names
// nothing.
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { persistIdentity } from "../src/identity/settings.js";
import { decodeToken, type TokenClaims } from "../src/identity/tokens.js";
import { createUser } from "../src/identity/users.js";
import { tokenMint } from "../src/token.js";
import { useTemporaryRoots } from "./temporary.js";

const PASSWORD = "a password nobody guesses";

/** Cheap parameters: this test is about the audience, not what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const temporaryRoot = useTemporaryRoots("nlteam-token-");

// Replaced rather than written to, because readPassword reads process.stdin
// itself: a command that took a stream as an argument would be a command
// nobody runs the way it is tested.
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(() => {
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
});

function pipeIn(text: string): void {
  const stream = Readable.from([Buffer.from(text, "utf8")]) as unknown as NodeJS.ReadStream;
  stream.isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

/** Bring an account and, optionally, a stored deployment identity into being. */
async function serverAt(
  root: string,
  identity?: Parameters<typeof identityConfig>[0],
): Promise<void> {
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  try {
    await createUser(database, hasher, { username: "ada", password: PASSWORD });
    if (identity !== undefined) {
      // What `up` writes from its resolved configuration when it is brought up.
      persistIdentity(database, identityConfig(identity));
    }
  } finally {
    database.close();
  }
}

/** Run `token mint` with a password piped in, and collect its two streams. */
async function mint(
  root: string,
  overrides: Parameters<typeof tokenMint>[0]["overrides"] = {},
  password: string = PASSWORD,
): Promise<{ code: number; token: string; err: string }> {
  pipeIn(password);
  let out = "";
  let err = "";
  const code = await tokenMint(
    { root, username: "ada", overrides },
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, token: out.trim(), err };
}

/** The audience array of a token this command printed. */
function audienceOf(token: string): readonly string[] {
  return (decodeToken(token).claims as TokenClaims).aud;
}

describe("nlteam token mint", () => {
  it("names the audience the server was brought up as, with no flag on the mint", async () => {
    const root = await temporaryRoot();
    // The trap this exists for: `up --hostname team.example.com --data-port
    // 41500`, then a bare `token mint`. Without the stored identity the token
    // would name lore://127.0.0.1:41337 — an address nothing answers on — and
    // nothing would say so.
    await serverAt(root, { hostnames: ["team.example.com"], dataPort: 41500 });

    const { code, err, token } = await mint(root);

    expect(err).toContain("claims");
    expect(code).toBe(0);
    expect(audienceOf(token)).toContain("lore://team.example.com:41500");
    // And it does not fall back to the loopback the defaults would have named.
    expect(audienceOf(token)).not.toContain("lore://127.0.0.1:41337");
  });

  it("lets a flag on the mint override the stored deployment identity", async () => {
    const root = await temporaryRoot();
    await serverAt(root, { hostnames: ["team.example.com"], dataPort: 41500 });

    const { code, token } = await mint(root, { dataPort: 42000 });

    expect(code).toBe(0);
    // The host is still the stored one; only the port the flag named has moved.
    expect(audienceOf(token)).toContain("lore://team.example.com:42000");
    expect(audienceOf(token)).not.toContain("lore://team.example.com:41500");
  });

  it("names the loopback on a server that has never been brought up", async () => {
    const root = await temporaryRoot();
    await serverAt(root);

    const { code, token } = await mint(root);

    expect(code).toBe(0);
    // Nothing stored, so the defaults answer, which for one machine is right.
    expect(audienceOf(token)).toContain("lore://127.0.0.1:41337");
  });
});
