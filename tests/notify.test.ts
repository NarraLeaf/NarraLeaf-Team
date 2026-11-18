/**
 * Where notifications go: switches, browser pushes, mail, digests, watches and reactions.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { composeDigest, digestDue, digestJob, sendDigest } from "../src/collab/digest.js";
import { listNotifications, notify, setNotificationAnnouncer } from "../src/collab/notifications.js";
import { categoryOf, readPrefs, writePrefs } from "../src/collab/prefs.js";
import {
  base64url,
  encryptPayload,
  fromBase64url,
  pushNotification,
  setPushTransport,
  subscribe,
  subscriptionCount,
  vapidAuthorization,
  vapidKeys,
} from "../src/collab/push.js";
import { reactionsOn, targetInProject, toggleReaction } from "../src/collab/reactions.js";
import { composeMessage, sendMail, setSmtpConnect, SmtpError } from "../src/collab/smtp.js";
import { listWatches, notifyWatchers, setWatch, touchScenes, WatchRefusal } from "../src/collab/watches.js";
import { setWebhookFetch } from "../src/collab/webhooks.js";
import { sendChat } from "../src/collab/chat.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { setPolicy, SMTP_FROM, SMTP_HOST, SMTP_PORT, WEBHOOKS_ALLOW_PRIVATE } from "../src/identity/policy.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { removeProjectMember, setProjectMember } from "../src/projects/members.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { notifyMethods } from "../src/team/methods/notify.js";
import type { MethodContext } from "../src/team/methods.js";
import { TEAM_METHODS } from "../src/team/protocol.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-notify-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const databases: DatabaseSync[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const db of databases.splice(0)) db.close();
  setPushTransport({});
  setSmtpConnect(undefined);
  setWebhookFetch(undefined);
  setNotificationAnnouncer(undefined);
});

async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  for (const [username, extra] of [
    ["ada", { email: "ada@example.com", displayName: "Ada" }],
    ["bob", { email: "bob@example.com", displayName: "Bob" }],
    ["vee", { displayName: "Vee" }],
    ["nora", { displayName: "Nora" }],
  ] as const) {
    await createUser(database, hasher, { username, password: "a password nobody guesses", ...extra });
  }
  const user = (name: string) => requireUser(database, name);
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("bob").id, role: "editor", addedBy: user("ada").id });
  setProjectMember(database, { projectId: project.id, userId: user("vee").id, role: "viewer", addedBy: user("ada").id });
  removeProjectMember(database, project.id, user("nora").id);
  return { database, user, project };
}

/** What a browser holds: a P-256 key pair and a sixteen-byte secret. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, p256dh: base64url(ecdh.getPublicKey()), auth: base64url(auth), authBytes: auth };
}

/** Decrypt as a browser does (RFC 8291), to check what was sent. */
function decrypt(body: Buffer, receiver: ReturnType<typeof browser>): Buffer {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const keyLength = body[20]!;
  const serverPublic = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);
  const shared = receiver.ecdh.computeSecret(serverPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, receiver.authBytes, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, plain.length - 1);
}

