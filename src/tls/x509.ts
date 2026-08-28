/**
 * Building an X.509 certificate, from the DER writer beside this file.
 *
 * A certificate is three things: a `TBSCertificate` — "to be signed" — an
 * algorithm identifier, and a signature over the DER of the first. Node's
 * `crypto` produces the signature; every byte it signs is written here, because
 * a signature over bytes somebody else assembled proves nothing about what this
 * program meant to say.
 *
 * The certificates Team issues are for one purpose: a TLS server on a machine an
 * operator controls, trusted because that operator installed Team's certificate
 * authority by hand. There is no revocation, no OCSP, no policy — nothing that
 * would need an infrastructure to answer for it. What is here is what a TLS
 * client checks: the chain, the validity dates, the basic constraints, the key
 * usage and the names.
 */
import { createHash, createSign, type KeyObject } from "node:crypto";

import {
  bitString,
  boolean,
  explicit,
  ia5Bytes,
  implicit,
  integer,
  namedBits,
  nullValue,
  objectIdentifier,
  octetString,
  printableString,
  sequence,
  set,
  time,
  unsignedInteger,
  utf8String,
  UnencodableValueError,
} from "./der.js";

/** Object identifiers, by the name they are known by in a certificate. */
const OID = {
  /** PKCS#1 sha256WithRSAEncryption. */
  sha256WithRsaEncryption: "1.2.840.113549.1.1.11",
  /** PKCS#1 rsaEncryption, the algorithm of a `SubjectPublicKeyInfo`. */
  rsaEncryption: "1.2.840.113549.1.1.1",
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  organizationalUnitName: "2.5.4.11",
  countryName: "2.5.4.6",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extendedKeyUsage: "2.5.29.37",
  /** id-kp-serverAuth: this key may be a TLS server. */
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/**
 * The bit each key usage occupies, from RFC 5280.
 *
 * The positions are the definition of the extension, not an ordering choice: a
 * value off by one says `dataEncipherment` where `keyEncipherment` was meant,
 * and a TLS client refuses the certificate without saying which bit it wanted.
 */
const KEY_USAGE_BITS = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
  encipherOnly: 7,
  decipherOnly: 8,
} as const;

/** A key usage, by the name `openssl x509 -text` prints for it. */
export type KeyUsage = keyof typeof KEY_USAGE_BITS;

/** The parts of a distinguished name Team writes. */
export interface DistinguishedName {
  readonly commonName: string;
  readonly organizationName?: string | undefined;
  readonly organizationalUnitName?: string | undefined;
  /** Two letters, if it is given at all. */
  readonly countryName?: string | undefined;
}

/** What a certificate says it is good for, beyond its key usage. */
export interface BasicConstraints {
  readonly ca: boolean;
  /** How many certificate authorities may appear below this one. */
  readonly pathLength?: number | undefined;
}

/** The names a TLS client may match against a certificate. */
export interface SubjectAltName {
  readonly dnsNames: readonly string[];
  /** Textual addresses; both families are accepted. */
  readonly ipAddresses: readonly string[];
}

/** Everything one certificate is made of. */
export interface CertificateSpec {
  readonly subject: DistinguishedName;
  /** A name to encode, or the issuer's `subject` field copied out of its own
   * certificate — see {@link subjectNameOf}. */
  readonly issuer: DistinguishedName | Buffer;
  /** The public key this certificate is about. */
  readonly publicKey: KeyObject;
  /** The key that signs it: the CA's, or the subject's own when self-signed. */
  readonly issuerPrivateKey: KeyObject;
  /** Raw bytes read as an unsigned integer. */
  readonly serialNumber: Buffer;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly basicConstraints: BasicConstraints;
  readonly keyUsage: readonly KeyUsage[];
  readonly extendedKeyUsage?: readonly string[] | undefined;
  readonly subjectAltName?: SubjectAltName | undefined;
  /**
   * The issuer's subject key identifier, written as this certificate's
   * `authorityKeyIdentifier`. Absent on a self-signed certificate, where it
   * would repeat the subject key identifier beside it.
   */
  readonly authorityKeyIdentifier?: Buffer | undefined;
}

/** A finished certificate, in both the forms anything asks for. */
export interface Certificate {
  readonly der: Buffer;
  readonly pem: string;
  /** SHA-256 over the DER, which is what a fingerprint of a certificate means. */
  readonly fingerprint256: string;
}

