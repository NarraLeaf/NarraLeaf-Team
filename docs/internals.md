# How Team works

Why the parts are the shape they are. None of it is needed to run a Team server — that is
[operations.md](operations.md).

## Reading what is inside a project

The interface shows a project's revision history and what its project file says.
Neither is in Team's database: both are inside the repository, and Team reads them
the same way a Studio installation on somebody else's machine does — as a client,
over the network, against its own `loreserver`.

That is not a preference. `loreserver` holds an exclusive lock on the store it
is serving, and opening it a second time does not fail: it waits, at no CPU,
with nothing logged and no timeout to reach. So Team clones each project into
`<root>/cache/projects/<repository id>/` and reads that instead.

A checkout there holds no files at all. The clone is bare, which costs nothing
on the wire and a couple of kilobytes on disk; the branch, the history and each
revision's metadata are then answered from disk, and the revision tree — every
directory, every file and every size — and the contents of any file in it are
read through the store, which fetches what it needs on demand. Measured against
a project whose latest revision runs to 12 MB: 240 ms to clone and read the
first time, 90 ms to refresh, and 5.7 KB of cache.

**The cache is disposable.** Deleting `<root>/cache` at any moment, in whole or
in part, costs the time of the next read and nothing else. Nothing is kept there
that is not also in the repository it came from.

Reading happens beside the interface rather than in front of it. The screen is
drawn from the database at once and each project's history and file replace the
word unknown as they arrive, so a slow or stopped `loreserver` costs freshness
and nothing else.

What Team takes from a project file is its title, its stage size, how many scenes
there are, and how many assets of each kind and how large. It reads no further:
what a scene means belongs to Studio, and a Team server that had to know it would be a
Team that had to be upgraded whenever Studio was.

Anything Team cannot make sense of becomes a sentence rather than an error. A
project file from a newer Studio, one that was only half written, one that is
not the shape its name claims, a project nobody has pushed to, a repository that
cannot be reached — each of them leaves the parts Team did understand on screen
and says in words what it could not read.

A repository Team cannot read is also said once on `up`'s own output, and once
more if it starts working:

```
cannot read driftwood's repository: this project's repository could not be read: …
read driftwood's repository again
```

Only on the change, never on the interval. This is not an error, nothing waits
on it and no screen turns red — what it prevents is a reader that has never once
worked being indistinguishable from one whose first clone is still running.

### The two variables the library reads

Both are settled in `src/lore/environment.ts`, once, before the command that
reads anything starts its reader. Neither may be decided lazily: they are read
by native code on connections Team does not schedule.

`SSL_CERT_FILE` names `<root>/tls/ca.crt`, so that the client trusts this
server's own authority when it signs in at the https endpoint. Without it the
exchange fails with "failed to connect to auth endpoint: transport error".

`LORE_AUTH_PATH` names `<root>/credentials`, and it matters more than it looks.
Lore keeps signed-in sessions in **one store per machine and per user** and
selects one **by the host of the remote** — not the port, not the auth endpoint,
not the identity in the call. Measured:

```
[lore_transport::auth::exchange] Selected identity 6ef48853-…, authenticated for 127.0.0.1
```

where that account belonged to a different Team server that had run on the same
machine earlier. `loreserver` then has no signing key for the token, refuses
with `Not allowed (KeyNotFound(NotFound))`, and the client reports **"Not
authorized to access repository"** — before Team is asked whether the caller may
have it, which is why such a server has nothing in its authorization log at all.
A store of Team's own holds one identity, so there is nothing else to select. It
also keeps Team out of the store an operator's own Studio is using.

An operator who set either variable themselves is left alone.

## The authorization service

`loreserver` does not decide who may touch a repository. It asks, over gRPC, at
the address in its `auth_url`, forwarding the caller's own `authorization`
header. That address is Team.

```
epic_urc.UrcAuthApi/CheckUserPermission     may this caller reach these?
epic_urc.UrcAuthApi/LookupUserPermissions   what may this caller reach?
epic_urc.UrcAuthApi/ExchangeExternalTokenForUserToken       sign in
epic_urc.UrcAuthApi/ExchangeUserTokenForMultiresourceToken  a token for the data connection
ucs.auth.RebacApi/CreateResource            a repository now exists
ucs.auth.RebacApi/DeleteResource            a repository is gone
```

The same methods are served twice: on 41402 over TLS, which is what a client and
a Team server-supervised `loreserver` both reach, and on 41401 in plain HTTP/2 on the
loopback, which is what a `loreserver` that cannot be given Team's authority can
be pointed at instead. Neither listener is given anything the other is not —
every method decides from the token it was presented, not from where the
connection came.

