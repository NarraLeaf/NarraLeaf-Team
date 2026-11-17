/**
 * The Team protocol: what a Studio installation and this server say to each other.
 *
 * This module is the single canonical source of the wire contract. It is
 * self-contained and has no runtime dependencies, so it can be published on its
 * own and consumed by anything that speaks this protocol - the server that lives
 * beside it in this repository, and a client that ships separately. Everything on
 * the wire is named here once: the frame catalogue, the method names, the
 * capability vocabulary, the error codes, the topic patterns, the limits, the
 * protocol number, and the TypeScript types over them.
 *
 * Until this protocol existed the whole conversation was authentication and a
 * repository address. Everything an author actually did happened in the version
 * control library, and everything the server knew was answered one request at a
 * time to whoever asked. That is enough for a list of projects and nothing else:
 * work somebody else did arrives when a person reopens a screen, and there is
 * nowhere below a project to put anything.
 *
 * So there is a second thing on the wire, and it is a **session** rather than a
 * request. One connection per Studio installation, authenticated once, over
 * which either side may speak: Studio makes calls and subscribes to topics, and
 * the server answers calls and pushes events on those topics.
 *
 * Two properties of this contract are load-bearing:
 *
 *  1. **Anchors are opaque.** A comment is attached to a place in a project, and
 *     that place is named in Studio's terms: a document inside the project, an
 *     element inside the document. The server stores those strings, indexes on
 *     them and hands them back. It never parses one, never checks one against a
 *     repository, and never needs upgrading because Studio started anchoring to
 *     a new kind of thing.
 *
 *  2. **A method is one place, not eight.** The names below are the whole of the
 *     surface. Adding one is a module of handlers and a caller in Studio. It is
 *     not a route, a capability constant, an IPC event, a preload line and a
 *     renderer type, which is the cost that kept this protocol at five verbs for
 *     as long as it was five verbs.
 */

/** Where the socket is, on the same TLS listener everything else is on. */
export const TEAM_SOCKET_PATH = "/api/team/v1/socket";

/**
 * The version of this contract, carried by both the discovery document and the
 * opening `hello` frame so that the two can never disagree about what a server
 * speaks. A client that finds a number it does not know closes the socket and
 * says so, rather than guessing at frames.
 *
 * It moves only when a field an older client relies on stops meaning what it
 * meant. Adding a capability, a method, a topic, an event kind or an optional
 * field is additive and does not move it.
 */
export const TEAM_PROTOCOL_VERSION = 2;

/**
 * How often each side expects to hear anything at all.
 *
 * Sent in the opening frame rather than agreed in advance, so a deployment behind
 * something with a shorter idle timeout can be told to speak sooner without every
 * client being rebuilt. The pings themselves are WebSocket control frames rather
 * than messages here: keeping a connection alive is the transport's job.
 */
export const TEAM_HEARTBEAT_MS = 30_000;

/* ------------------------------------------------------------ capabilities */

/**
 * The names a client matches literally to know what a server offers.
 *
 * One vocabulary, carried the same way by the discovery document and the opening
 * `hello` frame so that a client is told the same thing before and after it
 * connects. Which of these a given deployment advertises is derived from what its
 * build actually serves, never written down a second time.
 *
 * Most of the list is about the socket. **There are two things called a session
 * here and they are not the same thing.**
 *
 *  - A **link session** is the socket: one per client instance, opened by Studio
 *    on its own the moment something needs this server, closed when nothing
 *    does. That is the `session` capability, and everything else on the socket
 *    travels on it - including the project list, one project's detail and the
 *    member list, which are methods gated by `session` rather than capabilities
 *    of their own.
 *  - A **live session** is a room: opened by a person, on one project, joined by
 *    other client instances, and used to find them and say things to them. That
 *    is the `live` capability.
 *
 * Two names are about what the server answers over HTTP before a socket exists,
 * because a session needs a token and a token has to come from somewhere:
 *
 *  - `password-sign-in` - a username and a password may be exchanged for a token.
 *  - `project-history` - a project's revisions may be read a page at a time.
 *
 * **Every name here is a statement about the deployment and none of them is
 * about the caller.** `admin` is where that is easiest to misread: it says this
 * server can be administered over the socket, not that whoever is reading it
 * may. Which of those two a client is holding is a different question, answered
 * by {@link TeamAccount.operator} in the same `hello` frame.
 *
 * Most of what a deployment announces follows from its build, but not all of it:
 * `comments`, `live`, `overlay`, `clients` and `blobs` are the coordination
 * plane, and a server whose operator has closed it to collaboration announces
 * none of the five, refuses every method under them, and serves none of the blob
 * addresses. So the list is a statement about the server as it stands, which is
 * why it may differ between two connections to the same process and why a client
 * reads it again each time it connects.
 */
export const TEAM_CAPABILITIES = [
  /** The link session exists at all. Everything else on the socket implies it. */
  "session",
  /** Threads and comments anchored in a project. */
  "comments",
  /** Which client instances are connected, and what each has open. */
  "clients",
  /** Live sessions: rooms on a project, for finding instances and broadcasting to them. */
  "live",
  /** Data attached to a project at a revision, which never enters the repository. */
  "overlay",
  /**
   * This server's own state - its accounts, settings, keys, decisions and
   * health - may be read and changed over the socket, by an operator.
   *
   * Announced to everybody, refused to all but operators. It is what this build
   * can do; whether the account on the other end may do it is
   * {@link TeamAccount.operator}, and a client draws a management surface from
   * the two together.
   */
  "admin",
  /** A username and a password may be exchanged for a token, before any session. */
  "password-sign-in",
  /**
   * Studio may sign in through the browser instead: this server is an OAuth 2.0
   * authorization server for the public client `narraleaf-studio` —
   * authorization code with PKCE to a loopback redirect, refresh tokens, and the
   * device flow. The discovery document's `oauth` names the endpoints.
   */
  "oauth",
  /** A timeline and a contribution graph per account and per project. */
  "activity",
  /** To-dos, private or shown to a project, optionally assigned and anchored. */
  "todos",
  /** Mentions, replies and assignments, kept per account until read. */
  "notifications",
  /** Asking somebody to review a range of revisions, and their verdict. */
  "reviews",
  /** Names on revisions — "Demo 1" — that a project can be read at. */
  "milestones",
  /** Where each scene and asset stands: draft, waiting, approved or sent back. Team state only. */
  "approvals",
  /** An asset held by one person for a while; edits to it from anybody else are refused. */
  "locks",
  /**
   * Playable builds kept beside a project: uploaded to `PUT /api/team/v1/projects/{project}/builds`
   * and downloaded from it, never unpacked or run by the server.
   */
  "builds",
  /** Pictures put beside a comment (a playtest screenshot), at `/api/team/v1/projects/{project}/attachments`. */
  "attachments",
  /** Read-only links for somebody without an account, opened at `/console/s/{token}`. */
  "shares",
  /**
   * Notifications may reach a browser that is closed: Web Push, encrypted per RFC 8291, to the
   * subscriptions a console registered with `push.subscribe` under this server's VAPID key.
   */
  "push",
  /** An emoji from {@link TEAM_REACTIONS} on a comment or a chat message. */
  "reactions",
  /** Following a project, or one scene of it, to be told when a version is saved or a commit lands. */
  "watches",
  /** A project's glossary: terms and how each language says them, kept by Team for translators. */
  "glossary",
  /** Which voiced lines are recorded, and which need another take, per language. Team state only. */
  "voice",
  /** Project templates: members, milestones and to-dos to start a project with, or to add to one. */
  "templates",
  /** A daily or weekly letter of what was unread, by email or to a personal Feishu or Slack address. */
  "digests",
  /** Two-step sign-in: an authenticator app's code (RFC 6238) or a recovery code after the password. */
  "two-factor",
  /** Personal API tokens for scripts: per project, read-only unless made to write, expiring. */
  "api-tokens",
  /** A project may be archived - read-only and out of lists - and brought back; and given a title on screen. */
  "archive",
  /** How much a project keeps on this server (builds and attachments), against the quota. */
  "storage",
  /**
   * Operators may fix an account's own settings - its profile, notifications, two-step sign-in,
   * API tokens - by hand or from a template; what is fixed the account reads and cannot change.
   */
  "account-policy",
  /**
   * Studio may keep its preferences on this server, one document per account, to put back on
   * another computer: `PUT` and `GET /api/team/v1/studio-config`. Kept as bytes, never read.
   */
  "studio-config",
  /**
   * A project's own channel: messages its members write to each other, kept,
   * in order, and read back a page at a time - unlike a live session's chat,
   * which only the people in the room at that moment ever see.
   */
  "chat",
  /** Operators may have this server post its events to a chat or another service. */
  "webhooks",
  /** A project's revisions may be read a page at a time. */
  "project-history",
  /**
   * A live session's files may be put down on this server and collected from it.
   *
   * The one capability that is about bytes rather than about a call, and the one
   * address on this server that is not a document: a file a session carries is
   * streamed to `/api/team/v1/blobs/{project}/{transfer}` and streamed back out
   * of it, because the socket carries sixteen kilobytes a message and a file is
   * not a message.
   */
  "blobs",
  /**
   * This server is the authority over a team project's documents: every edit
   * is an intent sent here, applied here with Studio's own appliers, logged,
   * and published on the project's `doc` topic; history versions are
   * snapshots this server commits. Opening a team project means following
   * that topic - there is no room to open or join.
   */
  "documents",
] as const;

export type TeamCapability = (typeof TEAM_CAPABILITIES)[number];

/* ------------------------------------------------------------ error codes */

/**
 * Every way a call can fail.
 *
 * Small on purpose. A client that cannot act on the difference between two codes
 * will print whichever it got, so a code exists only where Studio does something
 * different because of it.
 */
