/**
 * The Team protocol: what a Studio installation and this server say to each other.
 *
 * Until now the whole conversation was authentication and a repository address.
 * Everything an author actually did happened in Lore, and everything this server
 * knew was answered one request at a time to whoever asked. That is enough for a
 * list of projects and nothing else: work somebody else did arrives when a person
 * reopens a screen, and there is nowhere below a project to put anything.
 *
 * So there is a second thing on the wire now, and it is a **session** rather than
 * a request. One connection per Studio installation, authenticated once, over
 * which either side may speak: Studio makes calls and subscribes to topics, and
 * this server answers calls and pushes events on those topics. The five things
 * the REST API already answers stay exactly where they are, for the Studio builds
 * that only know about those.
 *
 * Three properties of this file are load-bearing, and each is written here rather
 * than in the code that uses it so that both halves of the conversation read the
 * same page:
 *
 *  1. **It is additive.** The discovery document's `protocol` does not move. An
 *     older Studio never opens this socket, never hears of these methods, and
 *     loses nothing. What tells a newer Studio that this is here is a capability
 *     name, matched literally, exactly as the existing five are.
 *
 *  2. **Anchors are opaque.** A comment is attached to a place in a project, and
 *     that place is named in Studio's terms: a document inside the project, an
 *     element inside the document. This server stores those strings, indexes on
 *     them and hands them back. It never parses one, never checks one against a
 *     repository, and never needs upgrading because Studio started anchoring to
 *     a new kind of thing. That is the same bargain the project reader already
 *     makes, where what it cannot read is reported as unknown rather than as an
 *     error.
 *
 *  3. **A method is one place, not eight.** The names below are the whole of the
 *     surface. Adding one is a module in src/team/methods and a caller in Studio.
 *     It is not a route, a capability constant, an IPC event, a preload line and
 *     a renderer type, which is the cost that kept this protocol at five verbs
 *     for as long as it was five verbs.
 *
 * The twin of this file is `src/shared/types/team.ts` in Studio. They are two
 * copies on purpose, because the repositories release separately and neither
 * depends on the other, and `src/team/conformance.test.ts` pins the shapes both
 * sides agree on so that a change to one is a failing test rather than a bad
 * afternoon.
 */

/** Where the socket is, on the same TLS listener everything else is on. */
export const TEAM_SOCKET_PATH = "/api/team/v1/socket";

/**
 * What this file's shapes are, as a whole.
 *
 * Separate from the discovery document's `protocol`, and it moves for the same
 * reason: when a field an older client relies on stops meaning what it meant. A
 * client that finds a number it does not know closes the socket and says so,
 * rather than guessing at frames.
 */
export const TEAM_PROTOCOL_VERSION = 1;

/**
 * How often each side expects to hear anything at all.
 *
 * Sent in the opening frame rather than agreed in advance, so a deployment behind
 * something with a shorter idle timeout can be told to speak sooner without every
 * client being rebuilt. The pings themselves are WebSocket control frames rather
 * than messages here: keeping a connection alive is the transport's job.
 */
export const TEAM_HEARTBEAT_MS = 30_000;

/**
 * The names Studio matches literally to know what a session offers.
 *
 * **There are two things called a session here and they are not the same thing.**
 * Saying which is which once, in the place both are declared, is cheaper than
 * every reader working it out from context:
 *
 *  - A **link session** is the socket: one per client instance, opened by Studio
 *    on its own the moment something needs this server, closed when nothing
 *    does. Nobody asks for one and nobody sees one. That is the `session`
 *    capability, and everything else below travels on it.
 *  - A **live session** is a room: opened by a person, on one project, joined by
 *    other client instances, and used to find them and say things to them. That
 *    is the `live` capability.
 *
 * The second holds no content. It routes and it broadcasts; whatever the people
 * in it produce is written through `overlay` or through the repository, both of
 * which outlive it. So a live session is memory rather than a table, and this
 * server restarting ends every one of them without losing anything.
 */
export type TeamCapability =
  /** The link session exists at all. Everything below implies it. */
  | "session"
  /** Threads and comments anchored in a project. */
  | "comments"
  /** Which client instances are connected, and what each has open. */
  | "clients"
  /** Live sessions: rooms on a project, for finding instances and broadcasting to them. */
  | "live"
  /** Data attached to a project at a revision, which never enters the repository. */
  | "overlay";

/* ------------------------------------------------------------------ frames */

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
  /** Whether this account may open the operator's page. Not a permission over any project. */
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

/**
 * Every way a call can fail.
 *
 * Small on purpose. A client that cannot act on the difference between two codes
 * will print whichever it got, so a code exists only where Studio does something
 * different because of it.
 */
export type TeamErrorCode =
  /** This build has no such method. A client that read `methods` will not see this. */
  | "unknown-method"
  /** The parameters were not the shape the method takes. */
  | "bad-params"
  /** The thing named is not on this server. */
  | "not-found"
  /** The caller may not do that. */
  | "refused"
  /** It would collide with something already there. */
  | "conflict"
  /** True now and possibly not in a moment: a repository this server has not read yet. */
  | "unavailable"
  /** The token that opened this session is no longer good. Reconnecting will not help. */
  | "unauthenticated"
  /** Something nobody planned for. */
  | "internal";

/* ------------------------------------------------------------------ topics */

/** The list of projects on this server changed. */
export const TOPIC_PROJECTS = "projects";

/** The accounts on this server changed. */
export const TOPIC_MEMBERS = "members";

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

/* -------------------------------------------------------- method names */

/**
 * Every method, as one list.
 *
 * Written out rather than derived, because this is the half of the contract a
 * client checks against: a name here that no module answers is a name Studio
 * would call and be refused, and the registry asserts the two agree at startup.
 */
export const TEAM_METHODS = {
  /** Every project on this server, the same list the REST route answers. */
  projectsList: "projects.list",
  /** One project, and what has been read out of its repository. */
  projectsGet: "projects.get",
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
} as const;

export type TeamMethodName = (typeof TEAM_METHODS)[keyof typeof TEAM_METHODS];