Team identifies the caller by verifying the token against its own signing keys,
and answers with the projects that caller has a grant on. A token that is
expired, altered, from a disabled account, or issued before that account's
access was revoked is refused, and a refusal reaches the person as "not found" —
`loreserver` tells a client nothing about why. Every decision is written to
Team's log with the caller, the resource and the outcome, and kept in `team.db`
where something other than the terminal `up` is running in can read it —
`loreserver` records that it asked, not what it was told, so this is the only
account of who reached what.

The kept decisions are bounded, at two thousand rows. A count rather than an
age: a Team server used twice a month would have its whole history deleted between
visits by an age bound, while a busy one would keep hundreds of thousands of
rows inside any window worth calling recent. When the bound has to choose, it
drops the oldest allowances first and refusals last — an allowance is what every
working access produces, and a refusal is the row somebody comes looking for.
The trim runs once in every few hundred decisions rather than on each one, and a
decision is written without waiting for the disk, so answering a permission
question is not a Team server waiting on a platter.

This is also what makes revocation immediate, and it is the part `loreserver`
alone cannot do: it checks a token's signature and its expiry, and asks nothing
else, but every repository access goes on to ask Team.

## The Team protocol is a session, not a request

Everything a Studio installation could ask this server, it asked one request at
a time: seven routes under `/api/studio/v1`, a bearer token on each, and an
answer. That is enough for a list of projects and it is not enough for anything
an author does together with somebody else. Two things are missing from it and
neither can be added to a request: **this server cannot say anything nobody
asked for**, and **there is nowhere below a project to put anything**.

So there is a second thing on the same listener. `GET /api/team/v1/socket`, with
the same bearer, becomes a WebSocket, and over it either side speaks. Studio
makes calls and subscribes to topics; this server answers calls and pushes
events. The frames, the method names and the shapes they carry are all in
`src/team/protocol.ts`, which is the one file to read before changing any of it,
and whose twin lives in Studio.

Four decisions in it are worth stating here because they are what the rest
follows from.

**It is additive, and the discovery document's `protocol` does not move.** A
Studio that has never heard of the socket never opens one and loses nothing; a
newer one finds a capability name — `session`, `comments`, `clients`, `live`,
`overlay` — in the same list the existing five arrive in and matches it
literally. Nothing is ever discovered by getting a 404.

**One listener, one certificate.** The same reason the discovery document and
the operator's page are on the auth endpoint's port: an operator compares a
fingerprint once, and everything a Studio installation says to this server
arrives over the connection whose certificate was compared. That the `upgrade`
event fires at all on an `http2.createSecureServer` with `allowHTTP1` is
measured rather than assumed, and it is what makes this possible without a
second port.

**Anchors are opaque.** A comment is attached to a document inside a project and
usually to something inside that document. Both are strings Studio writes and
Studio interprets. This server stores them, indexes on them and compares them
for equality; it never parses one, never checks one against a repository, and
never has to be upgraded because Studio started anchoring to a new kind of
thing. It is the same bargain the project reader already makes, where a file it
cannot read is reported as unknown rather than as an error, and it is what keeps
the two halves independently releasable.

**A method is one place.** `src/team/methods.ts` holds a table of name,
capability and handler, and the discovery document's capability list is worked
out from that table rather than written down beside it. A build that leaves a
module out loses the method and the capability together, which is the one
direction that cannot strand a client: a capability announced by a build that
does not serve it defeats the whole point of checking before asking.

Who may do what has not changed and is still one sentence — every account of
this server reaches every project on it. The single exception is not about
projects: **a comment is edited or withdrawn by whoever wrote it**, operators
included. That is authorship rather than authorisation.

Delivery is deliberately the weakest guarantee that is still correct. Nothing is
queued and nothing is replayed. Each topic carries a sequence number, a client is
told where that number stands when it subscribes, and **anything other than
exactly the number it last saw means read the collection again**. A restart
takes the sequences back to nought, which reads as a missed event, which is what
it is.

## Three nouns on that session: instances, rooms, and what is attached

The socket by itself is a pipe. Three things travel on it that a request-shaped
API had nowhere to put, and each is a different answer to "who is working on
this, and what is beside it".

**A client instance is a machine, not a person.** The token says who is calling
and it is re-read on every call. What it cannot say is *which installation*, and
one person is routinely two — a desktop and a laptop, or two builds driven side
by side. The id is generated by the client, once, and kept; nothing here invents
one, because an id this server made would be new on every reconnect and would
identify a socket rather than an installation. A client says so with
`clients.announce` as soon as its session opens, and again when it opens a
different project. **An instance is removed when its socket closes**, never when
a client says goodbye: a client that is told to say so is one that will crash
instead, and a room full of people who are not there is worse than no room.

