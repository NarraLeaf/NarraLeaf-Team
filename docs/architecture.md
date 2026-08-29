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

The bytes of the work itself. Team does not carry them.

Version control is the version-control server's, spoken as `lore://`, and a
Studio installation clones and pushes against it directly. Team's part on this
plane is to answer, when asked, whether a given token may touch a given
repository. It moves no project bytes and decides access to them.

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

**A store the version-control server is serving is never opened.** Its lock is
exclusive and blocking, and a second open waits without failing and without
logging. Team reads every project as a client of its own version-control server,
against a bare clone under the cache.

**A room holds nothing.** A live session is addressing and fan-out. It stores no
content, replays nothing, and ends with the process that held it. Anything worth
keeping has gone to the repository or to an attachment before the room closes.

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
