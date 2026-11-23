# Changelog

## [Unreleased]

### _Fixes_

- **An `http://` address on the sign-in port is redirected, not dropped.** A
  browser given `192.168.1.100:54080` with no scheme asks for `http://`, and
  the port, which speaks only TLS, closed the connection without a byte: the
  browser showed `ERR_EMPTY_RESPONSE` and the log filled with failed
  handshakes. A plaintext request is now answered with a temporary redirect
  (307) to the same address over `https://`.

## [1.0.5]

### _Changes_

- **The sign-in port is 54080 by default, not 41402.** It is still the one port
  that carries sign-in, the web console and the session Studio holds, so the
  console is now at `https://<host>:54080/console/`. A server started without
  `--auth-tls-port` moves to it on upgrade, and every address an author saved
  names the old one: keep `--auth-tls-port 41402` (or `NLTEAM_AUTH_TLS_PORT`)
  to stay where it was, or hand authors the new address. `compose.yaml`
  publishes 54080; a deployment that copied the old file publishes 41402 and
  needs the same change.

### _Fixes_

- **No keychain dialog on macOS.** Team kept the key for its own Lore sessions
  in the login keychain and rewrote it on every sign-in, so a server whose
  process the keychain did not recognise stopped at a system dialog and Studio
  read it as offline. The key now sits in `<root>/credentials` beside the
  sessions. An operator who set `LORE_AUTH_PATH` or `LORE_AUTH_STORE` keeps
  their own.
- **Restoring a backup works in a container, and from the root's own
  backups.** `restore --force` renamed the storage root aside and recreated it,
  which a mounted volume refuses and which lost an archive kept under that
  root's `backups/`. It now moves what was there into
  `<root>/before-restore-<time>/` inside the root, reads the archive from where
  it went, and leaves those directories out of later backups. In a container,
  restore with `docker compose run --rm team restore <file> --force` while the
  server is stopped.

### _Documentation_

- The deployment guide covers backups and restoring, in Docker as well, the
  browser setup page for the first account, the per-project default access,
  the web console, and the port change on upgrade from 1.0.0.

## [1.0.0]

Team holds a team project's current state, gives each project its own members
and roles, and carries the work a team does around a project. A web console
reads all of it in a browser.

### _Projects held by the server_

- **Team is the authority for a team project's documents.** Studio sends what it
  means to change; Team applies it with the same kernel Studio edits with,
  numbers the result, and tells every window that has the project open. A window
  that was offline replays what it did on its next connection.

- **Every connection agrees the kernel first.** A client names its kernel version
  in `doc.head`. Until the two agree, that connection gets no document methods
  and no document events, so a Studio built against a different kernel stays
  offline instead of writing documents the other side reads differently. Studio
  says which version each side has.

- **A first follow keeps unsaved local work.** Before a window adopts the
  server's version, Studio records what it had not saved in local history. If
  that save fails, the window stays offline with the work intact.

- **Versions, compare and restore.** Any two revisions compare; a restore puts a
  project back to a revision and is itself a version. Work in a team project is
  credited to the person who did it, and Team commits and pushes from its own
  working copy.

### _Access_

- **Access is per project.** Each project has members, each an owner, editor,
  reviewer or viewer. A project somebody has no role in is, to them, not there.
  Presence, live rooms and events stay inside the project they belong to.

- **Sign-in grew.** Studio signs in through the browser with OAuth. Two-step
  sign-in, SSO, API tokens, reset links and account policies are on the server.

- **Permission templates, asking for access, and who may make and remove
  projects**, with the areas each editor may change.

### _Working together_

- **To-dos, review requests, milestones and approvals**, with kinds, labels,
  priorities and the revision that finished each one. A viewer's to-dos stay
  private.

- **Activity, notifications, watches, reactions, chat and a discussion area**,
  with email digests and push.

- **Comments beside the line, with pictures; asset locks; where each asset is
  used.**

- **Builds, share links, stats, localization, a glossary, voice, a roadmap and
  templates.**

- **Webhooks**, with their deliveries recorded.

### _Administration_

- **Backups, storage quotas, archive, and audit filters.**

- **Accounts can be deleted, locked and edited.**

### _The web console (beta)_

- **A signed-in console at the server's own address.** Projects as the server
  holds them, their files, the workbench, to-dos, reviews, settings and
  administration, in English, Chinese and Japanese, on a desktop or a phone.

### _Upgrading from 0.1.0_

`docker compose pull && docker compose up -d` with the image tag set to `1.0.0`.
The database migrates on start. Operators own every project and every other
account starts as an editor of it, so a server upgraded from 0.1.0 behaves as it
did until somebody narrows a project.

**Team documents sync only with a Studio that agrees the kernel** (kernel
version 4). A Studio without that agreement cannot edit a team project's
documents through this server.

### _Known limits_

- The web console is a beta.
- Reading a project's files and versions does not wait for kernel agreement.
  Only document edits and document events do.

[docs/security.md](docs/security.md) records the access model and the accepted
risks in full.

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
