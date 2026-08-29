# Changelog

## [0.1.0]

The first release of NarraLeaf Team.

### _The server_

- **One directory holds everything a server owns.** The accounts, the projects,
  the signing keys, the certificate authority and the repository store all live
  under the path `--root` names. Backing up that directory backs up the server.

- **`nlteam up` runs it.** It installs the pinned version-control server,
  verifies it against a recorded digest, writes its configuration, starts it,
  waits for its health check, and supervises it until interrupted.

- **A container image, `ghcr.io/narraleaf/team`.** `linux/amd64`, with the
  version-control binaries already unpacked, so nothing is downloaded on first
  start and a machine with no route to GitHub deploys as well as one with. A
  deployment is `compose.yaml`, `docker compose up -d`, and one command to
  create the first account.

- **Two ports reach the network.** 41402 carries sign-in and the session Studio
  holds; 41337 carries project data over TCP and QUIC. The server's own HTTP
  listener and the version-control health check are bound to the loopback.

### _Identity and access_

- **Accounts, and tokens issued from them.** An operator creates every account.
  Studio exchanges a password for a token and presents it on every request.

- **Every call is identified afresh.** The signature, the issuer, the audience
  and the expiry are checked, and then whether the account is still present, not
  disabled, and holding a token issued after its access was last revoked.
  Disabling an account or revoking its tokens takes effect on that account's next
  request rather than when the token would have expired.

- **`nlteam user disable` and `nlteam user revoke-tokens`** are the two ways to
  take access back, and they are not the same one: the first stops the account,
  the second refuses the tokens it holds and lets it sign in again.

- **`nlteam key retire`** ends a signing key's life, refusing every token that
  key signed. It is the lever for a key believed to have been exposed, and it is
  deliberately not part of rotating.

- **Every repository access is recorded.** `nlteam audit` reads the decisions
  back, newest first, and `--refused` prints refusals only.

### _Working together_

- **Projects.** A project is a repository on the server and a row in its
  registry. Studio lists them, creates them, and copies them to a machine. A
  repository that already exists is recorded rather than created.

- **Comments anchored in a project.** A note attaches to a scene, a row or an
  asset, and travels with the project.

- **Presence and live sessions.** Who else has a project open, and the data
  attached to a session while it runs.

- **`server.collaboration`** closes a deployment to collaboration in one
  setting, leaving it holding projects and being administered.

### _Administration_

- **One protocol.** Everything a running client needs is a method on one
  authenticated session. The discovery document and the sign-in route are the
  only things served over HTTP.

- **`nlteam login`, and `--server` on every command.** A server is administered
  from any machine that has signed in, and what a command prints does not depend
  on which path it took.

- **`up`, `init` and `trust` take `--root` only.** They are what a server is
  recovered with, and they answer when the protocol does not.

### _Transport_

- **A server is its own certificate authority.** The authority lasts ten years
  and is compared once, by a person. The endpoint certificate lasts 397 days and
  is reissued without anybody being asked to trust anything again.

- **`--tls-cert` and `--tls-key` take a certificate an organization already
  holds**, which removes the comparison for everybody. The server's own
  certificate continues to be served to the loopback, which is where the
  version-control server asks about callers.

### _Known limits_

- Every account on a server reaches every project on it. There is no per-project
  access.
- Any account may take any project off the list. The repository is untouched.
- Real-time collaboration is not finished.
- Upgrading between pinned versions of the version-control server is not
  implemented.

[docs/security.md](docs/security.md) records these and the accepted risks in
full.
