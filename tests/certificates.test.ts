import { createHash, X509Certificate } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type TLSSocket } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  ensureCertificates,
  MissingAuthorityError,
  readAuthority,
  tlsLayout,
  LEAF_VALIDITY_DAYS,
} from "../src/tls/authority.js";
import { colonHex, encodeIpAddress, subjectNameOf } from "../src/tls/x509.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-tls-");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The bytes an extension occupies in a certificate, as hex.
 *
 * The certificates are checked this way as well as through
 * `crypto.X509Certificate` because the two answer different questions: the
 * parser says the certificate can be read, and these say the extension was
 * written the one way DER allows. An extension that decodes but is encoded
 * differently — a padded key usage, an explicit non-critical flag — is a
 * certificate some verifiers accept and others do not.
 */
const ENCODED = {
  /** basicConstraints critical, CA:TRUE, pathlen:0. */
  caBasicConstraints: "30120603551d130101ff040830060101ff020100",
  /** basicConstraints critical, CA:FALSE — an empty SEQUENCE, because DER omits a DEFAULT. */
  leafBasicConstraints: "300c0603551d130101ff04023000",
  /** keyUsage critical, keyCertSign + cRLSign: bits 5 and 6 in one byte. */
  caKeyUsage: "300e0603551d0f0101ff040403020106",
  /** keyUsage critical, digitalSignature + keyEncipherment: bits 0 and 2. */
  leafKeyUsage: "300e0603551d0f0101ff0404030205a0",
  /** extendedKeyUsage, serverAuth, not critical. */
  serverAuth: "30130603551d25040c300a06082b06010505070301",
} as const;

/** Everything a test needs from one freshly set up storage root. */
async function freshRoot(hostnames: readonly string[] = []): Promise<{
  root: string;
  ca: X509Certificate;
  leaf: X509Certificate;
  caPem: string;
  leafCertPem: string;
  leafKeyPem: string;
  fingerprint: string;
}> {
  const root = await temporaryRoot();
  const certificates = await ensureCertificates(root, { hostnames });
  return {
    root,
    ca: certificates.authority.certificate,
    leaf: certificates.leafCertificate,
    caPem: certificates.authority.pem,
    leafCertPem: certificates.leafCertPem,
    leafKeyPem: certificates.leafKeyPem,
    fingerprint: certificates.authority.fingerprint256,
  };
}

describe("the certificate authority", () => {
  it("is self-signed, with the constraints of an authority", async () => {
    const { ca } = await freshRoot();

    expect(ca.subject).toBe(ca.issuer);
    expect(ca.subject).toContain("O=NarraLeaf Team");
    expect(ca.subject).toContain("CN=NarraLeaf Team CA on ");
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);

    const der = Buffer.from(ca.raw).toString("hex");
    expect(der).toContain(ENCODED.caBasicConstraints);
    expect(der).toContain(ENCODED.caKeyUsage);
    // subjectKeyIdentifier, not critical: an OCTET STRING of 20 bytes, itself
    // inside the OCTET STRING every extension's value is wrapped in.
    expect(der).toContain("0603551d0e04160414");
    // An authority that could serve TLS is an authority doing two jobs.
    expect(der).not.toContain(ENCODED.serverAuth);
  });

  it("lasts ten years, and starts an hour ago against a clock that disagrees", async () => {
    const { ca } = await freshRoot();
    const from = Date.parse(ca.validFrom);
    const to = Date.parse(ca.validTo);

    expect(from).toBeLessThan(Date.now());
    expect(Date.now() - from).toBeLessThan(2 * 60 * 60 * 1000);
    expect(Math.round((to - from) / DAY_MS)).toBe(3650);
  });

  it("keeps its private key to this account", async () => {
    const { root } = await freshRoot();
    const layout = tlsLayout(root);
    const mode = (await stat(layout.caKeyPath)).mode & 0o777;

    // Windows has no mode bits, and reports 0666 for a file anyone may read.
    // Asserting there would be asserting a fact about the platform.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
    expect((await readFile(layout.caKeyPath, "utf8")).startsWith("-----BEGIN PRIVATE KEY-----")).toBe(
      true,
    );
  });
});

