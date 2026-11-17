/**
 * Policies, retention, and the webhook delivery log: what a server looks after on its own.
 */
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptDelivery,
  createWebhook,
  deliverOne,
  listWebhookDeliveries,
  recordWebhookDelivery,
  redeliver,
  stopWebhookDeliveries,
  WEBHOOK_DELIVERIES_KEPT,
  webhookAddressRefusal,
  worthRetrying,
  type WebhookFetch,
} from "../src/collab/webhooks.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { sweepRetention } from "../src/identity/housekeeping.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import {
  addressAllowed,
  ALLOWED_NETWORKS,
  InvalidPolicyError,
  isPrivateAddress,
  policyNamed,
  policyNumber,
  policySwitch,
  RETAIN_CHAT,
  RETAIN_NOTIFICATIONS,
  setPolicy,
  shownPolicy,
  SMTP_PASSWORD,
  STUDIO_ACCESS_HOURS,
  WEBHOOKS_ALLOW_PRIVATE,
} from "../src/identity/policy.js";
import { createUser, requireUser } from "../src/identity/users.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-housekeeping-");
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const databases: DatabaseSync[] = [];
afterEach(() => {
  stopWebhookDeliveries();
  for (const db of databases.splice(0)) db.close();
});

async function team() {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  databases.push(database);
  await createUser(database, hasher, { username: "ada", password: "a password nobody guesses" });
  const ada = requireUser(database, "ada");
  const project = createProject(database, { id: newProjectId(), name: "harbour", createdBy: ada.id });
  return { database, ada, project };
}

const DAY = 24 * 60 * 60_000;

describe("policies", () => {
  it("have defaults, are found by key or label, and refuse what is out of range", async () => {
    const { database } = await team();
    expect(policyNumber(database, STUDIO_ACCESS_HOURS)).toBe(24);
    expect(policyNamed("studio access token (hours)")?.key).toBe(STUDIO_ACCESS_HOURS);
    setPolicy(database, STUDIO_ACCESS_HOURS, "2");
    expect(policyNumber(database, STUDIO_ACCESS_HOURS)).toBe(2);
    expect(() => setPolicy(database, STUDIO_ACCESS_HOURS, "0")).toThrow(InvalidPolicyError);
    expect(() => setPolicy(database, STUDIO_ACCESS_HOURS, "lots")).toThrow(InvalidPolicyError);
    expect(policySwitch(database, WEBHOOKS_ALLOW_PRIVATE)).toBe(false);
    setPolicy(database, WEBHOOKS_ALLOW_PRIVATE, "on");
    expect(policySwitch(database, WEBHOOKS_ALLOW_PRIVATE)).toBe(true);
  });

  it("never show a secret back", async () => {
    const { database } = await team();
    setPolicy(database, SMTP_PASSWORD, "hunter2");
    const shown = shownPolicy(database, policyNamed(SMTP_PASSWORD)!);
    expect(shown).not.toContain("hunter2");
  });

  it("tell private addresses from public ones, and keep a network list", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "0.0.0.0", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    const { database } = await team();
    expect(addressAllowed(database, "203.0.113.5")).toBe(true);
    setPolicy(database, ALLOWED_NETWORKS, "198.51.100.0/24, 2001:db8::/32");
    expect(addressAllowed(database, "198.51.100.7")).toBe(true);
    expect(addressAllowed(database, "2001:db8::5")).toBe(true);
    expect(addressAllowed(database, "203.0.113.5")).toBe(false);
    expect(addressAllowed(database, "127.0.0.1")).toBe(true);
    expect(() => setPolicy(database, ALLOWED_NETWORKS, "not a network")).toThrow(InvalidPolicyError);
  });
});

