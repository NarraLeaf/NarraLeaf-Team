/**
 * Checking a password against a directory: an LDAP simple bind and nothing more.
 *
 * The server binds as the person, with the DN `sso.ldap_bind_dn` makes from the
 * username they typed (`{username}` is replaced), and the directory's yes or no
 * is the answer. There is no search and no service account, so there is no
 * stored directory password and no query language to get wrong.
 *
 * The protocol is three messages, so it is written out here in BER by hand
 * rather than taken from a library: a bind request, its response, an unbind.
 */
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

const LDAP_TIMEOUT_MS = 8000;

function berLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function ber(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), berLength(content.length), content]);
}

/** The bind request, as a whole LDAPMessage with id 1. */
export function bindRequest(dn: string, password: string): Buffer {
  const op = ber(
    0x60,
    Buffer.concat([
      ber(0x02, Buffer.from([3])),
      ber(0x04, Buffer.from(dn, "utf-8")),
      ber(0x80, Buffer.from(password, "utf-8")),
    ]),
  );
  return ber(0x30, Buffer.concat([ber(0x02, Buffer.from([1])), op]));
}

const UNBIND = Buffer.from([0x30, 0x05, 0x02, 0x01, 0x02, 0x42, 0x00]);

interface Tlv {
  readonly tag: number;
  readonly content: Buffer;
  readonly end: number;
}

function readTlv(buffer: Buffer, at: number): Tlv | undefined {
  if (at + 2 > buffer.length) return undefined;
  const tag = buffer[at] as number;
  let length = buffer[at + 1] as number;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > buffer.length) return undefined;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (buffer[start + i] as number);
    start += count;
  }
  if (start + length > buffer.length) return undefined;
  return { tag, content: buffer.subarray(start, start + length), end: start + length };
}

/**
 * The result code of a bind response, or undefined while more bytes are needed,
 * or -1 for bytes that are not a bind response.
 */
export function bindResult(buffer: Buffer): number | undefined {
  const message = readTlv(buffer, 0);
  if (message === undefined) return undefined;
  if (message.tag !== 0x30) return -1;
  const id = readTlv(message.content, 0);
  if (id === undefined || id.tag !== 0x02) return -1;
  const op = readTlv(message.content, id.end);
  if (op === undefined || op.tag !== 0x61) return -1;
  const code = readTlv(op.content, 0);
  if (code === undefined || code.tag !== 0x0a || code.content.length !== 1) return -1;
  return code.content[0] as number;
}

/** Escape what RFC 4514 says may not appear bare in a DN value. */
export function escapeDnValue(value: string): string {
  return value
    .replace(/[\\,+"<>;=]/g, (char) => `\\${char}`)
    .replace(/^[ #]/, (char) => `\\${char}`)
    .replace(/ $/, "\\ ");
}

export function bindDnFor(template: string, username: string): string {
  return template.replaceAll("{username}", escapeDnValue(username));
}

/**
 * Whether the directory at this address accepts this DN and password.
 *
 * An empty password is refused before anything is sent: to LDAP a simple bind
 * with no password is an anonymous bind, which most directories accept, and
 * would make every name a valid sign-in.
 */
export function ldapBind(url: string, dn: string, password: string): Promise<boolean> {
  if (password === "" || dn === "") {
    return Promise.resolve(false);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const secure = parsed.protocol === "ldaps:";
  if (!secure && parsed.protocol !== "ldap:") {
    return Promise.resolve(false);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port === "" ? (secure ? 636 : 389) : Number(parsed.port);

  return new Promise((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket: Socket = secure
      ? connectTls({ host, port, servername: host })
      : connectTcp({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end(UNBIND);
      } catch {
        socket.destroy();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      finish(false);
      socket.destroy();
    }, LDAP_TIMEOUT_MS);
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(bindRequest(dn, password));
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 65536) {
        finish(false);
        return;
      }
      const code = bindResult(received);
      if (code !== undefined) {
        finish(code === 0);
      }
    });
    socket.on("error", () => {
      finish(false);
    });
    socket.on("close", () => {
      finish(false);
    });
  });
}