describe("the auth endpoint's certificate", () => {
  it("chains to the authority", async () => {
    const { ca, leaf } = await freshRoot();

    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.issuer).toBe(ca.subject);
    expect(leaf.ca).toBe(false);
  });

  it("names the issuer with the authority's own encoded subject", async () => {
    const { ca, leaf } = await freshRoot();
    const caSubject = subjectNameOf(Buffer.from(ca.raw));
    const leafDer = Buffer.from(leaf.raw);

    // Byte for byte, not merely equal as text: a chain joins on the encoding.
    expect(leafDer.includes(caSubject)).toBe(true);
  });

  it("is a server certificate and nothing else", async () => {
    const { leaf } = await freshRoot();
    const der = Buffer.from(leaf.raw).toString("hex");

    expect(der).toContain(ENCODED.leafBasicConstraints);
    expect(der).toContain(ENCODED.leafKeyUsage);
    expect(der).toContain(ENCODED.serverAuth);
    // authorityKeyIdentifier, pointing at the key that signed this.
    expect(der).toContain("0603551d23");
  });

  it("carries the loopback and localhost without being asked", async () => {
    const { leaf } = await freshRoot();

    expect(leaf.subjectAltName).toContain("DNS:localhost");
    expect(leaf.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  it("carries a host name the operator supplied", async () => {
    const { leaf } = await freshRoot(["team.example.com", "10.0.0.7"]);

    expect(leaf.subjectAltName).toContain("DNS:team.example.com");
    // An address given as a host name still has to be written as an address:
    // a client dialling 10.0.0.7 matches iPAddress entries and no others.
    expect(leaf.subjectAltName).toContain("IP Address:10.0.0.7");
    expect(leaf.subjectAltName).not.toContain("DNS:10.0.0.7");
  });

  it("lasts under the year and a bit Apple's platforms allow", async () => {
    const { leaf } = await freshRoot();
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY_MS;

    expect(Math.round(days)).toBe(LEAF_VALIDITY_DAYS);
    expect(days).toBeLessThan(398);
  });
});

describe("a real handshake", () => {
  it("completes between the generated pair and a client holding the CA", async () => {
    const { caPem, leafCertPem, leafKeyPem } = await freshRoot();

    const server = createServer({ key: leafKeyPem, cert: leafCertPem, ALPNProtocols: ["h2"] });
    server.on("secureConnection", (socket) => {
      socket.end("ok");
    });
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const socket = await new Promise<TLSSocket>((settle, fail) => {
        const client = connect(
          { host: "127.0.0.1", port, ca: caPem, ALPNProtocols: ["h2"] },
          () => settle(client),
        );
        client.on("error", fail);
      });

      // `authorized` is the whole assertion: node built a chain from the
      // certificate the server sent to the CA it was given, and matched
      // 127.0.0.1 against the certificate's names.
      expect(socket.authorized).toBe(true);
      expect(socket.authorizationError).toBeFalsy();
      expect(socket.alpnProtocol).toBe("h2");
      socket.destroy();
    } finally {
      await new Promise<void>((settle) => server.close(() => settle()));
    }
  });

  it("is refused by a client that was not given the CA", async () => {
    const { leafCertPem, leafKeyPem } = await freshRoot();

    const server = createServer({ key: leafKeyPem, cert: leafCertPem });
    server.on("secureConnection", (socket) => socket.end());
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const failure = await new Promise<Error>((settle) => {
        const client = connect({ host: "127.0.0.1", port }, () => {
          client.destroy();
          settle(new Error("the handshake was allowed to complete"));
        });
        client.on("error", settle);
      });
      // This is the state a Studio installation is in before `nlteam trust`, and
      // the reason that command exists at all.
      expect(failure.message).toMatch(/self-signed|unable to (verify|get)/i);
    } finally {
      await new Promise<void>((settle) => server.close(() => settle()));
    }
  });
});

