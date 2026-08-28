# The Team protocol

What a Studio installation and a Team server say to each other, on the wire. This
is the contract, stated once so that a client written against it and the server
that answers it cannot come to disagree quietly. Where a shape or a name is given
below, it is the one in the canonical contract package — `@narraleaf/team-protocol`,
under [`protocol/`](../protocol/) — which the server imports and from which
[`protocol/contract.json`](../protocol/contract.json) is generated. Every shape
here is one the server answers with today, not one it means to.

The whole of it is one protocol carried over two kinds of connection: a little
HTTP, for the two things that have to work before a client has a session, and a
WebSocket, for everything after. Both arrive over one TLS listener, so an
operator compares one certificate and every conversation that follows is over the
connection whose certificate was compared.

## The address a client is given

An author is handed one address, `nlteam://host:port`, and nothing else. That is
not where anything is served — it names a deployment, and reading the discovery
document is what turns it into the URLs a client actually uses. The default port
is `41402`.

That address resolves to a TLS listener bound on every interface. It speaks
HTTP/1.1 for the three things a client needs — the discovery document, the
sign-in route and the WebSocket upgrade — over the same certificate. A deployment
also runs listeners bound to the loopback for its own supervised `loreserver` to
reach: a JWKS document and a gRPC authorisation service. A client never speaks to
those, and they are not part of this protocol.

## The discovery document

```
GET /.well-known/nlteam
```

Unauthenticated, and the one request that turns an address into a server. It is
served as JSON, is never cached, and answers `GET` and `HEAD`.

```json
{
  "protocol": 2,
  "name": "team.example.lan",
  "auth": { "required": true, "url": "https://team.example.lan:41402" },
  "data": { "url": "lore://team.example.lan:41337" },
  "capabilities": ["session", "comments", "clients", "live", "overlay", "admin", "password-sign-in", "project-history"],
  "authority": { "sha256": "3D:38:…" },
  "version": "0.1.0"
}
```

- `protocol` is the contract version, `2`. It is the same number the opening
  socket frame carries, so a client is told the same thing before and after it
  connects. A client that reads a number it does not know stops here.
- `name` is what the deployment calls itself, for a list a person reads. It is
  read as each request is answered, so an operator renaming a server over ssh
  reaches the next request rather than the next restart.
- `auth.required` is whether a token is needed to reach the projects. It is false
  only for a server whose storage was brought up with no identity at all, which
  accepts anyone who can reach it; asking such a server's authors for a token
  would be asking for something nobody can issue.
- `auth.url` is where a token is presented — the `https` origin of this same
  listener.
- `data.url` is the remote the repositories live on. A client stores it and shows
  it to nobody: which storage a server runs is a detail, not something a person
  should have to learn and type.
