# How Team works

Why the parts are the shape they are. None of it is needed to run a Team server — that is
[operations.md](operations.md), and what Team is, above the parts, is
[architecture.md](architecture.md).

## Reading what is inside a project

Team answers for a project's revision history and for what its project file says.
Neither is in its database: both are inside the repository, and Team reads them
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

Reading happens beside whatever answers a question rather than in front of it.
What is in the database is answered at once, and each project's history and file
replace the word unknown as they arrive, so a slow or stopped `loreserver` costs
freshness and nothing else.

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

They are served on one listener, 41402, over TLS. A client reaches it and so
does the `loreserver` Team supervises, which is given Team's own certificate
authority and verifies against it. There was a second listener carrying the same
methods in plain HTTP/2 on the loopback, for a `loreserver` that could not be
given that authority; nothing was ever pointed at it, so what it amounted to was
this service answering, unencrypted, on a port with no caller.

Team identifies the caller by verifying the token against its own signing keys,
and answers with the projects of this server, since every account of it reaches
every project. A token that is expired, altered, from a disabled account, or
issued before that account's access was revoked is refused, and a refusal reaches the person as "not found" —
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
The trim runs once in every few hundred decisions rather than on each one, and
no commit here waits on a platter, so answering a permission question is not a
Team server waiting for a disk — see [What a write costs](#what-a-write-costs).

This is also what makes revocation immediate, and it is the part `loreserver`
alone cannot do: it checks a token's signature and its expiry, and asks nothing
else, but every repository access goes on to ask Team.

## What a write costs

`team.db` is node's own SQLite, in write-ahead-log mode, with exactly one
process writing to it. Everything below follows from that and from one setting
beside it, and both are in `src/identity/database.ts`, where they are set.

Outside a transaction SQLite commits every statement on its own. At SQLite's
default of `synchronous = FULL` every one of those commits is an fsync, and an
fsync is what writing a row actually costs — the row itself is nothing. Measured
here on a Windows workstation with an NVMe disk, two thousand single-row inserts
into a database opened the way a Team server opens its own:

```
synchronous = FULL     3999 ms   (2.000 ms a row)
synchronous = NORMAL     38 ms   (0.019 ms a row)
synchronous = OFF        20 ms   (0.010 ms a row)
```

Nearly all of the difference between the first two is the fsync, and it is the
same difference on every write this server really makes — each of these through
the function that is actually called, at `FULL` and then at `NORMAL`:

```
recordDecision   1.750 ms   0.020 ms
putOverlay       1.766 ms   0.079 ms
addComment       1.824 ms   0.068 ms
createProject    1.785 ms   0.065 ms
```

The disk, in other words, is nearly the whole of what writing anything costs.
The path it would be paid on most often is the one nobody asked for: a decision
is written on every repository access, so at `FULL` a Studio installation
opening a project would wait on a platter for a line of a log.

So this server sets `synchronous = NORMAL`.

**That cannot corrupt the file.** It is worth saying first because it is the
thing the setting is assumed to risk, and in WAL mode it is a guarantee rather
than a hope: a commit appends frames to the log, the log is replayed only as far
as its last complete and checksummed frame, and `NORMAL` still syncs the log
before a checkpoint copies any of it into the database file. Nor can a Team
server process losing its footing lose a write — a crash, a kill, a fatal
exception — because the pages are already with the operating system by the time
the commit returned. What is given up is the most recent commits, and only to an
operating-system crash or a power cut.

What that is worth is a question about the tables rather than about databases in
general. Decisions are the largest table and the cheapest to lose: a row records
an access that already happened and was already allowed, the log line beside it
went out at the time, and the bound throws the oldest of them away as a matter
of course. Threads, comments and overlay records are lost to the one person able
to write them again, who still has them on screen. Presence and rooms are not in
the file at all — they are memory, and are meant to go on a restart. Accounts,
settings and token revocations are the ones worth thinking hardest about, and
each of them fails **loudly**: an account that was created and lost cannot sign
in, and whoever holds the password says so; a setting that was lost reads back
as what it was, on the screen it was set from; a revocation that was lost leaves
the account working, which is the operator's own next observation. The failure
people fear here is the quiet one — a change that appears to have landed and has
not — and none of these is that.

`synchronous = OFF` is not on the table, and the reason is worth stating rather
than leaving somebody to wonder: it stops syncing the log before a checkpoint,
so a power cut part-way through one can leave the database file holding pages
the log never durably recorded. That ordering is the whole of what stands
between the file and corruption, and it is exactly what `NORMAL` keeps.

One consequence of those numbers is worth knowing, because it caught this
server out. At two milliseconds a write, consecutive rows reliably land in
different milliseconds; at a twentieth of one they reliably do not. A
conversation's comments were ordered by when they were written and tie-broken on
the comment's id — which is random — so the moment replies started sharing a
millisecond they came back shuffled, a reply above the remark it answered. They
are ordered by the moment and then by SQLite's own row key now, which is the
order they were written in. Anything else here that sorts on a moment and
tie-breaks on something arbitrary has the same latent fault, and it is a fault
that only shows once the writes are quick.

### Writes that belong together

The other half of what a write costs is how many of them one call makes. A
method that writes three rows outside a transaction pays three commits. Storing
the deployment identity, which `up` does on every start, is nine rows: 18.1 ms
as nine commits at `FULL` against 1.8 ms as one. The cost is the smaller half of
the problem, though — a call that wrote eight of its nine rows before the process
stopped leaves a state no reader here has an opinion about, and in that
particular case a new issuer beside an old audience is a server that refuses the
tokens it has just issued.

So writes that answer one call are made in one, through `inTransaction`. It is
deliberately narrow. The work it runs is **synchronous**, because one connection
serves this whole process and a transaction held open across an `await` is one
that unrelated writes fall inside — committed by this call's commit, or thrown
away by its rollback. It **refuses to nest**, because `node:sqlite` has no
nested transactions and the error a second `BEGIN` raises would roll the outer
one back; a store function meant to be part of a larger write does not open one
at all, which is the arrangement `insertUser` and `createUser` already had. And
it rolls back on a throw, because a transaction left open by one is a connection
holding the write lock for the life of the process — a Team server that has
stopped answering.

Two places write more than once on purpose and are worth knowing about, because
both look at first like something that was missed.

Making a project writes the row, asks `loreserver` for the repository, and
removes the row again if it refuses. Those cannot be one transaction: a request
to another server sits between them, so the transaction would be held across an
`await` — and the row is written early **precisely so that another caller can
see it**, since `loreserver` announces the new repository back over the gRPC
service while the create call is still open. A row inside an uncommitted
transaction is a row that announcement would not find. What is left is a
compensating write with a bounded cost: a row that outlives a process which died
in the middle is a project on the list with no repository, which denies nobody
anything and which `nlteam project forget` takes off.

An operator's write takes a note of itself afterwards, so that the same call
arriving twice over a dropped socket is not done twice. The note is a second
commit for three reasons at once — the handler may await, it may already have
opened a transaction of its own, and it announces what it did, which has to
happen after the effect is committed rather than while it is still provisional.
The window that leaves is the one the note was always written to live with, and
every method there survives it: a repeat re-reads the record rather than
replaying a stored answer, and the two whose effect is not a database row at all
are exactly the two no transaction could have covered.

## What a password costs

A write costs a disk. A password costs a core and a hundred and twenty-eight
megabytes, and that is not an accident to be optimised away: scrypt at OWASP's
2026 parameters is expensive precisely so that a stolen `team.db` is not a list
of everybody's passwords. What can be got wrong is not the price of one, but how
many are allowed to run at the same time.

They run on libuv's threadpool, which is four threads unless a deployment says
otherwise, and it is the same four threads every file this server reads and
every call it makes into lorelib is waiting for. So the cost of a derivation is
not only its own latency; past a point it is everybody else's. Measured by
`scripts/bench.ts` with eight file reads kept in flight throughout — the worst
one of those reads, because how many get stuck behind a derivation is bounded
while how many sail past grows with the stall, so every percentile flatters a
longer one:

```
derivations at once   worst file read beside them   peak RSS
         1                      0.9 ms               223 MiB
         2                      1.2 ms               352 MiB
         4                    238   ms               606 MiB
         8                    496   ms               608 MiB
```

The cliff is at four because four is the pool. Below it a derivation is simply
one thread's work and nothing else notices; at it, a file read no longer waits a
fraction of a millisecond, it waits for a whole derivation to finish — and at
eight it waits for two, which is the same fact said twice. The memory column
says it from the other side: it stops climbing at four, because a pool of four
is what stops a fifth derivation starting.

The obvious lever is the wrong one. Raising `UV_THREADPOOL_SIZE` to sixteen does
flatten the cliff — eight at once then leave the worst read at 3.9 ms — but it
takes the process to 1.1 GiB resident to do it, because the small pool had been
quietly serving as a memory limit as well as a thread limit. Sizing a threadpool is a
question about a deployment's I/O; how much memory a flood of sign-ins may reach
is a question about this server. Answering the second by changing the first ties
them together for whoever comes next.

So the pool is left alone and the limit is Team's own: **at most two key
derivations run in this process at once**, in `src/identity/passwords.ts`, taken
inside the hasher rather than around any of its callers. A third waits. That
placement is the whole point of it — the limit used to sit in front of the
Studio sign-in route, which meant it was true of sign-ins and of nothing else,
and `admin.users.create` hashed a new account's password on the management plane
with nothing counting. One operator's import loop was enough to reach four. A
limit a caller has to remember to ask for is a limit that holds until somebody
adds a door.

Two things are deliberately *not* behind a wait. `nlteam token mint --root`
checks a password and is not rate-limited, because it is reached only by
somebody who holds the storage root and could mint the token without a password
anyway. And the derivation limit is not a rate limit: a caller who is the only
one asking never waits on it. What imposes a wait on a caller for how they have
behaved is `SignInLimiter`, in `src/identity/signin.ts`, and it guards the one
door that takes a password from anybody.

## What a call costs before it is a call

Every call on a session is identified afresh: the token is verified, the account
is read, and its `token_epoch` is compared, before the method named runs. That
is what makes revoking somebody's access take effect on their next call rather
than on their next connection, and it is the one decision in this protocol that
is paid for on every single message. So it is worth knowing what it costs. From
`scripts/bench.ts`, against a database of forty accounts:

```
findUserById, one row and its groups        25 us
identifyToken, what every call does         55 us
mintToken, signing one                     215 us
```

Fifty-five microseconds, of which about half is the signature and half is the
row. Eighteen thousand a second on one core, against a protocol whose busiest
real client is a person typing. Identifying per call is not a cost this server
is carrying for correctness — it is free, and anything cached in front of it
would be a staleness bug bought with nothing.

Minting is four times dearer than verifying, which is Ed25519 rather than
anything here, and it is not on this path: a token is signed when somebody signs
in, and once per project on each pass of the repository reader. Neither is a
place where four times not-very-much matters.

## The Team protocol is a session, not a request

Everything a Studio installation could ask this server, it once asked one request
at a time: routes under `/api/studio/v1`, a bearer token on each, and an answer.
That is enough for a list of projects and it is not enough for anything an author
does together with somebody else. Two things are missing from it and neither can
be added to a request: **this server cannot say anything nobody asked for**, and
**there is nowhere below a project to put anything**.

So the work moved onto the same listener's socket. `GET /api/team/v1/socket`,
with the same bearer, becomes a WebSocket, and over it either side speaks. Studio
makes calls and subscribes to topics; this server answers calls and pushes
events. What is left under `/api/studio/v1` is the sign-in route, which has to
answer before a session can exist. The frames, the method names and the shapes they carry are all in
`src/team/protocol.ts`, which is the one file to read before changing any of it,
and whose twin lives in Studio.

Four decisions in it are worth stating here because they are what the rest
follows from.

**It is additive, and the discovery document's `protocol` does not move.** A
Studio that has never heard of the socket never opens one and loses nothing; a
newer one finds a capability name — `session`, `comments`, `clients`, `live`,
`overlay` — in the same list `password-sign-in` and `project-history` arrive in,
and matches it literally. Nothing is ever discovered by getting a 404.

**One listener, one certificate.** The same reason the discovery document and
the sign-in route are on the auth endpoint's port: an operator compares a
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

## One implementation, whatever asks for it

An operator's verb has two callers — a command and a method — and neither of them
implements it. Disabling an account is `disableUser` from both, refusing the
tokens it holds is `revokeUserTokens` from both, rotating a key is
`KeyStore.rotate` from both. So what a username may be, how short a password may
be and what happens to an account that is already disabled are decided in one
place, and a rule tightened there is tightened for whoever asks.

What the two ends do with the answer is where they differ, and they differ
because their readers do. A command prints a sentence, including how far the
thing it just did reaches — revoking says that a connection already open may last
until its repository token expires, because "every token" is otherwise read as
including a session somebody has open. A method answers with the record: the
account as `adminUserBody` built it, the setting as the settings list carries it,
so a panel updates the row it is already holding rather than re-reading a page to
find out what it did. A sentence would be the wrong shape for one and a record
for the other, which is why neither is built from the other.

Two things one end will do and the other will not, and both are deliberate.
Removing the last operator — demoting them, or disabling their account — is
refused over the session and allowed at the command line: the command line runs
on the machine that holds the storage root, so it is the way back from a server
nobody can administer, and the refusal names the command. Restarting `loreserver`
is offered by neither: it belongs to the `nlteam up` that started it, and nothing
else can honestly offer to.

What a whole server *is* — whether the server beside it is answering, what its
store weighs, how many accounts, projects and decisions it holds — is worked out
by `src/team/status.ts` and answered by `admin.server.status`. Two parts of it
are expensive: the health check is a request to another server, and measuring a
storage root walks and stats every file underneath it, bounded at fifty
thousand. So it is worked out **when somebody asks and never on a timer**, and
an answer is kept for ten seconds — callers arriving while a gather is running
wait on that gather rather than each starting one. It carries the moment it was
worked out and how long an answer is kept, so a panel saying "as of" is telling
the truth rather than showing its own clock.

What Team cannot work out arrives absent and is reported as "unknown" rather
than as an error or a zero — a project written by a newer Studio shows the parts
Team understands and the word unknown for the rest, which is what keeps Team
from having to be upgraded in step with Studio. Absent and zero are different
facts: a project with no revisions is `0` and `never`, one nobody has counted is
unknown; a storage root too large to walk reports no size rather than none.
Those shapes are in `src/teamview.ts`, filled in by whichever half holds the
thing being described.

## The languages are a shape, not a lookup

`src/i18n/` is one interface and three objects that fill it in. A message is a
field, and a message that needs a value is a function of exactly the values it
needs:

```ts
notADuration: ({ value }) =>
  `"${value}" is not a duration. Write it as 30 minutes, 48 hours or 7 days.`,
```

So a catalogue missing a message does not compile, and one that forgot a name
inside a sentence does not compile either. The alternative — `t("error.notADuration",
{...})` against a bag of strings — moves both of those to the moment somebody in
Tokyo reads it. There is no template syntax, no interpolation format and
no framework; `messagesFor(locale)` hands back an object and the caller reads
fields off it.

What is in them is small, and deliberately: a duration in words and a refusal to
read one back. Those are the sentences that have to reach a person in whatever
language they read, because a lifetime is *shown* to somebody in words and those
words are what they type back — `src/duration.ts` writes and reads them both,
taking a language and defaulting to English. Everything this server says of its
own accord is English: a command prints for whoever is running the server, a
refusal on the wire is a code and a line for a log, and the sentence a person
sees is written by the client holding the screen. **A catalogue holds no sentence
nothing reads** — three languages of a message with no caller is three
translations to keep true for nobody, which is why the ones the deleted terminal
interface spoke went with it.

The catalogues are bundled rather than read from disk, which is the only thing
they could be: the executable carries its own version number for the same
reason, and a language it had to find on disk would be the one thing about it
that could go missing once it had been copied somewhere. `SettingView` carries
the number a lifetime was written from beside the words, so that a reader
wanting the number does not have to take words in an unknown language apart.

The rule for what is *not* translated is in the tests and worth restating: what
Team recorded stays as Team recorded it. Usernames, project names, groups, key
ids, the label a settings row is found by on the way back, the detail a decision
was written down with, and the value somebody typed that could not be read are
data. `tests/i18n.test.ts` walks every
catalogue against English, calls every sentence in it, and checks that the names
handed in come back out — the type checker can promise a message exists and
cannot promise it says anything. All three change together or that test fails.

## What the build produces

`npm run build` bundles `src/nlteam.ts` into `dist/nlteam.js`, an executable file
with a `#!/usr/bin/env node` line. The version number is written into the bundle
as it is built, so the finished file does not depend on a `package.json` sitting
beside it.

It is one pass. The server never has to work out where it is on disk to answer
for itself, which is the thing that breaks once a file has been copied,
symlinked or put on a `PATH`. `npm run dev` is the same build, watched. A test
run does not bundle at all, so `vitest.config.ts` substitutes the version the
same way from the same place, or nothing that reaches `src/version.ts` could
run.

It is not a self-contained file, and it cannot be one. Reading a
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


The only runtime dependency is `koffi`, with one `@lore-vcs/sdk-*` platform
package, and both are for reading a repository. Everything else is written
here. That includes the binding to `lorelib`:
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

The three languages Team says anything in are written here too, and carry no
library either: `src/i18n/` is one TypeScript interface and three objects that
fill it in, which is what makes a missing message a build failure rather than a
blank in front of somebody. See
[The languages are a shape](#the-languages-are-a-shape-not-a-lookup).

## Tests and the endpoint driver

`scripts/socket-endpoint.ts` is a listener to point a real client at. The
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

`scripts/bench.ts` is where every performance figure in this file came from.
A number written down once is a number nobody can check on their own disk, or
after the change that invalidated it, and all three of this server's costs are
the kind that move — a disk, a threadpool and a signature. It writes to a
temporary directory and takes about half a minute; nothing it does touches a
storage root, so it is safe to run beside a live server, though the figures will
be that server's as much as this one's if you do.

```sh
npx esbuild scripts/bench.ts --bundle --platform=node --format=cjs   --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-bench\" --outfile=bench.cjs
node bench.cjs
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
