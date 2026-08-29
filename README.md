<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NarraLeaf/.github/refs/heads/master/doc/banner-md-transparent.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/NarraLeaf/.github/refs/heads/master/doc/banner-md-light.png">
  <img alt="narraleaf banner" src="https://raw.githubusercontent.com/NarraLeaf/.github/refs/heads/master/doc/banner-md-light.png">
</picture>

# NarraLeaf-Team

> This project is currently in the early stages of development.

NarraLeaf Team is a self-hosted project server for teams working in NarraLeaf
Studio. One organization runs one server, on its own network or in a container
it controls. There is no hosted service and no account to register.

Team holds the projects a team works on together, issues the identity Studio
signs in with, and answers the permission question behind every access to a
project's repository. It has no interface of its own: authors reach it from
Studio, and whoever runs it administers it with the `nlteam` commands, from a
terminal on the server or from any machine that has signed in to it.

## Features

- **Projects.** A project is a repository on this server and a row in its
  registry. Studio lists them, creates them and opens them; the server records
  who created each one and answers for it.
- **Accounts and tokens.** Every account is made by an operator. Studio exchanges
  a password for a token, and presents that token on every connection. Disabling
  an account, or revoking its tokens, takes effect on the next call.
- **Access decisions.** Every repository access is checked against the account
  that asked, and the outcome is recorded. An account that has been disabled or
  revoked is stopped before a data connection is opened.
- **Coordination.** Comments anchored to a scene, a row or an asset; who else has
  a project open; live sessions and the data attached to them. All of it over one
  authenticated connection.
- **Management.** Accounts, settings, signing keys and the audit record are
  managed over the same connection Studio uses, so a server is administered from
  anywhere its operator has signed in from.
- **One directory.** Everything a server owns lives under one path: the accounts,
  the projects, the signing keys, the certificate authority and the repository
  store. Back up that directory and the server is backed up.
- **Container image.** `linux/amd64`, with the version-control binaries already
  unpacked. Nothing is downloaded on first start.

## Documentation

