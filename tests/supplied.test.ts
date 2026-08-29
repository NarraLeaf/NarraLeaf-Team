/**
 * A certificate an operator already holds, beside the one Team issues.
 *
 * Two things are worth pinning here and they are different questions. The
 * reader refuses, at startup, what would otherwise fail as a handshake error on
 * somebody else's machine. And the listener presents the right one of two
 * certificates per connection, which is what makes the feature possible at all:
 * loreserver reaches this same listener at the loopback and verifies it against
 * Team's own authority, and no public certificate names 127.0.0.1.
 */
import { connect, type TLSSocket } from "node:tls";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GrpcServer } from "../src/grpc/server.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { readSuppliedCertificate, SuppliedCertificateError } from "../src/tls/supplied.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-supplied-");

/**
 * A certificate and key on disk, for a set of names, from an authority of its
 * own.
 *
 * A second storage root stands in for a certificate somebody else issued: what
 * matters to the code under test is that it is a valid pair from an issuer
 * Team's own clients have no reason to know about.
 */
async function pairFor(hostnames: readonly string[]): Promise<{
  certPath: string;
  keyPath: string;
  authorityPem: string;
}> {
  const root = await temporaryRoot();
  const certificates = await ensureCertificates(root, { hostnames });
  const certPath = join(root, "supplied.crt");
  const keyPath = join(root, "supplied.key");
  await writeFile(certPath, certificates.leafCertPem);
  await writeFile(keyPath, certificates.leafKeyPem);
  return { certPath, keyPath, authorityPem: certificates.authority.pem };
}

describe("reading a certificate an operator supplied", () => {
  it("reports the names it covers, which is what an operator needs to see", async () => {
    const { certPath, keyPath } = await pairFor(["public.example.com"]);

    const supplied = await readSuppliedCertificate(certPath, keyPath);

    expect(supplied.names).toContain("public.example.com");
    expect(supplied.expired).toBe(false);
  });

  it("refuses a key that belongs to a different certificate, and says which file", async () => {
    // The check worth doing at startup rather than anywhere else. A mismatched
    // pair starts a server that cannot complete one handshake, and the other
    // machine is told about a certificate rather than about a key.
    const certificate = await pairFor(["public.example.com"]);
    const other = await pairFor(["somewhere.else.example"]);

    await expect(readSuppliedCertificate(certificate.certPath, other.keyPath)).rejects.toThrow(
      SuppliedCertificateError,
    );
    await expect(readSuppliedCertificate(certificate.certPath, other.keyPath)).rejects.toThrow(
      other.keyPath,
    );
  });

  it("says what it could not read, rather than what it could not parse", async () => {
    const { certPath, keyPath } = await pairFor(["public.example.com"]);

    await expect(readSuppliedCertificate(join(certPath, "no"), keyPath)).rejects.toThrow(
      /could not be read as a certificate/,
    );
    await expect(readSuppliedCertificate(certPath, join(keyPath, "no"))).rejects.toThrow(
      /could not be read as a private key/,
    );
  });

  it("refuses something that is not a certificate at all", async () => {
    const root = await temporaryRoot();
    const notACertificate = join(root, "notes.txt");
    await writeFile(notACertificate, "this is not PEM");
    const { keyPath } = await pairFor(["public.example.com"]);

    await expect(readSuppliedCertificate(notACertificate, keyPath)).rejects.toThrow(
      /is not a certificate this can read/,
    );
  });

  it("reports an expired certificate rather than refusing to start with it", async () => {
    // A server that will not start is worse than one that says what is wrong
    // with what it is serving: the clock may be wrong, or a renewal may be half
    // done, and neither is a reason to take the server down.
    const { certPath, keyPath } = await pairFor(["public.example.com"]);
    const longAfter = new Date(Date.now() + 1000 * 24 * 60 * 60 * 1000);

    const supplied = await readSuppliedCertificate(certPath, keyPath, longAfter);

    expect(supplied.expired).toBe(true);
  });
});

/** What certificate a listener presents to one connection. */
async function presentedTo(
  port: number,
  options: { servername?: string; authorityPem: string; whateverItNames?: boolean },
): Promise<{ subject: string; issuer: string }> {
  return await new Promise((resolve, reject) => {
    const socket: TLSSocket = connect(
      {
        port,
        host: "127.0.0.1",
        ca: options.authorityPem,
        // Left out on purpose where the test is about a connection that sends
        // no server name: node sends one derived from the host unless that is
        // an address, which is what it is here.
        ...(options.servername === undefined ? {} : { servername: options.servername }),
        // For the connections whose question is which certificate was presented
        // rather than whether a client would accept it. Without this a
        // fallback to a certificate that does not name what was asked for ends
        // as a handshake error, and the test cannot see what it was shown.
        ...(options.whateverItNames === true ? { checkServerIdentity: () => undefined } : {}),
      },
      () => {
        const peer = socket.getPeerCertificate();
        socket.end();
        resolve({ subject: String(peer.subject?.CN ?? ""), issuer: String(peer.issuer?.CN ?? "") });
      },
    );
    socket.on("error", reject);
  });
}

describe("which of two certificates a connection is shown", () => {
  it("gives the supplied one to whoever asks for its name, and Team's own to the loopback", async () => {
    const own = await ensureCertificates(await temporaryRoot(), { hostnames: [] });
    const supplied = await pairFor(["public.example.com"]);
    const read = await readSuppliedCertificate(supplied.certPath, supplied.keyPath);
    const server = await GrpcServer.start({
      port: 0,
      methods: {},
      tls: {
        cert: own.leafCertPem,
        key: own.leafKeyPem,
        forNames: { cert: read.certPem, key: read.keyPem },
      },
    });

    try {
      // A client that asks for the name verifies against the supplied
      // certificate's own issuer, which is the whole point: its machine trusts
      // that already and nobody compared a fingerprint.
      const asked = await presentedTo(server.port, {
        servername: "public.example.com",
        authorityPem: supplied.authorityPem,
      });
      expect(asked.subject).toBe("public.example.com");

      // A connection to an address sends no server name at all, which is how
      // loreserver reaches this listener. It has to be shown Team's own
      // certificate, because Team's authority is the only one it has.
      const loopback = await presentedTo(server.port, { authorityPem: own.authority.pem });
      expect(loopback.subject).not.toBe("public.example.com");

      // And a name the supplied certificate does not carry falls back the same
      // way, so a client reaching this server by any other name still meets the
      // certificate it was told to trust.
      //
      // Not localhost, which would look like the obvious case and is not: the
      // stand-in above was issued by Team, and every certificate Team issues
      // carries localhost. A certificate from a public authority would not, and
      // then localhost would fall through here like anything else.
      const elsewhere = await presentedTo(server.port, {
        servername: "something.else.example",
        authorityPem: own.authority.pem,
        whateverItNames: true,
      });
      expect(elsewhere.subject).not.toBe("public.example.com");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("presents Team's own to everything when no certificate was supplied", async () => {
    const own = await ensureCertificates(await temporaryRoot(), {
      hostnames: ["public.example.com"],
    });
    const server = await GrpcServer.start({
      port: 0,
      methods: {},
      tls: { cert: own.leafCertPem, key: own.leafKeyPem },
    });

    try {
      const asked = await presentedTo(server.port, {
        servername: "public.example.com",
        authorityPem: own.authority.pem,
      });

      expect(asked.subject).not.toBe("");
    } finally {
      await server.close();
    }
  }, 30_000);
});
