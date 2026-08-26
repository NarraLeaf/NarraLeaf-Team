/**
 * The web interface: who gets in, what it will do once they are, and what the
 * listener answers before anybody has signed in at all.
 *
 * The interesting cases here are the refusals. A page that draws a list of
 * projects is a page anybody can look at once they are through the door, so
 * nearly everything worth asserting is about the door: a member is not an
 * operator, a session outlives nothing it should, and a request that arrived
 * from another origin is not a request from this interface however good its
 * cookie is.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { en, ja, zh } from "../src/i18n/index.js";
import { LANGUAGE_HEADER } from "../src/i18n/locales.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { SignInLimiter } from "../src/identity/signin.js";
import { decodeToken, type TokenClaims } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  findUser,
  revokeUserTokens,
  setAdmin,
} from "../src/identity/users.js";
import type { TeamView } from "../src/teamview.js";
import type { ViewContext } from "../src/view.js";
import { readAction, type ApiOptions } from "../src/web/api.js";
import { webHandler } from "../src/web/router.js";
import { readCookie, SessionStore, sessionCookie } from "../src/web/sessions.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-web-");

/** Cheap parameters: these tests are about who gets in, not what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";

const openDatabases: DatabaseSync[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => resolve());
    });
  }
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

async function openStorage(): Promise<{ root: string; database: DatabaseSync }> {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  openDatabases.push(database);
  return { root, database };
}

/** A view with nothing in it. Every test that needs one needs a different part. */
function emptyView(): TeamView {
  return {
    teamVersion: "0.0.0-test",
    root: "/srv/team",
    now: 1_700_000_000_000,
    server: {
      version: "0.8.6",
      running: false,
      restarts: 0,
      healthy: false,
      storageRoot: "/srv/team/store",
    },
    reach: {
      signIn: "https://team.example.lan:41402",
      data: "lore://team.example.lan:41401",
      fingerprint: "AA:BB",
      loopback: [],
    },
    users: [],
    projects: [],
    audit: [],
    settings: [],
    signingKeys: 0,
  };
}

const DISCOVERY = {
  protocol: 1,
  name: "team.example.lan",
  auth: { required: true, url: "https://team.example.lan:41402" },
  data: { url: "lore://team.example.lan:41401" },
  capabilities: ["projects", "project-detail", "members"],
  authority: { sha256: "AA:BB" },
  version: "0.0.0-test",
} as const;

