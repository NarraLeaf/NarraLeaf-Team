/**
 * The `up` command: from nothing to a running, healthy loreserver, with Team's
 * own endpoint beside it.
 *
 * Every step announces itself, because the first one can take a minute on a
 * slow connection and a silent program is indistinguishable from a stuck one.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteText } from "./cli.js";
import type { GrpcServer } from "./grpc/server.js";
import {
  audienceHosts,
  authUrl,
  dataRemoteUrl,
  hostOf,
  identityConfig,
  jwksUrl,
  type IdentityConfig,
} from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { discoveryDocument, type DiscoverySource } from "./identity/discovery.js";
import { IdentityEndpoint } from "./identity/endpoint.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { namedTokenLifetimes, persistIdentity } from "./identity/settings.js";
import { countUsers } from "./identity/users.js";
import { prepareLoreEnvironment } from "./lore/environment.js";
import {
  ensureLorelibNotices,
  LORELIB_VERSION,
  resolveLorelibArtifact,
} from "./lore/pin.js";
import { waitForHealth, healthCheckUrl } from "./loreserver/health.js";
import { verifyBinaryDigest, verifyBinaryVersion } from "./loreserver/identify.js";
import { ensureInstalled } from "./loreserver/install.js";
import {
  instanceLayout,
  writeInstance,
  type LoreserverAuth,
  type LoreserverPorts,
} from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import { Supervisor, describeExit } from "./loreserver/supervisor.js";
import { ProjectReadings } from "./projects/refresh.js";
import { startAuthorizationService } from "./projects/service.js";
import { TeamBlobStore } from "./team/blobs.js";
import { createTeamSocket, type TeamSocket } from "./team/endpoint.js";
import { projectTopic } from "./team/protocol.js";
import { refuseUpgrade } from "./team/websocket.js";
import { ensureCertificates, type TeamAuthority } from "./tls/authority.js";
import { trustCommandFor } from "./tls/trust.js";
import { VERSION } from "./version.js";
import type { TeamService } from "./team/service.js";
import { webHandler } from "./web/router.js";

export interface UpOptions extends LoreserverPorts {
  /** The storage root; everything Team writes goes underneath it. */
  readonly root: string;
  /**
   * True to configure loreserver to demand a Team server token. Without it the server
   * asks nobody who they are, which is what it did before Team could issue
   * tokens at all.
   */
  readonly identity?: boolean;
  /**
   * Identity settings an operator named; the rest keep their defaults.
   *
   * `hostnames` among them: the names people reach this Team server by go into the auth
   * endpoint's certificate and into every token's audience, and taking both
   * from one setting is what stops a Team server whose certificate names a host issuing
   * tokens that do not.
   */
  readonly overrides?: Partial<IdentityConfig>;
  /**
   * Aborted to bring the command down. Without one, `up` runs until
   * loreserver can no longer be kept alive.
   */
  readonly signal?: AbortSignal;
}

/** A promise that settles when the signal is aborted, and never otherwise. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The environment that lets loreserver reach Team's https auth endpoint.
 *
 * `auth_url` serves two callers at once. It is where a client is told to sign
 * in, so it has to be the https origin — and it is also where loreserver itself
 * asks whether a caller may touch a repository. Measured against loreserver
 * 0.8.6 on Windows, with the endpoint on https and nothing else done:
 *
 *   - loreserver does connect, and does start a TLS handshake.
 *   - It refuses the certificate with `tlsv1 alert unknown ca` (alert 48), and
 *     the call fails with "Failed to connect to rebac service". A repository
 *     cannot be created, and no repository can be opened.
 *   - Its TLS client is rustls with `rustls-native-certs`, which reads
 *     `SSL_CERT_FILE` before it reads the platform's own store.
 *   - With `SSL_CERT_FILE` naming Team's authority, the handshake completes and
 *     the whole flow works: `nlteam project create` succeeds and Team logs the
 *     `CreateResource` call arriving on the TLS listener.
 *
 * So the authority is handed to loreserver directly rather than by asking an
 * operator to install it on the server machine as well. It is narrower than a
 * trust store change in both directions: only this process is affected, and
 * only for as long as Team is running it.
 *
 * The one thing it costs is that loreserver, while Team supervises it, trusts
 * Team's authority and no other. Everything a Team server-configured loreserver reaches
 * is on this machine — the JWKS over the loopback in plain HTTP, and this
 * endpoint — so there is nothing else for it to verify. A configuration that
 * gave it a remote store or a telemetry endpoint over https would need the
 * public roots back, and this is the line that would have to change.
 */
