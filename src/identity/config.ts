/**
 * The settings that decide what a Team server token says and who will accept it.
 *
 * Three of them — the issuer, the audience and Team's own auth origin — are
 * written into two files at once: they appear in every token Team mints, and in
 * the `local.toml` Team generates for loreserver. A token is accepted only when
 * both copies agree, so they are read from one place rather than typed twice.
 */
import { DEFAULT_PORTS } from "../loreserver/layout.js";

/** Where the identity settings come from when an operator names none. */
export interface IdentityConfig {
  /** The `iss` claim, and loreserver's `jwt_issuer`. Any stable string. */
  readonly issuer: string;
  /**
   * The audience loreserver is configured to require. It is one entry of the
   * `aud` array, not the whole of it — see {@link tokenAudience}.
   */
  readonly audience: string;
  /**
   * Host and optional port of the endpoint Studio authenticates against,
   * without a scheme, for example `team.example.com:41402`.
   *
   * Studio refuses to use a token whose `aud` does not name the endpoint it is
   * talking to, so this value reaches the token as well as the configuration.
   * It is also the name the endpoint's certificate has to carry, which is why
   * `up --hostname` exists: a certificate for `127.0.0.1` proves nothing about
   * a machine somebody reaches as `team.example.com`.
   *
   * When an operator names none, it is this machine's loopback at the TLS
   * port, so the default configuration is consistent with itself.
   */
  readonly authOrigin: string;
  /** The `env` claim. `local` is the only value that has been tested. */
  readonly env: string;
  /** The `idp` claim: which identity provider vouched for the user. */
  readonly idp: string;
  /**
   * How long a token minted to sign in with is good for.
   *
   * Team is asked about this one every time it matters: it is presented back to
   * Team to be exchanged, and every repository access loreserver serves goes on
   * to ask Team about the account behind it. Revoking an account's access
   * therefore refuses it at once, and its expiry is not what bounds it.
   */
  readonly signInTokenLifetimeSeconds: number;
  /**
   * How long a token minted for a repository's data connection is good for.
   *
   * Much shorter than the one above, and src/identity/tokens.ts sets out why
   * the pair is not one number: this is the token presented to loreserver's
   * data plane, which Team is not necessarily asked about again before it
   * expires, so the lifetime is the only bound it has.
   */
  readonly repositoryTokenLifetimeSeconds: number;
  /** The port Team's own HTTP endpoint listens on. */
  readonly teamPort: number;
  /**
   * The port the authorization service listens on, over TLS.
   *
   * The only one it listens on. A Studio installation signs in here and will
   * not use anything else: its client library accepts only `https` and
   * `ucs-auth`, and refuses `http` and `grpc` by name. loreserver is pointed at
   * the same address and verifies the certificate there, so the plaintext copy
   * that used to sit beside it on the loopback had no caller at all.
   */
  readonly authTlsPort: number;
  /**
   * The port loreserver serves data on, which a client reaches as
   * `lore://host:port`.
   *
   * It is here, rather than only in the loreserver settings, because a token's
   * audience has to name that address — see {@link tokenAudience}. It is the
   * same number `--data-port` gives loreserver; there is no second option for
   * it, because two numbers that had to agree would eventually not.
   */
  readonly dataPort: number;
  /**
   * Host names people reach this deployment by, beyond the auth origin's own
   * host.
   *
   * The same `--hostname` values that go into the endpoint's certificate. A
   * token's audience is written for every one of them, because a collaborator
   * does not connect on `127.0.0.1` and a token whose audience names only the
   * loopback works on the Team server machine and nowhere else.
   */
  readonly hostnames: readonly string[];
}

/** The identity settings used when an operator names none. */
export const DEFAULT_IDENTITY: IdentityConfig = {
  issuer: "narraleaf-team",
  audience: "loreserver",
  // The TLS listener on this machine, so the default configuration is
  // consistent with itself. A deployment other people reach names its own host
  // with --auth-origin, and its certificate is given that name with --hostname.
  authOrigin: "127.0.0.1:41402",
  env: "local",
  idp: "narraleaf-team",
  // Both are defaults, and a Team server reads what it mints with out of its database
  // — src/identity/settings.ts. These are what answer for a setting nobody has
  // stored, which is every Team server until somebody changes one.
  signInTokenLifetimeSeconds: 30 * 24 * 60 * 60,
  repositoryTokenLifetimeSeconds: 15 * 60,
  teamPort: 41400,
  authTlsPort: 41402,
  dataPort: DEFAULT_PORTS.dataPort,
  hostnames: [],
};