/** `AlgorithmIdentifier` for sha256WithRSAEncryption. */
function signatureAlgorithm(): Buffer {
  // The NULL parameter is required for the PKCS#1 algorithms, and an absent one
  // is a different encoding that some verifiers refuse.
  return sequence(objectIdentifier(OID.sha256WithRsaEncryption), nullValue());
}

/** One `AttributeTypeAndValue`, inside the `SET` that an RDN is. */
function attribute(type: string, value: Buffer): Buffer {
  return set(sequence(objectIdentifier(type), value));
}

/**
 * `Name`, which is a sequence of one-element sets.
 *
 * The order is the order the components are written in, and it is part of the
 * name: an issuer name in one certificate has to be the byte-for-byte subject
 * name of the one above it, or the chain does not join.
 */
export function encodeName(name: DistinguishedName | Buffer): Buffer {
  // Already-encoded bytes pass straight through: this is how a leaf takes its
  // issuer name from the certificate above it rather than building one that
  // merely looks the same.
  if (Buffer.isBuffer(name)) {
    return name;
  }
  const components: Buffer[] = [];
  if (name.countryName !== undefined) {
    // The only component written as a PrintableString: a country code is two
    // letters, and the type is what a certificate conventionally uses for it.
    components.push(attribute(OID.countryName, printableString(name.countryName)));
  }
  if (name.organizationName !== undefined) {
    components.push(attribute(OID.organizationName, utf8String(name.organizationName)));
  }
  if (name.organizationalUnitName !== undefined) {
    components.push(
      attribute(OID.organizationalUnitName, utf8String(name.organizationalUnitName)),
    );
  }
  components.push(attribute(OID.commonName, utf8String(name.commonName)));
  return sequence(...components);
}

/**
 * The bytes of an IP address, as a `subjectAltName` carries it.
 *
 * A `iPAddress` general name is the address itself — four bytes or sixteen —
 * and not its text. A client comparing the address it dialled against a
 * certificate compares those bytes, so `127.000.000.001` and `127.0.0.1` are
 * the same entry and neither is written as text.
 */
export function encodeIpAddress(address: string): Buffer {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split(".").map(Number);
    if (parts.some((part) => part > 255)) {
      throw new UnencodableValueError(`"${address}" has a byte above 255`);
    }
    return Buffer.from(parts);
  }

  // IPv6, including the `::` that stands for a run of zero groups. Written out
  // rather than borrowed because node has no address parser to reach for, and
  // `[::1]` is where a client on this machine may well arrive.
  if (!address.includes(":")) {
    throw new UnencodableValueError(`"${address}" is not an IP address`);
  }
  const [head, tail, ...rest] = address.split("::");
  if (rest.length > 0 || head === undefined) {
    throw new UnencodableValueError(`"${address}" has more than one ::`);
  }
  const parse = (text: string): number[] =>
    text === ""
      ? []
      : text.split(":").map((group) => {
          if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
            throw new UnencodableValueError(`"${address}" has a group that is not hexadecimal`);
          }
          return Number.parseInt(group, 16);
        });

  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array.from<number>({ length: 8 - left.length - right.length }).fill(0),
          ...right,
        ];
  if (groups.length !== 8 || groups.some((group) => group < 0)) {
    throw new UnencodableValueError(`"${address}" is not eight groups of an IPv6 address`);
  }

  const bytes = Buffer.alloc(16);
  for (const [index, group] of groups.entries()) {
    bytes.writeUInt16BE(group, index * 2);
  }
  return bytes;
}

/** One extension: its identifier, whether it is critical, and its value. */
function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  // DER omits a DEFAULT, and `critical` defaults to FALSE, so a non-critical
  // extension writes no boolean at all rather than an explicit FALSE.
  return sequence(
    objectIdentifier(oid),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

/**
 * `SubjectPublicKeyInfo` for an RSA key.
 *
 * The BIT STRING holds the DER of PKCS#1's `RSAPublicKey`, which is exactly
 * what node exports as the `pkcs1` form — so the modulus and exponent are not
 * taken apart here, only wrapped.
 */
export function encodePublicKeyInfo(publicKey: KeyObject): Buffer {
  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new UnencodableValueError(
      `a ${publicKey.asymmetricKeyType ?? "key of unknown type"} cannot be written here; ` +
        "Team's certificates are RSA",
    );
  }
  const rsaPublicKey = publicKey.export({ type: "pkcs1", format: "der" });
  return sequence(
    sequence(objectIdentifier(OID.rsaEncryption), nullValue()),
    bitString(Buffer.from(rsaPublicKey)),
  );
}