/** A listener with the interface on it, and the address to reach it at. */
async function serve(api: ApiOptions | undefined): Promise<string> {
  const server = createServer(webHandler(() => DISCOVERY, api === undefined ? {} : { api }));
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Everything the interface needs, over a database with one account in it. */
async function withOperator(groups: readonly string[]): Promise<{
  origin: string;
  database: DatabaseSync;
  sessions: SessionStore;
  gathered: number;
  /** Every line the server wrote, for asserting on what is not in them. */
  logged: string[];
}> {
  const { root, database } = await openStorage();
  await createUser(database, hasher, {
    username: "ada",
    password: PASSWORD,
    displayName: "Ada Lovelace",
    groups: [...groups],
  });

  const context: ViewContext = {
    root,
    database,
    config: identityConfig({}),
    healthPort: 0,
    fingerprint: undefined,
  };
  const sessions = new SessionStore();
  const state = { gathered: 0 };
  const logged: string[] = [];
  const origin = await serve({
    context,
    sessions,
    // One per server. A running server shares one between its doors, and two
    // servers in one test run share nothing: an account this suite spent in one
    // of them is not one the next has to start counting from.
    signIns: new SignInLimiter(),
    gather: () => {
      state.gathered += 1;
      return Promise.resolve(emptyView());
    },
    request: () => {},
    subscribe: () => () => {},
    log: (line) => logged.push(line),
  });

  return {
    origin,
    database,
    sessions,
    logged,
    get gathered() {
      return state.gathered;
    },
  };
}

/** Sign in and answer with the cookie to send back, or with what went wrong. */
async function signIn(
  origin: string,
  password = PASSWORD,
  username = "ada",
): Promise<{ status: number; cookie?: string; body: { error?: string } }> {
  const response = await fetch(`${origin}/api/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await response.json()) as { error?: string };
  const header = response.headers.get("set-cookie");
  const cookie = header?.split(";")[0];
  return { status: response.status, ...(cookie === undefined ? {} : { cookie }), body };
}

describe("the listener, before the interface", () => {
  it("serves the discovery document whether or not the interface is on", async () => {
    const off = await serve(undefined);
    const response = await fetch(`${off}/.well-known/nlteam`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocol: 1, name: "team.example.lan" });
  });

  it("says the interface is off rather than that there is no such page", async () => {
    const off = await serve(undefined);
    const response = await fetch(`${off}/`);

    // A 404 would read as a server that has no interface, which is a different
    // thing from one whose operator did not start it.
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("--web");
  });
});

describe("the pages", () => {
  it("serves the page, its script and its styles, and nothing else", async () => {
    const { origin } = await withOperator(["admin"]);

    expect((await fetch(`${origin}/`)).status).toBe(200);
    expect((await fetch(`${origin}/app.js`)).status).toBe(200);
    expect((await fetch(`${origin}/app.css`)).status).toBe(200);
    expect((await fetch(`${origin}/icon.svg`)).status).toBe(200);
    expect((await fetch(`${origin}/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${origin}/index.php`)).status).toBe(404);
  });

  it("names a policy that lets the page load nothing from anywhere else", async () => {
    const { origin } = await withOperator(["admin"]);
    const page = await (await fetch(`${origin}/`)).text();

    // The one guarantee worth asserting about a page served by somebody's own
    // server on their own network: it cannot be made to report anywhere.
    expect(page).toContain("default-src 'none'");
    expect(page).not.toContain("unsafe-inline");
  });

  it("answers a browser that already has the file with a 304", async () => {
    const { origin } = await withOperator(["admin"]);
    const first = await fetch(`${origin}/app.css`);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const again = await fetch(`${origin}/app.css`, { headers: { "if-none-match": etag ?? "" } });
    expect(again.status).toBe(304);
  });
});

describe("signing in", () => {
  it("lets an administrator in", async () => {
    const { origin } = await withOperator(["admin"]);
    const attempt = await signIn(origin);

    expect(attempt.status).toBe(200);
    expect(attempt.cookie).toMatch(/^nlteam_session=/);
  });

  it("refuses a member, and says why once the password was right", async () => {
    const { origin } = await withOperator(["member"]);
    const attempt = await signIn(origin);

    // A different sentence from a wrong password, and it can be: there is
    // nothing left to hide from somebody who has just proved who they are.
    expect(attempt.status).toBe(403);
    expect(attempt.body.error).toContain("admin");
    expect(attempt.cookie).toBeUndefined();
  });

  it("says one thing about a wrong password and about an account that is not there", async () => {
    const { origin } = await withOperator(["admin"]);
    const wrong = await signIn(origin, "not the password");
    const absent = await signIn(origin, PASSWORD, "grace");

    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(wrong.body.error).toBe(absent.body.error);
  });

  it("refuses a sign-in that did not arrive as JSON", async () => {
    const { origin } = await withOperator(["admin"]);
    const response = await fetch(`${origin}/api/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=ada&password=x",
    });

    // What a form on somebody else's page is able to send. Refusing the content
    // type is half of why a cross-site request cannot reach anything here.
    expect(response.status).toBe(400);
  });

  it("refuses a request that says it came from somewhere else", async () => {
    const { origin } = await withOperator(["admin"]);
    const response = await fetch(`${origin}/api/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
      body: JSON.stringify({ username: "ada", password: PASSWORD }),
    });

    expect(response.status).toBe(403);
  });

  it("stops checking the password once enough from one place have been refused", async () => {
    const { origin, logged } = await withOperator(["admin"]);

    let attempt = await signIn(origin, "not the password");
    for (let count = 0; count < 10 && attempt.status === 401; count += 1) {
      attempt = await signIn(origin, "not the password");
    }

    // The same guard on both doors, because they are two ways to the same
    // accounts and the same scrypt: whichever somebody knocks on, the rate at
    // which they may make this server check a password is the one rate.
    expect(attempt.status).toBe(429);
    expect(attempt.body.error).toContain("try again in");
    expect(logged.some((line) => line.includes("held off"))).toBe(true);
    // Every refused sign-in is held before it is answered, so the run of them
    // this needs takes a few seconds on its own.
  }, 60_000);
});

describe("once signed in", () => {
  it("answers with the view, and refuses a browser that is not", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const without = await fetch(`${origin}/api/view`);
    expect(without.status).toBe(401);

    const withCookie = await fetch(`${origin}/api/view`, { headers: { cookie: cookie ?? "" } });
    expect(withCookie.status).toBe(200);
    expect(await withCookie.json()).toMatchObject({ teamVersion: "0.0.0-test" });
  });

  it("carries out an action and answers with what it did and the view after it", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify({ kind: "rotate-key" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string; view: TeamView };
    // The same sentence the command prints, including the part that says what
    // rotating does not do — the keys already published go on verifying.
    expect(body.message).toContain("still verify");
    expect(body.view.teamVersion).toBe("0.0.0-test");
  });

  it("refuses an action from a browser with no session", async () => {
    const { origin } = await withOperator(["admin"]);
    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "rotate-key" }),
    });

    expect(response.status).toBe(401);
  });

  it("says what was wrong with an action rather than raising", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify({ kind: "revoke-tokens", username: "grace" }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("grace");
  });

  it("stops answering once the account has been disabled under it", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    disableUser(database, "ada");

    // Not when the cookie expires: the account is looked up again on every
    // request, which is the whole reason the session stores an id and not a
    // signed token that would go on being true.
    const response = await fetch(`${origin}/api/view`, { headers: { cookie: cookie ?? "" } });
    expect(response.status).toBe(401);
  });

  it("stops answering once the account's tokens have been revoked", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    revokeUserTokens(database, "ada");

    const response = await fetch(`${origin}/api/view`, { headers: { cookie: cookie ?? "" } });
    expect(response.status).toBe(401);
  });

  it("gives the session back when it is signed out", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    await fetch(`${origin}/api/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
    });

    const response = await fetch(`${origin}/api/view`, { headers: { cookie: cookie ?? "" } });
    expect(response.status).toBe(401);
  });
});