/**
 * The identity settings, with anything an operator named replacing a default.
 *
 * Every command that mints a token or writes loreserver's configuration builds
 * its settings this way, so that the same options given to two commands mean
 * the same thing to both.
 *
 * The auth origin follows the TLS port when it is not named outright. Without
 * that, moving the listener with `--auth-tls-port` would leave every token
 * claiming an audience nothing listens on, and a client would refuse the token
 * it had just been given.
 */
export function identityConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  const merged = { ...DEFAULT_IDENTITY, ...overrides };
  return overrides.authOrigin === undefined
    ? { ...merged, authOrigin: `127.0.0.1:${merged.authTlsPort}` }
    : merged;
}

/**
 * The URL form of Team's auth origin.
 *
 * The scheme is fixed at `https`: the origin names an endpoint people
 * authenticate against from other machines, and a password may not travel in
 * clear. The same listener serves the JWKS, and a second loopback listener
 * serves it in plain HTTP as well — src/identity/endpoint.ts says which caller
 * needs that and what was measured before it was left there.
 */
export function authUrl(config: IdentityConfig): string {
  return `https://${config.authOrigin}`;
}

/**
 * The host part of an origin written as `host` or `host:port`.
 *
 * An IPv6 literal in an origin is bracketed, and the brackets are what tell its
 * colons from the one before the port.
 */
export function hostOf(origin: string): string {
  if (origin.startsWith("[")) {
    const close = origin.indexOf("]");
    return close === -1 ? origin : origin.slice(0, close + 1);
  }
  const colon = origin.indexOf(":");
  return colon === -1 ? origin : origin.slice(0, colon);
}

/** A host as it appears inside a URL: an IPv6 literal has to be bracketed. */
function bracketed(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Every host this deployment is reached by.
 *
 * The auth origin's host is always one: on a Team server nobody else connects to, it is
 * the only one there is. Anything an operator named with `--hostname` joins it,
 * which is the same list the endpoint's certificate is issued for — a name
 * people connect by has to be in both, and taking them from one setting is what
 * stops one being updated without the other.
 */
export function audienceHosts(config: IdentityConfig): string[] {
  return [...new Set([hostOf(config.authOrigin), ...config.hostnames])];
}

/** Where loreserver's data port is reached, as a client writes it. */
export function dataRemoteUrl(host: string, dataPort: number): string {
  return `lore://${bracketed(host)}:${dataPort}`;
}

/**
 * The `aud` array a minted token carries.
 *
 * A token's audience is not a label. It is the list of remotes the client will
 * send that token to, and it will send it to nothing else: the audience becomes
 * `acceptable_root_domains` in the client's own store, and a remote missing
 * from it is a remote the client treats as a third party it would be leaking
 * the token to. Every address a client legitimately reaches has to be in here.
 *
 * There are two such addresses, and it is the second that is easy to forget:
 *
 *   - Team's auth endpoint, `https://host:41402`, where the client signs in.
 *   - loreserver's data port, `lore://host:41337`, which is where the work
 *     happens — cloning, committing, pushing. A token naming only the first
 *     signs in successfully and then fails every repository operation with
 *     "Failed to resolve repository: No token stored", which reads like a
 *     missing token rather than a token the client declines to use.
 *
 * loreserver's own `jwt_audience` entry is here too, because loreserver checks
 * the audience before it will look at a token at all.
 *
 * Several spellings of each address are written. The comparison the client
 * makes is against strings it assembled itself, and the two sides are not known
 * to normalise a trailing slash, a scheme or a port the same way — an audience
 * seen working end to end carried the bare host, the host with its port, and
 * the URL both with and without its slash. An entry a verifier ignores costs a
 * few bytes; one a client will not match costs the whole session. Nothing here
 * should be tidied down to a single form without watching a real client do the
 * whole of a clone, commit and push against it.
 *
 * Both paths that issue a token — `nlteam token mint` and the exchange method a
 * client signs in with — build their audience here. Two lists that had to agree
 * would be two lists that eventually did not.
 *
 * Duplicates are dropped, because a repeated audience says nothing extra.
 */
export function tokenAudience(config: IdentityConfig): string[] {
  const auth = authUrl(config);
  const entries = [config.audience, auth, `${auth}/`];

  for (const host of audienceHosts(config)) {
    const remote = dataRemoteUrl(host, config.dataPort);
    entries.push(host, `${bracketed(host)}:${config.dataPort}`, remote, `${remote}/`);
  }

  return [...new Set(entries)];
}

/**
 * Where Team publishes its JWKS, as loreserver is told to fetch it.
 *
 * Plain HTTP on the loopback, which is not a preference: src/identity/endpoint.ts
 * records what happens when loreserver is pointed at the https listener instead,
 * and why the same document is served there as well.
 */
export function jwksUrl(teamPort: number, host = "127.0.0.1"): string {
  return `http://${host}:${teamPort}/.well-known/jwks.json`;
}