describe("web push", () => {
  it("encrypts a payload only the subscribed browser can read", () => {
    const receiver = browser();
    const body = encryptPayload(Buffer.from("hello, browser"), receiver.p256dh, receiver.auth);
    expect(decrypt(body, receiver).toString()).toBe("hello, browser");
    // A fresh key and salt each time.
    expect(encryptPayload(Buffer.from("hello, browser"), receiver.p256dh, receiver.auth).equals(body)).toBe(false);
  });

  it("signs a VAPID token the push service can check against the server's public key", async () => {
    const { database } = await team();
    const keys = vapidKeys(database);
    expect(vapidKeys(database).publicKey).toBe(keys.publicKey);
    const header = vapidAuthorization(database, "https://push.example.com/send/abc", 1_700_000_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromBase64url(claims!).toString())).toMatchObject({ aud: "https://push.example.com", exp: 1_700_000_000 + 12 * 3600 });
    const raw = fromBase64url(k!);
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: base64url(raw.subarray(1, 33)), y: base64url(raw.subarray(33)) },
      format: "jwk",
    });
    expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, fromBase64url(signature!))).toBe(true);
  });

  it("pushes a notification to every subscribed browser and forgets one the push service has forgotten", async () => {
    const { database, user, project } = await team();
    setPolicy(database, WEBHOOKS_ALLOW_PRIVATE, "on");
    const one = browser();
    const two = browser();
    const bob = user("bob");
    await subscribe(database, bob.id, { endpoint: "https://push.example.com/one", p256dh: one.p256dh, auth: one.auth });
    await subscribe(database, bob.id, { endpoint: "https://push.example.com/two", p256dh: two.p256dh, auth: two.auth });
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    setPushTransport({
      fetch: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body });
        if (sent.length === 2) setTimeout(settle, 5);
        return { status: url.endsWith("/two") ? 410 : 201 };
      },
    });
    notify(database, [bob.id], { kind: "mention", projectId: project.id, actorId: user("ada").id, summary: "look at scene 3" });
    await done;
    expect(sent.map((entry) => entry.url).sort()).toEqual(["https://push.example.com/one", "https://push.example.com/two"]);
    const first = sent.find((entry) => entry.url.endsWith("/one"))!;
    expect(first.headers["content-encoding"]).toBe("aes128gcm");
    expect(first.headers["authorization"]).toMatch(/^vapid t=/);
    const message = JSON.parse(decrypt(first.body, one).toString()) as Record<string, unknown>;
    expect(message).toMatchObject({ kind: "mention", actor: "ada", projectName: "harbour", summary: "look at scene 3" });
    expect(subscriptionCount(database, bob.id)).toBe(1);
  });

  it("refuses a subscription that is not https or whose keys are the wrong size", async () => {
    const { database, user } = await team();
    const receiver = browser();
    await expect(subscribe(database, user("bob").id, { endpoint: "http://push.example.com/x", p256dh: receiver.p256dh, auth: receiver.auth })).rejects.toThrow(/https/);
    await expect(subscribe(database, user("bob").id, { endpoint: "https://push.example.com/x", p256dh: receiver.auth, auth: receiver.auth })).rejects.toThrow(/p256dh/);
  });

  it("sends nothing for an account with no browsers", async () => {
    const { database, user, project } = await team();
    let called = false;
    setPushTransport({ fetch: async () => ((called = true), { status: 201 }) });
    const written = notify(database, [user("bob").id], { kind: "mention", projectId: project.id });
    pushNotification(database, user("bob").id, written.get(user("bob").id)!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(called).toBe(false);
  });
});

