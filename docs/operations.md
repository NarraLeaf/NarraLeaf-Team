# Deployment

How a NarraLeaf Team server is deployed, what it keeps, which ports it uses, and
every command that administers it. For what Team is, see
[Architecture](architecture.md). For what a server on a network protects, see
[Security](security.md).

Commands below are written with `--root`, the storage root on the machine the
server runs on. Most of them also take `--server`, and are then run from any
machine that has signed in. See [Remote administration](#remote-administration).

## Container deployment

`compose.yaml` in this repository is a complete deployment. The image carries the
version-control server and the library Team reads projects with already
unpacked, so nothing is downloaded on first start.

```yaml
services:
  team:
    image: ghcr.io/narraleaf/team:1.1.1
    restart: unless-stopped
    environment:
      NLTEAM_HOSTNAME: team.example.com
    ports:
      - "54080:54080"
      - "41337:41337/tcp"
      - "41337:41337/udp"
    volumes:
      - team:/var/lib/nlteam
volumes:
  team:
```

```sh
docker compose up -d
docker compose exec -T team nlteam init ada < admin-password
docker compose exec team nlteam status
```

`init` runs once: it creates the first account and is refused from the moment the
server has one. `admin-password` is a file written beforehand, holding that
password and nothing else, ten characters or more; delete it afterwards. The
password is read from standard input, which is what `-T` is for, because one
given as an argument appears in the process list and in the shell history.

`status` prints the other two things that reach the people who will use the
server: the address and the certificate fingerprint. The address is a host and a
port, `nlteam://team.example.com:54080`; `status` writes it as an `https://` URL
on its `sign in` line, and Studio does not take that spelling. Accounts, projects
and administration are managed from NarraLeaf Studio or from the
[web console](#the-web-console).

The first account can also be made in a browser. While a server has no
accounts, `up` prints a `/console/setup` address and a setup code beside the
`init` command; `docker compose logs team` shows it. The code is new on every
start and stops working once an account exists.

`NLTEAM_HOSTNAME` is the value that has to be correct. It goes into the
certificate, into the audience of every token, and into the address the discovery
document gives clients. A server given no hostname issues tokens that work on its
own machine only. Separate several names with commas; the first is the address
clients are sent to.

### Image contents

**`linux/amd64` only.** Team pins one version-control build per platform. The
only 64-bit ARM Linux build published targets Neoverse cores with 512-bit SVE and
is not expected to run on other ARM hardware, so no `arm64` image is published.

**The volume is the server.** `/var/lib/nlteam` holds the accounts, the projects,
the signing keys, the certificate authority and the repository store. Backing up
that volume backs up the server. Losing it means every machine that trusted this
server has to be told to trust its replacement.

**Two published ports.** 54080 carries sign-in and the session Studio holds.
41337 carries project data, and is one number with two listeners: gRPC over TCP
and QUIC over UDP. Publish both. A client whose connection settles on QUIC waits
rather than falling back. Team's own HTTP listener and the version-control health
check are bound to the loopback inside the container.

**Environment variables.** Every command-line option has one: `--hostname` is
`NLTEAM_HOSTNAME`, `--data-port` is `NLTEAM_DATA_PORT`, and so on. The storage
root and the binary cache are already set in the image.

**Image tags.** A release publishes `X.Y.Z` and moves `latest`. `develop`
follows the integration branch. A deployment names the version it means: both
`latest` and `develop` change under a deployment that pulls them, and an image
that changes under a server nobody restarted is a change nobody chose.

### Upgrading

Change the tag in `compose.yaml`, then
`docker compose pull && docker compose up -d`. The database migrates on start
and the certificate authority is kept, so no machine is asked to trust anything
again. A server coming from 1.0.0 moves its sign-in port from 41402 to 54080:
change the published port with the tag and give authors the new address, or set
`NLTEAM_AUTH_TLS_PORT: "41402"` and publish `41402:41402` to stay where it was.

**Knowing there is one.** The server asks GitHub for the newest `vX.Y.Z` tag
once at start and twice a day after, and the web console's home page tells
operators, and only operators, when it is newer than the running version, with
a link to the release and to this section. Nothing is downloaded or installed:
an upgrade is still the two commands above, run by an operator who chose the
version. A server that must not reach the internet starts with
`--no-update-check` or `NLTEAM_UPDATE_CHECK: "false"`; a failed check is only
noted, and the console says nothing.

Console pages that were open across an upgrade see the new version when their
connection comes back, and offer a reload, since what is on screen is still the
previous console.

### A certificate you already hold

An organization that holds a certificate for the name people use gives it to Team
and no fingerprint is compared: the certificate's issuer is already trusted on
each machine.

```yaml
    environment:
      NLTEAM_HOSTNAME: team.example.com
      NLTEAM_TLS_CERT: /etc/nlteam/tls/fullchain.pem
      NLTEAM_TLS_KEY: /etc/nlteam/tls/privkey.pem
    volumes:
      - team:/var/lib/nlteam
      - ./tls:/etc/nlteam/tls:ro
```

Both values or neither. The server's own certificate comes first in the file if
others follow it, and the key carries no passphrase. The pair is read before any
port is bound, and a key that does not belong to its certificate is refused at
startup.

Team continues to issue and serve its own certificate as well. Each connection is
answered with one of the two: a client that asks for a name the supplied
certificate covers is given that certificate, and everything else, including the
loopback, is given Team's own. The fingerprint, `nlteam trust`, and clients
reaching the server by any other name are unaffected. The version-control server
and Team's own reader reach the endpoint by its public name too, so `up` writes
`<root>/tls/loreserver-trust.pem`, Team's authority followed by the supplied
chain, and points both at it.

Renewal is a restart. Replace the files and run `docker compose restart team`.

## Installation

The package is not published yet. Outside a container, `nlteam` is built from a
checkout: `npm install && npm run build && npm link`.

```sh
nlteam up --root /srv/team
```

`--root` names one directory, or `NLTEAM_ROOT` does. Everything else has a
default, and everything Team writes goes underneath it:

```
<root>/loreserver/config/   local.toml, written by Team on every run
<root>/loreserver/store/    the immutable and mutable repository stores
<root>/logs/loreserver.log  the version-control server's output
<root>/team.db              the accounts, the projects and the decisions
<root>/keys/                the RSA private keys tokens are signed with
<root>/tls/                 the certificate authority and the endpoint certificate
<root>/credentials/         the session Team signs in to its own repositories with
<root>/authority/owed/      asset files a team project has not yet put in a snapshot
<root>/builds/              builds uploaded from Studio, one directory per project
<root>/attachments/         files attached to threads, one directory per project
<root>/backups/             what nlteam backup and the scheduled backups write
<root>/cache/projects/      Team's own checkouts, disposable at any moment
<root>/cache/authority/     the checkouts team project snapshots are committed from
```

`<root>/keys/`, `<root>/tls/` and `<root>/team.db` are what to guard. Together
they are every account on the server, the authority to issue a token for any of
them, and the authority every machine that trusted this server believes. Key
files are written `0600` where the platform supports it.

Deleting `<root>/credentials/` costs one sign-in and nothing else.
`<root>/cache/` may be deleted while the server is stopped. `<root>/authority/owed/`
may not: an asset file in it is the only copy the server has until the next
snapshot.

The binaries are kept outside the storage root, one copy per version per machine:

```
%LOCALAPPDATA%\nlteam\cache\bin\   Windows
$XDG_CACHE_HOME/nlteam/bin/        Linux, or ~/.cache/nlteam/bin/
~/Library/Caches/nlteam/bin/       macOS
```

`NLTEAM_CACHE_DIR` names a different directory. An installation left under
`<root>/bin/` by an earlier version is used where it is. Deleting `<root>/bin`
while the server is stopped is safe; the next start fetches one copy into the
cache.

`up` installs the pinned build if it is not already present, checks that the
binary reports the version Team expects, writes the configuration, starts the
version-control server, and waits for its health check to answer. It then runs
until it is interrupted, restarting the version-control server if it exits, and
stopping it on the way out.

## Ports

| Port | Listener | Protocol | Reachable from another machine |
| --- | --- | --- | --- |
| 41337 | Version-control data | gRPC over TCP, QUIC over UDP | Yes. Studio opens a project through it |
| 41339 | Version-control health check | HTTP | No |
| 41400 | Team's signing keys and health | HTTP/1.1 | No |
| 54080 | Sign-in, the discovery document, and the API Studio uses | gRPC over TLS, with HTTP/1.1 | Yes. People sign in here |

Only 41337 and 54080 belong on a network a collaborator reaches. `up` binds the
other two to the loopback, so they are unreachable from another machine whatever
a firewall allows.

41400 carries two documents and nothing else: the public halves of the signing
keys, and whether the process is answering. Both are served on 54080 as well, and
that is where an operator reads them.

Each port is moved by an option: `--data-port`, `--health-port`, `--team-port`
and `--auth-tls-port`. All four must differ, and `up` refuses a command line
where they do not. `--data-port` carries both version-control data listeners,
because gRPC listens on TCP and QUIC on UDP under one number. Each option is read
from an environment variable of the same name: `NLTEAM_DATA_PORT`,
`NLTEAM_HEALTH_PORT`, `NLTEAM_TEAM_PORT` and `NLTEAM_AUTH_TLS_PORT`. An option on
the command line takes precedence over its variable.

## The pinned version

Team installs one version of the version-control server, from the GitHub releases
of [EpicGames/lore](https://github.com/EpicGames/lore). Two SHA-256 digests are
recorded per platform: one for the release archive, checked as it downloads, and
one for the executable inside it, checked before each run. A download that does
not match is discarded. An installed binary that does not match is refused, and
the server stops rather than replacing it.

The digests are Team's own. Upstream publishes no checksums and no signatures.

Builds exist for 64-bit Linux, Windows and Apple silicon. A 64-bit ARM Linux
build is published, but the only one available targets Neoverse cores with
512-bit SVE and is not expected to run on other ARM hardware. Any other platform
is refused by name.

`LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` are kept beside the binary in the
same cache directory. They are Epic Games' terms for the program Team installs.

## Identity

Team issues the JSON Web Tokens a Studio installation presents to the
version-control server, which verifies them against a JWKS document Team
publishes.

`up` serves Team's own endpoint on port 41400 unless `--team-port` says
otherwise:

```
GET /.well-known/jwks.json   the public halves of the signing keys
GET /health                  {"ok":true,"version":"..."}
```

Nothing else is served there: no account data, no way to write anything, and no
CORS headers.

`up` writes the `[server.auth]` and `[environment.endpoint]` blocks into
`local.toml`, which is what makes the version-control server demand a token.

`up --no-identity` writes neither. A version-control server configured that way
demands nothing and never calls back into Team: the accounts, the tokens, the
signing keys and the decision record are all bypassed, and every repository on
the server is readable and writable by whoever can reach the port. It is a
configuration for a machine nothing else can reach, and `up` reports it on
standard error at every start. `--identity` asks for the default.
`NLTEAM_IDENTITY` sets the same thing from the environment: `0`, `false` or `no`
turns identity off, `1`, `true` or `yes` leaves it on. Either flag overrides the
variable.

## Sign-in

A Studio installation signs in over TLS on port 54080, by calling two methods:

```
epic_urc.UrcAuthApi/ExchangeExternalTokenForUserToken       signing in
epic_urc.UrcAuthApi/ExchangeUserTokenForMultiresourceToken  before touching a repository
```

The first presents a token Team issued and receives a fresh one. The new token
carries the account's state as it stands at that moment, so an account disabled
since the first token was issued receives nothing.

The second is called before a client opens a repository's data connection, and
names the resources it wants. Team refuses the whole request unless every
resource is a project of this server in which the caller still has a role that
may open the repository. A disabled account, a revoked token, or a role without
repository access is stopped here, before a data connection is opened.

Both tokens carry a `resources` claim naming the projects and what the bearer may
do to each. The version-control server refuses a token that arrives without it.

## The web console

`nlteam up` serves a web console at `https://<host>:54080/console/`, on the same
port and certificate as everything else. The port speaks only HTTPS; an `http://`
address, which is what a browser assumes when no scheme is typed, is redirected to
the same address over `https://`. People sign in with the same account
and password they would give Studio; the browser keeps a session cookie for up
to thirty days (seven unused), and `nlteam user disable` or
`nlteam user revoke-tokens` ends it as it ends tokens.

The page is built into `dist/console` by `npm run build` (or
`npm run build:console` alone). A server built without it answers
`/console/` with a 503 saying so. `NLTEAM_CONSOLE_ROOT` points the server at
another directory, for working on the page.

Studio signs in through the console too: a server that announces `oauth` is
offered "Sign in with browser", which opens
`/oauth/authorize`, has the person sign in and approve the device, and returns
to Studio. Where Studio's machine has no browser, the device flow shows a code
to type at `/console/device` from any device. Each signed-in Studio is a device
its owner can sign out from the console, and `nlteam user revoke-tokens` signs
out all of them. The password sign-in stays for Studio builds that predate this.

A link of the form `narraleaf://team/connect?server=https://<host>:54080` opens
Studio's Add Server dialog with the address filled in.

A browser has to trust the certificate the way Studio does. With Team's own
authority that means installing `tls/ca.crt` on the machine, which is the same
step as `nlteam trust`; a certificate supplied with `--tls-cert` from an
authority browsers already trust needs nothing.

## Trusting the certificate

Studio verifies the endpoint's certificate against its own host's trust store and
offers no certificate-pinning hook, so the first connection to a server is
established by a person comparing a fingerprint.

`trust` is how a machine that holds the storage root reads and installs that
authority. It is not what a collaborator runs: they have no storage root, and
Studio asks them to confirm the fingerprint instead.

```sh
nlteam trust --root /srv/team
nlteam trust --root /srv/team --install
nlteam trust --root /srv/team --remove
```

With no arguments, `trust` prints the authority's SHA-256 fingerprint, the file
it is in, and the command for the platform it is run on. Compare that fingerprint
with the one the server printed at startup, over a channel other than the
connection being trusted. Nothing is installed as a side effect of `up`.

`--install` puts the authority into the **current user's** trust store: the
`Root` store on Windows, the login keychain on macOS. Both operating systems may
open a window of their own, which Team reports before starting the command. On
Windows, adding is silent and removing raises a confirmation dialog. Linux has no
per-user store that other programs read, so nothing is run and the two commands
to run under `sudo` are printed instead.

A client that signs in with a token receives the authority's fingerprint in that
token, so trusting the server is one action in Studio rather than a command.

### Certificates

Team is its own certificate authority. On first run it writes two key pairs into
`<root>/tls/`, both keys at mode `0600`:

```
<root>/tls/ca.crt    the authority, self-signed, ten years. This is what is trusted
<root>/tls/ca.key
<root>/tls/auth.crt  the endpoint certificate, issued by the authority
<root>/tls/auth.key
```

The endpoint certificate lasts 397 days, the longest Apple's platforms accept,
and is reissued by the next `up` whenever it nears expiry or a name is added or
changed. The authority is untouched by that, so nobody is asked to trust anything
again.

```sh
nlteam up --root /srv/team --hostname team.example.com
```

`--hostname` is repeatable. `DNS:localhost`, `IP:127.0.0.1` and `IP:::1` are
always included. The name goes into the certificate and into the audience of
every token Team issues. A server given no hostname issues tokens a client will
use from the server machine only. `NLTEAM_HOSTNAME` names the same list where
there is no command line, separated by commas.

The certificates are written without an external tool. A server is not assumed to
have `openssl` on it.

### Token audience

A token's `aud` is the list of remotes the client is willing to send that token
to. It will send it to nothing else. Two addresses must be present:

- Team's endpoint, `https://host:54080`, where the client signs in.
- The version-control data port, `lore://host:41337`, where the work happens.

Without the second, a client signs in, stores the token, and then fails every
repository operation with "Failed to resolve repository: No token stored". Team
writes both, for the auth origin's host and for every `--hostname` given, in each
of the spellings the client compares against. `up` prints the list it built:

```
tokens are good for lore://127.0.0.1:41337, lore://team.example.com:41337
```

Read that line on a server other people connect to. A name missing from it is a
person who cannot open a project.

### Identity options

The issuer, the audience, the auth origin, the `env` and `idp` claims, the four
ports and the hostnames are identity options. Every command that issues a token,
including `token mint` and `project create`, accepts the set that `up` accepts.

They need not be repeated. `up` records the identity it was started with, and the
issuing commands read it, so `nlteam token mint` with no options names the
audience the running server issues for. Passing a set that disagrees with the
running server produces a token whose audience names an address nothing answers
on: it signs in and then fails every repository operation.

Each option has an environment variable of the same name as its flag:
`NLTEAM_ISSUER`, `NLTEAM_AUDIENCE`, `NLTEAM_AUTH_ORIGIN`, `NLTEAM_ENV`,
`NLTEAM_IDP`, alongside the port and hostname variables above. Where one setting
is named more than once, the order is: the built-in default, then what this
server has stored, then the environment, then the command line.

### The version-control server's trust anchor

The version-control server asks Team who a caller is at the address clients sign
in at, because it hands that same address to every client as where its sign-in
lives, and a client looks its session up under it. It verifies the certificate it
is shown. Team starts it with `SSL_CERT_FILE` naming `<root>/tls/ca.crt` (or
`<root>/tls/loreserver-trust.pem` with a supplied certificate), so no trust store
on the server machine is touched. Only that process is affected, and only while
Team is running it.

That address has to be reachable from the server machine itself. Behind a router
that does not loop a public address back to the machine behind it, it is not,
and every repository call fails with `Failed to connect to rebac service`. `up`
checks this before starting the version-control server and prints what to change:
map the name to `127.0.0.1` in `/etc/hosts`, or under `extra_hosts` in a
container, as `compose.yaml` does.

A version-control server started this way trusts Team's authority and no other.
Everything it reaches is on the same machine. A configuration giving it a remote
store or a telemetry endpoint over HTTPS would need the public roots restored.

### The server address

One address is what an author is given. `nlteam://team.example.com:54080` names
the endpoint, and the document served there provides the rest. It is answered
over HTTP/1.1 on the same TLS listener that carries gRPC:

```
GET /.well-known/nlteam
```

```json
{
  "protocol": 2,
  "name": "Winterlight",
  "policy": { "publishLineage": true },
  "auth": { "required": true, "url": "https://team.example.com:54080" },
  "data": { "url": "lore://team.example.com:41337" },
  "capabilities": ["session", "comments", "clients", "live", "overlay", "admin"],
  "authority": { "sha256": "3D:38:9F:E6:..." },
  "version": "1.1.1"
}
```

It is served to whoever asks, before anybody has signed in. Nothing in it is
secret, and every field is checkable against the token that arrives later.

`auth.required` is false on a server started with `--no-identity`, which accepts
anyone who can reach it.

`capabilities` is what this build serves and this deployment allows. A server
closed to collaboration announces fewer of them; see
[Collaboration](#collaboration).

`authority.sha256` lets a client that has already trusted this server confirm,
before anything else happens, that the machine answering is the one it trusted.

`name` is what the deployment calls itself, and is what Studio shows in place of
the address. Until one is chosen it is the server's own host name:

```sh
nlteam settings set server.name "Winterlight" --root /srv/team
```

The name is read as each document is answered. The next client to ask is told the
new name, with nothing restarted.

`protocol` is a single number, so a client compares once to decide whether it
speaks this server's protocol. It changes only when a field an older client
relies on stops meaning what it meant.

## Remote administration

Every command on this page is written with `--root`, which opens the storage root
on the machine the server runs on. For all but three of them that is not the only
way. `nlteam login` signs in to a server, after which the command takes
`--server <host:port>` in place of `--root` and does the same thing from any
machine:

```sh
nlteam login team.example.com:54080 ada < password.txt
nlteam user list --server team.example.com:54080
nlteam settings set token.sign_in_lifetime_seconds 7d --server team.example.com:54080
nlteam logout team.example.com:54080
```

`NLTEAM_SERVER` stands in for the flag, as `NLTEAM_ROOT` does for `--root`. A
command line naming both is refused rather than settled one way.

### What login stores

Signing in settles three things in order.

**Which machine this is.** A server's certificate chains to an authority it made
for itself. `--fingerprint` states what that fingerprint must be, which is the
path an automated deployment takes. Without it, whatever is presented is pinned
and printed for comparison.

**What that machine is.** The discovery document turns an address into a server,
and what it serves is read from that document.

**Who is asking.** A username and a password over the verified connection,
exchanged for a token.

The token, the address and the certificate authority go under the signed-in
person's own configuration directory, never under a server's storage root:

```
%APPDATA%\nlteam                              Windows
~/Library/Application Support/nlteam          macOS
$XDG_CONFIG_HOME/nlteam, or ~/.config/nlteam  elsewhere
```

`NLTEAM_CONFIG_DIR` names another directory outright, which is what a container
mounting a credential uses. The file is created `0600` and the directory `0700`
where the platform supports it. Several servers may be signed in to at once, and
`logout` forgets one of them.

Every call is checked against the account behind the token as it arrives, not
once when the session opened. An account taken out of the `admin` group is
refused on its next command.

### Commands that require the storage root

`up`, `init`, `trust`, `backup` and `restore` take `--root` and nothing else.

They are the recovery path. `up` brings a server up. `init` creates the first
account on a server that has none, and there is nobody to sign in as until it has
run. `trust` prints the fingerprint a person compares before trusting anything.
`backup` copies the root and `restore` puts a copy back; see [Backups](#backups).
Each of them is what an operator reaches for when the protocol is not answering.
They are guarded by access to the storage root and by nothing else.

The protocol will not take the last operator's administration away, and will not
disable the last operator's account. It refuses, and names the command to run on
the machine that holds the storage root. `nlteam user grant-admin ... --root` and
`nlteam user enable ... --root` are the way back.

### Differences between the two paths

What a command prints is the same on both paths wherever both have the same
facts. One command differs, and `nlteam --help` states it as well:

**`token mint` reads a password with `--root` and none with `--server`.** On the
machine itself, the password is how the operator shows the account is theirs to
issue for. Over the protocol the caller has already proved who they are by
holding an operator's session, and issuing a token for an account whose password
nobody knows is what the command is for.

`settings list` prints the same three columns on both paths. Each row says
whether its value was set on this server or a default is answering for it: a
server that never chose follows a later version of Team if the default moves, and
one that chose keeps its value. The column is blank against a server too old to
carry it.

Four options are refused beside `--server` rather than dropped:

- `--as` on `project create`. Over the protocol the account that asked is the
  account the project belongs to.
- `--service-account` on `user create`. Nothing over the protocol writes that
  mark.
- A `--role` that is neither `admin` nor the default. The protocol carries
  whether an account administers this server and nothing else about groups.
- `--health-port` on `status`. A server checks the version-control server it
  started, on the port it was started with.

The identity options, `--issuer`, `--hostname` and the ports among them, are
refused beside `--server` for the same reason: they describe the deployment a
token is issued for, and a server issues from what it was started with.

`user list --server` reads the whole list before printing. `audit` pages on both
paths and stops at the number of entries asked for.

## Server status

```sh
nlteam status --root /srv/team
nlteam status --server team.example.com:54080
```

```
nlteam 1.1.1 under /srv/team
as of 2026-08-27T09:12:33.001Z, and an answer is kept for 10 seconds

loreserver 0.8.6, answering
  store         /srv/team/loreserver/store
  size          4.2 GiB

reachable at
  sign in       https://team.example.com:54080
  data          lore://team.example.com:41337
  fingerprint   AB:CD:EF:...
  loopback      41339 health, 41400 jwks

on this server
  accounts      3
  projects      2
  decisions     41
  signing keys  1
```

The answer is not live, and the second line says so. A server works one out when
it is asked and gives that same answer to everyone who asks within the next ten
seconds. The `as of` line reports when the answer was true.

Two values are printed as `unknown` rather than estimated. **Size** is absent
where the store could not be measured: one too large to walk, at fifty thousand
files, or one the version-control server has not created yet.
**Fingerprint** is absent on a server that has never been started.

The loopback ports are listed so that an operator looking at a port already in
use can tell which of them this server holds.

`--health-port` is the one value `status --root` has to be told, because a
storage root does not record it. Left out it is the default, and a status taken
with the wrong number reports the version-control server as not answering. It is
refused beside `--server`.

## Access decisions

Every repository access is a question put to Team, and every answer is recorded
with the reason.

```sh
nlteam audit --root /srv/team
nlteam audit --refused --limit 200 --server team.example.com:54080
```

```
2026-08-27T09:12:33.001Z  allowed  ada  harbour     owner
2026-08-27T09:12:31.114Z  refused  bob  lighthouse  no grant
```

Newest first. The account is `unknown` for a caller whose token was missing,
expired, or not one this server issued. The resource is the project's name where
Team knew it and the repository id where it did not.

`--limit` is how many rows are printed, fifty by default. It counts rows printed
rather than rows read: the command reads back through the record until it has
printed what was asked for.

`--refused` prints refusals only. The command keeps reading back until it has the
refusals asked for or the record ends, so **an empty listing means nothing on
record was refused**.

The record is bounded by the server at a few thousand rows. When that bound
forces a choice, the oldest allowances are dropped first, and a refusal is
dropped only on a server whose refusals alone have filled the record.

`nlteam status` reports how many decisions are on record.

## Accounts

An operator creates accounts, at the server or from any machine they have signed
in from. The first account is the exception:

```sh
nlteam init ada --root /srv/team < password.txt
```

`init` works only while the server has no accounts, and is refused from the
moment it has one. The account it creates joins the `admin` group. While a server
has no accounts, `up` prints this command and nothing else about accounts.

Every account after the first is created by an account that is already there:

```sh
nlteam user create bob --root /srv/team --role authors < password.txt
nlteam user list --root /srv/team
nlteam user disable bob --root /srv/team
```

`--role` is the group the account joins, `member` unless stated otherwise. Only
accounts in `admin` may administer the server. What reaches the person is a token
issued for the account, together with the server's address.

The same commands take `--server` in place of `--root`:

```sh
nlteam user create bob --server team.example.com:54080 < password.txt
nlteam user list --server team.example.com:54080
nlteam user disable bob --server team.example.com:54080
nlteam user enable bob --server team.example.com:54080
```

Over the protocol, `--role` is `admin` or the default and nothing else. A third
group is refused rather than dropped, and an account that is to be in one is
created with `--root`. `--service-account` is refused there for the same reason.

Passwords are read from standard input on both paths. `user create --server`
sends the password over the session, which is TLS to a server whose authority
this account pinned when it signed in; it never reaches an argument, a log line
or an error message. Passwords are hashed with scrypt at N = 2^17, r = 8, p = 1,
and the stored string carries those parameters. An existing hash keeps verifying
under the parameters it was made with, and is replaced the next time its owner
signs in.

## Tokens

```sh
printf '%s' "$PASSWORD" | nlteam token mint ada --root /srv/team
nlteam token mint ada --server team.example.com:54080
```

The token goes to standard output on its own; what is in it goes to standard
error. It is a sign-in token, and it lasts thirty days.

With `--root` the password is checked first, through the same path a sign-in
takes. With `--server` no password is read: the caller has already proved who
they are by holding an operator's session.

The token is shown once and stored nowhere: not in the server's log, not in its
database. A person who has lost one is issued another.

The same token is issued over the network to somebody who has the address and the
password of an account on the server:

```
POST /api/studio/v1/sign-in   {"username": "ada", "password": "..."}
```

The answer is `{"token": "...", "account": {...}}`, or one sentence. That
sentence is the same for an account that is not there, a password that is wrong,
an account that has been disabled and an account marked as a machine's. It is the
same token the command issues, claim for claim, so an operator hands out an
address rather than a token for each person.

The sign-in route is guarded before the password is checked:

- A name refused several times from one address is answered `429` with a
  `Retry-After`, and the wait doubles with each refusal after that, up to five
  minutes. The check itself is held off, so the right password is not accepted
  during the wait either. A sign-in that succeeds clears the run. The count is
  against the name and the address together.
- Two password checks run at once across the process, and the rest queue.
- Both routes refuse a request whose `origin` names another site. Neither answers
  with a cookie.

### Token lifetimes

There are two kinds of token, with two lifetimes.

A **sign-in token** is one Team is asked about every time it matters. It is
exchanged for a fresh one, and every repository access asks Team whether that
caller may have that repository. Team refuses a caller whose account has been
disabled, or whose token was issued before their access was revoked. A thirty-day
lifetime is not thirty days in which a revoked account keeps working.

A **repository token** is presented on the data connection rather than to Team.
The version-control server checks its signature and its expiry there, and asks
Team nothing further before it runs out. Its lifetime is its only bound, which is
why it is fifteen minutes.

Both lifetimes are settings, kept in `team.db` and read as each token is issued,
so a change reaches a running server. `--token-lifetime` overrides the sign-in
lifetime for one run of one command and leaves the stored setting alone.
`NLTEAM_TOKEN_LIFETIME` names the same override where there is no command line.

```sh
nlteam settings list --root /srv/team
nlteam settings set token.sign_in_lifetime_seconds 7d --root /srv/team
nlteam settings set token.repository_lifetime_seconds 5m --root /srv/team
nlteam settings set server.name "Winterlight" --root /srv/team
nlteam settings set server.collaboration closed --root /srv/team
```

A lifetime is written as `30m`, `48h`, `7d`, or a bare number of seconds.
`server.name` takes the name a person reads in Studio. `server.collaboration`
takes `open` or `closed`; see [Collaboration](#collaboration).
`project.create_by` takes `everyone` (the default), `creators` or `admins`, and
says who may make a project: everybody, the operators plus the accounts in the
`project-creator` group (an operator puts somebody there with
`admin.users.setCreator`, or the "allow creating projects" button in the web
console's back office), or the operators alone. `project.delete_by` takes
`owners` (the default) or `admins`, and says who may take a project off the
list or delete it for good: any owner of it, or the operators alone. `project.default_access` takes
`editor` (the default), `viewer` or `none`, and says what everybody else is
given in a project they were not put in by hand: when a project is made (its
maker always owns it), and in every project when an account is made. With
`none` a project starts with its maker alone, and others join by being added
or by asking (`access.requests.create`; the web console's "join other
projects"), which its owners or an operator answer. Changing it moves nobody
already in a project. `documents.retain_days` (default 30) is how long a team
project's applied edits are kept once a saved version holds them; a Studio away
longer starts again from the last version, and its offline edits based on
anything older come back as conflicts.

`settings list` reports whether each value is the default or was set on this
server. Both commands take `--server` in place of `--root`, and a value written
that way reaches the running server as one written on its own disk does. Every
setting is read where it is used, so nothing is restarted either way.

### Removing access

```sh
nlteam user disable ada --root /srv/team
nlteam user revoke-tokens ada --root /srv/team
```

`disable` stops the account. `revoke-tokens` refuses every token already issued to
that account and changes nothing else, so the person signs in again and is given
one that works. It is the command for a token that has been exposed.

Both reach the same distance where tokens are concerned, and both report it when
they run. Every token issued to that account is refused from that moment wherever
Team is asked: signing in, exchanging, and the permission question behind every
repository access. A data connection already open is checked by the
version-control server rather than by Team, and may last until the repository
token it was opened with expires. Retiring the key that signed it is what ends
that sooner, and retiring a key refuses everybody's tokens; see
[Signing keys](#signing-keys).

`disable` over the protocol will not take the last operator's account away, and
reports the command that will. `disable --root` will.

## Collaboration

```sh
nlteam settings set server.collaboration closed --root /srv/team
nlteam settings set server.collaboration open --server team.example.com:54080
```

`open` is the value a deployment that has not been told otherwise has. `closed`
states that this deployment holds projects and is administered, and is not a place
people work together.

The setting says which of two things the deployment is. It does not say who may
do what on it: an account is refused with `user disable` and
`user revoke-tokens`.

On a closed deployment:

- Comments, live sessions, overlays, the client list and the files a live session
  carries are unavailable. Those capabilities are not announced in the discovery
  document or in the opening frame of a session, every call under them is refused
  to everyone including operators, and the addresses a file travels over are
  refused as well.
- The projects and the members are the operators' business. Any other account
  asking what is on this server, or trying to add a project or take one off, is
  refused and told that the server is closed to collaboration and which setting
  says so.
- Everything else carries on. The server signs people in, holds the repositories,
  and its accounts, settings, keys, decisions and status are read and changed as
  before.

The setting reaches a running server. A session that was already open was told a
list of capabilities that has since changed; a client acting on the old list is
refused on the call, and the next client to connect is told the current list. A
file transfer already under way is refused on its next request.

## Signing keys

An RSA-2048 key is generated on first run into `<root>/keys/`. A key's `kid` is
the RFC 7638 thumbprint of its public half.

Team holds more than one key at a time. The newest signs, and every key that has
not been retired is published in the JWKS, so a rotation invalidates nothing:

```sh
nlteam key rotate --root /srv/team
nlteam key list --root /srv/team
nlteam key rotate --server team.example.com:54080
nlteam key list --server team.example.com:54080
```

Rotating over the protocol rotates the store the running server holds, so the next
token it issues is signed by the new key with nothing restarted. Rotating on the
disk writes a file the running server has not seen, and the server re-reads the
directory before it answers about keys.

Removing a key from the JWKS is not part of rotating. Tokens a key signed remain
valid until they expire, so it keeps verifying for at least one sign-in token
lifetime after it stops signing.

### Key retirement

```sh
nlteam key retire nEQBz... --root /srv/team
nlteam key retire nEQBz... --server team.example.com:54080
```

The key stops being published, and **every token it signed is refused from that
moment**: by this server on every call, every subscription and every repository
access it is asked about, and by the version-control server, which verifies
against the same JWKS. Everyone holding one signs in again. The command reports
this when it runs.

Retirement is what to use when a private key is believed to have been exposed.
Shortening `token.sign_in_lifetime_seconds` is not: the setting bounds tokens
issued after it changes, and the tokens already issued are the problem.

Two rules about which key:

- **The key that is signing is refused.** Retiring it would refuse the tokens the
  server has just issued, including the one the command is using over `--server`,
  and leave nothing able to sign the replacements. The command says to rotate
  first. This is refused on both paths.
- **Retiring the last key that was only verifying is allowed.** Rotate, then
  retire everything else, and only the new key is published: every token issued
  before that rotation stops working and everyone signs in again. The command
  reports the cost rather than asking for confirmation.

The file is kept. `<serial>.pem` becomes `<serial>.retired.pem`, so the key stays
on `key list` as `retired`. Restoring one is a rename on the disk and is not
something this command does.

## Projects

A project is one repository plus Team's record of it.

```sh
nlteam project create harbour --root /srv/team --as ada --description "..."
nlteam project list --root /srv/team
nlteam project create harbour --server team.example.com:54080 --description "..."
nlteam project list --server team.example.com:54080
nlteam project create harbour --repository 19c0d42... --root /srv/team --as ada
```

**Access is per project.** Each project has members, each with a role: owner,
editor, reviewer or viewer. Owners and editors open the repository; reviewers and viewers do not, and read
the project through Team instead. The version-control server was measured not to
tell reading from writing — anybody it lets open a repository can push to it — so
a role that may not write is a role that may not open it. An operator owns every
project. A new project starts with its creator as owner and every other account
as editor, and a new account starts as an editor of every project, so a server
upgraded to this behaves as it did before until somebody narrows a project.
An owner of a project, or an operator, changes who belongs and in which role over
the session, with `projects.members.set` and `projects.members.remove`; there is
no command for it yet. A project always keeps one owner of its own, and taking
somebody out takes their access at once. The web console has the same table in a
project's settings, for its owners, and in the back office, for operators.

**Editors can be kept to some areas.** An owner ticks which parts of the project
an editor may change: story, characters, assets, UI, localization and game
config. All six are ticked to begin with. Owners always change everything;
reviewers and viewers change nothing. Team decides the area of every edit from
the file it reaches, and anything it does not recognise counts as game config,
so a new kind of file is guarded rather than left open. An editor kept to some
areas no longer opens the repository, since the version-control server would let
them push any file, and edits through Team instead, as Studio does for every
team project. Restoring a version changes every area, so it needs all six.

To stop somebody everywhere, stop the account: `nlteam user disable`, or
`nlteam user revoke-tokens` for a token that has been exposed.

`project create` generates the repository id, asks the version-control server to
create the repository, and records the project. `--as` names the account recorded
as its creator, and may be left out on a server with one account.

`--repository <id>` records a repository that already exists. Nothing is created,
Team records the row under that id, and the command reports `adopted` rather than
`created`. The id is thirty-two hexadecimal characters. An id that is already a
project on this server is refused as a conflict.

`--as` is refused with `--server`: over the protocol the account that asked is
the account the project belongs to. The line naming the repository's default
branch is printed only where the command asked the version-control server
directly, so it is absent over the protocol and absent on an adoption.

Creating a project is not an operator's privilege. Every account on a server may
create one, and a Studio installation does so over the session it opened with the
token it was given, on the same port it signed in at:

```
projects.list     what this server holds, with the remote for each
projects.create   {"name": "...", "description": "...", "repositoryId": "..."}
```

A repository created another way is recorded when the version-control server
announces it, with whoever created it as its creator.

`repositoryId` is optional. Left out, Team generates an id and asks for the
repository to be created. Given, Team records the row under that id and asks for
nothing.

### Making a project from a Studio project package

A local project becomes a team project from the console, not from Studio's
project window. Its author exports it in Studio (File › Export Project, a
`.nlspkg`), and on the console's Projects page "Import a project package" makes
the project and uploads the package to it. The button is shown to accounts the
server lets create projects.

```
PUT /api/team/v1/projects/{project}/package    the package's bytes, for an owner of the project
```

The package is streamed to `<root>/imports/` and removed once it is read, then
copied file by file into the project's working copy and committed and pushed as
the repository's first revision. It is taken only by a project whose repository
has no revision and whose log holds no edit; anything else is refused with 409,
so a package never writes over a project's history. A package larger than
8 GB is refused with 413, and one that is damaged, from an older Studio, or
holds no `.nlproj` at its top is refused with 400 and the reason. What a project
never carries (`.lore/`, `.nlstudio/`, `dist/`, `node_modules/`) is left out
whatever the package says.

### Removing a project from the list

Removing a project takes the row away and nothing else. The repository stays in
the store with every revision in it. `projects.forget` on a session is what does
it; there is no `nlteam project forget`.

What the removal reaches:

- **Nobody can open it.** A repository with no row is not one of this server's
  projects, so every access is refused whatever the account.
- **The conversations go with it.** Threads, their comments and their attachments
  are deleted with the project row.

Putting the project back means recording one against the repository, which needs
the repository's id:

```sh
# While it is still a project. The id is the second column.
nlteam project list --root /srv/team

# Afterwards, against the repository that never moved.
nlteam project create harbour --repository 19c0d42... --root /srv/team --as ada
```

**Read the id off `nlteam project list` before taking a project off the list.**
Nothing left on the list holds it once the row has gone. Otherwise it is in a
backup of `team.db`.

Give the project the name it had. The remote handed to every author is built from
the row's name, so recording the repository under a different name changes the
address this server advertises for work that has not moved.

The row that comes back is a new row: today's date, and the account `--as` named
as its creator. What an author opens is unchanged, because none of it was in the
row.

**The name stays taken.** loreserver keeps a repository's name for as long as the
repository exists, so a new project under the old name is refused while the
removed one's repository is there. `projects.create` says so, naming the
repository's id, and the console's package import offers the two ways out:
bring the old project back, or (for an operator) delete it for good.

### Deleting a project for good

Deleting a project removes its repository from loreserver's store, with every
branch and revision in it, then the row and everything Team kept about the
project, and frees its name. Nothing brings it back but a backup taken before.
In the console it is "Delete for good" in a project's settings, beside "Remove
project", and it asks for the project's name to be typed. The same people may do
it as may remove the project (`project.delete_by`).

`projects.delete` on a session is what does it. It takes the project's `name`,
always, as the confirmation, and a `repositoryId` beside it reaches the
repository of a project that was removed from the list earlier; only an operator
may delete one of those, since nobody owns it any more. Before deleting such a
repository Team looks it up by id and checks that it carries the name given, and
deletes nothing if it does not. There is no `nlteam project delete`.

A package import that the server refuses deletes the project it made for the
package in the same way, so a failed import leaves no repository holding the
name.

## Backups

```sh
nlteam backup --root /srv/team
```

`backup` writes `<root>/backups/nlteam-backup-<YYYYMMDD>-<HHMMSS>.tar.gz` and
prints its path; the time is UTC. It can be taken while the server runs: the
database is copied with `VACUUM INTO`, a consistent copy, and everything else
under the root is copied file by file. `cache/`, `logs/` and `backups/`
themselves are left out. A repository written during the backup may contribute
half of a push, which is an object nothing points to yet.

Two server policies, set in the web console's back office, govern the rest:
`backup.every_hours` (default `0`, off) has the running server take one on that
interval, and `backup.keep` (default `7`) is how many are kept. Older ones are
removed after each backup, scheduled or by hand. The console's storage page takes
and lists backups too; there is no `nlteam` command for the policies. A backup under `<root>/backups/` is on the same disk as
what it protects, so copy it somewhere else.

### Restoring

```sh
nlteam restore /srv/team/backups/nlteam-backup-20261119-030000.tar.gz --root /srv/team --force
```

`restore` is refused while a server runs under the root. Into an empty or
missing directory it unpacks the archive; into one that holds anything it is
refused unless `--force` is given, and then what was there is moved, not deleted,
into `<root>/before-restore-<YYYYMMDD>-<HHMMSS>/` first. The archive may be one of
the root's own backups: it moves aside with the rest and is read from there.
Once the restored server is confirmed, delete that directory; later backups
leave it out either way. Start the server with `up` afterwards.

In a container, stop the service and run `restore` in a one-off container on the
same volume. The image's entry point is `nlteam`, so the command starts at
`restore`:

```sh
docker compose stop team
docker compose run --rm team restore /var/lib/nlteam/backups/nlteam-backup-20261119-030000.tar.gz --force
docker compose start team
```

A backup kept outside the volume is mounted for the one run, for example with
`-v "$PWD/nlteam-backup-20261119-030000.tar.gz:/tmp/backup.tar.gz:ro"` and
`restore /tmp/backup.tar.gz`.

## Administrators

The `admin` group is who may manage the accounts, the projects and the settings,
and add somebody else to the group.

```sh
nlteam user grant-admin bob --root /srv/team
nlteam user revoke-admin bob --root /srv/team
nlteam user grant-admin bob --server team.example.com:54080
nlteam user revoke-admin bob --server team.example.com:54080
```

`nlteam init` puts the first account in it.

Everything on this page can be done over the session by an account in that group,
from a management panel or from a command line anywhere: creating accounts,
disabling and enabling them, granting and revoking administration, refusing the
tokens somebody holds, issuing a token for them, changing a setting and rotating
the signing keys. The group is read as each call arrives, so removing somebody
from it takes effect on the next call.

The last operator is where the two paths differ:

- `user revoke-admin --server` and `user disable --server` are **refused** for
  the only operator who can still sign in. Either would leave a server nobody
  could administer over the protocol. The refusal names the command to run on the
  machine that holds the storage root.
- `user revoke-admin --root` and `user disable --root` will both do it.
  `user grant-admin ... --root` and `user enable ... --root` undo them.
