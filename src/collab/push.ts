/**
 * Web Push: a notification reaching a browser whose console is closed.
 *
 * Everything is node:crypto - no library:
 *
 *  - **VAPID (RFC 8292).** This server has one P-256 key pair, made the first
 *    time anybody asks for it and kept in the settings table. A browser
 *    subscribes under its public key; every push carries an ES256 JWT signed
 *    with the private one, so the push service knows the message comes from the
 *    server the browser subscribed to.
 *  - **Message encryption (RFC 8291, `aes128gcm` of RFC 8188).** The push
 *    service carries the bytes and cannot read them: each payload is encrypted
 *    to the browser's own `p256dh` key with a fresh ephemeral key and salt.
 *
 * A push service that answers 404 or 410 has forgotten the subscription (the
 * browser unsubscribed, or was reset), so the row goes too.
 *
 * What is pushed is what the notification list would show: the kind, who, the
 * project's name and the summary. Never more than a member of the project sees.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalIntegerColumn, textColumn, type Row } from "../identity/database.js";
import { readPolicy, PUBLIC_URL, SMTP_FROM } from "../identity/policy.js";
import { readSetting, writeSetting } from "../identity/settings.js";
import { findProjectById } from "../projects/registry.js";
import type { TeamNotification } from "../team/protocol.js";
import { webhookAddressRefusal, type WebhookResolver } from "./webhooks.js";

const VAPID_SETTING = "push.vapid_private_jwk";
/** How long a push waits at the push service for a browser that is off, in seconds. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** One record: the whole payload is one, as every browser expects. */
const RECORD_SIZE = 4096;
/** Room for the payload inside one record, under the tag and the delimiter. */
export const PUSH_PAYLOAD_LIMIT = 3000;
const PUSH_TIMEOUT_MS = 10_000;
/** A browser per account is plenty; past this the oldest goes. */
const SUBSCRIPTIONS_PER_ACCOUNT = 10;

export class PushRefusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

/* --------------------------------------------------------------- base64url */

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(text: string): Buffer {
  return Buffer.from(text.replace(/=+$/, ""), "base64url");
}

/* -------------------------------------------------------------------- VAPID */

interface VapidKeys {
  readonly privateKey: KeyObject;
  /** The uncompressed point, 65 bytes, base64url: what `applicationServerKey` takes. */
  readonly publicKey: string;
}

let cachedKeys: { database: DatabaseSync; keys: VapidKeys } | undefined;

/** This server's VAPID keys, made and stored the first time they are wanted. */
export function vapidKeys(database: DatabaseSync): VapidKeys {
  if (cachedKeys !== undefined && cachedKeys.database === database) return cachedKeys.keys;
  let stored = readSetting(database, VAPID_SETTING);
  if (stored === undefined) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    stored = JSON.stringify(privateKey.export({ format: "jwk" }));
    writeSetting(database, VAPID_SETTING, stored);
  }
  const jwk = JSON.parse(stored) as { x: string; y: string; d: string; kty: string; crv: string };
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = base64url(Buffer.concat([Buffer.from([4]), fromBase64url(jwk.x), fromBase64url(jwk.y)]));
  const keys = { privateKey, publicKey };
  cachedKeys = { database, keys };
  return keys;
}

/** Who to tell when pushes go wrong, as the JWT's `sub`: a mailto: or an https address. */
function vapidSubject(database: DatabaseSync): string {
  const from = readPolicy(database, SMTP_FROM).match(/[^\s<>]+@[^\s<>]+/)?.[0];
  if (from !== undefined) return `mailto:${from}`;
  const site = readPolicy(database, PUBLIC_URL);
  if (site.startsWith("https://")) return site;
  return "mailto:team@narraleaf.invalid";
}

/** The `Authorization` header for one push service. */
export function vapidAuthorization(database: DatabaseSync, endpoint: string, now = Date.now()): string {
  const keys = vapidKeys(database);
  const audience = new URL(endpoint).origin;
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: vapidSubject(database) })),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

/* --------------------------------------------------------------- encryption */

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * Encrypt one payload to one browser (RFC 8291), as a single `aes128gcm` record.
 *
 * `ephemeral` and `salt` are for a test that checks against the RFC's own example; a push never
 * passes them, so each message has a key and a salt of its own.
 */
export function encryptPayload(
  payload: Buffer,
  p256dh: string,
  auth: string,
  fixed?: { readonly ephemeralPrivate: Buffer; readonly salt: Buffer },
): Buffer {
  const browserPublic = fromBase64url(p256dh);
  const authSecret = fromBase64url(auth);
  if (browserPublic.length !== 65 || browserPublic[0] !== 4) throw new PushRefusal("p256dh has to be an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new PushRefusal("auth has to be sixteen bytes");
  if (payload.length > RECORD_SIZE - 17) throw new PushRefusal("that payload does not fit one record");

  const ecdh = createECDH("prime256v1");
  if (fixed === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(fixed.ephemeralPrivate);
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), browserPublic, serverPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02: the last (and only) record, with no padding after it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, sealed]);
}

/* ------------------------------------------------------------ subscriptions */

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly accountId: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly createdAt: number;
  readonly lastOkAt: number | undefined;
}

function toSubscription(row: Row): PushSubscriptionRecord {
  return {
    endpoint: textColumn(row, "endpoint"),
    accountId: textColumn(row, "account_id"),
    p256dh: textColumn(row, "p256dh"),
    auth: textColumn(row, "auth"),
    createdAt: integerColumn(row, "created_at"),
    lastOkAt: optionalIntegerColumn(row, "last_ok_at"),
  };
}