describe("switches", () => {
  it("files every kind under a category", () => {
    expect(categoryOf("assigned")).toBe("assign");
    expect(categoryOf("review-answered")).toBe("review");
    expect(categoryOf("access-decided")).toBe("access");
    expect(categoryOf("watch")).toBe("watch");
  });

  it("is on until switched off, and an in-app switch off writes nothing", async () => {
    const { database, user, project } = await team();
    const bob = user("bob");
    expect(readPrefs(database, bob).switches.every((entry) => entry.enabled)).toBe(true);
    writePrefs(database, bob.id, { switches: [{ category: "reply", channel: "inapp", enabled: false }] });
    expect(notify(database, [bob.id], { kind: "reply", projectId: project.id }).size).toBe(0);
    expect(notify(database, [bob.id], { kind: "mention", projectId: project.id }).size).toBe(1);
    const prefs = readPrefs(database, bob);
    expect(prefs.switches.find((entry) => entry.category === "reply" && entry.channel === "inapp")?.enabled).toBe(false);
    expect(prefs.email).toBe("bob@example.com");
    expect(prefs.mail).toBe(false);
  });

  it("keeps a digest frequency and a personal address, and refuses an address that is not one", async () => {
    const { database, user } = await team();
    const bob = user("bob");
    writePrefs(database, bob.id, { digest: "weekly", hook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
    expect(readPrefs(database, bob)).toMatchObject({ digest: "weekly", hook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
    expect(() => writePrefs(database, bob.id, { hook: "ftp://example.com" })).toThrow();
    writePrefs(database, bob.id, { hook: null });
    expect(readPrefs(database, bob).hook).toBeUndefined();
  });
});

/** A relay on a local port that speaks just enough SMTP. */
async function fakeRelay(options: { offerStartTls?: boolean } = {}) {
  const transcript: string[] = [];
  let data = "";
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 relay ready\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }
        transcript.push(line);
        if (line.startsWith("EHLO")) socket.write(`250-relay\r\n250-8BITMIME\r\n${options.offerStartTls === true ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`);
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 no\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  return { connect: () => net.connect({ host: "127.0.0.1", port }), transcript, data: () => data };
}

describe("mail", () => {
  it("composes a message with an encoded subject, a base64 body and dot-stuffing ended by a lone dot", () => {
    const message = composeMessage({ from: "Team 服务器 <team@example.com>" }, { to: "bob@example.com", subject: "三条未读", text: "第一行\n.第二行" });
    expect(message).toMatch(/^From: =\?UTF-8\?B\?.+\?= <team@example\.com>\r\n/);
    expect(message).toContain("Subject: =?UTF-8?B?");
    expect(message.endsWith("\r\n.\r\n")).toBe(true);
    const body = message.split("\r\n\r\n")[1]!.replace(/\r\n\.\r\n$/, "").replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("第一行\r\n.第二行");
    expect(() => composeMessage({ from: "team@example.com" }, { to: "bob@example.com\r\nBcc: x@y.z", subject: "s", text: "t" })).toThrow(SmtpError);
  });

  it("speaks SMTP to a relay: greeting, sender, recipient, message", async () => {
    const relay = await fakeRelay();
    setSmtpConnect(relay.connect);
    await sendMail({ host: "relay.invalid", port: 25, secure: false, from: "team@example.com" }, { to: "bob@example.com", subject: "hi", text: "hello" });
    expect(relay.transcript[0]).toBe("EHLO example.com");
    expect(relay.transcript).toContain("MAIL FROM:<team@example.com> BODY=8BITMIME");
    expect(relay.transcript).toContain("RCPT TO:<bob@example.com>");
    expect(relay.data()).toContain("To: bob@example.com");
  });

  it("never sends a password to a relay that offers no encryption", async () => {
    const relay = await fakeRelay();
    setSmtpConnect(relay.connect);
    await expect(
      sendMail({ host: "relay.invalid", port: 25, secure: false, user: "team", password: "secret", from: "team@example.com" }, { to: "bob@example.com", subject: "hi", text: "x" }),
    ).rejects.toThrow(/no password/);
    expect(relay.transcript.some((line) => line.startsWith("AUTH"))).toBe(false);
  });
});

describe("digest", () => {
  it("is due once a day or a week has gone by, an hour early at most", () => {
    const day = 24 * 3600 * 1000;
    expect(digestDue("off", undefined, day)).toBe(false);
    expect(digestDue("daily", undefined, day)).toBe(true);
    expect(digestDue("daily", 0, day - 2 * 3600 * 1000)).toBe(false);
    expect(digestDue("daily", 0, day - 1800 * 1000)).toBe(true);
    expect(digestDue("weekly", 0, 3 * day)).toBe(false);
  });

  it("gathers the unread notifications whose email switch is on", async () => {
    const { database, user, project } = await team();
    const bob = user("bob");
    notify(database, [bob.id], { kind: "mention", projectId: project.id, actorId: user("ada").id, summary: "第三幕" }, 1000);
    notify(database, [bob.id], { kind: "assigned", projectId: project.id, actorId: user("ada").id, summary: "配音" }, 2000);
    writePrefs(database, bob.id, { switches: [{ category: "assign", channel: "email", enabled: false }] });
    const digest = composeDigest(database, bob, 0)!;
    expect(digest.count).toBe(1);
    expect(digest.text).toContain("［harbour］@ada 提到了你：第三幕");
    expect(digest.text).not.toContain("配音");
    expect(composeDigest(database, bob, 5000)).toBeUndefined();
  });

  it("mails it and posts it to the person's own address, then moves the window on", async () => {
    const { database, user, project } = await team();
    setPolicy(database, WEBHOOKS_ALLOW_PRIVATE, "on");
    setPolicy(database, SMTP_HOST, "relay.invalid");
    setPolicy(database, SMTP_PORT, "25");
    setPolicy(database, SMTP_FROM, "NarraLeaf <team@example.com>");
    const relay = await fakeRelay();
    setSmtpConnect(relay.connect);
    const posted: { url: string; body: string }[] = [];
    setWebhookFetch(async (url, init) => (posted.push({ url, body: init.body }), { status: 200 }));
    const bob = user("bob");
    writePrefs(database, bob.id, { digest: "daily", hook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
    notify(database, [bob.id], { kind: "mention", projectId: project.id, actorId: user("ada").id, summary: "看看" }, 10_000);

    await digestJob(database, 20_000);
    expect(relay.transcript).toContain("RCPT TO:<bob@example.com>");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.body)).toMatchObject({ msg_type: "text" });
    // Done until a day has gone by.
    await digestJob(database, 30_000);
    expect(posted).toHaveLength(1);
    const again = await sendDigest(database, bob, 40_000);
    expect(again.count).toBe(0);
  });
});

describe("watches", () => {
  it("tells project watchers about a commit, and scene watchers only about a version after their scene was edited", async () => {
    const { database, user, project } = await team();
    const ada = user("ada");
    const bob = user("bob");
    const vee = user("vee");
    setWatch(database, bob.id, project.id, "", true);
    setWatch(database, vee.id, project.id, "scene:s1", true);
    expect(listWatches(database, vee.id)).toEqual([expect.objectContaining({ project: project.id, scope: "scene:s1" })]);
    const announced: string[] = [];
    setNotificationAnnouncer((accountId) => announced.push(accountId));

    expect(notifyWatchers(database, { projectId: project.id, kind: "commit", ref: "abc", summary: "x" })).toBe(1);
    expect(notifyWatchers(database, { projectId: project.id, kind: "version", actorId: ada.id, ref: "v1", summary: "saved" })).toBe(1);
    touchScenes(database, project.id, ["s2"], ada.id);
    expect(notifyWatchers(database, { projectId: project.id, kind: "version", actorId: ada.id, ref: "v2", summary: "saved" })).toBe(1);
    touchScenes(database, project.id, ["s1"], ada.id);
    expect(notifyWatchers(database, { projectId: project.id, kind: "version", actorId: ada.id, ref: "v3", summary: "saved" })).toBe(2);
    // The marks are cleared by the version that told them.
    expect(notifyWatchers(database, { projectId: project.id, kind: "version", actorId: ada.id, ref: "v4", summary: "saved" })).toBe(1);
    expect(announced.filter((id) => id === vee.id)).toHaveLength(1);
    expect(listNotifications(database, vee.id, { unreadOnly: true, limit: 10 }).notifications[0]).toMatchObject({ kind: "watch", ref: "v3" });
  });

  it("never tells the person who saved, and refuses a scope that is neither", async () => {
    const { database, user, project } = await team();
    setWatch(database, user("ada").id, project.id, "", true);
    expect(notifyWatchers(database, { projectId: project.id, kind: "version", actorId: user("ada").id, ref: "v1", summary: "s" })).toBe(0);
    expect(() => setWatch(database, user("ada").id, project.id, "chapter:1", true)).toThrow(WatchRefusal);
    expect(setWatch(database, user("ada").id, project.id, "", false)).toBe(true);
  });
});

describe("reactions", () => {
  function contextFor(database: DatabaseSync, name: string, published: unknown[]): MethodContext {
    const user = requireUser(database, name);
    return {
      options: { database } as unknown as MethodContext["options"],
      user,
      account: { username: user.username, displayName: user.displayName } as unknown as MethodContext["account"],
      publish: (_topic, payload) => published.push(payload),
      connection: { id: "c" },
      presence: {} as MethodContext["presence"],
    };
  }

  it("gives and takes back an emoji, and tells the project's chat", async () => {
    const { database, user, project } = await team();
    const message = sendChat(database, user("ada"), project.id, "first cut is up");
    const target = String(message.id);
    expect(targetInProject(database, project.id, "chat", target)).toBe(true);
    expect(targetInProject(database, project.id, "chat", "999")).toBe(false);
    expect(toggleReaction(database, project.id, "chat", target, user("ada").id, "🎉").by).toEqual(["ada"]);
    expect(toggleReaction(database, project.id, "chat", target, user("bob").id, "🎉").by).toEqual(["ada", "bob"]);
    expect(toggleReaction(database, project.id, "chat", target, user("ada").id, "🎉").by).toEqual(["bob"]);
    expect(reactionsOn(database, "chat", target)).toEqual([{ target, emoji: "🎉", by: ["bob"] }]);

    const toggle = notifyMethods().find((method) => method.name === TEAM_METHODS.reactionsToggle)!;
    const published: unknown[] = [];
    await toggle.handle({ project: project.id, kind: "chat", target: message.id, emoji: "👍" }, contextFor(database, "bob", published));
    expect(published).toEqual([{ kind: "reaction", project: project.id, reaction: { target, emoji: "👍", by: ["bob"] } }]);
    await expect(
      Promise.resolve().then(() => toggle.handle({ project: project.id, kind: "chat", target: message.id, emoji: "👍" }, contextFor(database, "vee", published))),
    ).rejects.toThrow(/viewer/);
    await expect(
      Promise.resolve().then(() => toggle.handle({ project: project.id, kind: "chat", target: message.id, emoji: "🍕" }, contextFor(database, "bob", published))),
    ).rejects.toThrow(/reactions/);
  });
});