/**
 * The `subjectKeyIdentifier` of a key: the SHA-1 of its `subjectPublicKey`.
 *
 * SHA-1 is named by RFC 5280 for this and is not doing security work: the value
 * is how one certificate points at the key that signed it, so what matters is
 * that two different keys do not collide by accident. Substituting SHA-256
 * would produce a 32-byte identifier that some trust stores index differently,
 * for no gain.
 */
export function keyIdentifier(publicKey: KeyObject): Buffer {
  const rsaPublicKey = publicKey.export({ type: "pkcs1", format: "der" });
  return createHash("sha1").update(rsaPublicKey).digest();
}

/** The extensions of one certificate, in the order they are written. */
function encodeExtensions(spec: CertificateSpec, publicKey: KeyObject): Buffer {
  const extensions: Buffer[] = [];

  // Critical, both of them, and deliberately so: a client that does not
  // understand what this certificate may be used for must refuse it rather
  // than assume. An unconstrained leaf certificate is a certificate authority
  // to anything that does not look.
  extensions.push(
    extension(
      OID.basicConstraints,
      true,
      sequence(
        ...(spec.basicConstraints.ca ? [boolean(true)] : []),
        ...(spec.basicConstraints.pathLength === undefined
          ? []
          : [integer(spec.basicConstraints.pathLength)]),
      ),
    ),
  );
  extensions.push(
    extension(
      OID.keyUsage,
      true,
      namedBits(spec.keyUsage.map((usage) => KEY_USAGE_BITS[usage])),
    ),
  );

  if (spec.extendedKeyUsage !== undefined && spec.extendedKeyUsage.length > 0) {
    // Not critical: a certificate authority's own certificate carries none, and
    // marking a leaf's critical adds nothing a TLS client does not already do.
    extensions.push(
      extension(
        OID.extendedKeyUsage,
        false,
        sequence(...spec.extendedKeyUsage.map(objectIdentifier)),
      ),
    );
  }

  extensions.push(
    extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(publicKey))),
  );
  if (spec.authorityKeyIdentifier !== undefined) {
    // `[0] IMPLICIT` inside the AuthorityKeyIdentifier sequence: the field is a
    // KeyIdentifier, which is an OCTET STRING, and the implicit tag replaces
    // that type's tag rather than wrapping it.
    extensions.push(
      extension(
        OID.authorityKeyIdentifier,
        false,
        sequence(implicit(0, spec.authorityKeyIdentifier)),
      ),
    );
  }

  const altName = spec.subjectAltName;
  if (altName !== undefined && altName.dnsNames.length + altName.ipAddresses.length > 0) {
    extensions.push(
      extension(
        OID.subjectAltName,
        false,
        sequence(
          // GeneralName's dNSName is [2] and iPAddress is [7], both implicit.
          // The common name is not a name a modern TLS client looks at, so
          // everything a client may be dialled with has to be in here.
          ...altName.dnsNames.map((name) => implicit(2, ia5Bytes(name))),
          ...altName.ipAddresses.map((address) => implicit(7, encodeIpAddress(address))),
        ),
      ),
    );
  }

  return sequence(...extensions);
}

/** Where one tag-length-value sits inside a buffer. */
interface Span {
  /** Offset of the first content byte. */
  readonly contentStart: number;
  /** Offset one past the last content byte, which is where the next value starts. */
  readonly end: number;
}

/**
 * Find the extent of the value beginning at `offset`.
 *
 * This is not a DER parser and is not meant to become one: it reads a tag and a
 * length so that a caller can step over a field or take one out whole. Tags are
 * single-byte, which every field of a certificate's outer structure has.
 */