function loreserverTrustAnchor(authority: TeamAuthority): Record<string, string> {
  return { SSL_CERT_FILE: authority.layout.caCertPath };
}

/** What loreserver has to be told when identity is switched on. */
function loreserverAuth(config: IdentityConfig): LoreserverAuth {
  return {
    issuer: config.issuer,
    // One entry: this is the audience loreserver requires, not the whole of
    // what a token carries. A token is accepted when its `aud` array holds it.
    audience: [config.audience],
    jwksUrl: jwksUrl(config.teamPort),
    // The https origin, because `auth_url` is what a client is told to sign in
    // at as well as where loreserver asks about a token. src/loreserver/layout.ts
    // records what that means for loreserver's own calls.
    authUrl: authUrl(config),
  };
}

/**
 * Install, configure, start and supervise loreserver, then wait.
 *
 * Returns the process exit code.
 */
export async function up(
  options: UpOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const ports: LoreserverPorts = {
    dataPort: options.dataPort,
    healthPort: options.healthPort,
  };
  const config = identityConfig(options.overrides ?? {});
  const identity = identityLayout(options.root);

  let supervisor: Supervisor | undefined;
  let endpoint: IdentityEndpoint | undefined;
  let authorization: GrpcServer | undefined;
  let authorizationTls: GrpcServer | undefined;
  let database: DatabaseSync | undefined;
  let readings: ProjectReadings | undefined;
  /**
   * The sessions, once there are any.
   *
   * Declared out here because two things reach it and they are made at
   * different moments: the reader announces what it has read, and stopping this
   * process ends every session. Both are written before or after the socket
   * exists, so each goes through this and checks.
   */
  let team: TeamSocket | undefined;
  /** Where a live session's files wait for the machines that are short of them. */
  let blobs: TeamBlobStore | undefined;

  try {
    const artifact = resolveArtifact();
    const layout = instanceLayout(options.root, artifact.binaryName);
    stdout(`loreserver ${LORESERVER_VERSION} for ${artifact.target}\n`);
    if (artifact.caveat !== undefined) {
      stdout(`note: ${artifact.caveat}\n`);
    }
    stdout(`storage root ${layout.root}\n`);

    // Identity comes up first: it is quick, and a port already taken is worth
    // discovering before a download rather than after one.
    database = await openMigratedDatabase(identity.databasePath);
    // What this server is being brought up as, written down before anything can
    // mint against it. A token's audience depends on the ports and the host
    // names, and a `nlteam token mint` run in another terminal has no command
    // line telling it either — so it reads this. Refreshed on every start, so
    // that `up --hostname newname` is what moves the deployment's identity.
    persistIdentity(database, config);
    const keys = await KeyStore.open(identity.keysDir);
    endpoint = await IdentityEndpoint.start({
      port: config.teamPort,
      // The keys directory is read again on every request, so that a
      // `nlteam key rotate` in another terminal is published without this
      // process being restarted. It is a handful of small files, and the
      // document is fetched rarely.
      jwks: async () => {
        await keys.reload();
        return keys.jwks();
      },
      version: VERSION,
    });
    stdout(`identity endpoint on ${endpoint.url}, signing with ${keys.signingKey.kid}\n`);

    // Both authorization listeners come up whether or not loreserver is told to
    // use them, so that their ports are proved free at the same moment the
    // others are, rather than on the first repository access somebody attempts.
    const service = {
      database,
      keys,
      config,
      // Only what --token-lifetime named on this command line. Everything else
      // about the two lifetimes is read from the database as each token is
      // minted, so changing a stored one reaches this process without a
      // restart.
      namedLifetimes: namedTokenLifetimes(options.overrides ?? {}),
      log: (line: string) => stdout(`${line}\n`),
      onError: (error: Error) => stderr(`nlteam: authorization service: ${error.message}\n`),
    };
    authorization = await startAuthorizationService({ ...service, port: config.authPort });
    stdout(`authorization service on ${authorization.url}\n`);

    // The certificates are generated before the listener that needs them, and
    // on every start rather than only the first: the endpoint's own certificate
    // is reissued as it approaches its expiry or when a host name is added, and
    // neither of those should wait for somebody to notice.
    const certificates = await ensureCertificates(options.root, {
      hostnames: config.hostnames,
    });
    if (certificates.generatedAuthority) {
      stdout(`generated a certificate authority in ${certificates.authority.layout.tlsDir}\n`);
    }
    if (certificates.issuedLeafBecause !== undefined) {
      stdout(
        `issued a certificate for the auth endpoint: ${certificates.issuedLeafBecause}\n`,
      );
    }

    // Everything the version control library reads out of the environment is
    // settled here, before a single thing in this process can ask it for
    // anything — src/lore/environment.ts says what the two variables are and
    // what each one costs to get wrong. Deliberately not left to the reader's
    // first pass: a decision made inside a loop is a decision that has to win a
    // race, and the one it kept losing looked exactly like a permission error.
    const lore = prepareLoreEnvironment(options.root);
    if (lore.credentials !== undefined) {
      stdout(`this server signs in to its own repositories through ${lore.credentials}\n`);
    }
    if (lore.withoutAuthority !== undefined) {
      stderr(`nlteam: ${lore.withoutAuthority}\n`);
    }

    // The repositories are read beside whatever is answering questions about
    // them rather than in front of it. A Studio installation asks what a
    // project's history says over the API below, and an answer that waited for
    // a clone would be an answer that arrived after the person had gone.
    //
    // Made here because what it holds is handed to the API below, and started
    // further down, once loreserver is answering. Reading before then is a pass
    // that fails for the one reason nobody needs telling about — the server it
    // reads through has not started yet — and the sentence it produced said so
    // about every project on every start.
    const projects = new ProjectReadings({
      root: identity.root,
      database,
      config,
      // The one place a repository Team cannot read is said out loud. It is not
      // an error and nothing waits on it: `up` goes on to start loreserver
      // whatever this says, and every answer goes on reporting the project as
      // unread. What it stops is a reader that has never once worked being
      // indistinguishable from one that has not finished its first clone.
      onReadability: (line) => stdout(`${line}\n`),
      // Published on that project's own topic and not on the list's. One pass
      // over the repositories touches every project, so announcing each of them
      // to whoever holds the list would have every open Studio re-read the
      // whole thing once a minute for nothing. The list moves when somebody
      // makes a project or takes one off, which the method that did it says on
      // the list's topic itself.
      onChange: (projectId) => {
        team?.hub.publish(projectTopic(projectId), { kind: "project-read", project: projectId });
      },
    });
    readings = projects;

    // Opened before the service below, because whether there is one is part of
    // what this server announces. Opening empties the directory: a file in it
    // belongs to a live session, live sessions are held in memory, and this
    // process starting means every one of them has ended.
    const blobStore = await TeamBlobStore.open(options.root);
    blobs = blobStore;
    stdout(`live session files wait under ${identity.root}
`);

    const studio: TeamService = {
      database,
      keys,
      config,
      // What --token-lifetime named on this command line, so that the sign-in
      // route hands out the same lifetime the exchange does. Everything else
      // about the two lifetimes is read from the database as each token is
      // minted, so changing a stored one reaches this process without a restart.
      namedLifetimes: namedTokenLifetimes(options.overrides ?? {}),
      dataPort: ports.dataPort,
      blobs: true,
      // For the token the sign-in route hands out, which travels to a machine
      // that may not yet trust this server — the same claim `nlteam token mint`
      // writes, for the same reason.
      fingerprint: certificates.authority.fingerprint256,
      readings: projects,
      log: (line) => {
        stdout(`${line}\n`);
      },
    };

    // Made here rather than beside the listener because it needs the service
    // above and the listener needs it: one object, handed to the thing that
    // starts sessions and to the things that publish into them.
    const socket = createTeamSocket({
      service: studio,
      version: VERSION,
      host: hostOf(config.authOrigin),
    });
    team = socket;

    // The one address an author is given resolves to the listener below. It
    // answers before they have an account, which is the point: a server that
    // cannot say where to sign in is a server somebody has to be told about in
    // a chat message.
    const discovery: DiscoverySource = {
      database,
      // What this server is called until somebody names it, which is read out
      // of the database as each request is answered rather than here.
      host: hostOf(config.authOrigin),
      auth: { required: options.identity === true, url: authUrl(config) },
      data: { url: dataRemoteUrl(hostOf(config.authOrigin), config.dataPort) },
      // The one capability list, taken from the socket that worked it out - the
      // same list its `hello` frame carries. Worked out from what this build
      // actually answers rather than written down a second time: a capability
      // announced by a build that does not serve it is the one failure a client
      // cannot recover from, because checking before asking is the whole of what
      // a capability is for.
      capabilities: team.capabilities,
      authority: { sha256: certificates.authority.fingerprint256 },
      version: VERSION,
    };

    authorizationTls = await startAuthorizationService({
      ...service,
      port: config.authTlsPort,
      // Every interface, not the loopback: this is the listener a Studio
      // installation on somebody else's machine reaches, and one bound to
      // 127.0.0.1 would be reachable by nobody but this machine — which is what
      // the plaintext listener is already for.
      anyInterface: true,
      portOption: "--auth-tls-port",
      tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
      http1: webHandler(() => discoveryDocument(discovery), {
        studio,
        blobs: { store: blobStore, presence: socket.presence, service: studio },
      }),
      upgrade: (request, socket, head) => {
        if (team?.handleUpgrade(request, socket, head) === true) {
          return;
        }
        // Still speaking HTTP at this point, so this is a status and a sentence
        // rather than a dropped socket. See src/team/endpoint.ts.
        refuseUpgrade(socket, 404, "nothing at that address accepts a WebSocket");
      },
    });
    stdout(
      `auth endpoint on port ${config.authTlsPort} of every interface, over TLS, ` +
        `reached as ${authUrl(config)}\n`,
    );
    stdout(`its certificate authority is ${certificates.authority.fingerprint256}\n`);
    stdout(
      "a machine that has not trusted this server cannot connect: compare\n" +
        "that fingerprint with\n" +
        `      nlteam trust --root ${identity.root}\n` +
        `      and then run ${trustCommandFor(certificates.authority.layout.caCertPath)}\n`,
    );

    // Where the binary is decides nothing else: it is the one thing not under
    // the storage root, and src/loreserver/install.ts answers with the path
    // that was actually used rather than the one a layout would predict.
    const install = await ensureInstalled(layout, artifact, {
      onAlreadyInstalled: (path) => stdout(`already installed at ${path}\n`),
      onFetching: (url) => stdout(`fetching ${url}\n`),
      onVerifying: (bytes) =>
        stdout(`verifying ${bytes.toLocaleString("en-US")} bytes against the pinned checksum\n`),
      onExtracting: (binDir) => stdout(`extracting into ${binDir}\n`),
    });

    // The version control library arrives through npm, which does not carry
    // the two files it is redistributed under; they come from the release
    // instead. Nothing depends on this having worked — it is an obligation of
    // shipping somebody else's library, not a precondition of running — so a
    // machine that cannot reach GitHub says so once and carries on.
    const lorelib = resolveLorelibArtifact();
    if (lorelib !== undefined) {
      try {
        const notices = await ensureLorelibNotices(options.root, lorelib);
        if (!notices.alreadyPresent) {
          stdout(`kept lorelib ${LORELIB_VERSION}'s license and notices in ${notices.directory}\n`);
        }
      } catch (error) {
        stderr(`nlteam: could not fetch lorelib's license and notices: ${describeError(error)}\n`);
      }
    }

    // Both checks run on every start, including one that installed nothing:
    // the archive digest says what was downloaded, which is not the same as
    // what is on disk now.
    await verifyBinaryDigest(install.binaryPath, artifact.binarySha256);
    const reported = await verifyBinaryVersion(install.binaryPath, LORESERVER_VERSION);
    stdout(
      `verified ${install.binaryPath} is loreserver ${reported}, matching its pinned checksum\n`,
    );

    const auth = options.identity === true ? loreserverAuth(config) : undefined;
    await writeInstance(layout, ports, auth);
    stdout(`wrote ${layout.configPath}\n`);
    if (auth === undefined) {
      // On stderr, and saying what it costs rather than what to type. This is
      // the branch somebody has to ask for: loreserver is configured with no
      // authorization at all, so nothing between a stranger and every
      // repository on this server is left, and the accounts, the tokens and
      // the keys this process is otherwise about are not consulted once.
      stderr(
        "nlteam: --no-identity: loreserver will accept any client that can reach it, and\n" +
          "        Team will not be asked about anybody. Every repository on this server is\n" +
          "        readable and writable by whoever finds the port.\n",
      );
    } else {
      stdout(`loreserver will demand a token from ${auth.issuer} for ${auth.audience[0]}\n`);
      stdout(`clients are told to sign in at ${auth.authUrl}\n`);
      // The remotes a token authorises, spelled out. A client will not send its
      // token to a remote its audience does not name, so an operator whose
      // collaborators connect by a name that is missing here has a Team server that
      // works from its own machine and nowhere else.
      stdout(
        `tokens are good for ${audienceHosts(config)
          .map((host) => dataRemoteUrl(host, config.dataPort))
          .join(", ")}\n`,
      );
      stdout(
        `loreserver reaches that endpoint too, and is given ${
          certificates.authority.layout.caCertPath
        }\n      as the only authority it trusts while Team runs it\n`,
      );
    }

    // Only a failure that ends supervision should cut the health wait short; a
    // single early exit is followed by a restart and may still come good.
    let supervisionError: Error | undefined;

    supervisor = new Supervisor({
      name: "loreserver",
      command: install.binaryPath,
      args: ["--config", layout.configDir],
      logPath: layout.logPath,
      // See the note on loreserverTrustAnchor: without this, loreserver cannot
      // reach the https `auth_url` it was configured with, and every repository
      // access fails.
      ...(auth === undefined ? {} : { env: loreserverTrustAnchor(certificates.authority) }),
      onEvent: (event) => {
        switch (event.kind) {
          case "started":
            stdout(`started loreserver, pid ${event.pid}\n`);
            break;
          case "exited":
            if (!event.deliberate) {
              stderr(`nlteam: loreserver exited: ${describeExit(event.code, event.signal)}\n`);
            }
            break;
          case "restarting":
            stderr(
              `nlteam: restarting loreserver in ${(event.delayMs / 1000).toFixed(2)}s ` +
                `after ${event.consecutiveFailures} failure(s)\n`,
            );
            break;
          case "gave-up":
            supervisionError = event.error;
            break;
        }
      },
    });

    stdout(`logging to ${layout.logPath}\n`);
    await supervisor.start();

    const elapsedMs = await waitForHealth(ports.healthPort, {
      abandonReason: () => supervisionError?.message,
    });
    stdout(
      `healthy after ${(elapsedMs / 1000).toFixed(1)}s: ${healthCheckUrl(ports.healthPort)}\n`,
    );
    stdout(`gRPC and QUIC on port ${ports.dataPort}\n`);

    // Now, and not before: every read goes through the server that has just
    // this moment become able to answer. Nothing waits on this — the API and
    // the interface have been served for several steps already, and a project
    // nobody has read yet is drawn as one nobody has read yet.
    projects.start();

    // Last, so that it is the thing left on the screen rather than something
    // scrolled away by a download.
    printFirstAccountNotice(database, identity.root, stdout);

    stdout("press Ctrl-C to stop\n");

    // Whichever comes first: the operator interrupting, or supervision ending.
    const failure = await Promise.race([
      supervisor.failed,
      whenAborted(options.signal).then(() => undefined),
    ]);

    await supervisor.stop();

    if (failure !== undefined) {
      stderr(`nlteam: ${failure.message}\n`);
      return 1;
    }
    stdout("stopped loreserver\n");
    return 0;
  } catch (error) {
    // Anything raised after the child was spawned still has to take it down;
    // leaving a loreserver behind after a failed `up` would be worse than the
    // failure itself.
    if (supervisor !== undefined) {
      await supervisor.stop();
    }
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    // Both servers hold a listening socket and the database a file handle; any
    // of them would keep the process alive after the work is over.
    if (endpoint !== undefined) {
      await endpoint.close();
    }
    if (authorization !== undefined) {
      await authorization.close();
    }
    if (authorizationTls !== undefined) {
      await authorizationTls.close();
    }
    // It holds a timer and a reader that would go on reading repositories
    // through a database that is about to be closed under it.
    // Before the database closes, and with a sentence. A session that simply
    // stopped answering is one whose client reconnects into a machine that is
    // going down, and then does it again a second later.
    team?.hub.closeAll("this server is shutting down");
    // It holds a sweep timer and parked readers, each of which is a response
    // waiting for a byte that is not going to come now.
    blobs?.close();
    readings?.stop();
    database?.close();
  }
}

/**
 * Say how to make the first account, while there is no account yet.
 *
 * `up` does not make one itself. It runs until it is interrupted, and the
 * command that makes an account reads a password from standard input, so the
 * two cannot be the same command: whoever is running this needs a second
 * terminal, and what they need from this one is the line to type into it.
 *
 * Once an account exists, nothing is printed again.
 */
function printFirstAccountNotice(
  database: DatabaseSync,
  root: string,
  stdout: WriteText,
): void {
  if (countUsers(database) > 0) {
    return;
  }
  stdout("\n");
  stdout("This server has no accounts. Make the first one, from another terminal:\n");
  stdout("\n");
  stdout(`    nlteam init <username> --root ${root}\n`);
  stdout("\n");
  stdout("It joins the admin group, and reads its password from standard input.\n");
}