export function subscriptionsOf(database: DatabaseSync, accountId: string): PushSubscriptionRecord[] {
  return (database.prepare("SELECT * FROM push_subscriptions WHERE account_id = ? ORDER BY created_at").all(accountId) as Row[]).map(
    toSubscription,
  );
}

export function subscriptionCount(database: DatabaseSync, accountId: string): number {
  return integerColumn(database.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id = ?").get(accountId) as Row, "n");
}

/** Check what a browser handed over: an https endpoint and the two keys, the right sizes. */
export function checkSubscription(input: { endpoint: string; p256dh: string; auth: string }): void {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new PushRefusal("that endpoint is not an address");
  }
  if (url.protocol !== "https:") throw new PushRefusal("a push service is reached over https");
  if (input.endpoint.length > 2048) throw new PushRefusal("that endpoint is too long");
  const key = fromBase64url(input.p256dh);
  if (key.length !== 65 || key[0] !== 4) throw new PushRefusal("p256dh has to be an uncompressed P-256 point");
  if (fromBase64url(input.auth).length !== 16) throw new PushRefusal("auth has to be sixteen bytes");
}

/** Keep one browser's subscription for an account; the same endpoint again replaces it. */
export async function subscribe(
  database: DatabaseSync,
  accountId: string,
  input: { endpoint: string; p256dh: string; auth: string },
  now = Date.now(),
): Promise<void> {
  checkSubscription(input);
  const refusal = await addressRefusal(database, input.endpoint);
  if (refusal !== undefined) throw new PushRefusal(refusal);
  database
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, account_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .run(input.endpoint, accountId, input.p256dh, input.auth, now);
  const extra = subscriptionsOf(database, accountId).slice(0, -SUBSCRIPTIONS_PER_ACCOUNT);
  for (const old of extra) database.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(old.endpoint);
}

export function unsubscribe(database: DatabaseSync, accountId: string, endpoint: string): boolean {
  return Number(database.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?").run(endpoint, accountId).changes) > 0;
}

/* ------------------------------------------------------------------ sending */

export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number }>;

interface PushTransport {
  readonly fetch?: PushFetch;
  /** For a test: how a push service's name is looked up; never consulted when private addresses are allowed. */
  readonly resolver?: WebhookResolver;
}

let transport: PushTransport = {};

/** For tests: what posts pushes and resolves their hosts. `{}` puts the platform's back. */
export function setPushTransport(next: PushTransport): void {
  transport = next;
}

function addressRefusal(database: DatabaseSync, endpoint: string): Promise<string | undefined> {
  return webhookAddressRefusal(database, endpoint, transport.resolver);
}

/** What the service worker is handed: enough to draw the notification and open the right page. */
export interface PushMessage {
  readonly kind: string;
  readonly title?: string;
  readonly actor?: string;
  readonly project?: string;
  readonly projectName?: string;
  readonly summary?: string;
  readonly ref?: string;
  readonly id?: number;
  readonly url: string;
}

/** The message for one notification. */
export function pushMessageOf(database: DatabaseSync, notification: TeamNotification): PushMessage {
  const projectName = notification.project === undefined ? undefined : findProjectById(database, notification.project)?.name;
  return {
    kind: notification.kind,
    ...(notification.actor === undefined ? {} : { actor: notification.actor }),
    ...(notification.project === undefined ? {} : { project: notification.project }),
    ...(projectName === undefined ? {} : { projectName }),
    ...(notification.summary === undefined ? {} : { summary: notification.summary.slice(0, 400) }),
    ...(notification.ref === undefined ? {} : { ref: notification.ref }),
    id: notification.id,
    url: notification.project === undefined ? "/console/notifications" : `/console/p/${encodeURIComponent(notification.project)}`,
  };
}

/** Push one message to one subscription. Answers the push service's status, 0 for none. */
export async function pushTo(database: DatabaseSync, subscription: PushSubscriptionRecord, message: PushMessage, now = Date.now()): Promise<number> {
  let body = Buffer.from(JSON.stringify(message));
  if (body.length > PUSH_PAYLOAD_LIMIT) body = Buffer.from(JSON.stringify({ ...message, summary: undefined }));
  const refusal = await addressRefusal(database, subscription.endpoint);
  if (refusal !== undefined) return 0;
  let status = 0;
  try {
    const answer = await (transport.fetch ?? (fetch as unknown as PushFetch))(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(database, subscription.endpoint, now),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(PUSH_TTL_SECONDS),
        urgency: "normal",
      },
      body: encryptPayload(body, subscription.p256dh, subscription.auth),
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    status = answer.status;
  } catch {
    status = 0;
  }
  try {
    if (status === 404 || status === 410) {
      database.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(subscription.endpoint);
    } else if (status >= 200 && status < 300) {
      database.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?").run(now, subscription.endpoint);
    }
  } catch {
    // closed under us
  }
  return status;
}

/** Push to every browser of one account. Answers how many took it. */
export async function pushToAccount(database: DatabaseSync, accountId: string, message: PushMessage): Promise<number> {
  let reached = 0;
  for (const subscription of subscriptionsOf(database, accountId)) {
    const status = await pushTo(database, subscription, message);
    if (status >= 200 && status < 300) reached += 1;
  }
  return reached;
}

/** Push a notification, without waiting. Nothing at all happens for an account with no browsers. */
export function pushNotification(database: DatabaseSync, accountId: string, notification: TeamNotification): void {
  let none = true;
  try {
    none = subscriptionCount(database, accountId) === 0;
  } catch {
    return;
  }
  if (none) return;
  void pushToAccount(database, accountId, pushMessageOf(database, notification)).catch(() => undefined);
}