function spanAt(der: Buffer, offset: number): Span {
  const lengthByte = der[offset + 1];
  if (der[offset] === undefined || lengthByte === undefined) {
    throw new UnencodableValueError("a certificate ends in the middle of a field");
  }
  if (lengthByte < 0x80) {
    return { contentStart: offset + 2, end: offset + 2 + lengthByte };
  }
  const lengthBytes = lengthByte & 0x7f;
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    const byte = der[offset + 2 + index];
    if (byte === undefined) {
      throw new UnencodableValueError("a certificate ends in the middle of a length");
    }
    length = length * 256 + byte;
  }
  const contentStart = offset + 2 + lengthBytes;
  return { contentStart, end: contentStart + length };
}

/**
 * The `subject` field of a certificate, exactly as it is encoded in it.
 *
 * A chain joins on bytes: the issuer name of one certificate has to equal the
 * subject name of the one above it octet for octet, and a name rebuilt from its
 * parts is equal only if every choice — the order of the components, the string
 * type each is written as — is made the same way twice. Copying the field
 * removes the question, and makes a storage root that was moved to a machine
 * with a different name go on working.
 *
 * The path to it is fixed by X.509: Certificate is a SEQUENCE whose first
 * element is the TBSCertificate, and inside that the subject is the sixth
 * element after the optional version tag.
 */
export function subjectNameOf(certificateDer: Buffer): Buffer {
  const certificate = spanAt(certificateDer, 0);
  const tbs = spanAt(certificateDer, certificate.contentStart);
  let offset = tbs.contentStart;
  // [0] EXPLICIT version, present on every v3 certificate and optional in the
  // grammar, so its absence is stepped around rather than assumed.
  if (certificateDer[offset] === 0xa0) {
    offset = spanAt(certificateDer, offset).end;
  }
  // serialNumber, signature, issuer, validity — four fields, then the subject.
  for (let field = 0; field < 4; field += 1) {
    offset = spanAt(certificateDer, offset).end;
  }
  const subject = spanAt(certificateDer, offset);
  return certificateDer.subarray(offset, subject.end);
}

/** Wrap DER in the PEM armour every tool and node's TLS stack reads. */
export function toPem(der: Buffer, label: string): string {
  const body = der.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

/** The conventional colon-separated upper-case hex of a digest. */
export function colonHex(digest: Buffer): string {
  return digest.toString("hex").toUpperCase().replace(/..(?!$)/g, "$&:");
}

/**
 * The SHA-256 fingerprint of a certificate, in the form people compare.
 *
 * A fingerprint is over the DER of the whole certificate, not over the public
 * key and not over the PEM text. Hashing anything else produces a value that
 * still looks like a fingerprint and matches nothing a person can check it
 * against.
 */
export function fingerprintOf(certificateDer: Buffer): string {
  return colonHex(createHash("sha256").update(certificateDer).digest());
}

/**
 * Make one certificate.
 *
 * A self-signed certificate is this with the subject equal to the issuer and
 * the subject's own private key signing; there is no separate path for it,
 * because there is no difference in the encoding.
 */
export function createCertificate(spec: CertificateSpec): Certificate {
  if (spec.notAfter.getTime() <= spec.notBefore.getTime()) {
    throw new UnencodableValueError("a certificate cannot expire before it is valid");
  }

  const tbsCertificate = sequence(
    // Version 2 is X.509 v3: the numbering starts at 0, and v3 is the only
    // version that may carry extensions at all.
    explicit(0, integer(2)),
    unsignedInteger(spec.serialNumber),
    // Written twice on purpose. The algorithm inside the signed bytes and the
    // one beside the signature must agree, and a verifier that trusted only the
    // outer one could be told a certificate was signed with something weaker.
    signatureAlgorithm(),
    encodeName(spec.issuer),
    sequence(time(spec.notBefore), time(spec.notAfter)),
    encodeName(spec.subject),
    encodePublicKeyInfo(spec.publicKey),
    explicit(3, encodeExtensions(spec, spec.publicKey)),
  );

  const signature = createSign("RSA-SHA256")
    .update(tbsCertificate)
    .sign(spec.issuerPrivateKey);

  const der = sequence(
    tbsCertificate,
    signatureAlgorithm(),
    // A signature is a whole number of bytes, so no bits of the last one are
    // unused.
    bitString(signature, 0),
  );

  return {
    der,
    pem: toPem(der, "CERTIFICATE"),
    fingerprint256: colonHex(createHash("sha256").update(der).digest()),
  };
}