describe("issuing again", () => {
  it("keeps the authority and its certificate when everything is usable", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    const second = await ensureCertificates(root);

    expect(second.generatedAuthority).toBe(false);
    expect(second.issuedLeafBecause).toBeUndefined();
    expect(second.authority.fingerprint256).toBe(first.authority.fingerprint256);
    expect(second.leafCertificate.serialNumber).toBe(first.leafCertificate.serialNumber);
  });

  it("replaces the endpoint's certificate without replacing the authority", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    // A name that was not asked for last time is the ordinary reason: an
    // operator has decided people will reach this Team server by a name.
    const second = await ensureCertificates(root, { hostnames: ["team.example.com"] });

    expect(second.issuedLeafBecause).toContain("team.example.com");
    expect(second.authority.fingerprint256).toBe(first.authority.fingerprint256);
    expect(second.leafCertificate.serialNumber).not.toBe(first.leafCertificate.serialNumber);
    expect(second.leafCertificate.verify(first.authority.certificate.publicKey)).toBe(true);
    expect(second.leafCertificate.subjectAltName).toContain("DNS:team.example.com");
  });

  it("replaces it when the address people reach this server at has changed", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root, { hostnames: ["203.0.113.7"] });
    // A home connection's address is not a name it keeps. Addresses used not to
    // be checked at all here, so an operator who edited the command line and
    // restarted went on serving a certificate for the old one, and the only way
    // out was to delete the file by hand.
    const second = await ensureCertificates(root, { hostnames: ["198.51.100.4"] });

    expect(second.issuedLeafBecause).toContain("198.51.100.4");
    expect(second.leafCertificate.checkIP("198.51.100.4")).toBe("198.51.100.4");
    expect(second.leafCertificate.serialNumber).not.toBe(first.leafCertificate.serialNumber);
    // The authority is untouched, so nobody is asked to trust anything again.
    expect(second.authority.fingerprint256).toBe(first.authority.fingerprint256);
  });

  it("keeps it when an address is written a second way", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root, { hostnames: ["2001:db8::1"] });
    // node writes an IPv6 address into a subjectAltName expanded and in upper
    // case, so `2001:db8::1` reads back as `2001:DB8:0:0:0:0:0:1`. Comparing
    // what an operator typed against that text finds every IPv6 name missing
    // and re-issues the certificate on every start, for ever. This asks the
    // certificate the question a client asks instead.
    const second = await ensureCertificates(root, { hostnames: ["2001:0db8:0:0:0:0:0:1"] });

    expect(second.issuedLeafBecause).toBeUndefined();
    expect(second.leafCertificate.serialNumber).toBe(first.leafCertificate.serialNumber);
  });

  it("keeps it when the loopback is named outright, which it always carries", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    const second = await ensureCertificates(root, { hostnames: ["127.0.0.1", "::1"] });

    expect(second.issuedLeafBecause).toBeUndefined();
    expect(second.leafCertificate.serialNumber).toBe(first.leafCertificate.serialNumber);
  });

  it("replaces the endpoint's certificate as it approaches its expiry", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    const nearlyExpired = new Date(Date.now() + (LEAF_VALIDITY_DAYS - 10) * DAY_MS);
    const second = await ensureCertificates(root, { now: nearlyExpired });

    expect(second.issuedLeafBecause).toContain("expires");
    expect(second.authority.fingerprint256).toBe(first.authority.fingerprint256);
    expect(second.leafCertificate.verify(second.authority.certificate.publicKey)).toBe(true);
  });

  it("replaces a certificate that some other authority signed", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    const stranger = await ensureCertificates(await temporaryRoot());
    await writeFile(tlsLayout(root).leafCertPath, stranger.leafCertPem, "utf8");

    const second = await ensureCertificates(root);
    expect(second.issuedLeafBecause).toContain("not signed by this server's authority");
    expect(second.authority.fingerprint256).toBe(first.authority.fingerprint256);
    expect(second.leafCertificate.verify(first.authority.certificate.publicKey)).toBe(true);
  });
});

describe("the fingerprint", () => {
  it("is the SHA-256 of the DER, in the form node reports", async () => {
    const { ca, fingerprint } = await freshRoot();

    expect(fingerprint).toBe(ca.fingerprint256);
    expect(fingerprint).toBe(colonHex(createHash("sha256").update(Buffer.from(ca.raw)).digest()));
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("is the same on every run, because the authority is not made again", async () => {
    const root = await temporaryRoot();
    const first = await ensureCertificates(root);
    await ensureCertificates(root, { hostnames: ["one.example.com"] });
    const third = await ensureCertificates(root, { hostnames: ["two.example.com"] });
    const read = await readAuthority(root);

    expect(third.authority.fingerprint256).toBe(first.authority.fingerprint256);
    expect(read.fingerprint256).toBe(first.authority.fingerprint256);
  });

  it("cannot be read from a root that has no authority", async () => {
    await expect(readAuthority(await temporaryRoot())).rejects.toThrow(MissingAuthorityError);
  });
});

describe("addresses in a subjectAltName", () => {
  it("writes IPv4 as four bytes", () => {
    expect(encodeIpAddress("127.0.0.1").toString("hex")).toBe("7f000001");
    expect(encodeIpAddress("10.0.0.255").toString("hex")).toBe("0a0000ff");
  });

  it("writes IPv6 as sixteen, expanding the compressed run", () => {
    expect(encodeIpAddress("::1").toString("hex")).toBe("00000000000000000000000000000001");
    expect(encodeIpAddress("fe80::1").toString("hex")).toBe(
      "fe800000000000000000000000000001",
    );
    expect(encodeIpAddress("2001:db8:0:0:0:0:0:2").toString("hex")).toBe(
      "20010db8000000000000000000000002",
    );
  });

  it("refuses what is not an address", () => {
    expect(() => encodeIpAddress("300.1.1.1")).toThrow();
    expect(() => encodeIpAddress("team.example.com")).toThrow();
    expect(() => encodeIpAddress("::1::2")).toThrow();
  });
});
