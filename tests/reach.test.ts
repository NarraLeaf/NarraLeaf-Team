import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { canReach, unreachableNotice } from "../src/loreserver/reach.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-reach-");

/**
 * The check `up` makes before starting loreserver: can this machine reach the
 * address clients sign in at, which loreserver connects to as well.
 */
describe("canReach", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A TLS listener with Team's own certificate, as `up` runs one. */
  async function listening(host = "127.0.0.1"): Promise<number | undefined> {
    const certificates = await ensureCertificates(await temporaryRoot());
    const tls = createTlsServer({ cert: certificates.leafCertPem, key: certificates.leafKeyPem }, (socket) => {
      socket.end();
    });
    server = tls;
    const bound = await new Promise<boolean>((resolve) => {
      tls.once("error", () => resolve(false));
      tls.listen(0, host, () => resolve(true));
    });
    if (!bound) {
      server = undefined;
      return undefined;
    }
    return (tls.address() as AddressInfo).port;
  }

  it("answers true once a handshake completes, whatever the certificate says", async () => {
    const port = await listening();
    // "localhost" is on Team's certificate; the probe would answer the same if it were not.
    await expect(canReach(`https://localhost:${port}`)).resolves.toBe(true);
  });

  it("completes the handshake, so Team's listener has no half-open connection to log", async () => {
    const port = await listening();
    let failed = false;
    server!.on("tlsClientError", () => {
      failed = true;
    });

    await canReach(`https://127.0.0.1:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(failed).toBe(false);
  });

  it("answers false for a port nothing is listening on, without throwing", async () => {
    const port = await listening();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(canReach(`https://127.0.0.1:${port}`)).resolves.toBe(false);
  });

  it("answers false for a listener that never speaks TLS, within the timeout", async () => {
    const held: Socket[] = [];
    const silent = createTcpServer((socket) => {
      held.push(socket);
    });
    server = silent;
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;

    await expect(canReach(`https://127.0.0.1:${port}`, 300)).resolves.toBe(false);
    // The listener's end of the connection never hears the client go, so it is
    // let go here or closing the listener waits on it.
    for (const socket of held) socket.destroy();
  });

  it("answers false for a name that does not resolve", async () => {
    await expect(canReach("https://nlteam-reach-test.invalid:41402", 1000)).resolves.toBe(false);
  });

  it("takes an IPv6 literal as a URL writes it", async () => {
    const port = await listening("::1");
    if (port === undefined) {
      return; // No IPv6 loopback on this machine; nothing to measure.
    }
    await expect(canReach(`https://[::1]:${port}`)).resolves.toBe(true);
  });
});

describe("unreachableNotice", () => {
  it("names the address, the symptom and both remedies", () => {
    const notice = unreachableNotice("https://team.example.com:41402");

    expect(notice).toContain("https://team.example.com:41402");
    expect(notice).toContain("rebac");
    expect(notice).toContain("127.0.0.1 team.example.com");
    expect(notice).toContain("team.example.com:127.0.0.1");
  });
});
