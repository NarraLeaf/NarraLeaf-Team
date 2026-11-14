/**
 * Minting the tokens a Studio installation presents to loreserver.
 *
 * The claim set is not a suggestion. loreserver 0.8.6 refuses a token that is
 * missing any of these and names the field it wanted, so every one of them is
 * written on every token:
 *
 *     iss                 matches loreserver's configured jwt_issuer
 *     aud                 an array, holding loreserver's audience and the
 *                         origin of Team's auth endpoint
 *     sub                 the user id
 *     env                 environment name
 *     name                display name
 *     preferred_username
 *     groups              array, possibly empty
 *     is_service_account  boolean
 *     idp                 which identity provider vouched for the user
 *     iat, exp
 *
 * Three claims are Team's own:
 *
 *     token_epoch         the account's `token_epoch` when this was signed
 *     authority_sha256    the fingerprint of this Team server's certificate authority
 *     grant               the OAuth grant (one signed-in device) this token belongs to,
 *                         on tokens issued through the browser sign-in only
 *
 * The first is there because Team is a verifier too — it is the service
 * loreserver asks about a caller — and the epoch is what makes tokens minted
 * before a revocation refusable without keeping a list of every token ever
 * issued. loreserver ignores a claim it does not know.
 *
 * The second is read by Studio, and it is what turns trusting this Team server from a
 * paragraph of instructions into a decision somebody can make. See
 * {@link MintOptions.authorityFingerprint} for why a fingerprint carried this
 * way is worth as much as one read down a telephone.
 *
 * Nothing else is added. An extra claim is not refused, but one no verifier
 * reads would be something every token carries for nobody.
 */
import { createPublicKey, createSign, createVerify } from "node:crypto";

import { authUrl, tokenAudience, type IdentityConfig } from "./config.js";
import type { TeamKey, KeyStore } from "./keys.js";
import type { UserRecord } from "./users.js";

/** The claims of one token, in the shape they are signed in. */
export interface TokenClaims {
  readonly iss: string;
  readonly aud: readonly string[];
  readonly sub: string;
  readonly env: string;
  readonly name: string;
  /** The account's address, absent when it has none recorded. */
  readonly email?: string;
  readonly preferred_username: string;
  readonly groups: readonly string[];
  readonly is_service_account: boolean;
  readonly idp: string;
  /** Seconds since the epoch, as JWT counts time. */
  readonly iat: number;
  readonly exp: number;
  /** The account's `token_epoch` at the moment this was signed. */
  readonly token_epoch: number;
  /**
   * SHA-256 of this Team server's certificate authority, colon-separated upper-case
   * hex — the same string `nlteam trust` prints.
   *
   * Absent on a token minted where no authority could be read, and on every
   * token minted for Team's own use: it is written for the one reader outside
   * this program.
   */
  readonly authority_sha256?: string;
  /**
   * The OAuth grant this token was issued under — one Studio installation an
   * account signed in through the browser. Checked on every verification
   * Team makes (src/identity/bearer.ts), so revoking the device refuses its
   * tokens at once rather than at their expiry, and carried through both
   * exchanges so the tokens they mint answer to the same grant.
   */
  readonly grant?: string;
  /**
   * What the bearer may do to which resources.
   *
   * loreserver's data connection insists on this claim, and the shape is not
   * negotiable — it deserializes into `Option<Vec<ResourcePermission>>`, whose
   * fields the binary names as `resource_id` and `permission`. Both mistakes
   * fail silently in different ways and neither says which claim was wrong:
   *
   *   - Absent, the token decodes and is logged with `resources: None`, and the
   *     storage connection answers `AuthorizationFailure`.
   *   - Present as an array of plain strings, the token fails to decode at all,
   *     and the log shows "Decoding JWT token" with no result after it.
   */
  readonly resources?: readonly ResourceClaim[];
}

/**
 * One resource a token is good for.
 *
 * The same pair as the gRPC `ResourcePermission` message, in its JSON form.
 * The names are loreserver's, which is why they are not camel case like every
 * other field here.
 */
export interface ResourceClaim {
  readonly resource_id: string;
  readonly permission: readonly string[];
}

/** The JOSE header of one token. */
export interface TokenHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
  /** Which published key verifies this token. */
  readonly kid: string;
}

