# NarraLeaf Team

A self-hosted project server for teams working in NarraLeaf Studio. One
organisation runs one Team server on its own machine; there is no hosted service
to sign up for. It supervises `loreserver`, hands out the identity Studio signs
in with, holds the projects and answers for them.

It is a service with no interface of its own. Authors reach it from NarraLeaf
Studio; whoever runs it administers it with the `nlteam` commands below, over a
terminal on the machine it is on.

- **[Running a Team server](docs/operations.md)** — the ports, the certificate,
  and every command in full.
- **[How Team works](docs/internals.md)** — why the parts are the shape they are.

## Requirements

- **Node.js 24 or newer.** The accounts live in node's built-in `node:sqlite`,
  which is unflagged from 24 onwards.
- **The operating system's `tar`.** Windows has shipped one since Windows 10
  build 17063; Linux and macOS have always had it. Team unpacks the `loreserver`
  releases with it and carries no archive library of its own.
- **64-bit Linux, Windows, or Apple silicon.** Those are the platforms
  `loreserver` is published for, and any other is refused by name. Reading what
  is inside a project wants Epic's `lorelib` as well, which installs with Team's
  dependencies; a machine without one still runs the server, hands out identity
  and tracks access, and says of each project that it could not read its
  repository.

`loreserver` is not something to install. Team downloads the version it pins, on
first run, into a per-user cache.

## Installing

```sh
npm i @narraleaf/team -g
```

That puts the `nlteam` command on the path, and `nlteam --help` prints every
command with its options.

## Quick start

One directory holds everything a Team server owns, and `--root` names it; every
command takes it, or reads it from `NLTEAM_ROOT`. That variable is one of a set
mirroring the command-line options, for a container with no command line to
compose — [operations.md](docs/operations.md) has the whole layer.

**1. Start it.**

```sh
nlteam up --root /srv/team --hostname team.example.com
```

`up` installs `loreserver`, configures it, starts it, serves the endpoint
Studio signs in at, and runs until it is interrupted.

- `loreserver` demands a token, and Team is what it asks about one. This needs
  no flag. `--no-identity` gives it up: the server then accepts any client that
  can reach it, and every repository on it is readable and writable by whoever
  finds the port. `--identity` is still accepted, and asks for the default.
- `--hostname` is a name people will reach this server by. It goes into the
  certificate **and into the audience of every token**, so a server told none
  issues tokens that work on its own machine and nowhere else. Repeatable.

`up` runs in the foreground, so the rest of these are typed in a second
terminal.

**2. Trust the certificate, once per machine that will connect.**

```sh
nlteam trust --root /srv/team              # prints the fingerprint, changes nothing
nlteam trust --root /srv/team --install    # after comparing it
```

Studio checks the endpoint against its own host's trust store and has no
pinning hook, so this step is manual on purpose. Compare the fingerprint against
the one the server printed at startup, over something other than the connection
you are about to trust.

**3. Make the first account.** It joins the `admin` group, and `init` refuses
once there is an account, so this is the only time it works.

```sh
printf '%s' 'the password' | nlteam init ada --root /srv/team
```

Everybody after that is made by somebody who is already here:

```sh
printf '%s' 'their password' | nlteam user create bob --root /srv/team --role authors
```

**4. Create a project.** Every account of this server reaches every project on
it, so there is nothing to grant.

```sh
nlteam project create harbour --root /srv/team --as ada
```

**5. Give people the address, and a token.**

```sh
printf '%s' 'their password' | nlteam token mint bob --root /srv/team
```

Those two — `nlteam://team.example.com:41402` and the token — are the whole of
what an author is handed. Studio asks the server for everything else, and the
token carries the authority's fingerprint, so trusting this server is a button
rather than a command.

Two ports have to be reachable from their machines: **41402**, where people
sign in, and **41337**, where the project data is served. The other three are
between programs on the server machine and are bound to the loopback.

## Commands

| Command | What it does |
| --- | --- |
| `nlteam up` | Install and run `loreserver`, and serve the sign-in endpoint |
| `nlteam trust` | Show this server's certificate authority, or install it |
| `nlteam init <name>` | Make the first account, on a server with none |
| `nlteam login <server> <name>` | Sign in to a server, so this machine can administer it |
| `nlteam logout <server>` | Forget one server's token and its authority |
| `nlteam user create <name>` | Make an account |
| `nlteam user list` | List the accounts |
| `nlteam user disable\|enable <name>` | Stop an account, or let it back in |
| `nlteam user revoke-tokens <name>` | Refuse every token it already holds |
| `nlteam user grant-admin\|revoke-admin <name>` | Let an account administer this server, or stop it |
| `nlteam token mint <name>` | Sign a token for an account |
| `nlteam project create <name>` | Create a repository and record it |
| `nlteam project list` | List the projects |
| `nlteam settings list\|set <key> <value>` | Show or change the token lifetimes and this server's name |
| `nlteam key list\|rotate` | Show the signing keys, or sign with a new one |

Most of them take `--root <path>`, the directory this server keeps its files in,
which means being logged into the machine it runs on. `login` is how that stops
being the only way:

```sh
printf '%s' 'the password' | nlteam login team.example.com:41402 ada
nlteam user list --server team.example.com:41402
nlteam settings set token.sign_in_lifetime_seconds 7d --server team.example.com:41402
```

`login` exchanges a password for a token over TLS, pins the certificate
authority the server presented — printing its fingerprint to be compared against
`nlteam trust` run on the server itself — and keeps both under this account's own
configuration directory rather than under any storage root. `--fingerprint` names
what to expect instead, for a deployment that must trust nothing it was not told
to. Every command in the table then takes `--server` in place of `--root`, apart
from the three below, and prints the same thing either way; each of them is a
method the protocol already has, because a command line that grew a verb the
protocol does not have would be one Studio's own management surface could never
catch up with.

`up`, `init` and `trust` take `--root` alone and always will. They are what a
server is rescued with, and a rescue that worked only over the thing being
rescued would not be one.

`nlteam --help` prints the options for each.
[operations.md](docs/operations.md) is the same ground at length.

## Development

```sh
git clone https://github.com/NarraLeaf/NarraLeaf-Team.git
cd NarraLeaf-Team
npm install
npm run build
npm link            # puts this checkout's nlteam on the path
```

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle the executable into `dist/` |
| `npm run dev` | Rebuild whenever a source file changes |
| `npm run typecheck` | Check types without emitting anything |
| `npm test` | Run the test suite once |

`npm test` downloads nothing and contacts nothing outside the machine; the tests
that want a real `loreserver` are skipped unless told where they may install
one. [internals.md](docs/internals.md) covers that and what is written here
rather than depended on.

## Status

Team supervises `loreserver`, issues identity, holds the projects, answers the
permission question behind every repository access, and serves the API Studio
lists and creates projects through. Administering a server from Studio, rather
than from a terminal on the machine it runs on, is not implemented yet, and
neither is upgrading between pinned `loreserver` versions.

## License

MIT, in [LICENSE](LICENSE). Epic Games' terms for `loreserver` and `lorelib` are
kept beside the binaries Team installs on your behalf.
