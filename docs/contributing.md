# Contributing

NarraLeaf Team has a house style, and most of it is visible on any page of this
repository.
What is not visible is the shape of the work: which five files a new protocol
method touches, why a migration is never edited, what a refusal has to say. That
is what this is for. It is not a rulebook, [architecture.md](architecture.md)
says what Team is, [protocol.md](protocol.md) is the wire specification and
[internals.md](internals.md) is how the parts work, it is the list of things
somebody adding to this would otherwise have to find out by reading everything.

## Before pushing

```sh
npm run lint        # oxlint: the mistakes that type-check and still mean nothing
npm run typecheck   # tsc over src, tests, scripts and protocol/src
npm test            # vitest
npm run build       # esbuild, which the two above never run
npm run contract    # and then: git diff --exit-code -- protocol/contract.json
```

A sixth runs in CI only: the image is built on every push, started, and made to
answer its own health check and take a first account before anything is pushed
to a registry. `docker build .` from a checkout does the same build.

All five above are in CI and all five have caught something the others could
not. The
last pair is the one that is easy to forget: `protocol/contract.json` is
generated from `protocol/src/index.ts`, and Studio holds a copy of it that its
own tests pin, so a change to the source committed without the generated file
beside it leaves the two repositories describing different protocols.

Some of `npm test` is skipped unless a real loreserver is available. See
[internals.md](internals.md#tests-and-the-endpoint-driver) for the two
environment variables that switch those suites on, and for the two scripts in
`scripts/`, a listener to point a real client at, and the benchmark every
performance figure in these documents came from.

## How this is written

**Comments say what the code does and why, for somebody reading this cold.**
Not what it used to do, not which ticket asked for it, not what is planned. A
comment that explains a decision is worth more than the decision, because the
decision is in the code already and the reason is nowhere.

**Where a decision looks wrong, say why it is not.** Most of the long comments
here exist because somebody would otherwise have "fixed" the thing they are
about. `no-await-in-loop` fires seventy-four times in this repository and is
wrong every time: the project reader takes one repository at a time on purpose,
and that sentence belongs beside the loop rather than in a changelog.

**Prose uses American spelling**, as the rest of the NarraLeaf documentation
does. Identifiers and comments are in English.

**Prose carries no em dashes.** A parenthetical takes commas or parentheses; an
aside that runs to the end of a clause takes a colon or a comma.

**Headings are noun phrases.** Not sentences, and not a claim the section then
argues for.

**NarraLeaf Team is the product's name.** Write it in full the first time each
document uses it. `Team` on its own is the abbreviation, and is used only after
the full name has appeared above it. The same rule applies to NarraLeaf Studio.

**A refusal is one sentence, and the same sentence on both paths.** Something
that can be refused from a command line and over the protocol says the same
thing either way, from one place. Where the two must differ, the difference is
the way out: a protocol refusal that names the local command which would work is
useful, and two wordings of one rule are two rules to keep in step.

**Numbers have a reason next to them.** Every limit here says what it is derived
from, a page size from what a real project holds, a concurrency limit from the
size of libuv's threadpool, a retention window from what it is protecting. A
number without one is a number nobody can ever change safely.

## The shapes

### A new method on the protocol

Five places, and the fifth is in another repository:

1. `protocol/src/index.ts`, add the wire name to `TEAM_METHODS`. This is the
   only place a method name is written as a string.
2. `npm run contract`, regenerates `protocol/contract.json`. Never edit it.
3. `src/team/methods/`, a `TeamMethod`: a `name` from `TEAM_METHODS`, the
   `capability` it is announced under, and a `handle`. Register it in that
   file's own `...Methods()` function, which `teamMethods()` in
   `src/team/endpoint.ts` already collects.
4. Nothing else. The capability is **derived** from the table, never declared,
   and `assertProtocolConsistency` refuses to start a server whose registered
   handlers, declared names and published contract are not one set. That
   assertion is why there is no step here for announcing it.
5. Studio holds a byte-identical generated copy of the contract, pinned by a
   test of its own. A method added here without that copy regenerated leaves
   Studio unable to name what this server now serves.

Read the parameters with the helpers in `src/team/methods.ts`: `paramsObject`,
`optionalText`, `boundedCount`, `oneOf`. Each refuses with a `MethodError`
carrying a sentence rather than returning something odd, and each takes a limit,
because every answer this server composes is bounded and so is every string it
stores.

A method whose write a client might send twice over a socket that dropped takes
a client id and goes in `client_writes`. See `src/identity/writes.ts`, which
says which writes cannot be answered by re-reading the record, and why almost
all of them can.

### A new migration

Append to `MIGRATIONS` in `src/identity/database.ts`. Three rules, and the first
is absolute:

- **Never edit a migration that exists.** It is what that version meant, and a
  server that stopped at it has to be able to arrive here by the same steps as
  everybody else. Migration 1 still creates the invite table that migration 6
  drops.
- `SCHEMA_VERSION` is derived from the list. There is nothing to bump.
- **Do not write today's defaults into a table.** An absent settings row means
  "the default in `src/identity/config.ts` answers this", so a later version of
  Team that changes a default reaches every installation that never touched it.
  A migration that writes the defaults freezes them at whatever that build
  happened to think, and nothing says so.

An index is a write on every insert, spent to make one read faster. Say which
read, beside it. Two tables here deliberately have none, and both say why.

### A new setting

`src/identity/config.ts` holds the default and the type;
`src/identity/settings.ts` reads it back out of the table and refuses a value
that will not turn back into the thing it stands for. The table stores text
whatever the setting means, because a column per type is a schema change every
time a setting of a new type appears.

Settings are read **when they are used**, not when the server starts. An
operator changing one over ssh should reach the next connection, not the next
restart, and a capability list settled at startup was exactly the bug that made
`server.collaboration` appear to do nothing until somebody restarted.

### A new command

`src/args.ts` parses it, `src/cli.ts` dispatches it, and a module of its own
does it. Then one question decides where it may live:

- **Does the protocol have this verb?** If it does, the command works against a
  server with `--server` as well as a storage root with `--root`, and the two
  print the same thing. The CLI grows no verb the protocol lacks.
- **Is it rescue?** `up`, `init` and `trust` take `--root` only. They are
  reached by somebody holding the storage root, who holds the signing keys with
  it, and the protocol is not involved. That plane is guarded by filesystem
  permissions and by nothing else, on purpose.

### A new message in the three languages

`src/i18n/messages.ts` is an interface and `en.ts`, `zh.ts` and `ja.ts` fill it
in. A message is a field, and one that needs a value is a function of exactly
the values it needs, so a catalogue missing a message, or a translation that
forgot a name inside one, does not compile. There is no key lookup and no
template syntax, and adding either would move every one of those mistakes to the
moment somebody in Tokyo reads the sentence.

Anything the server recorded rather than said stays as it is: a username, a
project's name, the `detail` of a decision. Translating those would mean saying
something the database does not hold.

### A new limit

If only this server needs the number, it belongs beside the code that enforces
it. If **both ends of the wire** need it, the largest page a client may ask
for, the largest answer it must be able to receive, it belongs in the contract.
A client and a server disagreeing about a ceiling is a session that dies on a
message neither end thinks is too large, and that has happened here once: it
took a Studio installation's socket down every time it reconnected.

## Things that are settled

Not open questions. A change that reverses one has to say so out loud rather
than arriving as a refactor.

- **An anchor is three opaque strings**, `{document, element, revision}`, and
  Team never parses them. It is what lets Studio and Team ship on their own
  schedules, and it is why a comment can be attached to a kind of thing this
  build has never heard of.
- **Every call is identified afresh.** Revoking somebody's access takes effect
  on their next call, not their next connection. It costs 55 microseconds, and a
  cache in front of it would buy a staleness bug with nothing.
- **Capabilities are derived from the registered method table**, never declared,
  and a startup assertion refuses a build where the two disagree. What a given
  caller may do is a different question, answered by `hello.account.operator`,
  so a client can tell "this server is too old" from "you are not an operator".
- **A room stores nothing.** Presence and live sessions are memory, and they end
  when the connection does.
- **Never open a repository loreserver is serving.** The lock is exclusive and
  the call does not return.
- **One protocol.** Everything a running client needs is a session method. REST
  is the discovery document and sign-in, and that is all it will be.