**There are two things called a session and they are not the same.** The socket
is one — Studio opens it on its own, nobody asks for one and nobody sees one. A
**live session** is a room: opened by a person, on one project, joined by other
instances. It exists to answer which machines are on this together right now and
to give this server somewhere to send what one of them says to the others
(`live.say`, relayed on `live:{id}`, sender included). It is the part a real-time
feature cannot supply for itself — addressing, membership, a delivery path — and
it is deliberately all of it: there is no operation model, no conflict rule and
no opinion about documents here.

**Opening one names the revision it starts from, and that is not optional.** The
people in a room apply each other's operations to a document, which means
nothing unless they all began from the same document, and the revision is the
only thing that says which one that was. Without it the members would have no
way of telling whether their texts agreed, and every operation after the first
would land somewhere slightly different — silently, because nothing here
compares them. This server still does not read the string; it carries it, so
that the clients about to trust each other's edits can.

**A room holds nothing, which is why it is memory.** Nothing said in one is kept;
whatever the people in it produce is written through the overlay store or pushed
to the repository, and both are still there when the room is not. So this server
restarting ends every room, drops every instance, and loses nothing — there is no
table, no sweep, and no policy about how long a dead room counts as one. If a
future feature needs an ordered, replayable stream per document, **that is a
change to the frames and the version number goes with it**, not something to
smuggle in by making this durable.

**An overlay record is content that must not enter the history.** A revision is
what an author recorded; a thread is a conversation about one; a record is
anything else a client wants kept beside a place in a project *at a version* — a
review mark on a story row, a translator's flag, a note from a playtest. Nothing
in `src/team/methods/overlay.ts` writes to Lore, reaches loreserver, or produces a
revision; a collaborator who syncs sees exactly what they would have seen. `kind`
and `body` are opaque on the same bargain anchors are.

**Following the head is a comparison this server does not make.** Each record
names the revision it was written against, and `overlay.list` also hands back
what the reader last found the project's tip to be. It does not mark anything
stale, because it cannot: whether the row a note is about survived the next
revision is a question about a document, and this server has not got one. The
client compares, and the client decides — and where it has looked and the thing
is still there, it says so by putting the record forward onto the new revision
with `overlay.put`. ⚠ **A missing head is "not read yet", never "no
revisions"**: repositories are read on a loop, and a client that confused the two
would mark every record stale for a minute after a restart.

## The interface is a second host, not a second implementation

The interface carries nothing out itself. A key that changes something names
what it wants, and that is met by calling exactly what the command of the same
name calls: `d` reaches `disableUser`, `x` reaches `revokeUserTokens`, `k`
reaches `KeyStore.rotate`. What each one answers with says the same thing the
command prints, including how far it reaches — `x` says that a connection
already open may last until its repository token expires, because "every token"
is otherwise read as including a session somebody has open.

Three keys name a command instead of doing anything, and that is deliberate:
`n`, `g` and `r` need a project's name or an account to grant to, which the
terminal interface has no way to ask for. Opening a window that pretended to do
it would not be honest.

There are two hosts now and still one implementation. Naming what is wanted is
an `Action`, carrying it out is `perform` in `src/actions.ts`, and both
interfaces send the first and call the second: a button in a browser reaches
`disableUser` by the same path `d` does, and is answered with the same sentence.
The browser can do the three the terminal names a command for, because a page
has somewhere to type a project's name and choose an account — the difference is
what each interface can ask for, not what each one is allowed to do. Restarting
`loreserver` is refused in both, in the same words, because it belongs to the
`nlteam up` that started it.

They read from one place as well. `src/publisher.ts` holds the repository
readings, gathers a view when they land — once per short window, however many
arrived — and hands it to whoever subscribed. A terminal redraws from it, a
browser is sent it as a server-sent event, and neither can be looking at a
different server from the other. `src/web/api.ts` decides nothing beyond who is
at the door: it takes apart the body of a request into an `Action`, refuses
anything that is not one, and passes it on.

Everything drawn arrives in one read-only structure, `src/tui/teamview.ts`,
gathered by `src/view.ts`. Nothing under `src/tui/` opens the database or a
repository, and there are assertions that say so. What Team cannot work out
arrives absent and is drawn as "unknown" rather than as an error or a zero — a
project written by a newer Studio shows the parts Team understands and the word
unknown for the rest, which is what keeps Team from having to be upgraded in step
with Studio. Absent and zero are different facts and are drawn differently: a
project with no revisions reads `0`, `—` and `never`, one nobody has counted
reads `?` and `unknown`.

