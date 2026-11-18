# Architecture

What a NarraLeaf Team server is, and how its responsibilities are divided. For
how the parts work, see [Internals](internals.md). For running one, see
[Deployment](operations.md). For what a server protects, see
[Security](security.md).

## Scope

A Team server holds the shared work of one team using NarraLeaf Studio. It is
optional: Studio is complete on its own, and a server is what a team adds when
more than one person works on the same project.

Team keeps a team's projects, decides who may reach them, and carries the
messages people exchange while they work. It is not a general backend, not a
build service and not a chat system, and it does not read Studio's document
formats.

Team's responsibilities fall into four planes. Each has one protocol, one kind of
listener, and one rule about who is trusted on it.

## The content plane

The work itself, and for a team project Team is now where it lives.

**A team project's current state is held by Team** (the `documents`
capability). Every Studio that opens the project sends its edits to Team as
intents; Team applies each one with Studio's own appliers (the kernel in
`studio-kernel/`, bundled from Studio), writes it to a log in its database
before it counts, and publishes it on the project's `doc` topic for every Studio
to apply. There is no room and no host, and nothing ends when the last person
closes the project. See src/authority/.

**The history is still the repository's.** Team commits the project's state to
its own loreserver as ordinary revisions - a snapshot when the project goes
quiet, or when somebody saves a version by hand - so every version is one any
Studio or the console can open, and a restore reads one back. Team writes these
through a checked-out working copy of its own under the cache, never through the
store loreserver serves. Asset files reach Team through the blob store and go
into the snapshot beside their records; once one has arrived it is copied under
`<root>/authority/owed/` until a snapshot holds it, because the blob store is
emptied whenever the server starts.

**Every file of the project travels, not only the documents.** A document the
kernel has operations for travels as those operations. Every other file Studio
keeps in the project (the project file, story animations, the save schema,
presets, anything a later Studio adds) travels whole as a `put-file`, stamped
with the seq its author stood at; one somebody wrote after that is refused as a
conflict rather than overwritten. Team holds those files beside its documents
(small ones in memory, larger ones as a note of their digest) and commits them in
the same snapshot. Offline, Studio sends every file it changed whole on
reconnecting (stories alone replay row by row), and the same check applies: a
file reached by any edit after the author's seq collides. So editing a team
project is editing a personal one, with the server keeping everybody in step.

A project on a server without `documents`, or a personal project, is versioned
the old way: a Studio clones and pushes against loreserver directly, and Team's
part is to answer whether a given token may touch a given repository.

## The coordination plane

Everything that is about the work without being the work: who is present, what
someone said about one line of a scene, which live session is open, what has been
attached to a revision.

This is the Team protocol, one authenticated session per Studio installation, and
Team owns it completely. A new collaboration feature is a method here.

## The management plane

Who exists, what each account may do, and what the server is.

It is the same protocol as coordination, separated by an administrator's
authority rather than by a second port. The methods are the `admin.*` family on
that one session, and the authority behind them is read as each call arrives. An
account taken out of the admin group is refused on its next call.

The surface an operator uses is Studio, the same application authors run. The
command line reaches this plane as a client of the same methods.

## The rescue plane

Not on the protocol. Whoever holds the server's storage root can bring the server
up and reach the accounts and the settings underneath the protocol, and it is the
plane a backup is taken from and restored onto. It works when the protocol does
not answer or nobody can sign in.

It is guarded by access to the storage root and by nothing else.

Which plane a command is on is decided by one option: `--server` puts it on the
management plane, `--root` on the rescue plane. `up`, `init` and `trust` take
`--root` only. The management plane will not take the last operator's
administration away or disable their account, and names the rescue command that
will.

## Hosts

There are two hosts, divided by who is asking.

**Studio** is the host for people. Authors reach the coordination and content
planes through it, and operators reach the management plane through it. Studio
holds one sealed token per server and never lets the renderer touch the network;
every remote byte passes through its main process.

**The command line** is the host for programs and for recovery: the operations an
operator wants without opening an application, an output a script can read, and
the local recovery commands. On the management plane it is a client of the
protocol exactly as Studio is. What it holds afterwards belongs to the person who
signed in, and is kept under their own configuration directory rather than under
a server's storage root.

Two rules hold the division in place:

- The command line grows no verb the protocol lacks. Every administrative command
  is wired to a method that already exists.
- The recovery commands are reachable from the storage root only, never over the
  protocol.

What a command prints does not depend on which plane it took. Where the protocol
carries less than a database read does, the column is left blank rather than
estimated, and a test drives each command both ways and compares the output.

## Invariants

**An anchor is never parsed.** A note or an attachment is addressed by three
strings: a document, an element within it, and a revision. Team stores them,
indexes on them and compares them for equality, and never reads inside them. A
new kind of thing to point at is a new string, and the server needs no change to
carry it.