describe("SessionStore", () => {
  it("forgets a session once it has expired, without being asked", async () => {
    const { database } = await openStorage();
    const user = await createUser(database, hasher, {
      username: "ada",
      password: PASSWORD,
      displayName: "Ada",
      groups: ["admin"],
    });

    let now = 1_000;
    const sessions = new SessionStore(() => now);
    const { secret, expiresAt } = sessions.open(database, user);

    expect(sessions.identify(database, secret).kind).toBe("identified");

    now = expiresAt;
    const after = sessions.identify(database, secret);
    expect(after.kind).toBe("refused");
    expect(after.kind === "refused" && after.reason).toBe("expired");
    expect(sessions.size).toBe(0);
  });

  it("closes every session one account has, wherever it has one", async () => {
    const { database } = await openStorage();
    const user = await createUser(database, hasher, {
      username: "ada",
      password: PASSWORD,
      displayName: "Ada",
      groups: ["admin"],
    });

    const sessions = new SessionStore();
    const one = sessions.open(database, user);
    const other = sessions.open(database, user);
    expect(sessions.size).toBe(2);

    sessions.closeEvery(user.id);

    expect(sessions.identify(database, one.secret).kind).toBe("refused");
    expect(sessions.identify(database, other.secret).kind).toBe("refused");
  });

  it("does not treat a session it has never seen as one", async () => {
    const { database } = await openStorage();
    const sessions = new SessionStore();

    expect(sessions.identify(database, undefined).kind).toBe("refused");
    expect(sessions.identify(database, "").kind).toBe("refused");
    expect(sessions.identify(database, "made up").kind).toBe("refused");
  });
});

describe("readCookie", () => {
  it("finds the one it was asked for and compares the name whole", () => {
    expect(readCookie("nlteam_session=abc", "nlteam_session")).toBe("abc");
    expect(readCookie("other=1; nlteam_session=abc; more=2", "nlteam_session")).toBe("abc");
    // The trap: a name that ends with the one being looked for is not it.
    expect(readCookie("xnlteam_session=abc", "nlteam_session")).toBeUndefined();
    expect(readCookie(undefined, "nlteam_session")).toBeUndefined();
  });
});

describe("sessionCookie", () => {
  it("keeps the cookie out of scripts, off plaintext and off other sites", () => {
    const line = sessionCookie("secret", 61_000, 1_000);

    expect(line).toContain("HttpOnly");
    expect(line).toContain("Secure");
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Max-Age=60");
  });
});