## The languages are a shape, not a lookup

`src/i18n/` is one interface and three objects that fill it in. A message is a
field, and a message that needs a value is a function of exactly the values it
needs:

```ts
granted: ({ username, level, project }) =>
  `${username} can ${level} ${project}, from their next request`,
```

So a catalogue missing a message does not compile, and one that forgot a name
inside a sentence does not compile either. The alternative — `t("action.granted",
{...})` against a bag of strings — moves both of those to the moment somebody in
Tokyo presses a button. There is no template syntax, no interpolation format and
no framework; `messagesFor(locale)` hands back an object and the caller reads
fields off it.

Both halves import the catalogues. The page draws from them, and `perform`
composes the sentence an action answers with from them, which is what makes a
Chinese page Chinese rather than a Chinese frame around English sentences.
`src/actions.ts` and the format helpers take a language and default to English,
so the terminal interface passes nothing and gets exactly the words it always
had. Only `src/i18n/errors.ts` is server-only: it translates the errors an
operator can cause and can act on, once, at the API boundary, rather than
threading a language through every module that can fail. Anything it does not
know falls through to the error's own English message, which is the honest
answer — a sentence in the wrong language beats a sentence that says nothing.

The catalogues are bundled, not fetched. On the server that is the only thing
they could be, for the reason the pages themselves are inlined. In the browser
it is a decision: three languages are a few kilobytes, and having them all is
what makes switching one a redraw rather than a page load in the middle of
somebody's half-typed form. Nothing is refetched on a switch, because everything
on screen is drawn from the view the page already holds — including the two
lifetimes, which is why `SettingView` carries the number its value was written
from beside the value.

The rule for what is *not* translated is in the tests and worth restating: what
Team recorded stays as Team recorded it. Usernames, project names, groups, key
ids, the label a settings row is found by on the way back, and the detail a
decision was written down with are data. `tests/i18n.test.ts` walks every
catalogue against English, calls every sentence in it, and checks that the names
handed in come back out — the type checker can promise a message exists and
cannot promise it says anything.

## What the build produces

`npm run build` bundles `src/nlteam.ts` into `dist/nlteam.js`, an executable file
with a `#!/usr/bin/env node` line. The version number is written into the bundle
as it is built, so the finished file does not depend on a `package.json` sitting
beside it.

It is two passes, in this order. The browser half of the web interface —
`src/web/client` — is built first, minified because it crosses a network, and
into memory rather than onto disk. Then the executable is built around it, with
the script and the styles substituted into `src/web/assets.ts` as string
literals, beside the page and the icon which are written by hand there. So
`dist/nlteam.js` carries its own pages the way it already carries its own
version number: there is no state in which the server is running and its
interface is missing, half-built or left over from an older build, and the
server never has to work out where it is on disk to answer a request — which is
the thing that breaks once a file has been copied, symlinked or put on a `PATH`.

`npm run dev` watches both. A change to a page cannot be picked up by an
incremental rebuild of the executable, since its copy of the pages is a literal,
so that watch throws the server's build context away and makes another; a change
to anything else is the ordinary incremental rebuild it always was.

A test run builds neither, so `vitest.config.ts` substitutes a byte of each in
place of the real ones. That is enough for the router's tests to exercise
serving a file, an entity tag and a 304 without pretending a test run has an
interface in it, and the router says so in a sentence — rather than serving an
empty page — when it finds it has no interface to serve.

It is no longer a self-contained file, and it cannot be one. Reading a
repository needs `koffi`, a native addon, and `lorelib`, a 29.5 MB shared
library that arrives as one of four platform packages — Epic publish one per
platform, each declaring the `os` and `cpu` it is for, so installing puts
exactly one of them on disk. Neither can live inside a JavaScript bundle, so
both are left external and found at runtime in `node_modules`. That is there for
`npm i -g`, for a checkout, and inside a container; what stops being possible is
copying `dist/nlteam.js` somewhere on its own and running it. Everything except
reading a repository still works without them, and Team says which projects it
could not read rather than refusing to start.

`LORE_LIB_PATH` names a `lorelib` to load instead, and skips the platform check
on purpose: it is there for a machine Epic publishes no build for, where
somebody who built the library themselves should be able to point Team at it.

The `bin` entry names the executable `nlteam`, so `npm link` puts a working
`nlteam` command on the path during development.

## What Team redistributes, and under what terms