**Team never models a Studio document, but it runs the code that does.** A team
project's documents are JSON Team hands to Studio's kernel; what an operation
means, which documents it reaches and how a file is parsed are the kernel's.
A Studio and a server on different kernels (`KERNEL_VERSION`) must not edit the
same project. The server enforces it per connection: `doc.head` is where a
Studio says its kernel, and a connection that has not agreed this server's for a
project is told none of its effects and may not read its base or send it an
edit. A Studio that never says (one older than the question) is refused and
falls back to editing offline.

**Nothing an author was told happened is lost.** An applied edit is in the log
before it is published, and a project is reopened from its last snapshot plus
the log after it. The log is cleared only up to a saved version and only once it
is older than the retention (thirty days by default); an offline edit based on
something older is handed back as a conflict rather than landed unchecked.

**A store the version-control server is serving is never opened.** Its lock is
exclusive and blocking, and a second open waits without failing and without
logging. Team reads every project as a client of its own version-control server,
against a bare clone under the cache.

**A room holds nothing.** A live session (the older `live` capability, kept for
projects on servers without `documents` and for presence and chat) is addressing
and fan-out. It stores no content, replays nothing, and ends with the process
that held it. A team project's documents do not travel through rooms.

**Delivery is weak.** A subscriber that sees a sequence number other than the one
it last saw reads the collection again. Events are never queued and never
replayed, so a subscriber too slow to keep up is dropped and reconnects.

**The caller is identified on every call.** A token is checked again for each
method and each subscription, so withdrawing an account's access takes effect on
the next call rather than when its token would have expired.

## The database

`team.db` holds the accounts and their groups, the projects the server has
registered, the operator settings, the record of who was allowed or refused, and
the notes, threads and attachments people have left.

The work itself is not in it. That is in the repositories, on the content plane.
Presence, rooms and the per-topic sequence counters are not in it either: they
are lost on restart and rebuilt by whoever reconnects.

## Decided for 0.2: the web console

Recorded here before the code exists, so that what is built can be held to it
and a later change has to change this section first. The plan, with what was
measured behind it, is [refactor-plan.zh.md](refactor-plan.zh.md).

**A third host.** Studio edits, the command line scripts and rescues, and a
web console served by the server itself looks, comments and administers. The
reason the web interface was removed earlier still holds against what it was —
a second place to list and open projects — and does not hold against this one,
which does what Studio cannot by construction: a view across projects, a view of
a person, and knowing what happened without opening anything.

**D1. The console never edits a project.** It reads content, writes threads,
to-dos and settings, and nothing else. A second place to change a scene is a
second answer to "why did this change", and the repository keeps one writer.

**D2. The server passes project files through unread.** The console reads a
revision's files as bytes, through a route that serves them from Team's own
checkout, and parses them in the browser with a viewer package shared with
Studio. *An anchor is never parsed* and *Team does not read Studio's formats*
both stand: what changes is that Team now hands the bytes on.

**D3. Access is per project again.** Each project has members with a role —
owner, editor, reviewer, viewer — and the repository question is answered from
it. This reverses the rule that every account reaches every project. Existing
accounts are migrated in as editors of every existing project, so an upgrade
changes nobody's access.

**D4. Team is an OAuth 2 authorization server for Studio.** Studio signs in by
opening the system browser on Team's own page (authorization code with PKCE, a
loopback redirect), and receives the same token it does today together with a
refresh token. The password route is kept for one major version.

**D5. Threads on the server are the record when a project has one.** Studio's
in-project comment file is what a project without a server uses, and a cache
otherwise.

**D6. To-dos are a table of their own**, not overlay records, because whether
somebody else may see one is decided by the server, and an overlay body is not
read.

**D7. The console holds a session.** A same-origin, `HttpOnly` cookie, revocable
and recorded. Studio and the command line keep stateless tokens. The console's
data travels on the same protocol socket as Studio's, opened by the same origin
with the cookie; REST grows sign-in, OAuth, file reads and uploads, and no data
methods.


## The web console's viewers (0.2, P3)

The console reads a project at any revision through the two file routes in
docs/protocol.md (Project files), and interprets the bytes in the browser with
`@narraleaf/project-view` (`project-view/`): the story library and documents,
the characters, the asset registers and the UI blueprints. Each reader refuses a
schema newer than the Studio it was written against
(`STORY_DOCUMENT_MAX_SCHEMA` and its neighbours), and shows "this revision needs
a newer Team" rather than a guess. Raising those ceilings when Studio raises its
schemas is the one change a Studio format bump asks of Team, and it is a change
to the page, not to the server.

The plan (§4.1) had Studio import its read-only types from this package so the
two cannot drift. That turned out to be the wrong seam: Studio's `shared/` types
are richer than a viewer needs and carry its own migrations, and Studio has no
use for view models. What can drift is the schema version, so that is what is
pinned. Studio writes `src/shared/types/projectSchemas.json` (its own test keeps
it equal to its schema constants); Team keeps a copy as
`project-view/studio-schemas.json`, and `tests/projectview.test.ts` fails while
the readers' ceilings differ from it. Bringing a new copy across is the prompt to
look at what changed in that document and raise the reader's ceiling with it. It
is the Team contract's handshake run the other way.