describe("readAction", () => {
  it("takes the actions the interface sends", () => {
    expect(readAction({ kind: "rotate-key" })).toEqual({ kind: "rotate-key" });
    expect(readAction({ kind: "set-setting", index: 0, value: "7d" })).toEqual({
      kind: "set-setting",
      index: 0,
      value: "7d",
    });
  });

  it("refuses one that is missing what it needs, rather than passing it on", () => {
    // Each of these would otherwise reach the same code the commands use, and
    // fail somewhere that has no way to say what the caller left out.
    expect(typeof readAction({ kind: "grant", project: "p" })).toBe("string");
    expect(typeof readAction({ kind: "grant", project: "p", username: "ada", level: "all" })).toBe(
      "string",
    );
    expect(typeof readAction({ kind: "create-project", name: "" })).toBe("string");
    expect(typeof readAction({ kind: "set-user-disabled", username: "ada" })).toBe("string");
    expect(typeof readAction({ kind: "set-setting", index: 1.5, value: "7d" })).toBe("string");
    expect(typeof readAction({ kind: "quit" })).toBe("string");
    expect(typeof readAction({ kind: "drop everything" })).toBe("string");
    expect(typeof readAction("grant")).toBe("string");
  });
});

describe("the language it answers in", () => {
  it("takes the browser's own preference when the page has named none", async () => {
    const { origin } = await withOperator(["member"]);
    const response = await fetch(`${origin}/api/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN,zh;q=0.9,en;q=0.4" },
      body: JSON.stringify({ username: "ada", password: PASSWORD }),
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error?: string }).error).toBe(
      zh.refusal.notAnOperator({ group: "admin" }),
    );
  });

  it("prefers what the page chose over what the browser is set to", async () => {
    // The case this exists for: a Japanese page on a machine that came set to
    // English. The sentence has to match the screen it appears on.
    const { origin } = await withOperator(["admin"]);
    const cookie = (await signIn(origin)).cookie ?? "";

    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "accept-language": "en-GB,en;q=0.9",
        [LANGUAGE_HEADER]: "ja",
      },
      body: JSON.stringify({ kind: "set-user-disabled", username: "ada", disabled: true }),
    });

    expect(response.status).toBe(200);
    const { message } = (await response.json()) as { message: string };
    // The username is data, and is in it whatever the language; the sentence
    // around it is not English.
    expect(message).toContain("ada");
    expect(message).toContain("無効にしました");
  });

  it("says what went wrong in the language it was asked in", async () => {
    const { origin } = await withOperator(["admin"]);
    const cookie = (await signIn(origin)).cookie ?? "";

    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, [LANGUAGE_HEADER]: "zh" },
      body: JSON.stringify({ kind: "revoke-tokens", username: "nobody" }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe(
      zh.error.unknownUser({ username: "nobody" }),
    );
  });

  it("answers the pages themselves in it too, before anybody has signed in", async () => {
    const off = await serve(undefined);
    expect(await (await fetch(`${off}/`, { headers: { "accept-language": "ja" } })).text()).toContain(
      ja.refusal.interfaceIsOff,
    );

    const { origin } = await withOperator(["admin"]);
    const missing = await fetch(`${origin}/nothing-here`, { headers: { "accept-language": "zh" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain(zh.refusal.nothingAtThatAddress);
  });

  it("does not translate the view, which is what the server holds", async () => {
    // A settings row is found on the way back by the label it went out with, so
    // the label is not a word on a screen — the page draws its own. The same
    // goes for a username, a group and a project's name.
    const { origin } = await withOperator(["admin"]);
    const cookie = (await signIn(origin)).cookie ?? "";

    const response = await fetch(`${origin}/api/view`, {
      headers: { cookie, [LANGUAGE_HEADER]: "zh" },
    });
    const view = (await response.json()) as TeamView;

    expect(view.reach.signIn).toBe("https://team.example.lan:41402");
    expect(JSON.stringify(view)).not.toContain(zh.page.settings.rowNames["sign-in token"]);
  });

  it("falls back to English rather than refusing a language it has not got", async () => {
    const { origin } = await withOperator(["member"]);
    const response = await fetch(`${origin}/api/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "de-DE,de;q=0.9" },
      body: JSON.stringify({ username: "ada", password: PASSWORD }),
    });

    expect(((await response.json()) as { error?: string }).error).toBe(
      en.refusal.notAnOperator({ group: "admin" }),
    );
  });
});