/** A minted token and everything about it a caller might record. */
export interface MintedToken {
  /** The compact JWT: header, claims and signature, dot-separated. */
  readonly token: string;
  readonly header: TokenHeader;
  readonly claims: TokenClaims;
  /**
   * The `token_epoch` the user was at when this was minted.
   *
   * Recorded so that whatever exchanges a token later can compare it with the
   * user's epoch as it stands then, and refuse to renew one issued before a
   * revocation.
   */
  readonly tokenEpoch: number;
}

/** Raised when a token was asked for on behalf of an account that is disabled. */
export class DisabledAccountError extends Error {
  constructor(readonly username: string) {
    super(`${username} is disabled, so no token can be issued for them.`);
    this.name = "DisabledAccountError";
  }
}

/** Base64url of a JSON value, which is how JOSE writes both of a token's parts. */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * What a token is for, which is the whole of what decides how long it lasts.
 *
 * The two are set out under {@link mintToken}. They are a closed pair rather
 * than a number a caller passes, so that the reasoning about which one is safe
 * to lengthen lives in one place instead of at every mint site.
 */
export type TokenPurpose = "sign-in" | "repository";

/** Options a caller may vary per token. */
export interface MintOptions {
  /** When the token is issued. Supplied by tests; defaults to the clock. */
  readonly now?: Date;
  /**
   * Which lifetime this token gets, defaulting to the sign-in one.
   *
   * That default is what nearly every mint wants — `nlteam token mint`, the
   * sign-in exchange, and the token `project create` presents to loreserver.
   * The one place that must say otherwise is the multiresource exchange in
   * src/projects/service.ts, and it does.
   */
  readonly purpose?: TokenPurpose;
  /**
   * The resources this token is being issued for, written as the `resources`
   * claim. Given by the two exchanges a client makes; a token minted for
   * anything else opens no data connection and names none.
   */
  readonly resources?: readonly ResourceClaim[];
  /** The OAuth grant the token belongs to, written as the `grant` claim. */
  readonly grant?: string;
  /**
   * The fingerprint of this Team server's authority, for a token that is going to
   * leave the building.
   *
   * Written by the two mints whose token travels to a machine which may not yet
   * trust this Team server: `nlteam token mint`, which prints one for an
   * operator to hand over, and the sign-in route a Studio installation calls
   * with a password. Every other mint here happens on a connection that already
   * exists, and a fingerprint on those would be carried for nobody.
   *
   * **Why a fingerprint in a token is not circular reasoning.** Nothing
   * verifies this claim's signature before acting on it — the key that would
   * verify it is published behind the very certificate in question. What makes
   * it worth something is where the token has been: an operator minted it and
   * handed it to one person, over a telephone, a chat window or a piece of
   * paper. That is the same out-of-band channel a spoken fingerprint would
   * travel down, so a token carrying one is worth exactly what the spoken one
   * was worth, and asks nobody to compare 95 characters by eye. Anything able
   * to tamper with a token in transit could equally have dictated a
   * fingerprint of its own.
   */
  readonly authorityFingerprint?: string;
}

/**
 * Sign a token for `user`.
 *
 * What revoking access does, and what it does not
 * ----------------------------------------------
 * loreserver checks a token's signature and its expiry. It asks Team nothing
 * else: there is no introspection call, no revocation list, and no callback.
 * Team therefore cannot withdraw a token it has already handed out.
 *
 * What that means in practice:
 *
 *   - Disabling an account takes effect at once for anything that mints or
 *     exchanges a token. This function refuses outright, and so does the sign-in
 *     path; the account cannot obtain anything new from the moment it is
 *     disabled.
 *   - Bumping the user's `token_epoch` refuses that token everywhere Team is the
 *     one checking it: the epoch is written into the token, and {@link
 *     verifyToken}'s caller compares it with the account's epoch as it stands
 *     now. Since every repository access goes on to ask Team, that is nearly
 *     everywhere.
 *   - Against whatever does not ask Team, a token already in someone's hands
 *     keeps working until `exp`. Nothing in this system can stop that, short of
 *     rotating and retiring the signing key, which invalidates everybody's
 *     tokens at once.
 *
 * Why there are two lifetimes and not one
 * ---------------------------------------
 * That last point is the whole of the difference between them.
 *
 * A sign-in token is one Team is asked about every time it matters. It comes
 * back to Team to be exchanged, and the exchange refuses a disabled account or a
 * stale epoch on the spot; so does the permission question loreserver asks on
 * every repository access. Its expiry is not what bounds it, so it lasts thirty
 * days rather than making somebody sign in again every quarter of an hour.
 *
 * A repository token is presented on the data connection, to loreserver's data
 * plane, and Team is not necessarily consulted again before it expires. Nothing
 * done here reaches a connection that is already open. The lifetime is that
 * token's only bound, which is why it is fifteen minutes however inconvenient
 * that is, and why lengthening it is not the same kind of decision as
 * lengthening the other one.
 */
