/**
 * Sending one email, with nothing but node:net and node:tls.
 *
 * What the digest and the operator's "send a test" button need, and no more: one message, plain
 * text, to one address, through the relay the operator configured under the `email.*` policies.
 *
 *  - **Connection.** Implicit TLS (port 465) when `email.smtp_tls` is on; otherwise a plain
 *    connection that is upgraded with STARTTLS whenever the relay offers it. A relay that offers
 *    no STARTTLS is never given a password in the clear.
 *  - **Sign-in.** AUTH PLAIN, or AUTH LOGIN for a relay that only knows that, when a user is set.
 *  - **Message.** UTF-8, quoted-printable-free: the body goes as 8BITMIME base64 lines, the subject
 *    as an RFC 2047 encoded word, and nothing a header could be split by gets in.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { DatabaseSync } from "node:sqlite";

import { policyNumber, policySwitch, readPolicy, SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_SECURE, SMTP_USER } from "../identity/policy.js";

const SMTP_TIMEOUT_MS = 20_000;

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte; otherwise STARTTLS when offered. */
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  /** `Name <address>` or a bare address. */
  readonly from: string;
  /** For tests against a relay with a certificate of its own making. */
  readonly rejectUnauthorized?: boolean;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** The relay the operator configured, or undefined when there is none. */
export function smtpSettings(database: DatabaseSync): SmtpSettings | undefined {
  const host = readPolicy(database, SMTP_HOST).trim();
  const from = readPolicy(database, SMTP_FROM).trim();
  if (host === "" || from === "") return undefined;
  const user = readPolicy(database, SMTP_USER).trim();
  const password = readPolicy(database, SMTP_PASSWORD);
  return {
    host,
    port: policyNumber(database, SMTP_PORT),
    secure: policySwitch(database, SMTP_SECURE),
    ...(user === "" ? {} : { user, password }),
    from,
  };
}

/** Whether this server can send mail at all. */
export function mailConfigured(database: DatabaseSync): boolean {
  return smtpSettings(database) !== undefined;
}