export const TEAM_ERROR_CODES = [
  /** This build has no such method. A client that read `methods` will not see this. */
  "unknown-method",
  /** The parameters were not the shape the method takes. */
  "bad-params",
  /** The thing named is not on this server. */
  "not-found",
  /** The caller may not do that. */
  "refused",
  /** It would collide with something already there. */
  "conflict",
  /** True now and possibly not in a moment: a repository this server has not read yet. */
  "unavailable",
  /** The token that opened this session is no longer good. Reconnecting will not help. */
  "unauthenticated",
  /** Something nobody planned for. */
  "internal",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

/* ------------------------------------------------------------------ frames */

/** The frame kinds a server sends, as the contract lists them. */
export const TEAM_SERVER_FRAME_KINDS = [
  "hello",
  "result",
  "error",
  "subscribed",
  "event",
  "bye",
] as const;

/** The frame kinds a client sends, as the contract lists them. */
export const TEAM_CLIENT_FRAME_KINDS = ["call", "subscribe", "unsubscribe"] as const;

/**
 * What arrives first, before anything is asked.
 *
 * The account is in it because a session is a person rather than a token: Studio
 * shows whose comments are its own, and reading that off a JWT it holds would
 * mean Studio parsing tokens it is otherwise told to treat as opaque.
 */
export interface TeamHelloFrame {
  readonly t: "hello";
  readonly protocol: number;
  readonly server: { readonly name: string; readonly version: string };
  /** This connection's own id, for a log line on either side. */
  readonly session: string;
  readonly account: TeamAccount;
  /** Every method this build answers, so a client can check before it asks. */
  readonly methods: readonly string[];
  readonly capabilities: readonly TeamCapability[];
  /** The server's clock, so a client can say "two minutes ago" without trusting its own. */
  readonly serverTime: number;
  readonly heartbeatMs: number;
}

/** Who is on the other end. */
export interface TeamAccount {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  /** Whether this account may administer this server. Not a permission over any project. */
  readonly operator: boolean;
}

/** A question, which will be answered exactly once. */
export interface TeamCallFrame {
  readonly t: "call";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** The answer to one call. */
export interface TeamResultFrame {
  readonly t: "result";
  readonly id: number;
  readonly value: unknown;
}

/**
 * Why a call was not answered.
 *
 * Coded rather than worded, as every refusal crossing this boundary is: the
 * sentence a person reads is written in Studio, in their language. The message is
 * for a log, and it is in English on purpose.
 */
export interface TeamErrorFrame {
  readonly t: "error";
  readonly id: number;
  readonly code: TeamErrorCode;
  readonly message: string;
}

/** Ask to be told when something changes. */
export interface TeamSubscribeFrame {
  readonly t: "subscribe";
  readonly id: number;
  readonly topic: string;
}

/** Stop being told. */
export interface TeamUnsubscribeFrame {
  readonly t: "unsubscribe";
  readonly id: number;
  readonly topic: string;
}

/**
 * A subscription is in place, and from which point.
 *
 * `seq` is the last event this server published on that topic before the
 * subscription existed. A client compares it with the last number it saw, and
 * **anything other than exactly that number means read the collection again**.
 * Not merely a higher one: the sequences live in the server's memory, so a
 * restart takes them back to nought, and a restart is a missed event.
 *
 * Events are never replayed. This server keeps no log of them, and a client that
 * re-reads is a client that is correct rather than one that is fast.
 */
export interface TeamSubscribedFrame {
  readonly t: "subscribed";
  readonly id: number;
  readonly topic: string;
  readonly seq: number;
}

/** Something changed on a topic somebody is listening to. */
export interface TeamEventFrame {
  readonly t: "event";
  readonly topic: string;
  readonly seq: number;
  readonly payload: unknown;
}

/**
 * This server is about to close, and here is why.
 *
 * Sent as a message rather than left to the close code, because a close code is
 * two bytes and a number: what a person is shown when their session ends has to
 * distinguish a token that expired from a server that is shutting down, and only
 * one of those is worth reconnecting into straight away.
 */
export interface TeamByeFrame {
  readonly t: "bye";
  readonly code: TeamErrorCode;
  readonly message: string;
}

export type TeamServerFrame =
  | TeamHelloFrame
  | TeamResultFrame
  | TeamErrorFrame
  | TeamSubscribedFrame
  | TeamEventFrame
  | TeamByeFrame;

export type TeamClientFrame = TeamCallFrame | TeamSubscribeFrame | TeamUnsubscribeFrame;

/* ------------------------------------------------------------------ topics */

/** The list of projects on this server changed. */
export const TOPIC_PROJECTS = "projects";

/** One project's row, or what this server has read out of its repository. */
export function projectTopic(projectId: string): string {
  return `project:${projectId}`;
}

/** The threads anchored anywhere in one project. */
export function projectThreadsTopic(projectId: string): string {
  return `project:${projectId}/threads`;
}

/** What is attached to one project without being in its repository. */
export function projectOverlayTopic(projectId: string): string {
  return `project:${projectId}/overlay`;
}

/** Which client instances have one project open. */
export function projectClientsTopic(projectId: string): string {
  return `project:${projectId}/clients`;
}

/** The live sessions open on one project. */
export function projectLiveTopic(projectId: string): string {
  return `project:${projectId}/live`;
}

/** Who belongs to one project, and in which role. */
export function projectMembersTopic(projectId: string): string {
  return `project:${projectId}/members`;
}

/** The to-dos shown to one project's members. */
export function projectTodosTopic(projectId: string): string {
  return `project:${projectId}/todos`;
}

/** One project's review requests. Its members may hold it. */
export function projectReviewsTopic(projectId: string): string {
  return `project:${projectId}/reviews`;
}

/** One project's channel. Its members may hold it. */
export function projectChatTopic(projectId: string): string {
  return `project:${projectId}/chat`;
}

/** One project's milestones. Its members may hold it. */
export function projectMilestonesTopic(projectId: string): string {
  return `project:${projectId}/milestones`;
}

/** Where one project's scenes and assets stand. Its members may hold it. */
export function projectApprovalsTopic(projectId: string): string {
  return `project:${projectId}/approvals`;
}

/** One project's playable builds. Its members may hold it. */
export function projectBuildsTopic(projectId: string): string {
  return `project:${projectId}/builds`;
}

/** Who holds which of one project's assets. Its members may hold it. */
export function projectLocksTopic(projectId: string): string {
  return `project:${projectId}/locks`;
}

/** One project's applied edits, saved versions and restores. Its members may hold it. */
export function projectDocTopic(projectId: string): string {
  return `project:${projectId}/doc`;
}

/** One account's own to-dos — those it owns and those given to it. Only that account may hold it. */
export function accountTodosTopic(accountId: string): string {
  return `account:${accountId}/todos`;
}

/** One account's notifications. Only that account may hold it. */
export function accountNotificationsTopic(accountId: string): string {
  return `account:${accountId}/notifications`;
}

/**
 * What is being said inside one live session.
 *
 * The only topic that is not about a row somewhere. Nothing published here is
 * kept: it is delivered to whoever is subscribed at that instant and forgotten,
 * which is the whole of what "find the right instances and broadcast" means. A
 * client that was not connected missed it, and there is nothing to re-read,
 * because anything that had to survive was written through `overlay` instead.
 */
export function liveTopic(sessionId: string): string {
  return `live:${sessionId}`;
}

/**
 * The four topics a management surface listens on.
 *
 * **Every one of them is refused to anybody who is not an operator**, which no
 * other topic on this server is: the rest are about projects, and every account
 * reaches every project. A subscription is judged when it is taken, so one held
 * by an account that is demoted afterwards is taken back rather than kept until
 * the socket closes - see {@link TeamSubscriptionWithdrawn}.
 */

/** An account was made, disabled, enabled, given or denied administration, or had its tokens refused. */
export const TOPIC_ADMIN_USERS = "admin/users";

/** A setting of this server changed. */
export const TOPIC_ADMIN_SETTINGS = "admin/settings";

/** This server rotated its signing keys. */
export const TOPIC_ADMIN_KEYS = "admin/keys";

/**
 * A decision this server was asked to make was **refused**.
 *
 * Named for what it publishes rather than for the collection it belongs to, and
 * that is the whole design rather than a shortening. A decision is recorded on
 * the path that answers every repository access — an afternoon of one team
 * working is thousands of them — so a topic that fired per decision would push
 * more frames than the rest of this protocol together, to tell a panel
 * something it could only act on by re-reading a page it already holds. A
 * refusal is the rare outcome and the one an operator wants put in front of
 * them, so a refusal is what this carries.
 *
 * The consequence, said plainly so that nobody later reads this as a
 * list-changed topic with events missing: **an allowed decision is published
 * nowhere.** A client that wants the whole log pages `admin.audit.list`, and it
 * has to, because the sequence on this topic counts refusals and not rows.
 */
export const TOPIC_ADMIN_REFUSALS = "admin/refusals";

/* ----------------------------------------------------------------- anchors */

/**
 * Where in a project something is attached.
 *
 * **Every field is a string this server does not read.** `document` is a path as
 * Studio writes it, `element` is Studio's id for a row or an element inside that
 * document, and `revision` is what the repository was at when somebody wrote the
 * comment. This server stores them, indexes on the first two and compares them
 * for equality. It does not open the document, does not check the revision, and
 * does not refuse an anchor whose shape it has never seen.
 *
 * That is what keeps the two halves independently releasable. A Studio that
 * begins anchoring to something new needs nothing here at all.
 */
export interface TeamAnchor {
  /**
   * Which document inside the project, and absent for one about the project itself.
   *
   * Absent is a real case rather than a gap: "this project" is the first thing anybody
   * has to say about a project, and a made-up path standing in for it would be a string
   * every reader had to learn not to show.
   */
  readonly document?: string;
  readonly element?: string;
  readonly revision?: string;
}

/** The most a stored anchor field may be, so one cannot become somewhere to put a file. */
export const ANCHOR_FIELD_LIMIT = 512;

/** The most a comment may be. Long enough for a paragraph of notes, short of a document. */
export const COMMENT_BODY_LIMIT = 8 * 1024;
/** The longest message a project's channel keeps, in UTF-8 bytes. */
export const CHAT_BODY_LIMIT = 4 * 1024;
/** How many labels one to-do may carry, and how long each may be. */
export const TODO_LABELS_LIMIT = 8;
export const TODO_LABEL_LENGTH = 32;
/** How long an asset may be held at most, and for how long when nobody says. */
export const ASSET_LOCK_MAX_MINUTES = 7 * 24 * 60;
export const ASSET_LOCK_DEFAULT_MINUTES = 4 * 60;
/** The largest build one upload may be, and the largest picture beside a comment. */
export const BUILD_MAX_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** How long a share link may last at most, in days. */
export const SHARE_LINK_MAX_DAYS = 365;

/**
 * The most a suggestion may carry.
 *
 * Larger than a comment because it holds a replacement for whatever it is
 * anchored to rather than a sentence about it, and bounded for the same reason
 * everything else here is: this is a database row, not a repository.
 */
export const SUGGESTION_LIMIT = 64 * 1024;

/**
 * The most one overlay record may carry.
 *
 * The same size as a suggestion and for the same reason: a record holds
 * something Studio encoded about a place in a project, not the place itself. A
 * client with more than this to say about one line is a client that should be
 * writing to the repository, which is the thing built to hold documents.
 */
export const OVERLAY_BODY_LIMIT = 64 * 1024;

/**
 * The most one thing said in a live session may be.
 *
 * Smaller than a record on purpose. This is the real-time path: a cursor, a
 * selection, an edit somebody is in the middle of. Nothing here is stored, so
 * the bound is about how much one client may make this server relay to every
 * other, and a client with a document to send has `overlay` and the repository.
 */
export const LIVE_PAYLOAD_LIMIT = 16 * 1024;

/** The most any single field describing a client instance may be. */
export const INSTANCE_FIELD_LIMIT = 256;

/**
 * The most one edit may carry, as JSON: its document address and its
 * operation. Large enough for a paste of a few hundred rows; a whole document
 * is never an edit.
 */
export const DOC_INTENT_LIMIT = 96 * 1024;

/**
 * The most the rows on one page may weigh, in UTF-8 bytes.
 *
 * The per-field limits above bound one row and say nothing about how many of
 * them an answer holds; a count bounds how many and says nothing about how
 * large each is. Multiply the two out and one call asks a server to compose
 * megabytes, serialise them, and then hold them while a slow socket drains. So
 * every list this protocol pages carries a second ceiling beside its count, and
 * a page ends at whichever of the two is reached first.
 *
 * **A row's weight is the whole of its variable-length content**, not its
 * largest field: a comment's body and the suggestion beside it, an overlay
 * record's body and the anchor it is filed under. Counting one field and
 * leaving the rest to the count cap is how an answer of two thousand small rows
 * with long anchors comes out several times the ceiling that was meant to bound
 * it.
 *
 * A mebibyte, because what these lists carry is notes and marks rather than
 * documents: it holds the whole of an ordinary project's conversations in one
 * page, and it is a dozen times the largest single row anybody may write, so a
 * reader whose rows really are that large goes on making progress rather than
 * being cut off.
 *
 * **The first row of a page goes on it whatever it weighs.** A page that came
 * back empty because one row was larger than the whole budget would be a cursor
 * that never moved, and a reader that could never get past that row.
 */
export const PAGE_BYTES_LIMIT = 1024 * 1024;

/**
 * The largest answer a server composes, and the smallest reader a client may have.
 *
 * This is the figure every transport ceiling on either side of the wire is
 * derived from, and it is here rather than in one of them because both sides
 * need the same number: a client whose reader is smaller than this refuses an
 * answer its own server built, and a server that will not hold this much for one
 * session drops a peer for being sent one.
 *
 * Two mebibytes, worked out from the limits above rather than chosen:
 *
 *  - the rows on a page weigh at most PAGE_BYTES_LIMIT, which is one mebibyte;
 *  - one row goes on beyond that, because the first row of a page is admitted
 *    whatever it weighs, and the heaviest is a thread carrying an opening
 *    comment — COMMENT_BODY_LIMIT, SUGGESTION_LIMIT and an anchor, some
 *    seventy-four kilobytes;
 *  - and the fields around the rows are not weighed at all — ids, timestamps,
 *    usernames, field names, the punctuation between them — which is a few
 *    hundred bytes on a row and at most two thousand rows to a page, so under
 *    six hundred kilobytes.
 *
 * That is a little over one and a half mebibytes; the rest is the room a JSON
 * escape takes in text that needs one, and the frame the answer travels in.
 *
 * **One answer stands outside that working-out and is named here rather than
 * left to be discovered.** A page of a project's history is weighed like every
 * other page, but the one row a page admits beyond its budget is a commit
 * message, which comes out of a repository rather than out of a field this
 * protocol bounds — so one revision pushed with a message larger than this
 * figure is one answer larger than this figure. Weighing the page is what makes
 * that a single row rather than a hundred of them; the remedy for the row
 * itself would be to report less of a message than the repository holds, which
 * is not something this server does anywhere.
 */
export const ANSWER_BYTES_LIMIT = 2 * 1024 * 1024;

/* --------------------------------------------------------- client instances */

/**
 * One installation of Studio, as this server knows it while it is connected.
 *
 * **An instance is not an account and not a link session.** One person signs in
 * on the desktop and the laptop and is one account with two instances; one
 * instance opens a link session to each server it is configured for. The id is
 * generated by the client once and kept, so the same installation reconnecting
 * is recognisably the same installation - which is what "find the right
 * instance" needs, and what an account alone cannot give.
 *
 * Nothing about an instance is stored. This is a fact about who is here now,
 * and the honest place for it is memory: a table of installations that once
 * connected would be a list this server had to prune and an operator had to
 * wonder about. What outlives a connection is the id written into whatever that
 * instance produced, which is a string like any other.
 */
export interface TeamClientInstance {
  /** What the client calls itself, kept across restarts by the client. */
  readonly id: string;
  /** Which account it is connected as, by username. */
  readonly account: string;
  /**
   * What a person would call this machine, as the client chose to say it.
   *
   * Chosen by the client rather than taken off the connection: what is useful
   * here is "Nomen" or "the studio iMac", and the only thing this server could
   * derive is an address, which two instances behind one router share.
   */
  readonly label: string;
  /** Which client this is and which build, for a line in a log. */
  readonly agent: string;
  /** The project this instance has open, absent for one that has none. */
  readonly project?: string;
  /** What that project stands at on that machine, as the client reported it. */
  readonly revision?: string;
  /**
   * The document this instance is editing, in anchor terms (`story:<id>`,
   * `ui:<id>`), and since when. A hint for somebody about to open the same one —
   * "Ada has been in this chapter for ten minutes" — and never a lock: nothing
   * is refused because of it. Absent while nothing is being edited; only with a
   * project.
   */
  readonly editing?: string;
  readonly editingSince?: number;
  /** When this instance announced itself on its current link session. */
  readonly since: number;
}

/** What happened on a project's clients topic. */
export type TeamClientsEvent =
  | { readonly kind: "client-here"; readonly client: TeamClientInstance }
  | { readonly kind: "client-gone"; readonly client: string };

/* ------------------------------------------------------------ live sessions */

/**
 * A room on one project, opened by a person.
 *
 * Read the note on {@link TeamCapability} first: this is the session somebody
 * asks for, as distinct from the socket they never see. It exists to answer one
 * question - which client instances are working on this together right now - and
 * to give this server somewhere to send what one of them says to the others.
 *
 * **It holds nothing.** No document, no edit history, no record that it
 * happened. Everything produced inside one is written through `overlay` or
 * pushed to the repository, both of which are still there when the room is not.
 * That is why this is memory and why a restart ends every room without a
 * migration, a cleanup pass or an expiry policy.
 */
export interface TeamLiveSession {
  readonly id: string;
  readonly project: string;
  /**
   * What the project stood at when it was opened, as the opener reported it.
   *
   * **Required, alone among the things a room is described by.** A room is a
   * place where people apply each other's operations to a document, so it only
   * means anything if everybody in it started from the same document, and this
   * is the only thing that names that starting point. A room without one is a
   * room whose members have no way of telling whether they began from the same
   * text; the operations passing through it would land on documents that differ
   * from the first message onwards, and silently, because nothing here compares
   * them. This server still does not read the string - it carries it, so that
   * the people about to trust each other's edits can.
   */
  readonly revision: string;
  /**
   * Which document of that project the room is about, as the opener named it.
   *
   * **Required, for the same reason `revision` is, and it is not the same
   * reason twice.** The revision says which *text* everybody started from; this
   * says which *document* they are all editing. A room carrying only the first
   * leaves the second to be guessed, and the only thing a joiner could guess
   * from is its own copy - so two people would agree about the version and
   * still be applying each other's operations to different files, which is the
   * failure the revision was made required to prevent, arrived at by the other
   * road. It also decides who can join at all: a joiner that has to guess can
   * only guess a document it already has, which shuts out exactly the person
   * for whom joining is how they get the project in the first place.
   *
   * Opaque here, like every other anchor on this server (see `overlay`): it is
   * carried and compared for equality, never parsed. What the string means is
   * Studio's business.
   */
  readonly story: string;
  /** What the opener called it, absent when they called it nothing. */
  readonly title?: string;
  /** Who opened it, by username. */
  readonly openedBy: string;
  /** Which client instance opened it. */
  readonly openedByInstance: string;
  readonly openedAt: number;
  /** Who is in it now. Never empty: the last one out closes it. */
  readonly members: readonly TeamLiveMember[];
  /**
   * How somebody gets into it. Absent from a room opened by a client older than
   * the rule, which behaves as `open` and always did.
   */
  readonly rule?: TeamLiveJoinRule;
}

/**
 * How a room may be joined.
 *
 * ⚠ **The passcode is not in the room record and must never be put there.** A
 * record is broadcast on the project's topic, which everybody on the project is
 * watching, and a passcode broadcast to everybody is a passcode that has said
 * nothing. It is answered to the window that opened the room and to nobody else -
 * see `live.open`.
 *
 * **Two questions, not one, and the three answers are three of the four corners.**
 * Whether the room can be found is one; whether a person decides who comes in is
 * the other.
 *
 *  - `open` - listed on the project, and anybody who can see it may join. What
 *    every room was before there was a rule.
 *  - `code` - not listed to anybody who is not already in it, and joinable only
 *    by the four digits minted when it opened. **Checked here rather than by the
 *    client**: a client checks nothing an operator can rely on.
 *  - `request` - listed like `open`, and joined only after whoever opened it has
 *    said yes. See `live.requestJoin`.
 *
 * The fourth corner - a code AND an answer - is deliberately not offered: a code
 * is already a door, and a second one asks the host to decide something they know
 * nothing more about than the code did.
 */
export type TeamLiveJoinRule = "open" | "code" | "request";

export interface TeamLiveMember {
  readonly instance: string;
  readonly account: string;
  readonly label: string;
  readonly joinedAt: number;
}

/**
 * What happened on a project's live topic.
 *
 * ⚠ **The last two are seen by everybody watching the project, not only by the
 * room.** A request and its refusal are addressed to one window each - the host
 * and the person who asked - but they travel on the project's topic, because the
 * person who asked is not in the room and has nothing else to listen to. What that
 * costs is that everybody on the project can see who asked to join what, which is
 * consistent with a deployment where every account already reaches every project.
 * The alternative was a server-authored frame on the room's own topic, and that
 * topic carries payloads this server does not read - see {@link TeamLiveMessage}.
 */
export type TeamLiveEvent =
  | { readonly kind: "live-opened"; readonly session: TeamLiveSession }
  | { readonly kind: "live-changed"; readonly session: TeamLiveSession }
  | { readonly kind: "live-closed"; readonly session: string }
  /** Somebody wants into a `request` room. Acted on by whoever opened it, and by nobody else. */
  | {
      readonly kind: "live-requested";
      readonly session: string;
      readonly member: TeamLiveMember;
    }
  /**
   * A request that was answered no, or that its room outlived.
   *
   * Admission has no event of its own: the member is added, which is a change to
   * the room, and `live-changed` already says that - so whoever asked learns they
   * are in by finding themselves in the roster.
   */
  | {
      readonly kind: "live-refused";
      readonly session: string;
      readonly instance: string;
    };

/**
 * One thing said inside a live session, as it reaches the others.
 *
 * `payload` is Studio's, whole and unread, for the reason every opaque field
 * here is opaque: what two Studios say to each other while editing together is a
 * question about documents, and this server does not have one. What it adds is
 * who said it, because a client cannot tell its own broadcast from somebody
 * else's otherwise, and every participant receives every message including
 * their own.
 */
export interface TeamLiveMessage {
  readonly session: string;
  readonly from: string;
  readonly account: string;
  readonly at: number;
  readonly payload: unknown;
}

/* ----------------------------------------------------------------- overlay */

/**
 * Something attached to a project at a revision, which is not in the repository.
 *
 * **This is the third place a project's content can live and the only one that
 * is neither the repository nor a version of it.** A revision is what an author
 * recorded; a comment is a conversation about one; an overlay record is anything
 * else a client wants to keep beside a place in a project without changing what
 * that project is. A review mark on a story row, a translator's flag, a
 * playtest note - none of these belong in a revision, and until now there was
 * nowhere else to put them.
 *
 * Three properties are the whole of the bargain:
 *
 *  - **It never enters the history.** Nothing here is written to a repository,
 *    nothing here changes a revision, and a client that syncs sees exactly what
 *    it would have seen.
 *  - **It names the revision it was written against**, so a reader can tell a
 *    note about what is there now from one about what used to be. This server
 *    does not decide which is which: it hands back the revision and the head it
 *    last read, and the client - which is the half that knows whether the thing
 *    the note is about survived - decides.
 *  - **`kind` and `body` are Studio's.** A kind is a word this server groups
 *    and filters by and never interprets; a body is a string it never opens.
 *    Same bargain as an anchor, for the same reason: a Studio that starts
 *    attaching a new sort of thing needs nothing here at all.
 */
export interface TeamOverlayRecord {
  readonly id: string;
  readonly project: string;
  /**
   * Where it is attached, revision included and required.
   *
   * Required here where it is optional on a thread, because a record is
   * expressly about a project **at a version** - that is what asks for it - and
   * one that did not say which would be a note nobody could age.
   */
  readonly anchor: TeamAnchor & { readonly revision: string };
  /** What sort of thing this is, in Studio's words. */
  readonly kind: string;
  /** The thing itself, as Studio encoded it. */
  readonly body: string;
  /** Who wrote it, by username, and absent for an account this server no longer has. */
  readonly author?: string;
  /** Which client instance wrote it, absent for one that did not say. */
  readonly instance?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What happened on a project's overlay topic. */
export type TeamOverlayEvent =
  | { readonly kind: "overlay-put"; readonly record: TeamOverlayRecord }
  | {
      readonly kind: "overlay-dropped";
      readonly record: string;
      readonly anchor: TeamAnchor;
    };

/* ----------------------------------------------------- what methods answer */

/** A conversation attached to one anchor. */
export interface TeamThread {
  readonly id: string;
  readonly project: string;
  readonly anchor: TeamAnchor;
  readonly kind: TeamThreadKind;
  readonly status: TeamThreadStatus;
  /**
   * Who opened it, by username, and absent for an account this server no longer has.
   *
   * A name rather than an id, for the reason the project list carries one: what a reader
   * needs is who said this, and an id would send every client to the members list to
   * find out. Absent rather than a stand-in, because a thread outlives the account that
   * opened it and a row claiming an author it cannot name would be worse than a row that
   * does not claim one.
   */
  readonly createdBy?: string;
  readonly createdAt: number;
  /** When anything in it last changed, so a list can be ordered by what is live. */
  readonly updatedAt: number;
  /** Who settled it, by username. */
  readonly resolvedBy?: string;
  readonly resolvedAt?: number;
  /** How many comments it holds, withdrawn ones included: a list shows a count, not bodies. */
  readonly comments: number;
  /** The first comment, which is what a list of threads shows. */
  readonly opening?: TeamComment;
}

/**
 * What kind of thing a thread is.
 *
 * A suggestion is a comment that also carries a proposed replacement for what it
 * is anchored to. The replacement is opaque here, so the difference this server
 * knows about is one word and the difference Studio knows about is a button.
 */
export type TeamThreadKind = "comment" | "suggestion";

export type TeamThreadStatus = "open" | "resolved";

/** One thing somebody said. */
export interface TeamComment {
  readonly id: string;
  readonly thread: string;
  /** Who wrote it, by username. Absent for the same reason {@link TeamThread.createdBy} is. */
  readonly author?: string;
  readonly body: string;
  /**
   * What this comment proposes, as Studio encoded it.
   *
   * A string this server never looks inside, for the reason set out on
   * {@link TeamAnchor}. Absent on an ordinary comment.
   */
  readonly suggestion?: string;
  readonly createdAt: number;
  readonly editedAt?: number;
  /**
   * When it was withdrawn, if it was.
   *
   * A withdrawn comment keeps its row and loses its body. The shape of a
   * conversation is part of what the remaining comments mean, since a reply to
   * nothing reads as a reply to the comment above it, so the row stays and says
   * that it is gone.
   */
  readonly deletedAt?: number;
}

/** What happened on a project's threads topic. */
export type TeamThreadEvent =
  | { readonly kind: "thread-created"; readonly thread: TeamThread }
  | { readonly kind: "thread-updated"; readonly thread: TeamThread }
  | { readonly kind: "comment-created"; readonly thread: string; readonly comment: TeamComment }
  | { readonly kind: "comment-updated"; readonly thread: string; readonly comment: TeamComment }
  /** Somebody reacted to a comment, or took a reaction back; `target` is the comment id. */
  | { readonly kind: "reaction"; readonly reaction: TeamReaction };

/**
 * What happened on the projects topic.
 *
 * **Each event goes only to the accounts it is about.** The projects topic is
 * one name every session may hold, but the list behind it differs by account —
 * a project somebody has no role in is not on their list — so a project being
 * made or forgotten is told to its members and to the operators, and to nobody
 * else. A sequence still moves for everybody, so a session that was not told
 * sees a gap it may read the list again over, which costs it one call and tells
 * it nothing it could not already see.
 */
export type TeamProjectsEvent =
  | { readonly kind: "project-created"; readonly project: string }
  | { readonly kind: "project-forgotten"; readonly project: string }
  /** This server read a repository again, so what it says about it may have changed. */
  | { readonly kind: "project-read"; readonly project: string }
  /**
   * The receiving account was given a role in a project, had it changed, or was
   * taken out. Told to that account alone: read the list again, and the
   * project is on it with its new role, or is not on it any more.
   */
  | { readonly kind: "project-access-changed"; readonly project: string }
  /**
   * An access request was made, answered or withdrawn. Told to whoever asked
   * and to whoever decides it (the project's owners and the operators, or the
   * operators alone for leave to make projects): read the requests again.
   */
  | { readonly kind: "access-request"; readonly request: TeamAccessRequest };

/* ----------------------------------------------------------- own devices */

/**
 * One Studio installation an account signed in on through the browser (an OAuth
 * grant). Revoking it refuses every token it holds, at once, and touches no
 * other device.
 */
export interface TeamAccountDevice {
  readonly id: string;
  /** What the installation called itself when it asked, e.g. "the studio iMac". */
  readonly name: string;
  /** Which application, e.g. "NarraLeaf Studio". */
  readonly client: string;
  readonly signedInAt: number;
  readonly lastUsedAt: number;
}

/* ----------------------------------------------------------- activity */

/** What kind of thing happened. */
export type TeamActivityKind =
  | "commit"
  | "thread"
  | "comment"
  | "resolve"
  | "todo-created"
  | "todo-done"
  | "review"
  | "milestone"
  /**
   * Edits to a team project's documents through this server, folded into one row per stretch of
   * work: an account's edits to one project that follow each other within half an hour. `count`
   * says how many.
   */
  | "edit"
  /** A history version saved by hand, or an older one restored. Automatic snapshots are not news. */
  | "version"
  /** A scene or asset approved; `ref` is its target. */
  | "approved"
  /** A scene or asset sent back with a reason (the summary); `ref` is its target. */
  | "sent-back"
  /** A playable build uploaded; `ref` is `build:{id}`, the summary its name. */
  | "build";

/**
 * One thing that happened, for a timeline.
 *
 * `account` is who did it when Team knows; a commit's author is the string the
 * pushing client wrote, matched to an account by username, address or name
 * where one matches, and otherwise shown as `actor` alone. That match is a
 * convenience, not proof: loreserver does not check what a client writes there.
 */
export interface TeamActivity {
  readonly id: number;
  readonly kind: TeamActivityKind;
  readonly project?: string;
  /** Which thing: a revision id, a thread id, a to-do id. Never its text. */
  readonly ref?: string;
  /** A short line: a commit's message, a thread's opening words, a to-do's title. */
  readonly summary?: string;
  readonly account?: string;
  /** What to call whoever did it. */
  readonly actor: string;
  readonly at: number;
  /** How many edits an `edit` row stands for. */
  readonly count?: number;
}

/** One day of a contribution graph, in the caller's time zone. */
export interface TeamActivityDay {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly count: number;
}

/* -------------------------------------------------------------- to-dos */

export type TeamTodoStatus = "open" | "doing" | "done";
/** `private`: its owner alone. `project`: every member of its project. */
export type TeamTodoVisibility = "private" | "project";
/**
 * What a to-do asks for. `task` is anything; `asset` asks for a file (a sprite, a sound) for the
 * row it is anchored to, and names the asset that answered it once done; `translation` and `voice`
 * give one language of a story or scene to somebody, and name the `locale`.
 */
export type TeamTodoKind = "task" | "asset" | "translation" | "voice";

export interface TeamTodo {
  readonly id: string;
  /** Who made it, by username. */
  readonly owner: string;
  readonly assignee?: string;
  readonly project?: string;
  /** Where in the project it points, in the same terms a thread's anchor uses. Never parsed. */
  readonly anchor?: { readonly document: string; readonly element: string; readonly revision?: string };
  readonly title: string;
  readonly body?: string;
  readonly status: TeamTodoStatus;
  readonly visibility: TeamTodoVisibility;
  /** What it asks for; `task` where a client did not say. */
  readonly kind: TeamTodoKind;
  /** The language a `translation` or `voice` to-do is about, as a locale tag. */
  readonly locale?: string;
  /** The asset that answered an `asset` to-do, by id. Never read by the server. */
  readonly asset?: string;
  /** Short words to sort it by — "bug", "art", "chapter 2". At most {@link TODO_LABELS_LIMIT}. */
  readonly labels?: readonly string[];
  readonly dueAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly doneAt?: number;
  /** The revision that finished it, where it was ticked off in a commit. Never parsed. */
  readonly doneRevision?: string;
  /** The milestone of the same project it counts toward, by id: what a burndown is drawn from. */
  readonly milestone?: string;
}

/** What happened on a to-do topic. */
export type TeamTodosEvent =
  | { readonly kind: "todo-set"; readonly todo: TeamTodo }
  | { readonly kind: "todo-removed"; readonly todo: string };

/* -------------------------------------------------------- notifications */

export type TeamNotificationKind =
  | "mention"
  | "reply"
  | "assigned"
  | "review-requested"
  | "review-answered"
  /** Somebody asked for access this account decides on; `ref` is `access:{id}`. */
  | "access-requested"
  /** An access request this account made was answered; `ref` is `access:{id}`. */
  | "access-decided"
  /** Something this account follows changed: a version saved or a commit landed; `ref` is the revision. */
  | "watch";

/**
 * What a person may switch notifications on and off by. Each {@link TeamNotificationKind} is one
 * of these: `review-requested` and `review-answered` are both `review`, both access kinds `access`.
 */
export const TEAM_NOTIFICATION_CATEGORIES = ["mention", "reply", "assign", "review", "watch", "access"] as const;

export type TeamNotificationCategory = (typeof TEAM_NOTIFICATION_CATEGORIES)[number];

/**
 * Where a notification may go: the list in the console and Studio, a push to a browser, and the
 * daily or weekly digest (by email, or to the account's own Feishu or Slack address).
 */
export const TEAM_NOTIFICATION_CHANNELS = ["inapp", "push", "email"] as const;

export type TeamNotificationChannel = (typeof TEAM_NOTIFICATION_CHANNELS)[number];

export const TEAM_DIGEST_FREQUENCIES = ["off", "daily", "weekly"] as const;

export type TeamDigestFrequency = (typeof TEAM_DIGEST_FREQUENCIES)[number];

/** One account's notification settings. Every switch not stored is on. */
export interface TeamNotificationPrefs {
  readonly switches: readonly { readonly category: TeamNotificationCategory; readonly channel: TeamNotificationChannel; readonly enabled: boolean }[];
  readonly digest: TeamDigestFrequency;
  /** A Feishu or Slack incoming-webhook address the digest is also posted to. */
  readonly hook?: string;
  /** Where the digest is mailed, absent when the account has no address. */
  readonly email?: string;
  /** Whether this server can send mail at all: an operator configured SMTP. */
  readonly mail: boolean;
  /** How many browsers this account has asked to be pushed to. */
  readonly pushSubscriptions: number;
}

/** Something one account follows: a whole project, or one scene in it. */
export interface TeamWatch {
  readonly project: string;
  /** `scene:{sceneId}` for one scene; absent for the whole project. */
  readonly scope?: string;
  readonly createdAt: number;
}

/** The reactions a comment or a chat message may carry, and nothing else. */
export const TEAM_REACTIONS = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"] as const;

export type TeamReactionEmoji = (typeof TEAM_REACTIONS)[number];

/** Everybody who put one emoji on one comment or message, by username, earliest first. */
export interface TeamReaction {
  readonly target: string;
  readonly emoji: TeamReactionEmoji;
  readonly by: readonly string[];
}

/* -------------------------------------------------------------- reviews */

/**
 * `open` waits on the reviewer; `approved` and `changes` are their verdict; `withdrawn` is the
 * requester taking it back. A verdict can be changed while the request stands.
 */
export type TeamReviewStatus = "open" | "approved" | "changes" | "withdrawn";

/** Somebody asked to look at a range of a project's revisions. */
export interface TeamReview {
  readonly id: string;
  readonly project: string;
  /** Who asked, by username. */
  readonly requester: string;
  /** Who is asked, by username. */
  readonly reviewer: string;
  /** The revision before the range, absent for "everything up to". Never read by the server. */
  readonly fromRevision?: string;
  /** The last revision of the range. */
  readonly toRevision: string;
  readonly title: string;
  readonly note?: string;
  readonly status: TeamReviewStatus;
  /** What the reviewer said with the verdict. */
  readonly verdictNote?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type TeamReviewsEvent = { readonly kind: "review-set"; readonly review: TeamReview };

/* ----------------------------------------------------------------- chat */

/** One message in a project's channel. */
export interface TeamChatMessage {
  readonly id: number;
  readonly project: string;
  /** Who wrote it, by username; absent once that account is gone. */
  readonly author?: string;
  readonly body: string;
  readonly at: number;
  /** Set when its author took it back; the body is then empty. */
  readonly deletedAt?: number;
}

export type TeamChatEvent =
  | { readonly kind: "chat-message"; readonly message: TeamChatMessage }
  | { readonly kind: "chat-deleted"; readonly id: number; readonly project: string }
  /** Somebody reacted to a message, or took a reaction back; `target` is the message id. */
  | { readonly kind: "reaction"; readonly project: string; readonly reaction: TeamReaction };

/* ----------------------------------------------------------- milestones */

/**
 * A name on one revision of a project. Unique per project. A milestone that is only planned —
 * "Demo 1, due in March" — has no revision yet, and `revision` is the empty string.
 */
export interface TeamMilestone {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  /** The revision it names, or `""` while it is only planned. */
  readonly revision: string;
  readonly note?: string;
  readonly createdBy?: string;
  readonly createdAt: number;
  /** When it is meant to be reached. */
  readonly dueAt?: number;
  /**
   * It is not reached until every scene is approved. The server keeps the flag; the console
   * works the share out from the project's files and the approvals.
   */
  readonly gate?: boolean;
}

export type TeamMilestonesEvent =
  | { readonly kind: "milestone-set"; readonly milestone: TeamMilestone }
  | { readonly kind: "milestone-removed"; readonly milestone: string };

/* ------------------------------------------------------------- glossary */

/** One term of a project's glossary and how each language says it. Unique by term per project. */
export interface TeamGlossaryEntry {
  readonly id: string;
  readonly project: string;
  /** The term as the source language writes it. */
  readonly term: string;
  /** Locale tag → how that language says it. A missing locale has no agreed word yet. */
  readonly translations: Readonly<Record<string, string>>;
  readonly note?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly updatedBy?: string;
}

/* ---------------------------------------------------------------- voice */

/**
 * Where one voiced line stands in one language. `recorded`: there is a take to use; `retake`: it
 * has to be recorded again. A line with no record has not been recorded. Only Team's own record;
 * the voice files in the project are Studio's.
 */
export const TEAM_VOICE_STATUSES = ["recorded", "retake"] as const;
export type TeamVoiceStatus = (typeof TEAM_VOICE_STATUSES)[number];

export interface TeamVoiceLine {
  readonly project: string;
  readonly locale: string;
  /** The line, by the textId Studio gives it. Never parsed. */
  readonly line: string;
  readonly status: TeamVoiceStatus;
  /** Which take is the one to use, counted from 1. */
  readonly take?: number;
  readonly note?: string;
  readonly updatedAt: number;
  readonly updatedBy?: string;
}

/* ------------------------------------------------------------ templates */

/** What a project template puts into a project. Nothing in it touches the project's files. */
export interface TeamTemplateBody {
  /** Accounts to add, each with a permission template. Accounts that do not exist are skipped. */
  readonly members?: readonly { readonly username: string; readonly template: TeamPermissionTemplateId }[];
  /** Planned milestones, due some days after the template is applied. */
  readonly milestones?: readonly { readonly name: string; readonly note?: string; readonly dueInDays?: number }[];
  /** Project to-dos, optionally counting toward one of the milestones above, by name. */
  readonly todos?: readonly {
    readonly title: string;
    readonly body?: string;
    readonly kind?: TeamTodoKind;
    readonly locale?: string;
    readonly labels?: readonly string[];
    readonly milestone?: string;
    readonly dueInDays?: number;
  }[];
}

export interface TeamProjectTemplate {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly body: TeamTemplateBody;
  readonly createdBy?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/* ------------------------------------------------------------ approvals */

/**
 * `draft` is still being made; `pending` waits on a reviewer; `approved` and `changes` are the
 * verdict. Only Team's own record: the project's files are never touched by it.
 */
export const TEAM_APPROVAL_STATUSES = ["draft", "pending", "approved", "changes"] as const;
export type TeamApprovalStatus = (typeof TEAM_APPROVAL_STATUSES)[number];

/** Where one scene or asset stands. `target` is `scene:{id}` or `asset:{id}`, never parsed. */
export interface TeamApproval {
  readonly project: string;
  readonly target: string;
  readonly status: TeamApprovalStatus;
  /** Who moved it there, by username. */
  readonly by?: string;
  /** Why — required when it is sent back. */
  readonly note?: string;
  readonly at: number;
}

export type TeamApprovalsEvent = { readonly kind: "approval-set"; readonly approval: TeamApproval };

/* ---------------------------------------------------------------- locks */

/** Somebody holds one asset of a project until `expiresAt`. */
export interface TeamAssetLock {
  readonly project: string;
  readonly asset: string;
  /** Who holds it, by username. */
  readonly holder: string;
  readonly note?: string;
  readonly at: number;
  readonly expiresAt: number;
}

export type TeamLocksEvent =
  | { readonly kind: "lock-set"; readonly lock: TeamAssetLock }
  | { readonly kind: "lock-released"; readonly project: string; readonly asset: string };

/* --------------------------------------------------------------- builds */

/** One playable build kept beside a project. The bytes are at `/api/team/v1/projects/{project}/builds/{id}`. */
export interface TeamBuild {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly note?: string;
  /** The revision it was built from, where the uploader said. */
  readonly revision?: string;
  /** What it runs on, as the uploader put it: `windows`, `mac`, `web`... Never interpreted. */
  readonly platform?: string;
  /** The file's own name, for the download. */
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedBy?: string;
  readonly createdAt: number;
  /** The one build of the project to play now. At most one is. */
  readonly latest: boolean;
}

export type TeamBuildsEvent =
  | { readonly kind: "build-set"; readonly build: TeamBuild }
  | { readonly kind: "build-removed"; readonly build: string };

/** A picture kept beside a comment. Its bytes are at `/api/team/v1/projects/{project}/attachments/{id}`. */
export interface TeamAttachment {
  readonly id: string;
  readonly project: string;
  readonly type: "png" | "jpg" | "webp";
  readonly size: number;
  readonly uploadedBy?: string;
  readonly createdAt: number;
}

/* ---------------------------------------------------------- share links */

/**
 * A read-only link for somebody without an account.
 *
 * `paths` is the files it shows, worked out by the console when the link was made (a story's
 * document and what it needs), or absent for the whole project; the server holds the visitor to
 * that list without reading any of the files. The token itself is shown once, at creation.
 */
export interface TeamShareLink {
  readonly id: string;
  readonly project: string;
  readonly label: string;
  /** What the console calls it: `project`, or `story:{id}`. Never read by the server. */
  readonly scope: string;
  readonly revision: string;
  readonly paths?: readonly string[];
  readonly allowComments: boolean;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly createdBy?: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly uses: number;
}

/** What a visitor's page is told about the link it was opened from. */
export interface TeamShareView {
  readonly project: string;
  readonly projectName: string;
  readonly label: string;
  readonly scope: string;
  readonly revision: string;
  readonly allowComments: boolean;
  readonly expiresAt?: number;
}

/* -------------------------------------------------------- saved filters */

/** A search one account named and keeps. `query` is the page's own JSON, never read by the server. */
export interface TeamSavedFilter {
  readonly id: string;
  /** Which list it filters: `todos`, `threads`, ... */
  readonly scope: string;
  readonly name: string;
  readonly query: string;
  readonly createdAt: number;
}

/* ------------------------------------------------------------- webhooks */

/** What a webhook can be told about. */
export const TEAM_WEBHOOK_EVENTS = [
  "commit",
  "thread",
  "todo-assigned",
  "todo-done",
  "review-requested",
  "review-answered",
  "milestone",
  /** A history version saved by hand, or restored. Automatic snapshots post nothing. */
  "version",
  /** A playable build uploaded. */
  "build",
] as const;
export type TeamWebhookEvent = (typeof TEAM_WEBHOOK_EVENTS)[number];

/**
 * What this server knows about a revision it wrote as a team project's history version, carried on
 * `projects.history` beside the revision. Every such revision is committed under one account (the
 * one the server reads the repository as), so the commit's own author says nothing about who did
 * the work: this does.
 */
export interface TeamDocVersion {
  /** The name it was saved under, for a version saved by hand. */
  readonly label?: string;
  /** Saved by the server on its own, when the project went quiet or had been edited for a while. */
  readonly auto: boolean;
  /** Who saved it or restored it, for one saved by hand. */
  readonly savedBy?: string;
  /** Everybody whose edits it holds that the version before it did not, by username. */
  readonly participants: readonly string[];
  /** The authority's seq it stands at. */
  readonly seq: number;
}

/** Which project role at least may save a version, or restore one. */
export type TeamVersionRole = "editor" | "owner";

/**
 * How the body is shaped. `json` is this server's own event object, signed; the others are the
 * message shape of a chat service's incoming webhook, carrying one line of text.
 */
export const TEAM_WEBHOOK_FORMATS = ["json", "slack", "discord", "feishu"] as const;
export type TeamWebhookFormat = (typeof TEAM_WEBHOOK_FORMATS)[number];

export interface TeamWebhook {
  readonly id: string;
  /** Only this project's events, or every project's where absent. */
  readonly project?: string;
  readonly url: string;
  readonly format: TeamWebhookFormat;
  readonly events: readonly TeamWebhookEvent[];
  readonly createdBy?: string;
  readonly createdAt: number;
  /** How the last delivery went: an HTTP status, or 0 for no answer. */
  readonly lastStatus?: number;
  readonly lastAt?: number;
}

/** One event sent to one webhook, and how it went. Failed ones are tried again on a schedule. */
export interface TeamWebhookDelivery {
  readonly id: number;
  readonly webhook: string;
  readonly event: TeamWebhookEvent;
  readonly project?: string;
  readonly summary: string;
  /** Tries so far. */
  readonly attempts: number;
  /** The last answer: an HTTP status, or 0 for none. */
  readonly status: number;
  /** Why it failed, in a few words, where it did. */
  readonly error?: string;
  readonly at: number;
  readonly lastAt?: number;
  /** When it is tried again, where it will be. */
  readonly nextAt?: number;
}

export interface TeamNotification {
  readonly id: number;
  readonly kind: TeamNotificationKind;
  readonly project?: string;
  /** A thread id for a mention or a reply; a to-do id for an assignment. */
  readonly ref?: string;
  /** Who caused it, by username. */
  readonly actor?: string;
  readonly summary?: string;
  readonly at: number;
  readonly readAt?: number;
}

export type TeamNotificationsEvent =
  | { readonly kind: "notification"; readonly notification: TeamNotification }
  | { readonly kind: "notifications-read"; readonly ids: readonly number[] | "all" };

/* -------------------------------------------------------------- profiles */

/** An account as a person sees it: a name, a face and a line. */
export interface TeamProfile {
  readonly username: string;
  readonly displayName: string;
  readonly bio?: string;
  /** Where the avatar image is, on this server. Absent for an account with none. */
  readonly avatarUrl?: string;
  /** An IANA time zone the person set, such as `Asia/Shanghai`. */
  readonly timezone?: string;
  /** Whether a console or a Studio of theirs is connected now. */
  readonly online?: boolean;
}

/* --------------------------------------------------------- project members */

/**
 * The roles an account may have in a project, most able first.
 *
 * Owners and editors open the repository; reviewers and viewers read the
 * project through Team and never through loreserver, which does not tell a read
 * from a write. An owner may also change who belongs, and may take the project
 * off the list. An operator of the server is the owner of every project.
 */
export const TEAM_PROJECT_ROLES = ["owner", "editor", "reviewer", "viewer"] as const;

export type TeamProjectRole = (typeof TEAM_PROJECT_ROLES)[number];

/**
 * The parts of a project an owner may let an editor change separately: the
 * story (stories, variables, story animations), characters, assets (and audio
 * tracks), the UI, localization (and voice, and the dictionary), and the game's
 * configuration (the project file, brand, variants, DLC, save schema, icons and
 * any file not named elsewhere). Studio's kernel decides which a file is in.
 */
export const TEAM_PROJECT_AREAS = ["story", "characters", "assets", "ui", "localization", "config"] as const;

export type TeamProjectArea = (typeof TEAM_PROJECT_AREAS)[number];

/** One account's place in one project. */
export interface TeamProjectMember {
  readonly username: string;
  readonly displayName: string;
  /** Where the account's avatar is, absent for one with none. */
  readonly avatarUrl?: string;
  readonly role: TeamProjectRole;
  /**
   * For an editor kept to some areas, which ones; absent for an editor who may
   * change all of them, and for every other role. Such an editor reads the
   * project through Team rather than opening its repository.
   */
  readonly areas?: readonly TeamProjectArea[];
  /** Who gave them the role, by username; absent when nobody did, as on an upgrade. */
  readonly addedBy?: string;
  readonly addedAt: number;
}

/** What happened on a project's members topic. */
export type TeamProjectMembersEvent =
  | { readonly kind: "member-set"; readonly member: TeamProjectMember }
  | { readonly kind: "member-removed"; readonly username: string };

/* --------------------------------------------------- permission templates */

/**
 * A named grant: a role, and for an editor the areas it may change. What an
 * owner picks instead of ticking boxes one by one, and what somebody asking for
 * access names. A template is only a shorthand: what is stored is the role and
 * the areas it stands for, and changing the list later changes nobody's grant.
 */
export interface TeamPermissionTemplate {
  readonly id: string;
  readonly role: TeamProjectRole;
  /** For an editor kept to some areas, which ones; absent for all of them. */
  readonly areas?: readonly TeamProjectArea[];
}

/**
 * The templates every Team and every Studio offers, in the order a picker shows
 * them. Their names are the clients' to translate, by `id`.
 */
export const TEAM_PERMISSION_TEMPLATES = [
  { id: "owner", role: "owner" },
  { id: "editor", role: "editor" },
  { id: "writer", role: "editor", areas: ["story", "characters"] },
  { id: "artist", role: "editor", areas: ["characters", "assets", "ui"] },
  { id: "translator", role: "editor", areas: ["localization"] },
  { id: "engineer", role: "editor", areas: ["ui", "config"] },
  { id: "reviewer", role: "reviewer" },
  { id: "viewer", role: "viewer" },
] as const satisfies readonly TeamPermissionTemplate[];

export type TeamPermissionTemplateId = (typeof TEAM_PERMISSION_TEMPLATES)[number]["id"];

/** The template of an id, or undefined for one this build does not know. */
export function teamPermissionTemplate(id: string): TeamPermissionTemplate | undefined {
  return (TEAM_PERMISSION_TEMPLATES as readonly TeamPermissionTemplate[]).find((template) => template.id === id);
}

/**
 * The template a grant is exactly, or undefined when it is none of them. An
 * editor's areas are compared as a set; a list naming every area is all of them.
 */
export function teamTemplateOf(
  role: TeamProjectRole,
  areas?: readonly TeamProjectArea[],
): (TeamPermissionTemplate & { readonly id: TeamPermissionTemplateId }) | undefined {
  const all = (list?: readonly TeamProjectArea[]) => list === undefined || TEAM_PROJECT_AREAS.every((area) => list.includes(area));
  return (TEAM_PERMISSION_TEMPLATES as readonly (TeamPermissionTemplate & { readonly id: TeamPermissionTemplateId })[]).find((template) => {
    if (template.role !== role) return false;
    if (role !== "editor") return true;
    if (all(template.areas) || all(areas)) return all(template.areas) && all(areas);
    const mine = new Set(areas);
    return template.areas?.length === mine.size && template.areas.every((area) => mine.has(area));
  });
}

/* -------------------------------------------------------- access requests */

/**
 * What somebody may ask for: a place in a project, or more of one (`project`),
 * which that project's owners decide; or leave to make projects (`creator`),
 * which the operators decide, and which is only asked for where
 * `project.create_by` is `creators`.
 */
export const TEAM_ACCESS_REQUEST_KINDS = ["project", "creator"] as const;
export type TeamAccessRequestKind = (typeof TEAM_ACCESS_REQUEST_KINDS)[number];

/**
 * `pending` waits on whoever decides; `approved` and `denied` are their answer;
 * `withdrawn` is the person who asked taking it back. Only a pending request
 * changes, and an account has at most one pending request per project (and one
 * to make projects): asking again replaces what it asked before.
 */
export const TEAM_ACCESS_REQUEST_STATUSES = ["pending", "approved", "denied", "withdrawn"] as const;
export type TeamAccessRequestStatus = (typeof TEAM_ACCESS_REQUEST_STATUSES)[number];

/** The longest message a request, or an answer to one, carries, in bytes. */
export const ACCESS_REQUEST_MESSAGE_LIMIT = 1000;

export interface TeamAccessRequest {
  readonly id: number;
  readonly kind: TeamAccessRequestKind;
  /** The project asked about, for a `project` request. */
  readonly project?: string;
  /** Its name, so somebody who cannot see it yet still reads what they asked for. */
  readonly projectName?: string;
  /** Who asked, by username. */
  readonly requester: string;
  readonly requesterName?: string;
  /** For a `project` request: the role asked for, and for an editor its areas (absent for all). */
  readonly role?: TeamProjectRole;
  readonly areas?: readonly TeamProjectArea[];
  /** The template it was asked by, when it was. */
  readonly template?: string;
  /** The role the requester holds now, for a `project` request; absent for none. */
  readonly currentRole?: TeamProjectRole;
  readonly message?: string;
  readonly status: TeamAccessRequestStatus;
  readonly at: number;
  /** Who answered, by username, and when, and what they said. */
  readonly decidedBy?: string;
  readonly decidedAt?: number;
  readonly note?: string;
  /** For an approved `project` request: what was granted, which an owner may have changed. */
  readonly grantedRole?: TeamProjectRole;
  readonly grantedAreas?: readonly TeamProjectArea[];
}

/** A project somebody has no role in, as much as they need to ask to join it. */
export interface TeamDiscoverableProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/* ------------------------------------------------------- administration */

/**
 * What the `admin` methods answer with.
 *
 * Every one of these is a record with named fields, and none of them is shaped
 * by how a terminal would print it: this is what a management panel draws from,
 * and a column width, a joined string or an "n/a" would be a decision about a
 * screen taken in the wrong half of the system. Where Team does not know
 * something the field is absent, which is the same degradation rule everything
 * else on this wire follows.
 */

/**
 * One account, as whoever administers this server reads it.
 *
 * Deliberately more than a member of a project is - which is what
 * `members.list` answers with, and which carries a name, an address and one
 * label. This is the record somebody acts on: it says which groups an account
 * is in rather than only whether those groups amount to an operator, and it
 * says when its tokens were last refused, both of which are an operator's
 * business and nobody else's.
 */
export interface TeamAdminUser {
  /** The stable identifier, which is what a token's subject holds. */
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  /**
   * Every group the account is in, which is the whole of what a role is here.
   *
   * A list rather than one string. A server may put an account in as many
   * groups as it likes, and the one thing a reader must not have to do is take
   * a joined string apart to find out whether a name is in it.
   */
  readonly groups: readonly string[];
  /**
   * Whether those groups make it an operator.
   *
   * Derived from {@link groups} on every read, never stored, and sent beside
   * them so that the label a panel draws and the door this server opens are
   * decided by the same rule.
   */
  readonly operator: boolean;
  /** Whether the account is stopped from signing in or being issued anything. */
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  readonly createdAt: number;
  /**
   * When its tokens were last refused wholesale.
   *
   * Absent for an account nothing has ever done that to, and for one whose last
   * refusal was made before this server kept the moment.
   */
  readonly tokensInvalidatedAt?: number;
  /** The account policy an operator gave it: a template by name, or settings of its own. Absent when none. */
  readonly policy?: { readonly templateId?: string; readonly templateName?: string };
  /**
   * Until when its sign-ins are refused: after too many wrong passwords in a row, or because an
   * operator locked it. Absent while it is not locked. A lock with no end reads as the largest
   * safe integer.
   */
  readonly lockedUntil?: number;
}

/**
 * One of an account's own settings, fixed by an operator.
 *
 * Present means fixed: the account reads it and cannot change it. `value` is what it is fixed
 * to, written onto the account when the policy is applied; absent means fixed at whatever the
 * account has now (a template, which many accounts share, has no one display name to give).
 */
export interface TeamPolicyLock<T> {
  readonly value?: T;
}

/** Whether something may be done: at all, only reading, or not. */
export type TeamPolicyAccess = "on" | "read" | "off";

/**
 * What an operator decided about one account's own settings. Every field is optional, and a
 * field left out leaves that setting to the account.
 */
export interface TeamAccountPolicy {
  readonly displayName?: TeamPolicyLock<string>;
  readonly bio?: TeamPolicyLock<string>;
  /** An IANA zone, or "" for none. */
  readonly timezone?: TeamPolicyLock<string>;
  /** The picture cannot be changed or taken away. */
  readonly lockAvatar?: boolean;
  readonly notificationSwitches?: TeamPolicyLock<TeamNotificationPrefs["switches"]>;
  readonly digest?: TeamPolicyLock<TeamDigestFrequency>;
  /** A personal Feishu or Slack address, or "" for none. */
  readonly hook?: TeamPolicyLock<string>;
  /** Two-step sign-in is asked of this account whatever the server-wide switch says. */
  readonly requireTwoFactor?: boolean;
  /** Personal API tokens: may be made, only read-only ones, or none. "off" and "read" revoke what no longer fits. */
  readonly apiTokens?: TeamPolicyAccess;
  /** The longest an API token may live, in days; a token that never expires is then refused. */
  readonly apiTokenMaxDays?: number;
  /** Keeping Studio's preferences on this server: back up and restore, restore only, or neither. */
  readonly studioConfig?: TeamPolicyAccess;
}

/** A named policy many accounts may follow. Changing it changes it for all of them. */
export interface TeamPolicyTemplate {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly policy: TeamAccountPolicy;
  /** How many accounts follow it. */
  readonly accounts: number;
  readonly updatedAt: number;
}

/** The policy one account is under, as `account.policy` and `admin.users.policy` answer it. */
export interface TeamAccountPolicyView {
  /** What is in force: the template's or the account's own, with the server-wide two-step switch folded in. */
  readonly policy: TeamAccountPolicy;
  readonly template?: { readonly id: string; readonly name: string };
  /** Whether the account has settings of its own rather than a template. */
  readonly custom: boolean;
  /** Whether two-step sign-in is asked of every account on this server. */
  readonly serverRequiresTwoFactor: boolean;
}

/** What this server keeps of one account's Studio preferences. */
export interface TeamStudioConfigStatus {
  readonly access: TeamPolicyAccess;
  /** Absent when nothing has been put there. */
  readonly stored?: { readonly size: number; readonly updatedAt: number; readonly studioVersion?: string; readonly sha256: string };
}

/** The largest Studio preferences document this server keeps. */
export const STUDIO_CONFIG_MAX_BYTES = 1024 * 1024;

/** Where Studio puts and reads its preferences document. */
export const STUDIO_CONFIG_PATH = "/api/team/v1/studio-config";

/**
 * One line of what this server keeps in its settings.
 *
 * `editable` false means the value can be shown but not changed, and asking to
 * change it must do nothing: the identity settings and the ports are named on
 * the command line that started the server, and offering to change a value that
 * would be thrown away is worse than refusing, because it looks like it worked.
 */
export interface TeamAdminSetting {
  /** Which heading this row belongs under. */
  readonly group: string;
  /**
   * What the row is called.
   *
   * The key as well as the caption: a row is found by its position and written
   * by the setting this label stands for, so it is matched rather than only
   * displayed.
   */
  readonly label: string;
  readonly value: string;
  /**
   * The number `value` was written from, where it was written from one.
   *
   * Present on the two token lifetimes and nowhere else. `value` is a duration
   * in words, and a reader that wanted the number back would have to take those
   * words apart again - in whatever language they were written in. Sending both
   * is cheaper than making everybody parse one.
   */
  readonly seconds?: number;
  /**
   * Whether somebody chose this value, or a default is answering for a setting
   * nobody has touched.
   *
   * The difference is real rather than cosmetic, which is why it is on the wire
   * and not worked out from the value: a server that never chose follows a
   * later version of Team when the default moves, and one that chose keeps what
   * it was given. It is what a panel shows beside a value, and it is the word a
   * person needs before deciding whether a number is theirs.
   *
   * Absent on a row that has no such distinction - the identity settings, the
   * ports, the fingerprint - which are named on the command line the server was
   * started with and have no default answering for them. Those are the rows
   * `editable` is false on.
   */
  readonly stored?: boolean;
  readonly editable: boolean;
  /**
   * The change is written now and takes effect when loreserver is next started.
   *
   * Said out loud because a setting that silently did not apply is worse than
   * one that could not be changed.
   */
  readonly restartRequired?: boolean;
  /** Why this value is worth thinking about, shown when it is being changed. */
  readonly caution?: string;
}

/**
 * One signing key this server holds.
 *
 * The public half of it and nothing else. A `kid` is an RFC 7638 thumbprint of
 * the public key, so it identifies a key without being derived from anything
 * secret, and it is what a token names in its header.
 */
export interface TeamAdminKey {
  readonly kid: string;
  /** Position in the sequence of keys; the highest is the newest. */
  readonly serial: number;
  /**
   * True for a key that is kept but no longer published or used.
   *
   * A retired key verifies nothing: it is on this list so that an operator can
   * see a rotation happened rather than have a key disappear.
   */
  readonly retired: boolean;
  /**
   * Whether new tokens are signed with this one, which is true of at most one.
   *
   * The newest key that has not been retired signs, while every key that has
   * not been retired is published - which is what makes a rotation invisible to
   * anybody already holding a token.
   */
  readonly signing: boolean;
}

/** One decision this server was asked to make, as its log recorded it. */
export interface TeamAdminDecision {
  /** The row's own key, which is what a list of otherwise identical rows is keyed on. */
  readonly id: number;
  readonly at: number;
  /** Who asked, or the word for a caller that presented nothing this server could read. */
  readonly username: string;
  /** The project's name where this server knew it, and the resource id where it did not. */
  readonly resource: string;
  readonly allowed: boolean;
  /** The short reason, as the log line says it: `owner`, `no grant`, `expired`. */
  readonly detail: string;
}

/**
 * What this server is, as of the moment it was last worked out.
 *
 * **Gathered when somebody asks and cached for a stated moment, never on a
 * timer.** Two of the parts are expensive - the health check is a request to
 * another server, and measuring the store can stat tens of thousands of files -
 * so this carries {@link gatheredAt} and {@link freshnessMs} rather than
 * pretending to be live: a panel says "as of" and is telling the truth, where
 * one that showed a clock would be showing when it asked rather than when the
 * answer was true.
 */
export interface TeamAdminStatus {
  /** The moment the answer below was worked out. */
  readonly gatheredAt: number;
  /**
   * How long an answer is served before it is worked out again.
   *
   * Sent rather than assumed, so that a panel deciding how often to ask is
   * reading this server's number instead of guessing at one.
   */
  readonly freshnessMs: number;
  /** This server's own version. */
  readonly version: string;
  /** The storage root everything this server writes is underneath. */
  readonly root: string;
  readonly loreserver: TeamAdminLoreserver;
  readonly reach: TeamAdminReach;
  /** How many accounts exist. */
  readonly accounts: number;
  /** How many projects are on the list. */
  readonly projects: number;
  /** How many decisions are on record, which is bounded by this server. */
  readonly decisions: number;
  /** How many signing keys are published, retired ones not counted. */
  readonly signingKeys: number;
}

/**
 * The server beside this one, as far as this one can see it.
 *
 * What is here is what a second program can see over a socket: whether it
 * answered, the version this build pins, and what its store weighs. The
 * process itself - its pid, when it started, how often it has been restarted -
 * belongs to whatever is supervising it, and a number invented for those would
 * read as a fact.
 */
export interface TeamAdminLoreserver {
  /** The version this build of Team pins and installs. */
  readonly version: string;
  /** Whether it answered its health check when this was gathered. */
  readonly healthy: boolean;
  /** Where it keeps what it holds. */
  readonly storageRoot: string;
  /**
   * What that store weighs.
   *
   * Absent rather than nought where it could not be added up - a store too
   * large to walk, or one that is not there yet. A partial total looks exactly
   * like a real one, and a store that appeared to halve would read as a store
   * that had lost half of what was in it.
   */
  readonly storageBytes?: number;
}

/** The addresses somebody has to be told in order to reach this server. */
export interface TeamAdminReach {
  /** Where a person signs in. */
  readonly signIn: string;
  /** Where a repository is cloned from. */
  readonly data: string;
  /** This server's certificate authority, which is what a client compares once. */
  readonly fingerprint: string;
  /**
   * Ports bound to the loopback, which nobody off this machine can reach.
   *
   * Listed so that an operator diagnosing a port that is already taken can see
   * what this server is holding without reading its command line.
   */
  readonly loopback: ReadonlyArray<{ readonly port: number; readonly what: string }>;
}

/**
 * A sign-in token minted for somebody else, and the one answer on this wire
 * that carries a credential.
 *
 * It is what a person is handed so that they can sign in for the first time,
 * minted by an operator who does not know their password and does not need to:
 * whoever can disable the account can hardly be stopped from issuing it a
 * token.
 *
 * **The token is shown once and kept nowhere.** Not in this server's log, not
 * in its database, not in the note it keeps of the write. A person who lost it
 * is minted another.
 */
export interface TeamAdminMintedToken {
  /** The account it is for, by name. */
  readonly username: string;
  /** When it expires, in milliseconds since the epoch, as every other time here is. */
  readonly expiresAt: number;
  /**
   * The token itself — **absent on a repeat**.
   *
   * A client id makes a mint safe to send twice, and what "safe" means here is
   * that the second one mints nothing: a token nobody received is a live
   * credential nobody can account for. So a repeat is answered with the account
   * and the expiry of the mint that did happen, and with no token, because this
   * server did not keep the one it made. A caller that lost the answer mints
   * again under a new client id.
   */
  readonly token?: string;
}

/**
 * What happened on the `admin/users` topic.
 *
 * Every one of these carries the whole account rather than its name, so that a
 * panel updates the row it is already holding instead of re-reading a page to
 * find out what changed — which is the same bargain every write in this family
 * strikes by answering with the record rather than with an acknowledgement.
 */
export type TeamAdminUsersEvent =
  | TeamSubscriptionWithdrawn
  | { readonly kind: "user-created"; readonly user: TeamAdminUser }
  | { readonly kind: "user-disabled"; readonly user: TeamAdminUser }
  | { readonly kind: "user-enabled"; readonly user: TeamAdminUser }
  | { readonly kind: "user-granted-admin"; readonly user: TeamAdminUser }
  | { readonly kind: "user-creator-set"; readonly user: TeamAdminUser }
  | { readonly kind: "user-revoked-admin"; readonly user: TeamAdminUser }
  | { readonly kind: "user-tokens-revoked"; readonly user: TeamAdminUser }
  | { readonly kind: "user-locked"; readonly user: TeamAdminUser }
  | { readonly kind: "user-unlocked"; readonly user: TeamAdminUser }
  | { readonly kind: "user-updated"; readonly user: TeamAdminUser }
  /** The account is gone from the list; only its id and name are left, for the history that holds them. */
  | { readonly kind: "user-deleted"; readonly id: string; readonly username: string };

/** What happened on the `admin/settings` topic. */
export type TeamAdminSettingsEvent =
  | TeamSubscriptionWithdrawn
  | { readonly kind: "setting-changed"; readonly setting: TeamAdminSetting };

/**
 * What happened on the `admin/keys` topic.
 *
 * The list rather than the key that changed: a rotation changes which key
 * signs, so the row for the key before it changes too, and sending one row
 * would leave a panel holding a list with two keys claiming to sign.
 *
 * The same list `admin.keys.list` answers with, bounded the same way and with
 * the same `total` beside it — a topic is not somewhere a cursor can go, so an
 * event that carried more than the answer does would be the bound going out by
 * the front door and back in through the window.
 *
 * A rotation and a retirement carry exactly the same payload, and that is what
 * makes them safe to handle as one thing: a client that replaces the list it
 * holds with `keys` is correct afterwards without having had to work out which
 * of the two it was told about. The kinds differ only so that a panel wanting
 * to say what happened has something to say it from.
 */
export type TeamAdminKeysEvent =
  | TeamSubscriptionWithdrawn
  | {
      readonly kind: "keys-rotated";
      readonly keys: readonly TeamAdminKey[];
      /** Every key this server holds, whatever the ceiling on the list left out. */
      readonly total: number;
    }
  | {
      readonly kind: "key-retired";
      readonly keys: readonly TeamAdminKey[];
      /** Unmoved by a retirement, which keeps the key's file rather than deleting it. */
      readonly total: number;
    };

/** What happened on the `admin/refusals` topic. Read what that topic is named for. */
export type TeamAdminRefusalsEvent =
  | TeamSubscriptionWithdrawn
  | { readonly kind: "decision-refused"; readonly decision: TeamAdminDecision };

/**
 * A subscription this server has taken back, said on the topic it is taking.
 *
 * An ordinary event rather than a frame of its own, so that a client which has
 * never heard of it does what it does with any event kind it does not know, and
 * an older one is not left holding a frame it has no name for.
 *
 * Two kinds of topic carry this, each for one reason: an `admin/*` topic when
 * the account holding it stopped being an operator, and a `project:*` topic
 * when the account was taken out of that project. A topic is judged when it is
 * taken and a token stays perfectly valid across either change, so without this
 * the account would go on being told until it happened to reconnect. The
 * session itself stays open and keeps everything else it subscribed to.
 */
export interface TeamSubscriptionWithdrawn {
  readonly kind: "subscription-withdrawn";
  readonly topic: string;
  /** Why, in English, for a log. What a person reads is written by the client. */
  readonly why: string;
}

/* -------------------------------------------------------- method names */

/**
 * Every method, as one list.
 *
 * The names a client checks against: a name here that no module answers is a name
 * Studio would call and be refused. The server asserts at startup that the
 * registered handlers, these names and the contract all agree.
 */
export const TEAM_METHODS = {
  /** Every project on this server. */
  projectsList: "projects.list",
  /** One project, and what has been read out of its repository. */
  projectsGet: "projects.get",
  /** A page of one project's revisions, newest first. */
  projectsHistory: "projects.history",
  /** Make a project, or register a repository the author already has. */
  projectsCreate: "projects.create",
  /**
   * Take a project off this server's list, leaving its repository untouched. Its
   * owners, or the operators alone where `project.delete_by` says so.
   */
  projectsForget: "projects.forget",
  /** Who belongs to one project, and in which role. Any member may ask. */
  projectsMembersList: "projects.members.list",
  /**
   * Give an account a role in a project, or change it, and for an editor the
   * areas it may change (`areas`: a list, or null for all), or both at once by
   * a permission `template`. Owners only.
   */
  projectsMembersSet: "projects.members.set",
  /** Take an account out of a project. Owners only; never the last owner. */
  projectsMembersRemove: "projects.members.remove",
  /**
   * The projects the caller has no role in, by name, so it can ask to join one.
   */
  projectsDiscover: "projects.discover",
  /**
   * The caller's own access requests, and those it decides on (a project's
   * owners its requests; the operators every one). Pending ones unless `all`.
   */
  accessRequestsList: "access.requests.list",
  /**
   * Ask for a place in a project or more of one (`kind: "project"`, by
   * `template` or `role` and `areas`), or for leave to make projects
   * (`kind: "creator"`). Replaces the caller's own pending request for the same.
   */
  accessRequestsCreate: "access.requests.create",
  /**
   * Approve or deny a pending request, with a `note`. A project's owner may
   * grant something other than what was asked, by `template` or `role` and `areas`.
   */
  accessRequestsDecide: "access.requests.decide",
  /** Take back one's own pending request. */
  accessRequestsWithdraw: "access.requests.withdraw",
  /** Change a project's name, description, or who may save and restore its versions. Owners only. */
  projectsUpdate: "projects.update",
  /** The webhooks that post one project's events. Its owners. */
  projectsWebhooksList: "projects.webhooks.list",
  /** Add one for the project; answers its signing secret, once. Its owners. */
  projectsWebhooksCreate: "projects.webhooks.create",
  /** Remove one of the project's. Its owners. */
  projectsWebhooksDelete: "projects.webhooks.delete",
  /** Post a test event to one of the project's now. Its owners. */
  projectsWebhooksTest: "projects.webhooks.test",
  /** The latest deliveries of one of the project's webhooks. Its owners. */
  projectsWebhooksDeliveries: "projects.webhooks.deliveries",
  /** Send one of those deliveries again. Its owners. */
  projectsWebhooksRedeliver: "projects.webhooks.redeliver",
  /** Every account, as a name beside a piece of work. */
  membersList: "members.list",
  /** The devices the caller is signed in on through the browser sign-in. */
  accountDevicesList: "account.devices.list",
  /** Sign one of the caller's own devices out, refusing its tokens at once. */
  accountDevicesRevoke: "account.devices.revoke",
  /** An account's profile: name, face, line. */
  accountProfileGet: "account.profile.get",
  /** Change the caller's own display name or line. */
  accountProfileUpdate: "account.profile.update",
  /** A page of what happened, for one account or one project, newest first. */
  activityList: "activity.list",
  /** How much one account did each day, for a contribution graph. */
  activityHeatmap: "activity.heatmap",
  /** The caller's to-dos, or one project's. */
  todosList: "todos.list",
  /** Review requests in a project, or those the caller asked for or is asked. */
  reviewsList: "reviews.list",
  /** Ask somebody to review a range of revisions. */
  reviewsCreate: "reviews.create",
  /** Give a verdict (the reviewer), or withdraw (the requester). */
  reviewsUpdate: "reviews.update",
  /** A page of a project's channel, newest first. */
  chatList: "chat.list",
  /** Write in a project's channel. Members who may comment. */
  chatSend: "chat.send",
  /** Take back one's own message. */
  chatDelete: "chat.delete",
  /** A project's milestones, newest first. */
  milestonesList: "milestones.list",
  /** Put a name on a revision. Owners and editors. */
  milestonesCreate: "milestones.create",
  /** Take a name off. Owners, or whoever put it there. */
  milestonesDelete: "milestones.delete",
  /** Change a milestone's name, note, due date or gate. Owners, or whoever put it there. */
  milestonesUpdate: "milestones.update",
  /** Where every scene and asset of a project stands. */
  approvalsList: "approvals.list",
  /** Move one: editors to draft or pending, reviewers and owners to approved or changes. */
  approvalsSet: "approvals.set",
  /** Every change one scene or asset went through, oldest first. */
  approvalsHistory: "approvals.history",
  /** Who holds which of a project's assets, and until when. */
  assetsLocks: "assets.locks",
  /** Hold an asset for a while. Editors who may change assets. */
  assetsLock: "assets.lock",
  /** Let go of one: its holder, a project owner, or an operator. */
  assetsUnlock: "assets.unlock",
  /** The caller's saved filters, optionally for one list. */
  filtersList: "filters.list",
  /** Save a filter under a name, replacing one of that name. */
  filtersSave: "filters.save",
  /** Forget a saved filter. */
  filtersDelete: "filters.delete",
  /** A project's builds, newest first. Uploading one is an HTTP PUT, not a call. */
  buildsList: "builds.list",
  /** Change a build's name, note, revision, platform, or make it the one to play. Editors and owners. */
  buildsUpdate: "builds.update",
  /** Remove a build and its file. Owners, or whoever uploaded it. */
  buildsDelete: "builds.delete",
  /** Take a picture away from beside its comment. Whoever put it there, or an owner. */
  attachmentsDelete: "attachments.delete",
  /** A project's share links. Owners. */
  sharesList: "shares.list",
  /** Make a share link; the answer carries the token, which is never shown again. Owners. */
  sharesCreate: "shares.create",
  /** Stop a share link working. Owners. */
  sharesRevoke: "shares.revoke",
  /** The webhooks this server posts to. Operators. */
  adminWebhooksList: "admin.webhooks.list",
  /** Add one; answers its signing secret, once. Operators. */
  adminWebhooksCreate: "admin.webhooks.create",
  /** Remove one. Operators. */
  adminWebhooksDelete: "admin.webhooks.delete",
  /** Post a test event to one now and answer how it went. Operators. */
  adminWebhooksTest: "admin.webhooks.test",
  /** The latest deliveries of one webhook. Operators. */
  adminWebhooksDeliveries: "admin.webhooks.deliveries",
  /** Send a delivery again. Operators. */
  adminWebhooksRedeliver: "admin.webhooks.redeliver",
  /** Make a to-do. */
  todosCreate: "todos.create",
  /** Change a to-do: its status, its assignee, its words. */
  todosUpdate: "todos.update",
  /** Delete a to-do. Its owner only. */
  todosDelete: "todos.delete",
  /** The caller's notifications, newest first. */
  notificationsList: "notifications.list",
  /** Mark notifications read. */
  notificationsRead: "notifications.read",
  /** The caller's notification switches, digest frequency and personal address. */
  notificationsPrefs: "notifications.prefs",
  /** Change some of them. */
  notificationsPrefsSet: "notifications.prefs.set",
  /** Post a line to the caller's personal Feishu or Slack address now, and answer how it went. */
  notificationsHookTest: "notifications.hook.test",
  /** Send the caller their digest now, whatever the frequency says. */
  notificationsDigestNow: "notifications.digest.now",
  /** This server's VAPID public key, for `PushManager.subscribe`. */
  pushKey: "push.key",
  /** Ask for this browser to be pushed to. */
  pushSubscribe: "push.subscribe",
  /** Stop pushing to one browser. */
  pushUnsubscribe: "push.unsubscribe",
  /** Push a test notification to every browser of the caller's, and answer how many it reached. */
  pushTest: "push.test",
  /** What the caller follows, optionally in one project. */
  watchesList: "watches.list",
  /** Follow a project or a scene, or stop. */
  watchesSet: "watches.set",
  /** The reactions on some of a project's comments or chat messages. */
  reactionsList: "reactions.list",
  /** Put an emoji on a comment or a message, or take it back. */
  reactionsToggle: "reactions.toggle",
  /** Mail a test letter to an address with the stored SMTP settings, and answer what the server said. Operators. */
  adminEmailTest: "admin.email.test",
  /** A project's glossary. */
  glossaryList: "glossary.list",
  /** Add a term to a project's glossary, or change one. Whoever may edit the project's localization. */
  glossarySet: "glossary.set",
  /** Take a term out of a project's glossary. */
  glossaryDelete: "glossary.delete",
  /** Where a project's voiced lines stand, optionally in one language. */
  voiceList: "voice.list",
  /** Mark some lines of one language recorded, needing a retake, or not recorded. */
  voiceSet: "voice.set",
  /** The project templates on this server. */
  templatesList: "templates.list",
  /** Keep a project template, new or changed; or make one from a project as it stands. */
  templatesSave: "templates.save",
  /** Take a project template away. */
  templatesDelete: "templates.delete",
  /** Put a template's members, milestones and to-dos into a project. Its owners. */
  templatesApply: "templates.apply",
  /** The threads anchored in one project, newest activity first. */
  threadsList: "threads.list",
  /** One thread and every comment in it. */
  threadsGet: "threads.get",
  /** Open a thread on an anchor, with its first comment. */
  threadsCreate: "threads.create",
  /** Add a comment to a thread. */
  threadsReply: "threads.reply",
  /** Mark a thread resolved, or open it again. */
  threadsResolve: "threads.resolve",
  /** Change the wording of one's own comment. */
  commentsEdit: "comments.edit",
  /** Withdraw one's own comment, leaving the shape of the conversation. */
  commentsDelete: "comments.delete",
  /** Say which installation this is, and what it has open. */
  clientsAnnounce: "clients.announce",
  /** Take one window's presence back, because it closed while the session stayed open. */
  clientsWithdraw: "clients.withdraw",
  /** Which installations are connected, optionally only those on one project. */
  clientsList: "clients.list",
  /**
   * Answer at once with this server's clock, echoing `sent` when given: what a client times to
   * show how far away the server is. Touches nothing, so it is cheap enough to ask every few seconds.
   */
  serverPing: "server.ping",
  /** The live sessions open on one project. */
  liveList: "live.list",
  /** Open one, and be its first member. */
  liveOpen: "live.open",
  /** Join one somebody else opened. */
  liveJoin: "live.join",
  /** Leave one. The last one out closes it. */
  liveLeave: "live.leave",
  /** Close one outright, which only its opener may do. */
  liveClose: "live.close",
  /** Change how one may be joined, which only its opener may do. */
  liveRule: "live.rule",
  /**
   * Which room a passcode names, without joining it.
   *
   * **The one live method that does not need the caller to have the project
   * open**, and that is the whole reason it exists rather than being folded into
   * `live.join`: somebody who was read four digits may not have the project at
   * all, and what they need first is to learn which project it is so they can go
   * and get it. Having the code is the entitlement; the room record is the answer.
   */
  liveByCode: "live.byCode",
  /** Ask to be let into a `request` room. */
  liveRequestJoin: "live.requestJoin",
  /** Answer somebody who asked, which only the room's opener may do. */
  liveAnswerJoin: "live.answerJoin",
  /** Say something to everybody in one. Kept by nobody. */
  liveSay: "live.say",
  /**
   * Where a project's documents stand: the last applied seq, the last saved
   * version, the kernel this server applies with. Loads the authority.
   */
  docHead: "doc.head",
  /** The applied edits after a seq, oldest first, a page at a time. */
  docEffects: "doc.effects",
  /**
   * The files of the last saved version and the seq they stand at: what a Studio that does not
   * know where it stands starts from, before following the log. A file comes a chunk at a time.
   */
  docBase: "doc.base",
  /** The project documents of one saved version, a file and a chunk at a time: for previewing and comparing. */
  docFiles: "doc.files",
  /**
   * One file as the project holds it right now, with the seq it stands at, a chunk at a time: how a
   * Studio puts back a file it could not keep in step - one its author's offline copy collided on.
   */
  docFile: "doc.file",
  /** Ask for one edit; answered with the effect every Studio applies, or a refusal. */
  docIntent: "doc.intent",
  /** Save what the project holds now as a history version. */
  docSnapshot: "doc.snapshot",
  /** Put one revision back as the current state, as a new version. */
  docRestore: "doc.restore",
  /** What is attached to one project, and what this server last read its head to be. */
  overlayList: "overlay.list",
  /** Attach something, or replace something one attached before. */
  overlayPut: "overlay.put",
  /** Take one's own record off again. */
  overlayDrop: "overlay.drop",
  /** The team projects this server holds in memory, and how each one's log and versions stand. Operators. */
  adminDocumentsStatus: "admin.documents.status",
  /** A page of this server's accounts, newest first. */
  adminUsersList: "admin.users.list",
  /** Make an account, and answer with it. */
  adminUsersCreate: "admin.users.create",
  /** Stop an account being issued anything, and refuse what it already holds. */
  adminUsersDisable: "admin.users.disable",
  /** Let a disabled account sign in again. */
  adminUsersEnable: "admin.users.enable",
  /** Let an account administer this server. */
  adminUsersGrantAdmin: "admin.users.grantAdmin",
  /** Stop an account administering this server. Never the last one. */
  adminUsersRevokeAdmin: "admin.users.revokeAdmin",
  /** Refuse every token an account already holds, without disabling it. */
  adminUsersRevokeTokens: "admin.users.revokeTokens",
  /** Let an account make projects where `project.create_by` is `creators`, or stop it (`creator`). */
  adminUsersSetCreator: "admin.users.setCreator",
  /** Mint a sign-in token for an account, without knowing its password. */
  adminTokensMint: "admin.tokens.mint",
  /** Everything this server keeps in its settings, and which of it may be changed. */
  adminSettingsList: "admin.settings.list",
  /** Change one setting, found by the label the settings list gives it. */
  adminSettingsSet: "admin.settings.set",
  /** Every signing key this server holds, published and retired. */
  adminKeysList: "admin.keys.list",
  /** Generate a signing key and sign with it from now on. */
  adminKeysRotate: "admin.keys.rotate",
  /** Stop publishing one key, refusing every token it signed. Never the one that signs. */
  adminKeysRetire: "admin.keys.retire",
  /** A page of the decisions this server has been asked to make, newest first. */
  adminAuditList: "admin.audit.list",
  /** What this server is and what it can reach, as of the moment it was gathered. */
  adminServerStatus: "admin.server.status",
  /** Set or clear the team's accent colour. The logo is uploaded over HTTP. */
  adminBrandSet: "admin.brand.set",
  /** Whether the caller has two-step sign-in, is setting it up, and how many recovery codes are left. */
  accountTotpStatus: "account.totp.status",
  /** Start setting two-step sign-in up: a new secret and its otpauth address, not yet in force. */
  accountTotpBegin: "account.totp.begin",
  /** Put it in force with a code from the app; answers ten recovery codes, once. */
  accountTotpConfirm: "account.totp.confirm",
  /** Turn it off, with a current code or a recovery code. */
  accountTotpDisable: "account.totp.disable",
  /** Ten new recovery codes, with a current code; the old ones stop working. */
  accountTotpRecovery: "account.totp.recovery",
  /** The caller's API tokens, without the tokens themselves. */
  accountTokensList: "account.tokens.list",
  /** Make an API token; the token is in this answer and never again. */
  accountTokensCreate: "account.tokens.create",
  /** Revoke one of the caller's API tokens. */
  accountTokensRevoke: "account.tokens.revoke",
  /** Archive a project: read-only, and out of lists unless they ask for archived ones. Owners. */
  projectsArchive: "projects.archive",
  /** Bring an archived project back. Owners. */
  projectsRestore: "projects.restore",
  /** How much one project keeps on this server, and its quota. Members. */
  projectsStorage: "projects.storage",
  /** A one-time link, good for a day, that sets a new password for an account. Operators. */
  adminUsersResetLink: "admin.users.resetLink",
  /** Take two-step sign-in off an account that lost its phone and its codes. Operators. */
  adminUsersResetTwoFactor: "admin.users.resetTwoFactor",
  /** How much every project keeps, against the quota. Operators. */
  adminStorageList: "admin.storage.list",
  /** The backups this server has made, newest first. Operators. */
  adminBackupsList: "admin.backups.list",
  /** Make a backup now. Operators. */
  adminBackupsCreate: "admin.backups.create",
  /** The account policy the caller is under. */
  accountPolicy: "account.policy",
  /** What this server keeps of the caller's Studio preferences, and whether they may keep any. */
  accountStudioConfig: "account.studioConfig",
  /** Throw away the caller's Studio preferences kept here. */
  accountStudioConfigDelete: "account.studioConfig.delete",
  /** The policy templates, with how many accounts follow each. Operators. */
  adminPoliciesList: "admin.policies.list",
  /** Make a policy template, or change one (and every account that follows it). Operators. */
  adminPoliciesSave: "admin.policies.save",
  /** Remove a template; the accounts that followed it keep its settings as their own. Operators. */
  adminPoliciesDelete: "admin.policies.delete",
  /** The policy one account is under. Operators. */
  adminUsersPolicy: "admin.users.policy",
  /** Put accounts under a template, give them settings of their own, or clear their policy. Operators. */
  adminUsersPolicySet: "admin.users.policySet",
  /**
   * Delete an account for good. Its name and row stay for the history that names it; its
   * password, profile, sessions, tokens and memberships go, and it never signs in again. Not
   * the caller's own account, nor the last operator. Operators.
   */
  adminUsersDelete: "admin.users.delete",
  /** Refuse an account's sign-ins, for `minutes` or until unlocked. Operators. */
  adminUsersLock: "admin.users.lock",
  /** Lift a lock, whether an operator put it on or wrong passwords did. Operators. */
  adminUsersUnlock: "admin.users.unlock",
  /** Change another account's display name or email address. Operators. */
  adminUsersUpdate: "admin.users.update",
} as const;

export type TeamMethodName = (typeof TEAM_METHODS)[keyof typeof TEAM_METHODS];

/* --------------------------------------------------------------- contract */

/**
 * The whole contract, as one serialisable object.
 *
 * This is what `contract.json` is generated from and what the server's
 * boot-time check reads: the frame catalogue, the method names, the capability
 * vocabulary, the error codes, the topic patterns, the limits and the protocol
 * number, each taken from the constant above it rather than written a second
 * time. A `{project}` or `{session}` in a topic pattern is where an id goes.
 */
export const CONTRACT = {
  protocol: TEAM_PROTOCOL_VERSION,
  socketPath: TEAM_SOCKET_PATH,
  capabilities: TEAM_CAPABILITIES,
  errorCodes: TEAM_ERROR_CODES,
  methods: Object.values(TEAM_METHODS),
  topics: {
    projects: TOPIC_PROJECTS,
    project: "project:{project}",
    projectThreads: "project:{project}/threads",
    projectOverlay: "project:{project}/overlay",
    projectClients: "project:{project}/clients",
    projectLive: "project:{project}/live",
    projectMembers: "project:{project}/members",
    projectTodos: "project:{project}/todos",
    projectReviews: "project:{project}/reviews",
    projectMilestones: "project:{project}/milestones",
    projectApprovals: "project:{project}/approvals",
    projectLocks: "project:{project}/locks",
    projectBuilds: "project:{project}/builds",
    projectChat: "project:{project}/chat",
    projectDoc: "project:{project}/doc",
    accountTodos: "account:{account}/todos",
    accountNotifications: "account:{account}/notifications",
    live: "live:{session}",
    adminUsers: TOPIC_ADMIN_USERS,
    adminSettings: TOPIC_ADMIN_SETTINGS,
    adminKeys: TOPIC_ADMIN_KEYS,
    adminRefusals: TOPIC_ADMIN_REFUSALS,
  },
  permissionTemplates: TEAM_PERMISSION_TEMPLATES,
  frames: {
    fromServer: TEAM_SERVER_FRAME_KINDS,
    fromClient: TEAM_CLIENT_FRAME_KINDS,
  },
  limits: {
    anchorField: ANCHOR_FIELD_LIMIT,
    commentBody: COMMENT_BODY_LIMIT,
    chatBody: CHAT_BODY_LIMIT,
    accessRequestMessage: ACCESS_REQUEST_MESSAGE_LIMIT,
    suggestion: SUGGESTION_LIMIT,
    overlayBody: OVERLAY_BODY_LIMIT,
    livePayload: LIVE_PAYLOAD_LIMIT,
    docIntent: DOC_INTENT_LIMIT,
    instanceField: INSTANCE_FIELD_LIMIT,
    pageBytes: PAGE_BYTES_LIMIT,
    answerBytes: ANSWER_BYTES_LIMIT,
  },
} as const;
