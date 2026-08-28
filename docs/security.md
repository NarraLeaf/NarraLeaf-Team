# What a Team server protects

What this server protects, whom it protects it from, and what it deliberately
leaves unprotected. For what Team is, see [architecture.md](architecture.md); for
how the parts are put together, [internals.md](internals.md); for running one,
[operations.md](operations.md); and for what travels on the wire,
[protocol.md](protocol.md).

This is not a list of things that were once wrong. A defect appears below only
where the shape of it explains something that is true now.

## Which plane a worry belongs to

The four planes of [architecture.md](architecture.md#the-planes) are the frame,
and nearly every question about this server's security turns out to be a
question about which of them it lands on. Each has one rule about who is trusted
on it, and the four rules are not the same.

**The content plane** is a project's bytes, and it is the one Team is not on.
Version control is `loreserver`'s, spoken as `lore://` on port 41337, and a
Studio installation clones and pushes against it directly. Team's whole part is
to answer, when `loreserver` asks, whether the token in front of it may reach a
given repository. So a worry about what people write — its confidentiality, its
integrity, whether it can be exfiltrated in bulk — is a worry about who holds an
account here and about `loreserver`, and never about a byte passing through
Team, because none does. This is also why Team can add no protection to that
plane beyond deciding who gets on it: see
[The one Team cannot fix](#the-one-team-cannot-fix).

**The coordination plane** is one authenticated WebSocket per Studio
installation, carrying everything that is about the work without being the work.
It is the largest surface here — every method in
[protocol.md](protocol.md#methods) — and the one where a ceiling is
load-bearing, because everything on it is memory this server allocates and rows
this server keeps, at somebody else's request.

**The management plane** is that same socket and that same token, separated by
one thing: whether the account behind the call is in the `admin` group. It is
not a second port, not a second certificate and not a second credential, so it
adds no attack surface of its own. What it adds is a check, and *when* that
check is made is the whole of what this server claims about withdrawing access.

**The rescue plane** is off the protocol on purpose, and it is guarded by
nothing but access to the storage root. `up`, `init` and `trust` take `--root`
and will never take `--server`, because a rescue reachable only over the thing
being rescued would not be a rescue. Whoever holds that directory holds
`<root>/keys/`, and whoever holds the signing keys can mint a token for any
account on the server — and can make the account first, with `nlteam user create
--root`. Nothing in the code pretends otherwise, and the file modes below do not
protect anything from them: this is the floor under the other three planes rather
than a barrier on top of them.

## Two decisions that read as gaps

Both of these surprise people, and both are decisions rather than omissions.
Neither is going to change quietly, so a deployment has to be planned around
them.

**Every account of a server reaches every project on it.** There is no
per-project grant to give or to take away. `loreserver`'s question on each
repository access is answered from the account alone — an account of this
server, not disabled, holding a token this server has not refused — and
`PROJECT_PERMISSIONS` in `src/projects/registry.ts` is a single list read for
every account and every project. The table that once held per-project access is
gone: migration 7 in `src/identity/database.ts` is called "every account of a
server reaches every project on it" and its whole body is `DROP TABLE
project_grants`. The consequence is that the way to stop somebody is to stop the
account, which is `nlteam user disable` or `nlteam user revoke-tokens`, and that
one project you would rather a contractor did not see is a second server rather
than a setting. The same rule is why `members.list` hands every account of this
server the username, display name and recorded email address of every other —
see `memberBody` in `src/projects/answers.ts`.

It is what makes the four-digit code a live session is joined by not a secret,
and not meant to be one. Ten thousand values is a range an account here could
work through, and `mintCode` in `src/team/presence.ts` says so plainly: what the
code buys is not keeping people out but letting somebody in without having to
know whose room they are looking for. Lengthening it, hashing it or expiring it
would cost exactly that and buy nothing this server's own permissions have not
already decided.

**Any account may take any project off the list.** `projects.forget` is gated by
`session` and by nothing else, and the handler in
`src/team/methods/projects.ts` says so in as many words: any account may forget
any project, which is why nothing there is a role check. What goes is the row.
The repository stays in `loreserver`'s store with every branch and every
revision exactly as they were; what is destroyed is this server's record that
the repository is a project of its, and — through `ON DELETE CASCADE` — the
threads and comments hanging off that row. Nobody can open the project
afterwards, because a repository with no row is not one of this server's
projects. It is taken back with `nlteam project create <name> --repository <id>`,
against the repository that never moved, and
[operations.md](operations.md#taking-a-project-off-the-list) has the section on
doing that — including the part that bites, which is that the repository id is
not recoverable from anything left on the list once the row has gone.

## What the trust rests on

**One listener, one certificate, one fingerprint.** Everything a client says to
this server — the discovery document, the sign-in route, the socket upgrade, the
blob addresses and the gRPC authorisation service `loreserver` calls — arrives on
port 41402 behind one certificate, issued by an authority this server generated
for itself on first run into `<root>/tls/`. `src/tls/` writes both by hand, DER
byte by byte, and `node:crypto` signs them; the authority lasts ten years and the
endpoint's certificate 397 days, which is the split that makes the manual step
happen once. The router in `src/web/router.ts` is four arms and a 404, and its
opening comment says why they are not four ports: an operator is asked to compare
a fingerprint once, and a second listener would be a second such conversation.

Nothing inside the connection can establish that trust the first time, and a
person has to. `nlteam trust` prints the authority's SHA-256 fingerprint,
changing nothing, and `--install` puts it into the current user's trust store —
the user's rather than the machine's, so that the blast radius of a mistake is
one account. That step exists for one specific client: Studio's version-control
library builds its chain against the host's own trust store and offers nowhere to
pin a certificate. Everything else here does pin. `nlteam login` probes the
endpoint with verification off, sending not one byte of application data, keeps
the authority it was shown, and refuses loudly if that server later presents a
different one; `--fingerprint` says what to expect in advance, for a deployment
that must trust nothing it was not told to. Studio keeps the same bytes and
passes them as `ca:` with `rejectUnauthorized: true`. The `authority.sha256` in
the discovery document is a label and never evidence — it arrives over the
connection it describes.

**A token is verified on every call, not once at the door.** `identify()` in
`src/team/session.ts` runs on each call, on each subscription, and on a
thirty-second timer besides. It checks the signature against a published key
before it reads a single claim, then the issuer, the audience and the expiry
(`verifyToken` in `src/identity/tokens.ts`), and then asks the database two
questions the token cannot answer for itself: is the account still here and not
disabled, and was this token signed before somebody revoked that account's access
(`identifyToken` in `src/identity/bearer.ts`, comparing the token's `token_epoch`
with the account's). Every repository access `loreserver` serves goes through the
same pair. So disabling an account or revoking its tokens is refused against the
next thing it asks rather than whenever its token would have expired, and a
thirty-day sign-in lifetime is not thirty days in which a revoked account keeps
working. What none of it covers is the repository token, which is presented to
`loreserver`'s data plane rather than to Team, and that is why it lives fifteen
minutes rather than thirty days — see
[operations.md](operations.md#tokens-and-taking-access-away).

**A management subscription does not outlive its operator.** The `admin` family
is refused to anybody not in the group, checked on every call. A subscription is
the case that check alone cannot cover: `judgeTopic` runs when a client
subscribes, the account is demoted afterwards, and the token it holds is
untouched by that — minted before, signed, unexpired, belonging to an account
that is neither disabled nor revoked. So `identify()` calls `withdrawManagement`
on the way through, which takes every `admin/*` topic back from a session whose
account is no longer an operator. A session making calls loses them on the next
one; a session that has gone silent loses them on the next revalidation tick, and
**thirty seconds is the whole of that window**. Each topic taken back is said on
that topic, to that session alone, as an ordinary `subscription-withdrawn` event
— the sequence does not move for the operators still listening, and the session
stays open and keeps everything else it asked for, because a demotion is no
reason to disconnect somebody who is still an author here.

**One door on the network takes a password, and it is guarded in front of the
check rather than behind it.** `POST /api/studio/v1/sign-in` is the only route
this server serves besides the two documents about itself, and it is where
`nlteam login` goes too. Checking a password is the most expensive thing this
server will do for somebody who has presented nothing — scrypt at OWASP's 2026
parameters, N = 2^17, r = 8, p = 1, about 128 MiB and a few hundred milliseconds
— and an unknown username costs exactly the same as a known one, because
`authenticate` in `src/identity/users.ts` verifies it against a decoy hash
derived once per process from bytes nobody knows. That is what stops the account
list being enumerated, and it also means an attacker needs no valid account to
spend this. Whether an account is disabled is checked *after* the password, since
learning that a name exists but is disabled is learning that the password was
right. Every refusal answers one sentence — a wrong password, an account that is
not here, one that is disabled and one belonging to a machine are one status and
one wording — and is held half a second before it is answered. A request whose
`origin` names another site is refused outright: neither answer is a cookie, so a
page elsewhere gains nothing by the reply, but without the check any page a person
visits could drive their browser at this door.

## What is bounded, and why that is a security property

Every answer this server composes, every buffer it holds and every read it makes
off a disk has a ceiling now, and the reason is one sentence: without one, the
size of what this server spends is chosen by whoever is asking. That is not a
robustness concern that happens to look like a security one. An authenticated
account with a loop is the cheapest attacker there is, and against an unbounded
composition it needs nothing else.

They fall into five kinds, and it is the shape rather than the figures that is
worth carrying away — a reader who wants a number should go to the constant,
which in every case is named and carries the reasoning beside it.

**What one caller may send in one go.** A WebSocket message may total 128 KiB,
fragments included, and is refused on the header that announces it rather than
after the body has arrived. A sign-in body is 4 KiB. A gRPC message is four
mebibytes, gRPC's own default, and a unary call decodes exactly one of them, so
that a bounded per-message limit cannot become an unbounded per-call one. A
permission request may name at most `MAXIMUM_RESOURCE_IDS` resources —
sixty-four, in `src/grpc/messages.ts`, where the comment does the arithmetic that
makes it necessary: `loreserver` 0.8.6 asks about exactly one, an entry costs two
bytes inside a four-mebibyte message, and each id decoded becomes a lookup, a
written row and an RSA-signed claim. Two million decisions out of one request is
the sum that ceiling ends.

**What a server will compose in one answer.** Every list this protocol pages
carries a count cap and a byte budget, and a page ends at whichever comes first,
because the count alone bounds nothing when a row may be sixty-four kilobytes.
The first row of a page goes on it whatever it weighs, or a large row would be a
cursor that never moved.

**What one account may make this server keep.** A project holds at most
`PROJECT_OVERLAY_LIMIT` overlay records — twenty thousand, in
`src/overlay/store.ts`, deliberately generous, with the refusal naming
`overlay.drop` as the way back under. The hole it closes is stated plainly there:
without it an authenticated account may put sixty-four kilobytes into this
server's database as often as it likes, for as long as it likes, and nothing
anywhere says stop. A server keeps two thousand authorisation decisions, dropping
the oldest allowances before any refusal. Thirty-two live sessions are open at
once on one project, and one project has four gibibytes of transfers reserved at
once — a bound on disk rather than on two machines' memory, which is what makes
it a figure an operator can state, and it counts what has been reserved rather
than what has arrived, because reservation is the last moment a refusal can still
be a refusal rather than a half-finished import. Every field that reaches a row
is bounded before it gets there.

**What this server will read off a disk it does not own.** The pass in
`src/projects/refresh.ts` reads every project on the server once a minute, so a
file committed at a path Team looks at is a file this server allocates once a
minute for as long as it runs, whatever a collaborator made it. Each read is
therefore checked against the size the repository's tree reports before anything
is fetched: a project file past `MAX_PROJECT_FILE_BYTES` is refused rather than
decoded, and the story index and the documents it names share a budget. One read
on that path still has no ceiling, and it has its own entry below.

**How fast, and how many at once.** A name refused repeatedly from one address
waits longer and longer before its password is looked at, the wait doubling from
one second to a ceiling of five minutes after five free attempts — and it is the
*check* that is held off, so the right password is not accepted during the wait
either. The pair is the key rather than either half of it, so nobody can lock
somebody else's account out by knowing their name. Behind that, two password
checks run at once across the whole process and the rest queue: node's threadpool
is four threads shared with every file this server reads, so a handful of
simultaneous attempts would otherwise stop everything else it is doing. Both are
in `src/identity/signin.ts`. The keys directory is on the same kind of footing
for a subtler reason: a token's `kid` is read before its signature is, so an
unauthenticated caller can ask this server to look for a key it has not got, and
a re-read is a directory listing plus a parse and a thumbprint per file on that
same four-thread pool. `RELOAD_INTERVAL_MS` in `src/identity/keys.ts` is why a
flood of unknown `kid`s buys one scan rather than one each.

Two ceilings are in the contract itself — `pageBytes` and `answerBytes` in
`protocol/src/index.ts` — because both ends of the wire need the same number. A
client whose reader is smaller than the largest answer refuses what its own
server built, and a server that will not hold that much for one session drops a
peer for being sent one. Both are derived from it rather than chosen: the socket
will hold four times `ANSWER_BYTES_LIMIT` queued for a peer that has stopped
reading, and this repository's own command line reads twice that.

Two bounds are worth naming for a reason that is not about memory at all.
`DISPLAY_NAME_LIMIT` and `EMAIL_LIMIT` in `src/identity/users.ts` — 128 bytes and
320 — are not about screen space or about the column. Both fields are carried by
every token the account is issued, tokens travel in an `authorization` header,
and a header past what will be sent leaves the account unable to open a
connection at all. A name too long is an account locked out by its own name, from
a client with no way to change it, which is why the bound sits beside the write
rather than in the method: `nlteam user create --root` and `nlteam init` reach
that store with no frame reader in front of them, and a bound only one of the
three paths honoured is not a bound.

## Accepted risks

Five, each with what bounds it. The first three and the last are decisions the
code records the reasoning for; the fourth is an asymmetry nothing in the code
weighs, and it is written down here as one rather than dressed as a choice. None
of them is a plan to do something later.

**1. The signing keys travel in the clear on the loopback.** `loreserver`
fetches Team's JWKS — the public halves of the keys every token is verified
against — over plain HTTP from `127.0.0.1`, on port 41400. A JWKS fetched over a
connection somebody had tampered with is a token that verifies when it should
not, and serving it on the TLS listener would close that. `loreserver` will not
have it. It is given Team's own certificate authority as its only trust anchor
and honours it for the address it asks about callers at, but the client behind
its `[server.auth.jwk]` setting does not use that anchor: pointed at the https
listener, `loreserver` 0.8.6 fails the handshake with `tlsv1 alert unknown ca`
and exits with `Internal Error` before serving anything. That is measured rather
than assumed, and the whole story is at the top of `src/identity/endpoint.ts`.
So the fetch stays on plain HTTP bound to the loopback, the same two documents
are served on the TLS listener as well — which is where an operator should read
them — and what bounds the exposure is that a tampered answer would have to come
from the machine `loreserver` is already running on. **A deployment that ever
ran `loreserver` on another machine would have to revisit this.**

**2. File modes are a POSIX protection and nothing more.** `team.db` holds a
password hash per account, so it and the two files WAL mode keeps beside it are
set to 0600 on every open — the `-wal` file too, because a locked-down
database beside a world-readable write-ahead log protects nothing: that log
holds exactly the rows written most recently. Doing it on every open is also
what tightens a file an older Team left behind, so a server is fixed by being
restarted rather than by anybody noticing. `<root>/keys/` and `<root>/tls/` are
created 0700 and the key files written 0600. What this is: a barrier against
other accounts on the same host. What it is not: anything at all on Windows,
which has no such bits, where a chmod is close to a no-op and what guards the
files is the ACL of the directory the operator chose — which is not Team's to
set. Note also that the storage root is given mode 0700 when Team creates it and
**a root that already exists keeps whatever mode it was made with**, since that
is a directory the operator named. Read `restrictToOwner` and `openDatabase` in
`src/identity/database.ts`. And none of it defends the files from whoever holds
the root directory, which is the rescue plane doing its job.

**3. The asset registers are still read unbounded.** `readAssets` in
`src/projects/content.ts` fetches every file matching
`assets/assets.metadata.*.json` out of a project's latest revision, on the
once-a-minute pass, with no check against the size the tree reports — unlike the
project file and the story documents beside it, which are both refused before
they are fetched. The path is a pattern a collaborator can match with a file of
any size. It is the one read on that path left without a ceiling, and the reason
it has none is that it is the one that does not have an obvious figure: a project
file does not grow with a project's content and so has a number that no honest
file could meet, while the registers scale with the project's asset count and any
figure would be a guess at how large a real project may become. So the gap is
named rather than closed with an invented number.

**4. Threads and comments have no per-project ceiling, though overlay records
do.** The argument written against `PROJECT_OVERLAY_LIMIT` — that an
authenticated account may put sixty-four kilobytes into this server's database as
often as it likes, and nothing anywhere says stop — holds unchanged for
`threads.create` and `threads.reply`, where a thread carries an anchor, a comment
body and a suggestion beside it. `src/comments/store.ts` bounds what one page
weighs and what one row may be, and nothing there bounds how many rows a project
accumulates. What limits the damage is that both are refused outright on a
deployment closed to collaboration, that the rows go with the project row on
`ON DELETE CASCADE`, and that the account behind them is named on every one of
them and can be disabled. Unlike the three above, no comment in the code says
this was considered and accepted, so it is recorded here as what it is. A smaller
version of the same shape is `clients.list`, which answers whole with no ceiling
of its own and is bounded only by however many sessions are open times sixteen
instances of bounded fields.

**5. A commit message is read before it can be weighed.** A page of a project's
history is weighed like every other page, and the row that overruns is bounded by
the same rule that admits the first row of a page whatever it weighs. What
differs is where the weight comes from: a revision carries the message it was
pushed with, and that message comes out of a repository rather than out of a
field this protocol bounds. So one revision pushed with a very long message is
one answer past `ANSWER_BYTES_LIMIT` — one row, not a hundred, which is what
weighing the page buys. It is documented on the constant itself in
`protocol/src/index.ts` rather than left to be discovered, and the remedy would
be to report less of a message than the repository holds, which is not something
this server does anywhere.

## The one Team cannot fix

`loreserver` 0.8.6's `RepositoryMetadataGet` and `RepositoryMetadataSet` are
**authenticated but not authorised**: any token `loreserver` accepts can read and
write the metadata blob of any repository on that server. That includes a token
already issued to an account which has since been disabled and whose token has
not yet expired, because these two calls are the ones that do not come back to
ask.

There is no point at which Team could intercept it. Team is not a data-plane
proxy — every byte between Studio and `loreserver` goes direct, and the only
calls Team makes on `loreserver` are `RepositoryCreate` and `RepositoryGet`, when
a project is made or read. `loreserver` decides for itself which of its own
methods put a question to the authorisation service in
[internals.md](internals.md#the-authorization-service), and for these two it puts
none. So this is a property of the storage this deployment runs, and Team's part
in it is that it cannot help.

Two things narrow it, and they are different in kind.

The first is time. `token.sign_in_lifetime_seconds` — thirty days unless a
deployment has chosen otherwise — is the only bound on how long a token an
account no longer has stays usable *for this one call*. Every other repository
access asks Team about the account and is refused at once, which is why that
figure is otherwise not what bounds a sign-in token at all. It is worth being
exact that this is a bound and not a mitigation: shortening the setting shortens
the window and costs everybody a more frequent sign-in.

The second closes it outright, and it is not the command it looks like. Rotating
does **not** do it: `nlteam key rotate` makes a new key the signing key, and
every key that has not been retired goes on being published, which is exactly
what makes a rotation invisible to anybody holding a token. What ends a key's
life is *retiring* it, which stops it being published and refuses every token it
signed, everywhere Team is the one checking — and, since `loreserver` verifies
against the same JWKS, on these two calls as well. Everybody signs in again.
There is deliberately no `key retire` command and no `admin.keys.retire` method:
`KeyStore.retire` in `src/identity/keys.ts` renames `<serial>.pem` to
`<serial>.retired.pem` under `<root>/keys/`, and nothing in either surface calls
it. Retiring is a rescue-plane act, done on the disk, and
[operations.md](operations.md#signing-keys) says why it is kept out of rotating:
a key has to go on verifying for at least one sign-in token lifetime after it
stops signing, or a rotation would invalidate everybody's tokens by accident.

## Reporting a problem

There is no security contact for this project. The repository is
[NarraLeaf/NarraLeaf-Team](https://github.com/NarraLeaf/NarraLeaf-Team) and the
licence is MIT, and neither the README, the licence, the package manifest nor
any file in the repository names an address, a `SECURITY.md`, a disclosure
policy or a private advisory channel.

⚠ **That is a gap rather than a decision, and it is written down here as a gap
rather than papered over.** Until somebody chooses a channel, a report has
nowhere to go that is not a public issue on that repository — which is the wrong
place for anything that would be useful to somebody else before it is fixed.
Choosing one is a change to this section and to the README, and to no code at
all.