export function mintToken(
  user: UserRecord,
  key: TeamKey,
  config: IdentityConfig,
  options: MintOptions = {},
): MintedToken {
  if (user.disabledAt !== undefined) {
    throw new DisabledAccountError(user.username);
  }

  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const lifetimeSeconds =
    options.purpose === "repository"
      ? config.repositoryTokenLifetimeSeconds
      : config.signInTokenLifetimeSeconds;
  const header: TokenHeader = { alg: "RS256", typ: "JWT", kid: key.kid };
  const claims: TokenClaims = {
    iss: config.issuer,
    // Assembled from the configuration, never a literal: one of the two
    // entries is the origin of Team's own auth endpoint, which is a fact about
    // where this Team server is deployed.
    aud: tokenAudience(config),
    sub: user.id,
    env: config.env,
    name: user.displayName,
    // Written only when the account has one. A revision's author is a name and
    // an address by convention everywhere else, and a client that takes its
    // authorship from this token can only write what the token carries: an
    // account with no address recorded here authors as a bare name, which is
    // true, rather than as a name and an invented address, which would not be.
    ...(user.email === undefined ? {} : { email: user.email }),
    preferred_username: user.username,
    groups: user.groups,
    is_service_account: user.isServiceAccount,
    idp: config.idp,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    token_epoch: user.tokenEpoch,
    // Written only when the caller had an authority to name. A Team server whose
    // storage root holds no certificates yet still mints tokens; they simply
    // carry no fingerprint, and Studio falls back to asking a person for one.
    ...(options.authorityFingerprint === undefined
      ? {}
      : { authority_sha256: options.authorityFingerprint }),
    // Written only when there are resources to name. An empty array is not the
    // same as an absent claim to a reader that treats the field as optional,
    // and a token for signing in is good for no resources rather than for none.
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    ...(options.grant === undefined ? {} : { grant: options.grant }),
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  // RSASSA-PKCS1-v1_5 with SHA-256 — the "RS256" the header names, and what
  // loreserver has been shown to verify. Naming the digest and the key is the
  // whole of the choice; node reads the padding from the key type.
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);

  return {
    token: `${signingInput}.${signature.toString("base64url")}`,
    header,
    claims,
    tokenEpoch: user.tokenEpoch,
  };
}

/** The header and claims of a compact JWT, without checking its signature. */
export function decodeToken(token: string): { header: unknown; claims: unknown } {
  const [header, claims] = token.split(".");
  if (header === undefined || claims === undefined) {
    throw new Error("this is not a compact JWT: it has fewer than three parts");
  }
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as unknown,
  };
}

/** Why a token was not accepted. */
export type TokenRefusal =
  | "malformed"
  | "unsupported-algorithm"
  /** No published key has that `kid`, so nothing here signed it, or it was retired. */
  | "unknown-key"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired";

/** What checking a token came to. */
export type TokenVerification =
  | { readonly kind: "verified"; readonly claims: TokenClaims; readonly kid: string }
  | { readonly kind: "refused"; readonly reason: TokenRefusal };

/** One sentence for each way a token can be refused. */
export const TOKEN_REFUSAL_REASONS: Readonly<Record<TokenRefusal, string>> = {
  malformed: "the token is not a JWT this server could take apart",
  "unsupported-algorithm": "the token is not signed with RS256",
  "unknown-key": "no published key of this server signed the token",
  "bad-signature": "the token's signature does not match its contents",
  "wrong-issuer": "the token was issued by somebody else",
  "wrong-audience": "the token was not meant for this server",
  expired: "the token has expired",
};

