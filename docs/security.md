# Security

What a NarraLeaf Team server protects, whom it protects it from, and what it
leaves unprotected. For what Team is, see [Architecture](architecture.md). For
how the parts are put together, see [Internals](internals.md). For running a
server, see [Deployment](operations.md).

## Which plane a question belongs to

The four planes in [Architecture](architecture.md) are the frame. Each has one
rule about who is trusted on it, and the four rules differ.

**The content plane** is a project's bytes, and Team is not on it. Version
control is the version-control server's, spoken as `lore://` on port 41337, and a
Studio installation clones and pushes against it directly. Team answers whether
the token in front of it may reach a given repository. A question about the
confidentiality or integrity of what people write is a question about who holds
an account on this server and about the version-control server. No project byte
passes through Team.

**The coordination plane** is one authenticated WebSocket per Studio
installation. It is the largest surface here, and the one where a ceiling
matters: everything on it is memory this server allocates and rows this server
keeps, at somebody else's request.

**The management plane** is that same socket and that same token, separated by
whether the account behind the call is in the `admin` group. It is not a second
port, a second certificate or a second credential, and adds no attack surface of
its own. What it adds is a check, and when that check is made is what this server
claims about withdrawing access.

**The rescue plane** is off the protocol and is guarded by access to the storage
root. `up`, `init` and `trust` take `--root` and never `--server`. Whoever holds
that directory holds `<root>/keys/`, and whoever holds the signing keys can issue
a token for any account on the server, and can create the account first with
`nlteam user create --root`. The file modes below do not protect anything from
them.

## Two decisions that read as gaps

Both are decisions rather than omissions, and a deployment is planned around
them.

**Every account on a server reaches every project on it.** There is no
per-project grant to give or take away. The question asked on each repository
access is answered from the account alone: an account of this server, not
disabled, holding a token this server has not refused.

The way to stop somebody is to stop the account, with `nlteam user disable` or
`nlteam user revoke-tokens`. One project a contractor should not see is a second
server rather than a setting. The same rule is why `members.list` gives every
account on a server the username, display name and recorded email address of
every other.

It is also why the four-digit code a live session is joined by is not a secret.
Ten thousand values is a range an account on this server could work through. The
code lets somebody join without knowing whose room they are looking for; it does
not keep anybody out.

**Any account may take any project off the list.** `projects.forget` is gated by
the session and by nothing else. What goes is the row. The repository stays in
the store with every branch and every revision. What is destroyed is this
server's record that the repository is a project of its, and, by cascade, the
threads and comments hanging off that row. Nobody can open the project
afterwards, because a repository with no row is not one of this server's
projects.