describe("retention", () => {
  it("cuts each table back to its setting, and keeps for ever at 0", async () => {
    const { database, ada, project } = await team();
    const now = 1_000 * DAY;
    const insertNotification = database.prepare("INSERT INTO notifications (account_id, kind, at) VALUES (?, 'mention', ?)");
    insertNotification.run(ada.id, now - 100 * DAY);
    insertNotification.run(ada.id, now - 10 * DAY);
    const insertChat = database.prepare("INSERT INTO chat_messages (project_id, author_id, body, at) VALUES (?, ?, 'hi', ?)");
    insertChat.run(project.id, ada.id, now - 900 * DAY);

    expect(sweepRetention(database, now)).toEqual({ notifications: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()).toEqual({ n: 1 });

    setPolicy(database, RETAIN_CHAT, "30");
    setPolicy(database, RETAIN_NOTIFICATIONS, "0");
    expect(sweepRetention(database, now)).toEqual({ chat_messages: 1 });
  });

  it("never drops a delivery still waiting for a retry", async () => {
    const { database, ada, project } = await team();
    const hook = createWebhook(database, ada, { url: "https://a.example/", format: "json", events: ["commit"] });
    const old = recordWebhookDelivery(database, hook, { type: "commit", projectId: project.id, summary: "x" }, 0);
    const waiting = recordWebhookDelivery(database, hook, { type: "commit", projectId: project.id, summary: "y" }, 0);
    database.prepare("UPDATE webhook_deliveries SET next_at = 5 WHERE id = ?").run(waiting.id);
    sweepRetention(database, 100 * DAY);
    expect(listWebhookDeliveries(database, hook.id).map((d) => d.id)).toEqual([waiting.id]);
    expect(old.id).toBeLessThan(waiting.id);
  });
});

describe("webhook deliveries", () => {
  it("are written down with how they went, and a failure is given a time to try again", async () => {
    const { database, ada, project } = await team();
    const hook = createWebhook(database, ada, { url: "https://a.example/", format: "json", events: ["commit"] });
    const delivery = recordWebhookDelivery(database, hook, { type: "commit", projectId: project.id, summary: "x" }, 10);
    const down: WebhookFetch = async () => ({ status: 503 });
    expect(await attemptDelivery(database, delivery.id, { fetchImpl: down, now: 100 })).toBe(503);
    expect(listWebhookDeliveries(database, hook.id)[0]).toMatchObject({ attempts: 1, status: 503, error: "answered 503", nextAt: 1_100 });

    for (let tries = 2; tries <= 6; tries += 1) await attemptDelivery(database, delivery.id, { fetchImpl: down, now: 200 });
    // Six tries in all: the first and five more. Then it gives up.
    expect(listWebhookDeliveries(database, hook.id)[0]).toMatchObject({ attempts: 6 });
    expect(listWebhookDeliveries(database, hook.id)[0]?.nextAt).toBeUndefined();

    const ok: WebhookFetch = async () => ({ status: 204 });
    const again = redeliver(database, delivery.id);
    expect(again?.body).toBe(delivery.body);
    expect(await attemptDelivery(database, again!.id, { fetchImpl: ok })).toBe(204);
    expect(listWebhookDeliveries(database, hook.id)[0]).toMatchObject({ id: again!.id, status: 204 });
    expect(listWebhookDeliveries(database, hook.id)[0]?.error).toBeUndefined();
  });

  it("retries what is worth retrying and nothing else", () => {
    expect([0, 408, 429, 500, 502].every(worthRetrying)).toBe(true);
    expect([200, 204, 301, 400, 401, 404].some(worthRetrying)).toBe(false);
  });

  it("keep only the latest few hundred per webhook", async () => {
    const { database, ada, project } = await team();
    const hook = createWebhook(database, ada, { url: "https://a.example/", format: "json", events: ["commit"] });
    for (let i = 0; i < WEBHOOK_DELIVERIES_KEPT + 5; i += 1) recordWebhookDelivery(database, hook, { type: "commit", projectId: project.id, summary: `n${i}` });
    expect(database.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: WEBHOOK_DELIVERIES_KEPT });
  });

  it("refuse an address on this machine or its network unless the operator allows it", async () => {
    const { database, ada, project } = await team();
    const publicName = async () => ["93.184.216.34"];
    const sneaky = async () => ["93.184.216.34", "10.0.0.5"];
    expect(await webhookAddressRefusal(database, "https://hooks.example/", publicName)).toBeUndefined();
    expect(await webhookAddressRefusal(database, "https://hooks.example/", sneaky)).toMatch(/own network/);
    expect(await webhookAddressRefusal(database, "http://127.0.0.1:8080/", publicName)).toMatch(/own network/);
    expect(await webhookAddressRefusal(database, "http://[::1]/", publicName)).toMatch(/own network/);
    expect(await webhookAddressRefusal(database, "http://localhost/", publicName)).toMatch(/own network/);
    expect(
      await webhookAddressRefusal(database, "https://nowhere.example/", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toMatch(/no address/);

    // Refused before anything is posted, and not tried again.
    const hook = createWebhook(database, ada, { url: "http://10.0.0.5/", format: "json", events: ["commit"] });
    const posted: string[] = [];
    const delivery = recordWebhookDelivery(database, hook, { type: "commit", projectId: project.id, summary: "x" });
    const status = await attemptDelivery(database, delivery.id, {
      fetchImpl: async (url) => {
        posted.push(url);
        return { status: 204 };
      },
      resolver: publicName,
    });
    expect(status).toBe(0);
    expect(posted).toEqual([]);
    expect(listWebhookDeliveries(database, hook.id)[0]).toMatchObject({ error: expect.stringMatching(/own network/) });
    expect(listWebhookDeliveries(database, hook.id)[0]?.nextAt).toBeUndefined();

    setPolicy(database, WEBHOOKS_ALLOW_PRIVATE, "on");
    expect(await webhookAddressRefusal(database, "http://10.0.0.5/", publicName)).toBeUndefined();
  });

  it("answer a test straight away, without a retry", async () => {
    const { database, ada, project } = await team();
    const hook = createWebhook(database, ada, { url: "https://a.example/", format: "json", events: ["commit"] });
    expect(await deliverOne(database, hook, { type: "commit", projectId: project.id, summary: "x" }, async () => ({ status: 500 }))).toBe(500);
    expect(listWebhookDeliveries(database, hook.id)[0]?.nextAt).toBeUndefined();
  });
});