describe("making an account from the operator's page", () => {
  /** Ask for one thing to be done, as the page does. */
  async function act(
    origin: string,
    cookie: string | undefined,
    action: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify(action),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const NEW_ACCOUNT = {
    kind: "create-account",
    username: "bob",
    password: "a password nobody guesses either",
    displayName: "Bob",
    email: "bob@example.lan",
    operator: false,
  };

  it("makes one the way nlteam user create makes one", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const answer = await act(origin, cookie, NEW_ACCOUNT);

    expect(answer.status).toBe(200);
    expect(answer.body["message"]).toContain("bob");
    const bob = findUser(database, "bob");
    expect(bob?.displayName).toBe("Bob");
    expect(bob?.email).toBe("bob@example.lan");
    // The default group, which is the one the command's --role defaults to.
    expect(bob?.groups).toEqual(["member"]);
  });

  it("puts one in the admin group when that is what was asked for", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    await act(origin, cookie, { ...NEW_ACCOUNT, username: "grace", operator: true });

    expect(findUser(database, "grace")?.groups).toEqual(["admin"]);
  });

  it("refuses a name that is already an account here, and says which", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const answer = await act(origin, cookie, { ...NEW_ACCOUNT, username: "ada" });

    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toContain("ada");
  });

  it("refuses a browser that is not an operator's", async () => {
    // Creating an account is a management action, and management is the whole
    // of what the admin group decides. There is no session to try it with: a
    // member cannot sign in to this interface at all.
    const { origin, database, sessions } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    expect((await act(origin, undefined, NEW_ACCOUNT)).status).toBe(401);

    // And the door is the account as it stands now, not as it stood at sign-in.
    setAdmin(database, "ada", false);
    expect((await act(origin, cookie, NEW_ACCOUNT)).status).toBe(401);
    expect(sessions.size).toBeGreaterThan(0);
    expect(findUser(database, "bob")).toBeUndefined();
  });

  it("says what an account needs when it was asked for one with no password", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const answer = await act(origin, cookie, { kind: "create-account", username: "bob" });

    expect(answer.status).toBe(400);
    expect(findUser(database, "bob")).toBeUndefined();
  });

  it("writes no password into the log, whatever happened", async () => {
    const { origin, logged } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    await act(origin, cookie, NEW_ACCOUNT);
    await act(origin, cookie, NEW_ACCOUNT);

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(NEW_ACCOUNT.password);
    }
  });
});

describe("handing a token to somebody", () => {
  async function issue(
    origin: string,
    cookie: string | undefined,
    username: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify({ kind: "issue-token", username }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("answers with the token beside the sentence, not inside it", async () => {
    const { origin } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const answer = await issue(origin, cookie, "ada");

    expect(answer.status).toBe(200);
    const secret = answer.body["secret"];
    expect(typeof secret).toBe("string");
    // A token this server signed, for the account that was named.
    const claims = decodeToken(secret as string).claims as TokenClaims;
    expect(claims.preferred_username).toBe("ada");
    expect(claims.iss).toBe(identityConfig({}).issuer);
    // The sentence is what everything else shows, and it is not the token.
    expect(answer.body["message"]).not.toContain(secret);
    expect(JSON.stringify(answer.body["view"])).not.toContain(secret);
  });

  it("writes no token into the log", async () => {
    // The log is read beside everything else `up` prints and is kept as long as
    // the file is. A token in it would outlive the person who was handed one.
    const { origin, logged } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);

    const answer = await issue(origin, cookie, "ada");
    const secret = answer.body["secret"] as string;

    expect(logged.some((line) => line.includes("issue-token"))).toBe(true);
    for (const line of logged) {
      expect(line).not.toContain(secret);
    }
  });

  it("refuses one for an account that has been disabled", async () => {
    const { origin, database } = await withOperator(["admin"]);
    const { cookie } = await signIn(origin);
    await createUser(database, hasher, { username: "bob", password: PASSWORD });
    disableUser(database, "bob");

    const answer = await issue(origin, cookie, "bob");

    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toContain("bob");
    expect(answer.body).not.toHaveProperty("secret");
  });

  it("refuses a browser that is not an operator's", async () => {
    const { origin } = await withOperator(["admin"]);

    expect((await issue(origin, undefined, "ada")).status).toBe(401);
  });
});
