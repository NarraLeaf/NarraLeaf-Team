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
 * **Every name here is a statement about the build and none of them is about the
 * caller.** `admin` is where that is easiest to misread: it says this server can
 * be administered over the socket, not that whoever is reading it may. Which of
 * those two a client is holding is a different question, answered by
 * {@link TeamAccount.operator} in the same `hello` frame.
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
  /** A project's revisions may be read a page at a time. */
  "project-history",
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
 * The three topics a management surface listens on.
 *
 * **Every one of them is refused to anybody who is not an operator**, which no
 * other topic on this server is: the rest are about projects, and every account
 * reaches every project. See the note on `admin/*` in src/team/topics.ts.
 */

/** An account was made, disabled, enabled, given or denied administration, or had its tokens refused. */
export const TOPIC_ADMIN_USERS = "admin/users";

/** A setting of this server changed. */
export const TOPIC_ADMIN_SETTINGS = "admin/settings";

/** This server rotated its signing keys. */
export const TOPIC_ADMIN_KEYS = "admin/keys";

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
}

export interface TeamLiveMember {
  readonly instance: string;
  readonly account: string;
  readonly label: string;
  readonly joinedAt: number;
}

/** What happened on a project's live topic. */
export type TeamLiveEvent =
  | { readonly kind: "live-opened"; readonly session: TeamLiveSession }
  | { readonly kind: "live-changed"; readonly session: TeamLiveSession }
  | { readonly kind: "live-closed"; readonly session: string };

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
  | { readonly kind: "comment-updated"; readonly thread: string; readonly comment: TeamComment };

/** What happened on the projects topic. */
export type TeamProjectsEvent =
  | { readonly kind: "project-created"; readonly project: string }
  | { readonly kind: "project-forgotten"; readonly project: string }
  /** This server read a repository again, so what it says about it may have changed. */
  | { readonly kind: "project-read"; readonly project: string };

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
}

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
  | { readonly kind: "user-created"; readonly user: TeamAdminUser }
  | { readonly kind: "user-disabled"; readonly user: TeamAdminUser }
  | { readonly kind: "user-enabled"; readonly user: TeamAdminUser }
  | { readonly kind: "user-granted-admin"; readonly user: TeamAdminUser }
  | { readonly kind: "user-revoked-admin"; readonly user: TeamAdminUser }
  | { readonly kind: "user-tokens-revoked"; readonly user: TeamAdminUser };

/** What happened on the `admin/settings` topic. */
export type TeamAdminSettingsEvent =
  | { readonly kind: "setting-changed"; readonly setting: TeamAdminSetting };

/**
 * What happened on the `admin/keys` topic.
 *
 * The whole list rather than the key that was made: a rotation changes which
 * key signs, so the row for the key before it changes too, and sending one row
 * would leave a panel holding a list with two keys claiming to sign.
 */
export type TeamAdminKeysEvent =
  | { readonly kind: "keys-rotated"; readonly keys: readonly TeamAdminKey[] };

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
  /** Take a project off this server's list, leaving its repository untouched. */
  projectsForget: "projects.forget",
  /** Every account, as a name beside a piece of work. */
  membersList: "members.list",
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
  /** Say something to everybody in one. Kept by nobody. */
  liveSay: "live.say",
  /** What is attached to one project, and what this server last read its head to be. */
  overlayList: "overlay.list",
  /** Attach something, or replace something one attached before. */
  overlayPut: "overlay.put",
  /** Take one's own record off again. */
  overlayDrop: "overlay.drop",
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
  /** A page of the decisions this server has been asked to make, newest first. */
  adminAuditList: "admin.audit.list",
  /** What this server is and what it can reach, as of the moment it was gathered. */
  adminServerStatus: "admin.server.status",
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
    live: "live:{session}",
    adminUsers: TOPIC_ADMIN_USERS,
    adminSettings: TOPIC_ADMIN_SETTINGS,
    adminKeys: TOPIC_ADMIN_KEYS,
  },
  frames: {
    fromServer: TEAM_SERVER_FRAME_KINDS,
    fromClient: TEAM_CLIENT_FRAME_KINDS,
  },
  limits: {
    anchorField: ANCHOR_FIELD_LIMIT,
    commentBody: COMMENT_BODY_LIMIT,
    suggestion: SUGGESTION_LIMIT,
    overlayBody: OVERLAY_BODY_LIMIT,
    livePayload: LIVE_PAYLOAD_LIMIT,
    instanceField: INSTANCE_FIELD_LIMIT,
  },
} as const;
