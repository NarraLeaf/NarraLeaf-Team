# The shape of a Team server

What Team is, before any of how it works. The mechanism is
[internals.md](internals.md); running one is [operations.md](operations.md).

## One server, one team's work

A Team server holds one thing: the shared work of a small team using NarraLeaf
Studio. It is optional — Studio is whole on its own, and a Team server is what a
team adds when more than one person works on the same project. It is not a
general backend, not a build service, not a chat system, and it does not learn
Studio's document formats. It keeps a team's projects, decides who may reach
them, and carries the messages people exchange while they work — and nothing
past that line.

Everything below follows from a single division: the work Team is responsible
for falls into planes, and each plane has one protocol, one kind of listener,
and one rule about who is trusted on it. Most of the tangle that a refounding
untangles is a capability that ended up on the wrong plane.

## The planes

**The content plane** is the bytes of the work itself, and Team does not carry
them. Version control is `loreserver`'s, spoken as `lore://`, and a Studio
installation clones and pushes against it directly. Team's whole part on this
plane is to answer, when `loreserver` asks, whether a given token may touch a
given repository. It moves no project bytes; it decides access to them.

**The coordination plane** is everything that is about the work without being
the work: who is present, what someone said about one line of a scene, which
live session is open, what has been attached to a revision. This is the Team
protocol — one authenticated session per Studio installation — and Team owns it
completely. It is the plane that is meant to grow; a new collaboration feature
is a method here and nowhere else.

**The management plane** is who exists, what each may do, and what this server
is. It is the same protocol as coordination, separated only by an
administrator's authority — not a second product and not a second port. Today
these operations are reached by a local command that opens the database
directly; the direction is that they become protocol methods, so that the
surface an operator uses is Studio, the same application authors already run,
and the command line remains for automation and for the times the protocol is
not the answer.

**The rescue plane** is deliberately not on the protocol. Whoever holds the
server's root directory can bring it up and reach the accounts and the settings
underneath the protocol directly — and it is the plane a backup is taken from and
put back onto — precisely because it must keep working when the protocol itself
is broken or no one can sign in. It is guarded
by nothing more than access to the disk, which is the point: it is the floor
under the other three, not a convenience on top of them.

## Two hosts, divided by who is asking

There are two hosts and there will be two, because the browser interface and the
terminal interface are both gone — which is what makes the attack surface and
the deployment small enough to run in a container.

**Studio** is the host for people. Authors reach the coordination and content
planes through it, and operators will reach the management plane through it too.
It holds one sealed token per server and never lets the renderer touch the
network; every remote byte passes through its main process.

**The command line** is the host for programs and for emergencies: the common
operations an operator wants without opening an application, an automation path
with output a script can read, and the local rescue commands that answer when
nothing else does.

Two consequences hold the division in place, and each is meant to be checkable
rather than merely intended. The command line grows no verb the protocol lacks,
or the Studio surface could never reach parity with it. And the rescue commands
are reachable only from the disk, never over the protocol, or the thing that
works when the protocol is broken would not in fact be separate from it.

## The rules that do not bend

These are the invariants the code is built to keep. Each is stated with what
holds it, because a rule a comment merely asks for is not a rule.

**An anchor is never parsed.** A note or an attachment is addressed by three
strings — a document, an element within it, a revision — and Team stores them,
indexes on them and compares them for equality, but never looks inside them.
This is the whole reason Studio and Team can be released on separate schedules:
a new kind of thing to point at is a new string, and the server needs no change
to carry it. The database columns say so and the method layer never reaches into
them.

**A store that `loreserver` is serving is never opened.** Its lock is exclusive
and blocking, and a second open does not fail — it waits forever, at no CPU,
with nothing logged. So Team reads every project as a client of its own
`loreserver`, against a bare clone under the cache, and a test asserts that the
only modules which know where the store lives are the two that must.

**A room holds nothing.** A live session is addressing and fan-out and no more;
it stores no content, replays nothing, and ends with the process that held it.
Anything worth keeping from inside one has gone to the repository or to an
attachment before the room closes. This is what lets a room live only in memory,
and it is the premise the collaboration model's host-owns-the-document rule
stands on.

**Delivery is weak on purpose.** A subscriber that sees a sequence number other
than the one it last saw is being told to read the collection again, not handed
what it missed; events are never queued and never replayed. The gain is that a
subscriber too slow to keep up can simply be dropped, because dropping it is
correct — it reconnects and re-reads.

**The caller is identified on every call, not once at the door.** A token is
checked again for each method and each subscription, so withdrawing an account's
access takes effect against the next thing it asks rather than whenever its
token would have expired.

## Where this leaves the database

Team's own store, `team.db`, holds only what the planes above require it to:
the accounts and their groups, the projects it has registered, a few operator
settings, the record of who was allowed or refused, and the notes, threads and
attachments people have left. The work itself is never in it — that is in the
repositories, on the content plane — and the transient things, presence and
rooms and the per-topic sequence counters, are never in it either, because they
are meant to be lost on restart and rebuilt by whoever reconnects.