It is recovered with `nlteam project create <name> --repository <id>` against the
repository that never moved. See
[Removing a project from the list](operations.md#removing-a-project-from-the-list),
including the part that matters: the repository id is not recoverable from
anything left on the list once the row has gone.

## What the trust rests on

### One listener, one certificate, one fingerprint

Everything a client says to this server arrives on port 41402 behind one
certificate: the discovery document, the sign-in route, the socket upgrade, the
blob addresses and the gRPC authorization service the version-control server
calls. The certificate is issued by an authority this server generated for itself
on first run into `<root>/tls/`. The authority lasts ten years and the endpoint
certificate 397 days.

Nothing inside the connection establishes that trust the first time. `nlteam
trust` prints the authority's SHA-256 fingerprint and changes nothing.
`--install` puts it into the current user's trust store rather than the
machine's.

That step exists for one client: Studio's version-control library builds its
chain against the host's own trust store and offers nowhere to pin a certificate.
Everything else pins. `nlteam login` probes the endpoint with verification off,
sending no application data, keeps the authority it was shown, and refuses if
that server later presents a different one. `--fingerprint` states what to expect
in advance. Studio keeps the same bytes and passes them with verification on.

`authority.sha256` in the discovery document is a label rather than evidence: it
arrives over the connection it describes.

An organization that supplies its own certificate for the name people use removes
this step. See
[A certificate you already hold](operations.md#a-certificate-you-already-hold).

### A token is verified on every call

The check runs on each call, on each subscription, and on a thirty-second timer.
It verifies the signature against a published key before reading a claim, then
the issuer, the audience and the expiry, and then asks the database two questions
the token cannot answer for itself: whether the account is still present and not
disabled, and whether the token was signed before that account's access was
revoked. Every repository access goes through the same pair.

Disabling an account or revoking its tokens is refused on the next call rather
than when the token would have expired. A thirty-day sign-in lifetime is not
thirty days in which a revoked account keeps working.

What this does not cover is the repository token, which is presented to the
version-control server's data plane rather than to Team. That is why it lives
fifteen minutes.

### A management subscription does not outlive its operator

The `admin` family is refused to anybody not in the group, checked on every call.
A subscription is the case a per-call check alone cannot cover: an account
subscribes, is demoted afterwards, and the token it holds is untouched by that.
Every `admin/*` topic is therefore taken back from a session whose account is no
longer an operator. A session making calls loses them on the next one; a silent
session loses them on the next revalidation, and thirty seconds is the whole of
that window.

Each topic taken back is reported on that topic to that session alone. The
session stays open and keeps everything else it asked for.

### One network door takes a password

`POST /api/studio/v1/sign-in` is the only route this server serves besides the
two documents about itself, and it is where `nlteam login` goes.

Checking a password is the most expensive thing this server does for somebody who
has presented nothing: scrypt at OWASP's 2026 parameters, N = 2^17, r = 8, p = 1,
about 128 MiB and a few hundred milliseconds. An unknown username costs the same
as a known one, because it is verified against a decoy hash derived once per
process. That is what stops the account list being enumerated, and it means an
attacker needs no valid account to spend it.

Whether an account is disabled is checked after the password. Learning that a
name exists but is disabled is learning that the password was right.

Every refusal answers one sentence, the same for a wrong password, an account
that is not there, one that is disabled and one belonging to a machine, and is
held half a second before it is answered. A request whose `origin` names another
site is refused outright.

## Bounds

Every answer this server composes, every buffer it holds and every read it makes
from a disk has a ceiling. Without one, the size of what this server spends is
chosen by whoever is asking, and an authenticated account with a loop needs
nothing else.

They fall into five kinds. Each constant is named in the source and carries its
reasoning beside it.

**What one caller may send at once.** A WebSocket message may total 128 KiB,
fragments included, and is refused on the header that announces it rather than
after the body arrives. A sign-in body is 4 KiB. A gRPC message is four
mebibytes, gRPC's own default, and a unary call decodes exactly one. A permission
request may name at most sixty-four resources: each id decoded becomes a lookup,
a written row and an RSA-signed claim, and an entry costs two bytes inside a
four-mebibyte message.

**What a server composes in one answer.** Every list this protocol pages carries
a count cap and a byte budget, and a page ends at whichever comes first. The first
row of a page goes on it whatever it weighs.

**What one account may make a server keep.** A project holds at most twenty
thousand overlay records, and the refusal names `overlay.drop` as the way back
under. A server keeps two thousand authorization decisions, dropping the oldest
allowances before any refusal. Thirty-two live sessions are open at once on one
project, and one project has four gibibytes of transfers reserved at once,
counted at reservation rather than on arrival. Every field that reaches a row is
bounded before it gets there.

**What a server reads from a disk it does not own.** Every project on the server
is read once a minute, so a file committed at a path Team looks at is a file this
server allocates once a minute for as long as it runs. Each read is checked
against the size the repository's tree reports before anything is fetched: a
project file past its ceiling is refused rather than decoded, and the story index
and the documents it names share a budget. One read on that path has no ceiling
and is listed under [Accepted risks](#accepted-risks).

**How fast, and how many at once.** A name refused repeatedly from one address
waits longer before its password is looked at, doubling from one second to a
ceiling of five minutes after five free attempts. The check is what is held off,
so the right password is not accepted during the wait either. The count is
against the name and the address together, so nobody can lock somebody else's
account out by knowing their name. Two password checks run at once across the
process and the rest queue. The keys directory is re-read at most once per
interval, because a token's `kid` is read before its signature is, so an
unauthenticated caller can ask this server to look for a key it does not hold.

Two ceilings are in the protocol contract, `pageBytes` and `answerBytes`, because
both ends of the wire need the same number. A client whose reader is smaller than
the largest answer refuses what its own server built, and a server that will not
hold that much for one session drops a peer for being sent one.

`DISPLAY_NAME_LIMIT` and `EMAIL_LIMIT`, 128 bytes and 320, are not about screen
space or about the column. Both fields are carried by every token the account is
issued, tokens travel in an `authorization` header, and a header past what will
be sent leaves the account unable to open a connection at all.

## Accepted risks

Five, each with what bounds it. None is a plan to do something later.

**1. The signing keys travel in the clear on the loopback.** The version-control
server fetches Team's JWKS over plain HTTP from `127.0.0.1`, on port 41400. It is
given Team's own certificate authority as its only trust anchor and honors it for
the address it asks about callers at, but the client behind its
`[server.auth.jwk]` setting does not use that anchor: pointed at the HTTPS
listener, version 0.8.6 fails the handshake and exits before serving anything.
The fetch stays on plain HTTP bound to the loopback, and the same two documents
are served on the TLS listener as well. What bounds the exposure is that a
tampered answer would have to come from the machine the version-control server is
already running on. **A deployment that ran the version-control server on another
machine would have to revisit this.**

**2. File modes are a POSIX protection and nothing more.** `team.db` holds a
password hash per account, so it and the two files WAL mode keeps beside it are
set to `0600` on every open, the write-ahead log included. `<root>/keys/` and
`<root>/tls/` are created `0700` and the key files written `0600`. This is a
barrier against other accounts on the same host. It is nothing on Windows, which
has no such bits, where what guards the files is the ACL of the directory the
operator chose. The storage root is given mode `0700` when Team creates it, and a
root that already exists keeps the mode it was made with. None of it defends the
files from whoever holds the storage root.

**3. The asset registers are read unbounded.** Every file matching
`assets/assets.metadata.*.json` is fetched out of a project's latest revision on
the once-a-minute pass, with no check against the size the tree reports. The
project file and the story documents beside it are both refused before they are
fetched; these are not. The path is a pattern a collaborator can match with a file
of any size. It is the one read on that path without a ceiling.

**4. Threads and comments have no per-project ceiling, though overlay records
do.** An authenticated account may add rows to `threads.create` and
`threads.reply` without limit. What one page weighs and what one row may be are
both bounded; how many rows a project accumulates is not. What limits the damage
is that both are refused on a deployment closed to collaboration, that the rows go
with the project row on cascade, and that the account behind them is named on
every one and can be disabled. `clients.list` has a smaller version of the same
shape: it answers whole, bounded only by however many sessions are open times
sixteen instances of bounded fields.

**5. A commit message is read before it can be weighed.** A page of a project's
history is weighed like every other page, and the row that overruns is admitted by
the same rule that admits the first row of a page whatever it weighs. A revision
carries the message it was pushed with, and that message comes out of a repository
rather than out of a field this protocol bounds. One revision pushed with a very
long message is one answer past `answerBytes`.

## The one Team cannot fix

Version 0.8.6 of the version-control server treats `RepositoryMetadataGet` and
`RepositoryMetadataSet` as **authenticated but not authorized**: any token it
accepts can read and write the metadata blob of any repository on that server.
That includes a token issued to an account which has since been disabled and
whose token has not yet expired, because these two calls do not come back to ask.

There is no point at which Team could intercept it. Team is not a data-plane
proxy: every byte between Studio and the version-control server goes direct, and
the only calls Team makes are `RepositoryCreate` and `RepositoryGet`. The
version-control server decides for itself which of its own methods put a question
to the authorization service, and for these two it puts none. This is a property
of the storage a deployment runs.

Two things narrow it.

**Time.** `token.sign_in_lifetime_seconds`, thirty days unless a deployment has
chosen otherwise, is the only bound on how long a token an account no longer has
stays usable for this one call. Every other repository access asks Team about the
account and is refused at once. Shortening the setting shortens the window and
costs everybody a more frequent sign-in.

**Key retirement.** Rotating does not close it: `nlteam key rotate` makes a new
key the signing key, and every key that has not been retired goes on being
published. Retiring a key stops it being published and refuses every token it
signed, everywhere Team is asked, and on these two calls as well because the
version-control server verifies against the same JWKS. Everyone signs in again.

```sh
nlteam key retire <kid> --root /srv/team
nlteam key retire <kid> --server team.example.com:41402
```

The key that is signing is refused on both paths. Rotate first, then retire the
key that used to sign. Retiring the last key that was only verifying is not
refused: that is the act somebody performs about a key they believe has been
exposed. See [Key retirement](operations.md#key-retirement).

## Reporting a vulnerability

Report privately through GitHub's security advisory form on
[NarraLeaf/NarraLeaf-Team](https://github.com/NarraLeaf/NarraLeaf-Team/security/advisories/new).
Do not open a public issue for a vulnerability.

See [SECURITY.md](../SECURITY.md) for what to include and what to expect.