- [Running a Team server](https://www.narraleaf.com/docs/studio/team) on
  narraleaf.com.
- [Deployment](docs/operations.md), the ports, the certificate and every command
  in full.
- [Security](docs/security.md), what a server protects and what it does not.
- [Architecture](docs/architecture.md) and the [protocol specification](docs/protocol.md).
- [Internals](docs/internals.md) and [contributing](docs/contributing.md), for
  work on Team itself.

## Requirements

The container image carries all of these. They apply to an installation from
npm.

- **Node.js 24 or newer.** Accounts are stored in Node's built-in `node:sqlite`,
  which is available without a flag from version 24.
- **The operating system's `tar`.** Windows has shipped one since Windows 10
  build 17063. Linux and macOS have always had it.
- **64-bit Linux, Windows, or Apple silicon.** These are the platforms the
  version-control server is published for. Any other platform is refused by name.

The version-control server is not installed separately. Team downloads the
version it pins on first run, into a per-user cache.

## Running a server

`compose.yaml` in this repository is a complete deployment. The one value to
change is the name people will reach the server by.

```sh
docker compose up -d
docker compose exec -T team nlteam init ada < admin-password
```

The second command runs once. It creates the first account, and is refused from
the moment the server has one. Three things then reach the people who will use
the server: the address, that account, and the certificate fingerprint printed in
`docker compose logs team`. Everything else is managed from Studio.

If the organization already holds a certificate for the name people use, Team
presents it and no fingerprint has to be compared. See
[a certificate you already hold](docs/operations.md#a-certificate-you-already-hold).

## Installing

The package is not published yet. Until it is, an installation outside a
container is built from a checkout:

```sh
git clone https://github.com/NarraLeaf/NarraLeaf-Team.git
cd NarraLeaf-Team
npm install
npm run build
npm link
```

That puts the `nlteam` command on the path. `nlteam --help` prints every command
with its options.

## Quick start

One directory holds everything a server owns, and `--root` names it. Every
command takes it, or reads it from `NLTEAM_ROOT`. Each command-line option has a
matching environment variable; [Deployment](docs/operations.md) lists them.

**1. Start the server.**

```sh
nlteam up --root /srv/team --hostname team.example.com
```

`up` installs the version-control server, configures it, starts it, serves the
endpoint Studio signs in at, and runs until it is interrupted. Run the remaining
steps in a second terminal.

`--hostname` is a name people will reach this server by. It goes into the
certificate, into the audience of every token, and into the address the server
tells clients to sign in at. A server given no hostname issues tokens that work
on its own machine only. The option is repeatable.

**2. Trust the certificate, once on each machine that will connect.**

```sh
nlteam trust --root /srv/team
nlteam trust --root /srv/team --install
```

The first command prints the fingerprint and changes nothing. Compare it against
the fingerprint the server printed at startup, over a channel other than the
connection being trusted, then run the second.

**3. Create the first account.** It joins the `admin` group. `init` is refused
once the server has an account.

```sh
printf '%s' 'the password' | nlteam init ada --root /srv/team
```

Every account after the first is created by an account that is already there:

```sh
printf '%s' 'their password' | nlteam user create bob --root /srv/team --role authors
```

**4. Create a project.** Every account on a server reaches every project on it.

```sh
nlteam project create harbour --root /srv/team --as ada
```

**5. Hand out the address and a token.**

```sh
printf '%s' 'their password' | nlteam token mint bob --root /srv/team
```

The address and the token are what an author is given. Studio asks the server for
everything else, and the token carries the authority's fingerprint, so trusting
the server is one action in Studio rather than a command.

Two ports must be reachable from an author's machine: **41402**, where people
sign in, and **41337**, where project data is served. The remaining listeners are
between programs on the server machine and are bound to the loopback.

## Commands

| Command | Description |
| --- | --- |
| `nlteam up` | Install and run the version-control server, and serve the sign-in endpoint |
| `nlteam trust` | Show this server's certificate authority, or install it |
| `nlteam init <name>` | Create the first account, on a server that has none |
| `nlteam login <server> <name>` | Sign in to a server, so this machine can administer it |
| `nlteam logout <server>` | Forget one server's token and its authority |
| `nlteam user create <name>` | Create an account |
| `nlteam user list` | List the accounts |
| `nlteam user disable \| enable <name>` | Stop an account, or admit it again |
| `nlteam user revoke-tokens <name>` | Refuse every token an account already holds |
| `nlteam user grant-admin \| revoke-admin <name>` | Change whether an account may administer this server |
| `nlteam token mint <name>` | Sign a token for an account |
| `nlteam project create <name>` | Create a repository and record it |
| `nlteam project list` | List the projects |
| `nlteam settings list \| set <key> <value>` | Show or change the token lifetimes and this server's name |
| `nlteam status` | Report what this server is running and what it holds |
| `nlteam audit` | Read the record of repository access decisions |
| `nlteam key list \| rotate` | Show the signing keys, or sign with a new one |
| `nlteam key retire <kid>` | Stop publishing one, refusing every token it signed |

Most commands take `--root <path>`, the directory the server keeps its files in,
which requires a terminal on the machine it runs on. `login` is the alternative:

```sh
printf '%s' 'the password' | nlteam login team.example.com:41402 ada
nlteam user list --server team.example.com:41402
nlteam settings set token.sign_in_lifetime_seconds 7d --server team.example.com:41402
```

`login` exchanges a password for a token over TLS, pins the certificate authority
the server presented, prints its fingerprint for comparison, and stores both in
this account's configuration directory. `--fingerprint` names the authority to
expect instead, for a deployment that trusts nothing it was not told to. Every
command above then takes `--server` in place of `--root` and prints the same
output either way.

`up`, `init` and `trust` take `--root` only. They are what a server is recovered
with, and a recovery path that ran over the thing being recovered would be
unusable at the moment it is needed.

`nlteam --help` prints the options for each command.
[Deployment](docs/operations.md) covers the same ground in full.

## Development

The same checkout as [Installing](#installing).

| Command | Description |
| --- | --- |
| `npm run build` | Bundle the executable into `dist/` |
| `npm run dev` | Rebuild whenever a source file changes |
| `npm run lint` | Run the linter |
| `npm run typecheck` | Check types without emitting anything |
| `npm test` | Run the test suite once |
| `npm run contract` | Regenerate the published protocol contract |

`npm test` downloads nothing and contacts nothing outside the machine. The suites
that need a real version-control server are skipped unless told where they may
install one. [Contributing](docs/contributing.md) covers the checks and the shape
of a change; [Internals](docs/internals.md) covers how the parts work.

## Status

Team supervises the version-control server, issues identity, holds the projects,
answers the permission question behind every repository access, and serves the
protocol Studio uses to list and create projects, to comment, and to administer
the server. Real-time collaboration is in development. Upgrading between pinned
versions of the version-control server is not implemented.

## License

MIT, in [LICENSE](LICENSE). Epic Games' terms for `loreserver` and `lorelib` are
kept beside the binaries Team installs.
