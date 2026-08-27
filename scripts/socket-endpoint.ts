/**
 * A Team socket endpoint on its own, over TLS, for driving a real client at.
 *
 * The suites here drive the protocol with node's own WebSocket, which proves the server.
 * What no suite in this repository can prove is the join: Studio's client, its
 * certificate handling and its framing against this server's. This is the half of that
 * which lives here - a listener with one account, one project and one token, and nothing
 * else. What connects to it is somebody else's business.
 *
 * Not part of the build and not shipped. Run it against a certificate you made:
 *
 *     npx esbuild scripts/socket-endpoint.ts --bundle --platform=node --format=cjs  *       --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-drive\" --outfile=endpoint.cjs
 *     node endpoint.cjs cert.pem key.pem
 *
 * It prints one line of JSON saying where it is, what token to present and which project
 * is on it, then stays up until it is killed. Every second it publishes on the `projects`
 * topic, so a client can be seen being told rather than asking.
 */
import { createSecureServer } from "node:http2";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { createUser } from "../src/identity/users.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { createTeamSocket } from "../src/team/endpoint.js";
import { refuseUpgrade } from "../src/team/websocket.js";
import type { TeamService } from "../src/team/service.js";

async function main(): Promise<void> {
  const [, , certPath, keyPath] = process.argv;
  if (certPath === undefined || keyPath === undefined) {
    throw new Error("usage: socket-endpoint <cert.pem> <key.pem>");
  }

  const root = await mkdtemp(path.join(tmpdir(), "nlteam-e2e-"));
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const hasher = new ScryptPasswordHasher({
    cost: 2 ** 12,
    blockSize: 8,
    parallelism: 1,
    keyLength: 32,
  });
  const ada = await createUser(database, hasher, {
    username: "ada",
    password: "a password nobody guesses",
    displayName: "Ada Lovelace",
  });
  const project = createProject(database, {
    id: newProjectId(),
    name: "lighthouse",
    description: "the project this endpoint serves",
    createdBy: ada.id,
  });

  const service: TeamService = {
    database,
    keys,
    config,
    root,
    dataPort: config.dataPort,
    healthPort: DEFAULT_PORTS.healthPort,
  };
  const socket = createTeamSocket({ service, version: "0.0.0-e2e", host: "127.0.0.1" });

  const server = createSecureServer({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ALPNProtocols: ["h2", "http/1.1"],
    allowHTTP1: true,
  });
  server.on("request", (_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, raw, head) => {
    if (!socket.handleUpgrade(request, raw, head)) {
      refuseUpgrade(raw, 404, "nothing at that address accepts a WebSocket");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  const token = mintToken(ada, keys.signingKey, config, { purpose: "sign-in" }).token;
  process.stdout.write(
    `${JSON.stringify({ port, token, project: project.id, name: project.name })}\n`,
  );

  // Published on a timer, so a client can be seen being told rather than asking. It is
  // the one thing a request-and-response API could never do, and the one thing a driver
  // has to sit still for to see.
  setInterval(() => {
    socket.hub.publish("projects", { kind: "project-read", project: project.id });
  }, 1_000).unref();
  setInterval(() => undefined, 1_000);
}

void main();