`up` keeps Epic Games' `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` beside every
binary it installs: `loreserver`'s come out of the release archive it was
unpacked from, and `lorelib`'s are fetched from its own release archive into
`lorelib-<version>/` in the same per-user cache. The library itself comes from
npm, and its package lists both files among its `files` while shipping neither —
checked against 0.8.6, where the published tarball holds the library, two entry
points and a README. Fetching them is not a precondition of anything: a machine
that cannot reach GitHub says so once and carries on.


## What is written here, and what is not


The runtime dependencies are Ink and React for the terminal interface, and
`koffi` with one `@lore-vcs/sdk-*` platform package for reading a repository.
Everything else is written here. That includes the binding to `lorelib`:
`src/lore/` is the slice of Epic's C ABI Team uses, a loader, an event decoder
and a dozen verbs, none of which writes anything. It includes gRPC, which Team
both serves and calls: `src/grpc/` is the protocol buffer codec, the framing, a
server and a client, on `node:http2`, for the dozen small messages `loreserver`
and Team exchange. It includes reading MessagePack, which is what a Studio
project file is written in. It includes WebSocket: `src/team/websocket.ts` is
the handshake, the framing and the control frames, and no extensions at all —
a few hundred lines against a specification that has not moved since 2011, for
a protocol whose every message is JSON. And it includes X.509:
`src/tls/` writes the DER of a certificate a byte at a time, and `node:crypto`
signs it.

The browser half is written here too, and carries no framework at all. What it
draws is five lists and a form; a framework would be a hundred and forty
kilobytes over the network and a second way of writing everything. `h` in
`src/web/client/dom.ts` is the whole of the abstraction, and drawing is a whole
redraw — the view arrives complete, so working out what changed would mean
keeping a second copy of it to compare against. The one thing a redraw would
lose is where somebody was typing, and `renderInto` carries that across by name.
The screens share the view type and the formatters with the terminal interface,
which is why "2h ago" means the same thing on both and neither reads a clock of
its own. It is checked by `tsconfig.web.json`, the one place the DOM exists, and
`npm run typecheck` runs both configurations.

The three languages the web interface is written in are written here too, and
carry no library either: `src/i18n/` is one TypeScript interface and three
objects that fill it in, which is what makes a missing message a build failure
rather than a blank on somebody's screen. See
[The languages are a shape](#the-languages-are-a-shape-not-a-lookup).

## Tests and the interface driver

`scripts/tui-drive.mjs` runs the built executable's interface through a real
pseudo-terminal and prints the grid a person would be looking at, one frame per
key. It is a mechanical driver: it captures, it does not judge. It needs
`node-pty` and `@xterm/headless`, which are not dependencies of this package —
install them for a checkout with
`npm install --no-save --no-package-lock node-pty @xterm/headless`, and it says
so if they are missing.

```sh
node scripts/build.mjs
node scripts/tui-drive.mjs --root /srv/team --columns 120 --rows 40 --keys 2,down,x
```

`scripts/socket-endpoint.ts` is the same kind of thing for the Team protocol. The
suites here drive a session with node's own WebSocket client, which proves the
server against an implementation nobody here wrote. What no suite in this
repository can prove is the join — Studio's client, its certificate handling and
its framing against this server's — so this is a listener with one account, one
project and one token, and what connects to it is somebody else's business. It
publishes on the `projects` topic once a second, so a client can be seen being
told rather than asking.

```sh
npx esbuild scripts/socket-endpoint.ts --bundle --platform=node --format=cjs \
  --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-drive\" --outfile=endpoint.cjs
node endpoint.cjs cert.pem key.pem
```

The certificate tests are worth knowing about before changing anything under
`src/tls/`. They read what the writer produced back with
`crypto.X509Certificate`, compare the extensions against the exact bytes DER
allows for them, and complete a real TLS handshake between a server holding the
generated pair and a client holding the authority. A certificate that only looks
right is worth nothing.

`npm test` downloads nothing and contacts nothing outside the machine. The tests
that need a real `loreserver` — the whole lifecycle, and reading a project while
the server holds its store — are skipped unless `NLTEAM_TEST_LORESERVER_ROOT`
names a directory they may install into:

```sh
NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it npm test
```

Reading covers more when `NLTEAM_TEST_LORE_CLI` also names Epic's `lore`
executable: with it the test puts a project into a repository and reads it back,
which is the half of it a repository nobody has pushed to cannot reach. Team
binds no verb that writes a revision and is not going to grow one for a test.

```sh
NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it NLTEAM_TEST_LORE_CLI=/opt/lore/lore npm test
```
