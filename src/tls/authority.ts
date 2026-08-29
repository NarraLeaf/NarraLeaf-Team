/**
 * Team's own certificate authority, and the certificate its auth endpoint
 * presents.
 *
 * Why an authority at all, rather than one self-signed certificate: a Studio
 * installation's client library will not talk to the auth endpoint over
 * anything but TLS, and it checks the certificate against the host's own trust
 * store. There is no pinning hook. The one lever there is — `SSL_CERT_FILE`,
 * which that library does read on every platform including Windows — belongs to
 * whoever starts the process, and on a collaborator's machine that is not Team.
 * So trust cannot be established inside the connection: a person has to put
 * something into the trust store once, having compared a fingerprint out of
 * band. That thing should not be the certificate the endpoint presents: a
 * leaf expires, and moving a Team server or adding a host name changes its names, and
 * every one of those would otherwise mean going round every machine again. So
 * the long-lived authority is what is trusted, and the endpoint's certificate is
 * issued from it and replaced whenever it needs to be.
 *
 * Both private keys sit under the storage root at mode 0600. The authority's is
 * the more valuable: anything holding it can issue a certificate for any name,
 * to any machine that has trusted this Team server.
 */
import {
  createPrivateKey,
  generateKeyPair,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import {
  createCertificate,
  fingerprintOf,
  keyIdentifier,
  subjectNameOf,
  type SubjectAltName,
} from "./x509.js";

/**
 * The modulus size of both keys.
 *
 * RSA-2048, for the same reason the signing keys are: it is accepted
 * everywhere, including by the trust stores and TLS stacks that are
 * conservative about newer curves, and this is a certificate a person installs
 * by hand into an operating system.
 */
const MODULUS_LENGTH = 2048;

/**
 * How long each certificate lasts.
 *
 * Ten years for the authority, because renewing it is the expensive act: every
 * machine that trusted this Team server has to be visited again.
 *
 * A little over a year for the endpoint's certificate, which is the limit
 * Apple's platforms enforce on a server certificate — anything longer is
 * refused there, whoever issued it. Renewing it costs nothing: the next `up`
 * does it, and no client notices, because what a client trusts is the authority
 * above it.
 */
export const CA_VALIDITY_DAYS = 3650;
export const LEAF_VALIDITY_DAYS = 397;

/** How close to expiry the endpoint's certificate is replaced rather than kept. */
export const LEAF_RENEWAL_MARGIN_DAYS = 30;

/**
 * How far in the past a certificate starts being valid.
 *
 * An hour, against two machines' clocks disagreeing: a certificate whose
 * `notBefore` is a minute in the future is refused with much the same message
 * as one that has expired, and a person with a freshly started Team would have
 * no idea why.
 */
const BACKDATE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The organization both certificates carry, so a trust store groups them. */
const ORGANIZATION = "NarraLeaf Team";

/** Where the transport files live under one storage root. */
export interface TlsLayout {
  readonly root: string;
  readonly tlsDir: string;
  /** The authority's private key. */
  readonly caKeyPath: string;
  /** The authority's certificate: the file an operator installs. */
  readonly caCertPath: string;
  /** The auth endpoint's private key. */
  readonly leafKeyPath: string;
  /** The auth endpoint's certificate. */
  readonly leafCertPath: string;
}

/** Derive the transport paths from a storage root. */
export function tlsLayout(root: string): TlsLayout {
  const absoluteRoot = resolve(root);
  const tlsDir = join(absoluteRoot, "tls");
  return {
    root: absoluteRoot,
    tlsDir,
    caKeyPath: join(tlsDir, "ca.key"),
    caCertPath: join(tlsDir, "ca.crt"),
    leafKeyPath: join(tlsDir, "auth.key"),
    leafCertPath: join(tlsDir, "auth.crt"),
  };
}

/** Raised when the transport files are not there to be read. */
export class MissingAuthorityError extends Error {
  constructor(readonly tlsDir: string) {
    super(
      `this Team server has no certificate authority in ${tlsDir}. ` +
        "Run up once with the same --root; it generates one on first start.",
    );
    this.name = "MissingAuthorityError";
  }
}

/** Raised when the authority's certificate is there and its key is not. */
export class MissingAuthorityKeyError extends Error {
  constructor(path: string, tlsDir: string) {
    super(
      `${path} is missing, so nothing can issue a certificate for the auth endpoint. ` +
        `Delete ${tlsDir} and run up again to make a new authority — every machine that ` +
        "trusted the old one has to be told to trust the new one.",
    );
    this.name = "MissingAuthorityKeyError";
  }
}

/** Team's certificate authority, as it is on disk. */
export interface TeamAuthority {
  readonly layout: TlsLayout;
  readonly certificate: X509Certificate;
  readonly pem: string;
  /** SHA-256 over the DER, colon-separated upper-case hex. */
  readonly fingerprint256: string;
}

/** The authority and the endpoint certificate issued from it. */
export interface TeamCertificates {
  readonly authority: TeamAuthority;
  /** The endpoint's certificate and the authority's, as node's TLS wants them. */
  readonly leafCertPem: string;
  readonly leafKeyPem: string;
  readonly leafCertificate: X509Certificate;
  /** True when this call created the authority rather than finding one. */
  readonly generatedAuthority: boolean;
  /** Why the endpoint's certificate was issued now, or undefined if it was kept. */
  readonly issuedLeafBecause: string | undefined;
}

/** One RSA key pair. `generateKeyPair` has no promisified form here. */
function generateRsaKeyPair(): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> {
  return new Promise((settle, fail) => {
    generateKeyPair("rsa", { modulusLength: MODULUS_LENGTH }, (error, publicKey, privateKey) => {
      if (error !== null) {
        fail(error);
        return;
      }
      settle({ publicKey, privateKey });
    });
  });
}

/**
 * A serial number: sixteen random bytes.
 *
 * Random rather than counted, because two certificates from one authority must
 * not share a serial and nothing here keeps a register. Sixteen bytes is what a
 * public authority is required to use, for a second reason that applies here
 * too: the number is unpredictable input to what is being signed.
 */
function serialNumber(): Buffer {
  return randomBytes(16);
}

/** A private key as PEM text, whichever form node hands back. */
function privateKeyPem(key: KeyObject): string {
  const exported = key.export({ type: "pkcs8", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

/** Write a file only this account may read. */
async function writePrivate(path: string, contents: string): Promise<void> {
  // The mode goes to `writeFile` for a file it creates, and is set again for
  // one it replaced: an existing file keeps its own mode, and renewing a
  // certificate must not leave its key readable because something else made
  // that file first. Windows has no such bits, which is a fact about that
  // platform rather than a reason to skip this elsewhere.
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** A certificate on disk, or undefined when there is not one to read. */
async function readCertificate(
  path: string,
): Promise<{ pem: string; x509: X509Certificate } | undefined> {
  let pem: string;
  try {
    pem = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { pem, x509: new X509Certificate(pem) };
  } catch {
    // A file that is not a certificate is treated as no certificate, and one is
    // written over it. Nothing is lost that Team server cannot make again, and the
    // alternative is a Team server that will not start until a person deletes a file.
    return undefined;
  }
}

/**
 * The names the endpoint's certificate has to carry.
 *
 * The loopback addresses are always there: a Team server is reached from its own
 * machine at least during setup, and a client dialling an address matches
 * against `iPAddress` entries, never against `DNS` ones. Anything an operator
 * names is added, sorted into the two kinds by whether it parses as an address,
 * because `DNS:192.168.1.10` matches nothing a client will ever ask for.
 */
export function endpointNames(hostnames: readonly string[]): SubjectAltName {
  const dnsNames = new Set<string>(["localhost"]);
  const ipAddresses = new Set<string>(["127.0.0.1", "::1"]);
  for (const name of hostnames) {
    if (isIP(name) === 0) {
      dnsNames.add(name);
    } else {
      ipAddresses.add(name);
    }
  }
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] };
}

/** Generate the authority: a key, and a self-signed certificate over it. */
async function issueAuthority(
  layout: TlsLayout,
  hostnames: readonly string[],
  now: Date,
): Promise<{ pem: string; x509: X509Certificate }> {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  // A name in the subject so that a person scrolling a trust store full of
  // well-known authorities can tell which entry is theirs. It is not an
  // identity check — the fingerprint is, which is what `nlteam trust` prints
  // and what a person compares.
  //
  // The name the operator gave, ahead of the machine's own, because the
  // machine's own is not always one anybody recognises: inside a container it
  // is a dozen random hex characters, which is exactly no help in the list this
  // is meant to be findable in. It also separates two servers on one machine,
  // which used to take the same subject — and two authorities with one subject
  // in a client's trust list shadow each other rather than both being tried.
  const subject = {
    commonName: `NarraLeaf Team CA on ${hostnames[0] ?? hostname()}`,
    organizationName: ORGANIZATION,
  };

  const certificate = createCertificate({
    subject,
    // Self-signed is exactly this: the issuer is the subject, and the signing
    // key is the subject's own.
    issuer: subject,
    publicKey,
    issuerPrivateKey: privateKey,
    serialNumber: serialNumber(),
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    // pathlen:0 says no further authority may sit below this one. Team issues
    // leaf certificates and nothing else, so a chain with an intermediate in it
    // did not come from here.
    basicConstraints: { ca: true, pathLength: 0 },
    keyUsage: ["keyCertSign", "cRLSign"],
  });

  await writePrivate(layout.caKeyPath, privateKeyPem(privateKey));
  await writeFile(layout.caCertPath, certificate.pem, "utf8");
  return { pem: certificate.pem, x509: new X509Certificate(certificate.der) };
}

/** Generate the endpoint's key and a certificate for it, signed by the authority. */
async function issueLeaf(
  layout: TlsLayout,
  caPrivateKey: KeyObject,
  caCertificate: X509Certificate,
  hostnames: readonly string[],
  now: Date,
): Promise<{ pem: string; keyPem: string; x509: X509Certificate }> {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const names = endpointNames(hostnames);
  // A common name is not what a modern TLS client matches — the subject
  // alternative names are — but it is what a person sees in a certificate
  // viewer, so it names the endpoint rather than repeating the organization.
  const primary = names.dnsNames.find((name) => name !== "localhost") ?? "localhost";

  const certificate = createCertificate({
    subject: { commonName: primary, organizationName: ORGANIZATION },
    issuer: subjectNameOf(Buffer.from(caCertificate.raw)),
    publicKey,
    issuerPrivateKey: caPrivateKey,
    serialNumber: serialNumber(),
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY_MS),
    basicConstraints: { ca: false },
    // What a TLS server's key does: sign the handshake, and — for the RSA key
    // exchange an older client may still choose — have a secret encrypted to it.
    keyUsage: ["digitalSignature", "keyEncipherment"],
    // id-kp-serverAuth. Without it, a trust store that checks what a
    // certificate is for treats this as a certificate for nothing.
    extendedKeyUsage: ["1.3.6.1.5.5.7.3.1"],
    subjectAltName: names,
    authorityKeyIdentifier: keyIdentifier(caCertificate.publicKey),
  });

  const keyPem = privateKeyPem(privateKey);
  await writePrivate(layout.leafKeyPath, keyPem);
  await writeFile(layout.leafCertPath, certificate.pem, "utf8");
  return { pem: certificate.pem, keyPem, x509: new X509Certificate(certificate.der) };
}

/**
 * Why the endpoint's certificate cannot go on being used, or undefined if it
 * can.
 *
 * Every answer here causes a new one to be issued from the same authority,
 * which is invisible to every machine that has trusted this Team server.
 */
export function leafReplacementReason(
  leaf: X509Certificate,
  caCertificate: X509Certificate,
  hostnames: readonly string[],
  now: Date,
): string | undefined {
  if (!leaf.verify(caCertificate.publicKey)) {
    return "the certificate on disk was not signed by this server's authority";
  }
  const notAfter = Date.parse(leaf.validTo);
  if (Number.isNaN(notAfter)) {
    return "the certificate on disk has no readable expiry";
  }
  if (notAfter - now.getTime() < LEAF_RENEWAL_MARGIN_DAYS * DAY_MS) {
    return `the certificate on disk expires on ${leaf.validTo}`;
  }
  // Only the names an operator asked for are checked. The loopback entries are
  // written on every issue, so a certificate that has those but is missing a
  // host name added since would be refused by exactly the client that name was
  // added for.
  //
  // Asked of the certificate rather than read out of its `subjectAltName` text,
  // for two reasons. Addresses used not to be checked at all — the test was
  // `isIP(name) === 0`, so a deployment reached by a bare address that changed
  // went on serving a certificate for the old one, and the only way out was to
  // delete the file by hand. And the text cannot be compared against anyway:
  // node writes an IPv6 address there expanded and in upper case, so `::1`
  // reads back as `IP Address:0:0:0:0:0:0:0:1` and any spelling an operator
  // typed would look missing, re-issuing the certificate on every start for
  // ever. `checkHost` and `checkIP` are the match a client makes, which is the
  // question being asked.
  const missing = hostnames.filter((name) =>
    isIP(name) === 0 ? leaf.checkHost(name) === undefined : leaf.checkIP(name) === undefined,
  );
  const first = missing[0];
  return first === undefined ? undefined : `the certificate on disk does not carry ${first}`;
}

/** Options for looking at, or setting up, the transport files. */
export interface CertificateOptions {
  /** Host names an operator supplied; the loopback is always included. */
  readonly hostnames?: readonly string[];
  /** The moment validity is judged from. Supplied by tests; defaults to now. */
  readonly now?: Date;
}

/**
 * Read the authority without creating anything.
 *
 * `nlteam trust` uses this: printing a fingerprint for a person to compare must
 * not be the act that decides what the fingerprint is.
 */
export async function readAuthority(root: string): Promise<TeamAuthority> {
  const layout = tlsLayout(root);
  const found = await readCertificate(layout.caCertPath);
  if (found === undefined) {
    throw new MissingAuthorityError(layout.tlsDir);
  }
  return {
    layout,
    certificate: found.x509,
    pem: found.pem,
    fingerprint256: fingerprintOf(Buffer.from(found.x509.raw)),
  };
}

/**
 * Make sure this storage root has an authority and a usable endpoint
 * certificate, generating whichever is missing.
 *
 * A second call keeps the authority it finds, which is the property the whole
 * arrangement rests on: the fingerprint a person compared once stays the
 * fingerprint for the life of the Team server, however often the endpoint's own
 * certificate is replaced underneath it.
 */
export async function ensureCertificates(
  root: string,
  options: CertificateOptions = {},
): Promise<TeamCertificates> {
  const layout = tlsLayout(root);
  const now = options.now ?? new Date();
  const hostnames = options.hostnames ?? [];

  // 0700, for the reason the keys directory is: the two private keys under here
  // are the whole of this Team server's transport security.
  await mkdir(layout.tlsDir, { recursive: true, mode: 0o700 });

  const existingCa = await readCertificate(layout.caCertPath);
  const authority = existingCa ?? (await issueAuthority(layout, hostnames, now));
  const generatedAuthority = existingCa === undefined;

  let caPrivateKey: KeyObject;
  try {
    caPrivateKey = createPrivateKey(await readFile(layout.caKeyPath, "utf8"));
  } catch {
    throw new MissingAuthorityKeyError(layout.caKeyPath, layout.tlsDir);
  }

  // A new authority cannot have issued anything, so whatever leaf is beside it
  // belongs to an authority that is gone.
  const existingLeaf = generatedAuthority ? undefined : await readCertificate(layout.leafCertPath);
  const because =
    existingLeaf === undefined
      ? generatedAuthority
        ? "this server had no certificate authority"
        : "this server had no certificate for its auth endpoint"
      : leafReplacementReason(existingLeaf.x509, authority.x509, hostnames, now);

  let leafCertPem: string;
  let leafKeyPem: string;
  let leafCertificate: X509Certificate;
  if (because === undefined && existingLeaf !== undefined) {
    leafCertPem = existingLeaf.pem;
    leafKeyPem = await readFile(layout.leafKeyPath, "utf8");
    leafCertificate = existingLeaf.x509;
  } else {
    const issued = await issueLeaf(layout, caPrivateKey, authority.x509, hostnames, now);
    leafCertPem = issued.pem;
    leafKeyPem = issued.keyPem;
    leafCertificate = issued.x509;
  }

  return {
    authority: {
      layout,
      certificate: authority.x509,
      pem: authority.pem,
      fingerprint256: fingerprintOf(Buffer.from(authority.x509.raw)),
    },
    // The authority's certificate is sent after the endpoint's. A client that
    // has trusted it does not need the copy, but one verifying against a
    // certificate it was handed separately does, and it costs a kilobyte.
    leafCertPem: `${leafCertPem}${authority.pem}`,
    leafKeyPem,
    leafCertificate,
    generatedAuthority,
    issuedLeafBecause: because,
  };
}