/** Read the JSON of a token's parts, or say it is not a token. */
function segments(
  token: string,
): { header: unknown; claims: unknown; signingInput: string; signature: Buffer } | undefined {
  const parts = token.split(".");
  const [header, claims, signature] = parts;
  if (parts.length !== 3) {
    return undefined;
  }
  if (header === undefined || claims === undefined || signature === undefined) {
    return undefined;
  }
  try {
    return {
      header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown,
      claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as unknown,
      signingInput: `${header}.${claims}`,
      signature: Buffer.from(signature, "base64url"),
    };
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Read a decoded claim set, insisting on every claim Team writes.
 *
 * A token missing one is refused rather than defaulted: everything here comes
 * out of {@link mintToken}, so an absent claim means the token came from
 * something else that happened to have the key.
 */
function readClaims(value: unknown): TokenClaims | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const claims = value as Record<string, unknown>;
  const { iss, sub, env, name, preferred_username, idp, aud, groups } = claims;
  const { is_service_account, iat, exp, token_epoch, grant } = claims;
  if (
    typeof iss !== "string" ||
    typeof sub !== "string" ||
    typeof env !== "string" ||
    typeof name !== "string" ||
    typeof preferred_username !== "string" ||
    typeof idp !== "string" ||
    typeof is_service_account !== "boolean" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof token_epoch !== "number" ||
    !isStringArray(aud) ||
    !isStringArray(groups) ||
    (grant !== undefined && typeof grant !== "string")
  ) {
    return undefined;
  }
  return {
    iss,
    aud,
    sub,
    env,
    name,
    preferred_username,
    groups,
    is_service_account: is_service_account,
    idp,
    iat,
    exp,
    token_epoch,
    ...(typeof grant === "string" ? { grant } : {}),
  };
}

/** Options a caller may vary per verification. */
export interface VerifyOptions {
  /** The moment to judge expiry against. Supplied by tests; defaults to now. */
  readonly now?: Date;
}

/**
 * Check a token Team signed.
 *
 * This is the same check loreserver makes of the same token, done again by the
 * side that has the private keys, because loreserver's answer is not something
 * Team can see: loreserver forwards the caller's `authorization` header to Team
 * and asks what that caller may reach, and an unreadable header has to mean the
 * caller may reach nothing.
 *
 * Only a published key verifies. A retired key stays on disk so that its
 * `kid` can be recognised, and a token it signed is refused here for the same
 * reason it is refused by anything holding the JWKS: retiring is how a key
 * stops being trusted.
 *
 * Nothing in the database is consulted — this settles what the token says, not
 * whether the account it names may still do anything. src/identity/bearer.ts is
 * where those two are put together.
 */
export function verifyToken(
  token: string,
  keys: KeyStore,
  config: IdentityConfig,
  options: VerifyOptions = {},
): TokenVerification {
  const parts = segments(token);
  if (parts === undefined) {
    return { kind: "refused", reason: "malformed" };
  }

  const header = parts.header as { alg?: unknown; kid?: unknown } | null;
  if (header === null || typeof header !== "object" || typeof header.kid !== "string") {
    return { kind: "refused", reason: "malformed" };
  }
  if (header.alg !== "RS256") {
    return { kind: "refused", reason: "unsupported-algorithm" };
  }

  const key = keys.published.find((published) => published.kid === header.kid);
  if (key === undefined) {
    return { kind: "refused", reason: "unknown-key" };
  }

  // The signature is checked before anything the token claims is read, so that
  // no decision downstream can be made from a value nobody signed. The public
  // half is derived from the key on disk rather than taken from the JWKS, which
  // is the same key by a longer route.
  const signed = createVerify("RSA-SHA256")
    .update(parts.signingInput)
    .verify(createPublicKey(key.privateKey), parts.signature);
  if (!signed) {
    return { kind: "refused", reason: "bad-signature" };
  }

  const claims = readClaims(parts.claims);
  if (claims === undefined) {
    return { kind: "refused", reason: "malformed" };
  }
  if (claims.iss !== config.issuer) {
    return { kind: "refused", reason: "wrong-issuer" };
  }
  // The audience carries loreserver's audience and this Team server's own origin. The
  // second is what says the token was meant to be presented here, rather than
  // to some other service that happens to accept the same issuer.
  if (!claims.aud.includes(authUrl(config)) && !claims.aud.includes(config.audience)) {
    return { kind: "refused", reason: "wrong-audience" };
  }

  const now = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  if (claims.exp <= now) {
    return { kind: "refused", reason: "expired" };
  }

  return { kind: "verified", claims, kid: key.kid };
}