- `capabilities` is described under [Capabilities](#capabilities).
- `authority.sha256` is the fingerprint of the authority this endpoint's
  certificate chains to. It lets a client that has already trusted this server
  recognise the machine answering. It proves nothing on its own — it arrives over
  the connection it describes — and is treated as a label rather than as evidence.
- `version` is the server's own build, for a support conversation rather than for
  a decision.

Unknown fields are ignored, never refused. A client must ignore a field it does
not know, and a server must not begin requiring a field it did not previously
require.

## Signing in

```
POST /api/studio/v1/sign-in
```

The only route this server serves, and the one that takes no token, because it is
where a token comes from. It takes a username and a password and mints the same
token the server's own tooling would, claim for claim, so that an operator can
hand a person a username and a password instead of a token through a chat window.

Everything else an author does is a method on the session below. Any other
address under `/api/studio/v1` is a `404`, and a client must never discover what
a server can do by trying one — the capability list is what that is for.

The request is a JSON object, `{ "username": …, "password": … }`, at most four
kilobytes. On success it answers `200` with the token and the account it belongs
to:

```json
{ "token": "…", "account": { "username": "ada", "displayName": "Ada", "email": "ada@example.lan" } }
```

Every way it can be refused is one status and one sentence, so that whoever is at
the other end learns nothing about which accounts exist: a wrong password, an
account that is not there, one that has been disabled and one that belongs to a
machine are all `401` with the same words. A request from another site's page is
`403` on its origin; a body that is too large or not JSON is `400`; and a name
guessed at too often from one place is held off with `429` and a `retry-after`,
its password never looked at. The password is never written to a log.

A client that has a token already does not use this route. It presents the token
as a bearer on the socket upgrade below, and the token's lifetime is the whole of
how long that works — there is no session to sign out of.

## The session

Everything an author does travels on one WebSocket per installation:

```
GET /api/team/v1/socket
Authorization: Bearer <token>
```

The bearer is on the upgrade request, and it is checked before the `101` is
written — a refusal is worth far more to a client as an HTTP status it can show a
person than as a close code on a socket that connected and then did not. A
missing or refused token is `401`; a request that is not a WebSocket handshake
this server speaks is `400`.

Once open, either side may speak. The client makes calls and subscribes to
topics; the server answers calls, acknowledges subscriptions and pushes events.
The caller is identified again out of the token on every call, and on a timer of
thirty seconds besides, so that disabling an account or revoking its tokens ends
its session within that window rather than at the token's expiry.

### Framing

The framing is [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) in the amount
this protocol uses, and no more.

- Every message is a text frame carrying JSON. A binary frame is refused with
  `1003`.
- No extensions are negotiated; a client that offers one is answered without it,
  and a reserved bit set on a frame is a protocol error.
- A frame from a client must be masked, as the specification requires of a client.
- A message may total at most **128 KiB**, fragments included. One larger is
  refused with `1009` before it is assembled.
- Ping, pong and close are control frames and carry at most 125 bytes. The server
  pings on the heartbeat interval it announced and closes a peer it has not heard
  from for twice that.

### The opening frame

Before anything is asked, the server sends one `hello`:

```json
{
  "t": "hello",
  "protocol": 2,
  "server": { "name": "team.example.lan", "version": "0.1.0" },
  "session": "<connection id>",
  "account": { "id": "…", "username": "ada", "displayName": "Ada", "operator": false },
  "methods": ["projects.list", "…"],
  "capabilities": ["session", "comments", "clients", "live", "overlay", "admin", "password-sign-in", "project-history"],
  "serverTime": 1737936000000,
  "heartbeatMs": 30000
}
```

`protocol` is the same number the discovery document carries. `account` is the
person the session is, so that a client can show whose comments are its own
without parsing a token it is told to treat as opaque; `operator` says the
account may administer the server, and is not a permission over any project.
`methods` is every method this build answers and `capabilities` is described
below — a client checks either before it asks. `serverTime` lets a client say
"two minutes ago" without trusting its own clock, and `heartbeatMs` is how often
each side should expect to hear something.

### Calls

A call names a method and carries an id the client chose. The id is echoed on the
one frame that answers it, which is exactly one of a `result` or an `error`.

```json
{ "t": "call", "id": 1, "method": "threads.create", "params": { … } }
```

```json
{ "t": "result", "id": 1, "value": { … } }
```

**Every method answers with an object.** A method that has nothing to report
answers with `{}`, never a bare `null`, so that `result.value` is always an
object rather than a value a client has to tell apart from a handler that built
no body. A session holds at most 64 calls in flight at once.

Every write accepts an optional `clientId`, and repeating a write with the same
one is safe: the key is `(account, method, clientId)`, so a write that arrives
twice — the same client, the same id, over a socket that dropped between the
request and the answer — returns the row it already made rather than a second
one, and a repeat announces nothing on any topic.

**A server remembers an id for a day and no longer.** That is what a retry
takes, with a night's margin on it; past that a client sending the same id again
is not repeating itself, and the call is made. An id is a way of saying "this is
the call I already sent", not a name reserved for ever.

### Errors

A call that is not answered is refused with a coded frame:

```json
{ "t": "error", "id": 1, "code": "not-found", "message": "…" }
```

The message is English, for a log; the sentence a person reads is written by the
client, in their language, from the code. The codes are the whole vocabulary of
failure:

| Code | Means |
|---|---|
| `unknown-method` | This build has no such method. A client that read `methods` never sees it. |
| `bad-params` | The parameters were not the shape the method takes. |
| `not-found` | The thing named is not on this server. |
| `refused` | The caller may not do that. |
| `conflict` | It would collide with something already there. |
| `unavailable` | True now and perhaps not in a moment — a repository not read yet, or a content server that would not complete a call. |
| `unauthenticated` | The token is no longer good; reconnecting will not help. |
| `internal` | Something nobody planned for. The message is kept off the wire. |

### Subscriptions and events

A client asks to be told when something changes by subscribing to a topic. The
acknowledgement carries the topic's sequence as it stands:

```json
{ "t": "subscribe", "id": 2, "topic": "project:abc/threads" }
```

```json
{ "t": "subscribed", "id": 2, "topic": "project:abc/threads", "seq": 7 }
```

Subscribing validates; unsubscribing never fails. A well-formed topic whose
project or room is not on this server is `not-found`; a topic that is not a shape
this server publishes is `not-found`; but dropping a topic that was never held is
a success, because a client tidying up should not have to know what it still
holds. A session holds at most 64 topics at once.

An event names its topic and carries a sequence and a payload:

```json
{ "t": "event", "topic": "project:abc/threads", "seq": 8, "payload": { "kind": "thread-created", "thread": { … } } }
```

Delivery is deliberately weak. The sequences live in the server's memory and
start again at nought when it restarts, and events are never queued or replayed.
A client compares each sequence with the last it saw, and **anything other than
exactly the next number means read the collection again** — a gap, or a restart,
both mean the same thing and both have the same answer. A client too slow to read
may be dropped, because dropping it is correct: it reconnects and re-reads.

### Closing

A clean end is a WebSocket close of `1000`. When the server ends a session
itself, it first sends a `bye` saying why, because a close code is two bytes and
cannot tell a token that expired from a server that is shutting down — only one
of those is worth reconnecting into at once:

```json
{ "t": "bye", "code": "unauthenticated", "message": "…" }
```

The close code that follows names the reason, so that a client author has
something to fix rather than a goodbye that reads as clean:

| Situation | Close code |
|---|---|
| A normal end, or a `bye` for any non-authentication reason | `1000` |
| A frame the protocol does not allow | `1002` |
| A quota, an in-flight cap or a topic cap reached | `1008` |
| A token refused or revoked, after `bye{unauthenticated}` | `1008` |
| A message over the ceiling | `1009` |

## Capabilities

One vocabulary, carried the same way by the discovery document and the `hello`
frame, so a client is told the same thing before and after it connects. It is
derived from what the build actually serves and from what the deployment is set
to, rather than written down, so a module left out of a build takes its capability
with it, and a capability is never announced by a server that cannot answer it.

| Capability | What it means |
|---|---|
| `session` | The socket exists. Everything else on it implies this, including the project list, one project's detail and the member list, which are methods gated by `session` rather than capabilities of their own. |
| `comments` | Threads and comments anchored in a project. |
| `clients` | Which installations are connected, and what each has open. |
| `live` | Live sessions: rooms on a project, for finding installations and broadcasting to them. |
| `overlay` | Data attached to a project at a revision, which never enters the repository. |
| `admin` | This server's own state — its accounts, settings, keys, decisions and health — may be read and changed over the socket, by an operator. |
| `password-sign-in` | A username and a password may be exchanged for a token, before any session. This names the sign-in route above. |
| `project-history` | A project's revisions may be read a page at a time, through `projects.history`. Present only where the server has a reader that can page one — a build without one answers an empty page, which is not the same as a project with no revisions. |
| `blobs` | A live session's files may be put down on this server and collected from it, over `/api/team/v1/blobs/{project}/{transfer}`. The one capability that is about bytes rather than about a call: the socket carries sixteen kilobytes a message, and a file is not a message. Present only where the build has somewhere to put one. |

A client decides what a server can do from `capabilities` or from `hello.methods`,
never by probing for a `404`.

### The five a deployment can turn off

Most of what a server announces follows from its build. Five names do not.
`comments`, `live`, `overlay`, `clients` and `blobs` are the coordination plane —
everything on this server that is a remote-collaboration service — and an operator
may decide that their deployment holds projects and is administered and is not a
place people work together. The setting is `server.collaboration`, which is `open`
or `closed`, and on a closed deployment:

- the five are absent from the discovery document and from the `hello` frame, and
  every method under them is refused — to everybody, operators included. An
  operator has no use for `live.say`, and an exception for them would be a hole in
  a switch whose whole purpose is that there is nothing on the other side of it.
- the blob addresses are refused as well, and that is a separate check rather than
  a consequence of the capability going quiet. They are HTTP rather than methods,
  and they admit an installation this server currently knows to have the project
  open — an installation that announced itself before the switch keeps that
  standing until its socket closes, so nothing about the capability list or the
  methods would have stopped it collecting a transfer it had already agreed. The
  route reads the setting as it stands at the moment of the request.
- `projects.list`, `projects.get`, `projects.history`, `members.list`,
  `projects.create` and `projects.forget` are refused to anybody who is not an
  operator: what is on this server becomes its operators' to read and to change.
  Those are `session` methods, and `session` cannot be withdrawn — a server
  answering the socket has it — so this is a refusal per call rather than a
  capability that disappears. The refusal says what happened and names the
  setting, because the account it refuses has done nothing wrong and would
  otherwise read it as a server that is broken. The two writes are in the list
  because a closed server that still let an ordinary account make a project on it
  would be accepting collaboration, and accepting a write whose result the same
  account then cannot see.
- everything under `admin` is untouched, and so is the sign-in route. What the
  switch stops is the deployment being worked on, not its being administered, and
  `admin.settings.set` is the way back from it.

The list is worked out when a discovery document is written and when a `hello`
frame is composed, from one source, so a deployment closed over ssh reaches the
next connection rather than the next restart and no client is told one thing
before it connects and another after.

**A session already open was told a list that has since changed, and it is not
withdrawn.** There is no frame that takes a capability back and none is being
invented for this: the methods refuse regardless, because the capability list is
advice and the gate on the call is the authority. So the worst a stale list can do
is lead a client to call something and be refused, which is the ordinary shape of
a refusal and the one thing every client already handles. A new session is told
the truth. A subscription held under a capability that has just been turned off is
left alone as well — those topics carry nothing an account of this server may not
see, and with the methods that publish on them refused there is nothing left to
publish, so the subscription goes quiet by itself.

**Every name here is about the deployment and none of them is about the caller.**
`admin` is where that is easiest to misread: it is announced to every session,
including the ones every `admin.*` method will refuse, because it says this
server has a management surface rather than that whoever is reading it may use
one. That second question is answered in the same `hello` frame, by
`account.operator`. A client draws a management surface from the two together —
the capability says the surface can exist here, the account says whether to draw
it — and folding them into one would leave a client unable to tell "this server
is too old to be administered over the socket" from "you are not an operator",
which are different sentences to show a person and only one of them is about
them.

## Methods

The whole surface, and every name a client may call. All are gated by `session`
unless a capability is named.

On a deployment closed to collaboration, every method under `comments`, `live`,
`overlay` and `clients` is refused to everybody, and `projects.list`,
`projects.get`, `projects.history`, `members.list`, `projects.create` and
`projects.forget` are refused to anybody who is not an operator — see
[Capabilities](#capabilities).

| Method | Capability | What it does |
|---|---|---|
| `projects.list` | `session` | Every project on this server. |
| `projects.get` | `session` | One project: its row, and the project file read out of its repository — the title, the stage, how many scenes and assets. A file the server could not make sense of comes back `readable: false` with a sentence, never a refusal, and so does one whose first clone has not landed. Takes an id or a name. |
| `projects.history` | `session` | A page of one project's revisions, newest first. `limit` defaults to 20 and is capped at 100; the cursor is the id of the revision to carry on after, and is absent when there is no page beyond this one. A project the server has no checkout of yet answers an empty page rather than a refusal, which is not the same as a project with no revisions. |
| `projects.create` | `session` | Make a project, or — given a `repositoryId` — register a repository the author already has. Making one asks the content server for the repository and takes the row back if it refuses; registering one asks it for nothing, because the repository already exists under that id. Announces `project-created` on the `projects` topic. |
| `projects.forget` | `session` | Take a project off this server's list. The row goes; the repository and every revision in it stay exactly as they were. Any account may, and forgetting a project that is already gone answers `{}` rather than a refusal. Announces `project-forgotten` on the `projects` topic and on the project's own. |
| `members.list` | `session` | Every account, as a name beside a piece of work. |
| `threads.list` | `comments` | The threads anchored in one project, newest activity first, paged. |
| `threads.get` | `comments` | One thread and a page of its comments, oldest first. `limit` defaults to 50 and is capped at 200; `after` carries the reader on from the cursor the last page ended with, and the cursor is absent when the conversation ends there. The thread's own `comments` count is how many there are in all, so a client knows what it holds a page of. |
| `threads.create` | `comments` | Open a thread on an anchor, with its first comment. |
| `threads.reply` | `comments` | Add a comment to a thread. |
| `threads.resolve` | `comments` | Mark a thread resolved, or open it again. Idempotent: resolving a thread that is already in the asked-for state changes nothing and announces nothing. |
| `comments.edit` | `comments` | Change the wording of one's own comment. |
| `comments.delete` | `comments` | Withdraw one's own comment, keeping the shape of the conversation. |
| `clients.announce` | `clients` | Say which installation this is, and what it has open. |
| `clients.withdraw` | `clients` | Take one window's presence back. |
| `clients.list` | `clients` | Which installations are connected, optionally on one project. |
| `live.list` | `live` | The live sessions open on one project. |
| `live.open` | `live` | Open one, and be its first member. |
| `live.join` | `live` | Join one somebody else opened. |
| `live.leave` | `live` | Leave one. The last one out closes it. |
| `live.close` | `live` | Close one outright, which only its opener may do. |
| `live.say` | `live` | Say something to everybody in one. Kept by nobody. |
| `overlay.list` | `overlay` | A page of what is attached to one project, newest change first, and what the server last read its head to be. `limit` defaults to 500 and is capped at 2 000, and a page also ends once the bodies on it total a mebibyte — whichever comes first, since a record's body may be 64 KiB and the count alone would not bound the answer. `before` carries the reader on from the cursor the last page ended with, and the cursor is absent when there is nothing past this page. `total` is how many the project holds in all, whatever this page or a narrowing left out. |
| `overlay.put` | `overlay` | Attach something, or replace something one attached before. |
| `overlay.drop` | `overlay` | Take one's own record off again. |
| `admin.users.list` | `admin` | A page of this server's accounts, newest first. Each carries the groups it is in, whether those make it an operator, whether it is disabled, and when its tokens were last refused — which is more than `members.list` says, and deliberately so. `limit` defaults to 50 and is capped at 200. |
| `admin.audit.list` | `admin` | A page of the decisions this server has been asked to make, newest first. `limit` defaults to 50 and is capped at 200. |
| `admin.settings.list` | `admin` | Everything this server keeps in its settings, which rows may be changed, and — on the rows that have a default behind them — whether the value was chosen or that default is answering for it. Answered whole rather than paged: the rows are a literal in the server rather than a query, so there is nothing for a cursor to be a cursor over. |
| `admin.keys.list` | `admin` | Every signing key this server holds, published and retired, and which of them signs. The public half of each and nothing else. Answered whole, for the reason the settings are: this is however many times a server has rotated. |
| `admin.server.status` | `admin` | What this server is, what it can reach, and how much of each thing it holds. Worked out when somebody asks and kept briefly; the answer carries the moment it was worked out and how long one is kept, so a client shows "as of" rather than implying it is live. |
| `admin.users.create` | `admin` | Make an account from a username and a password, optionally with a display name, an address, and `operator: true` to put it in the admin group. Answers with the account. A name already taken is a `conflict`; a name or a password this server will not store is `bad-params`, carrying the sentence that says what either may be. Announces `user-created`. |
| `admin.users.disable` | `admin` | Stop an account being issued anything, and refuse the tokens it already holds. Answers with the account. Idempotent: one already disabled is answered and nothing is announced, and its token epoch is not moved a second time. Announces `user-disabled`. |
| `admin.users.enable` | `admin` | Let a disabled account sign in again. Tokens minted before it was disabled stay unrenewable. Idempotent, and announces `user-enabled`. |
| `admin.users.grantAdmin` | `admin` | Put an account in the admin group. Idempotent, and announces `user-granted-admin`. |
| `admin.users.revokeAdmin` | `admin` | Take one out again. Idempotent, and announces `user-revoked-admin`. **Refused for the last operator**; see below. |
| `admin.users.revokeTokens` | `admin` | Refuse every token an account already holds, without disabling it. Answers with the account, whose `tokensInvalidatedAt` is the moment. Never a no-op, which is why it is worth a `clientId`. Announces `user-tokens-revoked`. |
| `admin.tokens.mint` | `admin` | Mint a sign-in token for an account without knowing its password, to be handed to the person. Answers with the account, when it expires, and the token — **shown once and kept nowhere**. A repeat under the same `clientId` mints nothing and answers without a token. Refused for a disabled account. Announces nothing on any topic. |
| `admin.settings.set` | `admin` | Change one setting, named by the `label` the settings list gives it, to `value`. A lifetime takes the words the row shows, `7d`, or a bare number of seconds. Answers with the row as the list carries it. A row that is not editable is `refused`; a label this server has not got is `not-found`. Announces `setting-changed`, and nothing when the value was already that. |
| `admin.keys.rotate` | `admin` | Generate a signing key and sign with it from now on. Every key that is not retired goes on being published, so a token signed a second ago still verifies. Answers with the whole key list, and announces `keys-rotated` carrying it. |

### Administering a server

The `admin` family is refused to anybody who is not an operator, and the check is
made **on every call** rather than when the session opened. That is not
belt-and-braces: this server's whole claim about revocation is that it takes
effect at once rather than at expiry, and a session that decided this once would
leave an account demoted an hour ago still administering until it happened to
reconnect.

**Every write answers with the record it changed**, never with an
acknowledgement, so a panel updates the row it is already holding instead of
re-reading a page to find out what it did. **Every write takes an optional
`clientId`** and is done at most once under it, keyed by the account, the method
and that id together — one id reused across two methods is two writes rather than
one, and one reused a day later is a fresh write rather than a repeat. **A write
that changed nothing announces nothing**: enabling an account that is already
enabled is the state that was asked for.

**The last operator cannot be removed over this protocol.** Demoting the only
account that can administer this server, or disabling it, is refused: it would
leave a server nobody could put right over the session. The refusal names the way
back — `nlteam user grant-admin` or `nlteam user enable`, run on the machine that
holds the storage root. The command line is the rescue plane, and is deliberately
allowed to do what this one will not.

**A management subscription does not outlive the operator who took it.** A topic
is judged when it is subscribed to, and an account demoted afterwards keeps a
perfectly good token — so the check is made again on every call the session
makes, and on its revalidation timer for a session making none. The window for a
silent one is **thirty seconds**. Each topic taken back is said on that topic as
an ordinary event, `{ kind: "subscription-withdrawn", topic, why }`, and to that
session alone: the sequence does not move for the operators still listening, and
the session stays open and keeps everything else it subscribed to.

### Anchors

Where in a project something is attached is an **anchor**: `{ document?, element?, revision? }`,
three strings the server stores, indexes on and hands back, and **never parses**.
`document` is a path as the client writes it, `element` is the client's id for a
row or an element inside that document, and `revision` is what the repository
stood at. That the server never reads them is what lets the two halves ship on
separate schedules: a client that begins anchoring to a new kind of thing needs
no server release.

## Topics

A topic is a string a client subscribes to. Every one has a publisher; a name the
server never publishes on is refused rather than left waiting.

| Topic | When it fires |
|---|---|
| `projects` | The list of projects on this server changed. |
| `project:{project}` | One project's row changed, or the server read its repository again. |
| `project:{project}/threads` | A thread or comment in one project changed. |
| `project:{project}/overlay` | An overlay record on one project changed. |
| `project:{project}/clients` | An installation opened or closed one project. |
| `project:{project}/live` | A live session on one project opened, changed or closed. |
| `live:{session}` | Something was said inside one live session. Kept by nobody. |
| `admin/users` | An account was made, disabled, enabled, given or denied administration, or had its tokens refused. Operators only. |
| `admin/settings` | A setting of this server changed. Operators only. |
| `admin/keys` | This server rotated its signing keys; the event carries the whole list. Operators only. |
| `admin/refusals` | A decision this server was asked to make was **refused**. Operators only. |

The people on a server are read on demand, through `members.list`, rather than
watched on a topic: that list is a name beside a piece of work, and what moves it
is an account being made, which `admin/users` already says.

`admin/refusals` is named for what it publishes rather than for the collection it
belongs to, and that is the design rather than a shortening. A decision is
recorded on the path that answers every repository access — thousands in an
afternoon of one team working — so a topic firing per decision would push more
frames than the rest of this protocol together, to say something a panel could
only act on by re-reading a page it already holds. **An allowed decision is
published nowhere.** A client that wants the whole log pages `admin.audit.list`,
and has to: the sequence on that topic counts refusals, not rows.

## Limits

Every limit is in the contract, so that a client can know it rather than discover
it by being refused.

| Limit | Bytes | Bounds |
|---|---|---|
| `anchorField` | 512 | Each field of an anchor. |
| `commentBody` | 8 192 | One comment. |
| `suggestion` | 65 536 | What a suggestion carries. |
| `overlayBody` | 65 536 | One overlay record. |
| `livePayload` | 16 384 | One thing said in a live session. |
| `instanceField` | 256 | Each field describing a client installation. |

Two transport ceilings sit above the per-field limits: a WebSocket message may
total **128 KiB**, and an HTTP request body — the sign-in route's — at most
**4 KiB**. Both are refused before they are read in full.

## Versioning

`protocol` moves only when a field an older client relies on stops meaning what
it meant. Adding a capability, a method, a topic, an event kind or an optional
field is additive and does not move it, which is why a newer server answers an
older client without either being rebuilt. A client that finds a `protocol` it
does not know refuses the server rather than guessing at frames.

The number is `2`. It moved to `2` while Team had never been released and the
only client shipped in step with it, so the change cost nobody a migration. That
justification does not return: once Team is released, a further breaking change is
made by negotiation rather than by moving this number under a client's feet.