/** A plausible single address, with nothing a header or command could be split by. */
export function plainAddress(text: string): string | undefined {
  const address = text.trim();
  return /^[^\s<>()@,;:"\\]+@[^\s<>()@,;:"\\]+\.[^\s<>()@,;:"\\]+$/.test(address) && address.length <= 254 ? address : undefined;
}

/** The address part of `Name <address>`, or the whole of a bare address. */
function addressOf(from: string): string | undefined {
  const bracketed = from.match(/<([^<>]+)>\s*$/);
  return plainAddress(bracketed?.[1] ?? from);
}

function encodedWord(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function fromHeader(from: string, address: string): string {
  const name = from.match(/^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/)?.[1]?.trim();
  return name === undefined || name === "" ? address : `${encodedWord(name.replace(/[\r\n]/g, " "))} <${address}>`;
}

/** The whole message as it goes after DATA, dot-stuffed and ended. */
export function composeMessage(settings: Pick<SmtpSettings, "from">, message: MailMessage, now = new Date()): string {
  const from = addressOf(settings.from);
  const to = plainAddress(message.to);
  if (from === undefined) throw new SmtpError("the sender address is not one");
  if (to === undefined) throw new SmtpError("that is not an email address");
  const domain = from.split("@")[1] ?? "localhost";
  const body = Buffer.from(message.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const lines = [
    `From: ${fromHeader(settings.from, from)}`,
    `To: ${to}`,
    `Subject: ${encodedWord(message.subject.replace(/[\r\n]+/g, " ").slice(0, 200))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    ...(body.match(/.{1,76}/g) ?? []),
  ];
  return `${lines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n")}\r\n.\r\n`;
}

/** One reply: its code and every line of text. */
interface Reply {
  readonly code: number;
  readonly lines: string[];
}

/** Reads replies off a socket, one complete (possibly multi-line) reply at a time. */
class ReplyReader {
  private buffer = "";
  private readonly queue: Reply[] = [];
  private waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  private lines: string[] = [];

  attach(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.feed(chunk));
    socket.on("error", (error: Error) => this.fail(new SmtpError(`the mail relay: ${error.message}`)));
    socket.on("close", () => this.fail(new SmtpError("the mail relay closed the connection")));
  }

  detach(socket: net.Socket): void {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024) {
      this.fail(new SmtpError("the mail relay sent too much"));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) {
        this.fail(new SmtpError("the mail relay's answer could not be read"));
        return;
      }
      this.lines.push(match[3] ?? "");
      if (match[2] === " ") {
        const reply = { code: Number(match[1]), lines: this.lines };
        this.lines = [];
        if (this.waiting !== undefined) {
          const waiting = this.waiting;
          this.waiting = undefined;
          waiting.resolve(reply);
        } else {
          this.queue.push(reply);
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    if (this.waiting !== undefined) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.reject(error);
    }
  }

  next(): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
}

export type SmtpConnect = (settings: SmtpSettings) => net.Socket;

let connectOverride: SmtpConnect | undefined;

/** For tests: how a connection to the relay is opened. `undefined` puts the real one back. */
export function setSmtpConnect(next: SmtpConnect | undefined): void {
  connectOverride = next;
}

function openSocket(settings: SmtpSettings): net.Socket {
  if (connectOverride !== undefined) return connectOverride(settings);
  if (settings.secure) {
    return tls.connect({
      host: settings.host,
      port: settings.port,
      servername: net.isIP(settings.host) === 0 ? settings.host : undefined,
      rejectUnauthorized: settings.rejectUnauthorized ?? true,
    });
  }
  return net.connect({ host: settings.host, port: settings.port });
}

/** Send one message. Resolves when the relay has accepted it; rejects with what went wrong. */
export async function sendMail(settings: SmtpSettings, message: MailMessage): Promise<void> {
  const data = composeMessage(settings, message);
  const from = addressOf(settings.from) as string;
  const to = plainAddress(message.to) as string;

  let socket = openSocket(settings);
  let reader = new ReplyReader();
  reader.attach(socket);
  const timer = setTimeout(() => socket.destroy(new Error("timed out")), SMTP_TIMEOUT_MS);

  const send = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  const expect = async (codes: readonly number[], what: string): Promise<Reply> => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) throw new SmtpError(`the mail relay refused ${what}: ${reply.code} ${reply.lines.join(" ").slice(0, 200)}`);
    return reply;
  };
  const hello = async (): Promise<Set<string>> => {
    send(`EHLO ${from.split("@")[1] ?? "localhost"}`);
    const reply = await expect([250], "the greeting");
    return new Set(reply.lines.slice(1).map((line) => line.toUpperCase()));
  };

  try {
    await expect([220], "the connection");
    let features = await hello();
    let encrypted = settings.secure;
    if (!encrypted && features.has("STARTTLS")) {
      send("STARTTLS");
      await expect([220], "STARTTLS");
      reader.detach(socket);
      const plain = socket;
      socket = await new Promise<net.Socket>((resolve, reject) => {
        const upgraded = tls.connect({
          socket: plain,
          servername: net.isIP(settings.host) === 0 ? settings.host : undefined,
          rejectUnauthorized: settings.rejectUnauthorized ?? true,
        });
        upgraded.once("secureConnect", () => resolve(upgraded));
        upgraded.once("error", (error) => reject(new SmtpError(`the mail relay's certificate: ${error.message}`)));
      });
      reader = new ReplyReader();
      reader.attach(socket);
      encrypted = true;
      features = await hello();
    }
    if (settings.user !== undefined) {
      if (!encrypted) throw new SmtpError("the mail relay offers no encryption, so no password is sent to it");
      const auth = [...features].find((line) => line.startsWith("AUTH")) ?? "";
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        send(`AUTH PLAIN ${Buffer.from(`\0${settings.user}\0${settings.password ?? ""}`, "utf8").toString("base64")}`);
        await expect([235], "the sign-in");
      } else {
        send("AUTH LOGIN");
        await expect([334], "the sign-in");
        send(Buffer.from(settings.user, "utf8").toString("base64"));
        await expect([334], "the sign-in");
        send(Buffer.from(settings.password ?? "", "utf8").toString("base64"));
        await expect([235], "the sign-in");
      }
    }
    send(`MAIL FROM:<${from}>${features.has("8BITMIME") ? " BODY=8BITMIME" : ""}`);
    await expect([250], "the sender");
    send(`RCPT TO:<${to}>`);
    await expect([250, 251], "the recipient");
    send("DATA");
    await expect([354], "the message");
    socket.write(data);
    await expect([250], "the message");
    send("QUIT");
    await reader.next().catch(() => undefined);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
