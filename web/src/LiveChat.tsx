/**
 * Talking in a project's live session from the browser.
 *
 * A live session is a room Studio opens; this page joins it as one more
 * window and speaks the same chat lines Studio does (`{ kind: "chat", id,
 * text }` through `live.say`). Everything else said in the room - cursors, a
 * host moving the room - is Studio's business and is ignored here.
 *
 * **Nothing said is kept.** The server hands each line to whoever is in the
 * room at that moment and forgets it (src/team/methods/live.ts); this panel
 * shows what arrived while it was open, and says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  CHAT_BODY_LIMIT,
  liveTopic,
  projectChatTopic,
  projectLiveTopic,
  type TeamChatEvent,
  type TeamChatMessage,
  type TeamLiveEvent,
  type TeamLiveMessage,
  type TeamLiveSession,
} from "@narraleaf/team-protocol";

import type { ConsoleAccount } from "./api";
import { Face } from "./Collab";
import { Icon } from "./Icon";
import { t } from "./i18n";
import type { ConnectionState, TeamConnection } from "./socket";

/** Studio's own bound for one line (src/shared/live/presence.ts there). */
const CHAT_TEXT_LIMIT = 2000;
/** How many lines the panel keeps; the room keeps none. */
const CHAT_KEPT = 200;

interface Line {
  readonly id: string;
  readonly account: string;
  readonly text: string;
  readonly at: number;
  readonly mine: boolean;
}

/** This tab's name in rooms, kept for as long as the tab is open. */
function tabInstance(): string {
  const key = "nlteam.instance";
  try {
    const known = sessionStorage.getItem(key);
    if (known !== null) return known;
    const made = `web-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return `web-${crypto.randomUUID()}`;
  }
}

type Joined = "no" | "asking" | "refused" | "yes";

/**
 * The chat panel: the project's own channel, kept for everybody, and the live
 * session Studio may have open, for whoever is in it right now.
 */
export function ChatPanel(props: { connection: TeamConnection; state: ConnectionState; projectId: string; account: ConsoleAccount }) {
  const [tab, setTab] = useState<"channel" | "live">(() => {
    try {
      return localStorage.getItem("nlteam.chatTab") === "live" ? "live" : "channel";
    } catch {
      return "channel";
    }
  });
  const pick = (next: "channel" | "live") => {
    setTab(next);
    try {
      localStorage.setItem("nlteam.chatTab", next);
    } catch {
      /* nothing to remember with */
    }
  };
  return (
    <div className="chat">
      <div className="panel-head">
        <Icon name="chat" />
        <span>{t("chatTitle")}</span>
      </div>
      <div className="chat-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "channel"} className={tab === "channel" ? "active" : undefined} onClick={() => pick("channel")}>
          {t("chatChannel")}
        </button>
        <button role="tab" aria-selected={tab === "live"} className={tab === "live" ? "active" : undefined} onClick={() => pick("live")}>
          {t("chatLive")}
        </button>
      </div>
      {tab === "channel" ? <ProjectChannel {...props} /> : <LiveChat {...props} />}
    </div>
  );
}

/** A message's words, with every @name in it marked. */
function withMentions(text: string, me: string) {
  return text.split(/(@[A-Za-z0-9_.-]+)/g).map((part, index) =>
    part.startsWith("@") ? (
      <span key={index} className={part.slice(1) === me ? "mention mention-me" : "mention"}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function ProjectChannel({ connection, state, projectId, account }: { connection: TeamConnection; state: ConnectionState; projectId: string; account: ConsoleAccount }) {
  const open = state.kind === "open";
  const [messages, setMessages] = useState<readonly TeamChatMessage[] | undefined>(undefined);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(
    (before?: number) => {
      connection
        .call<{ messages: TeamChatMessage[]; cursor?: number }>("chat.list", { project: projectId, limit: 50, ...(before === undefined ? {} : { cursor: before }) })
        .then((page) => {
          const older = [...page.messages].reverse();
          stick.current = before === undefined;
          setMessages((current) => (before === undefined ? older : [...older, ...(current ?? [])]));
          setCursor(page.cursor);
        })
        .catch((caught: unknown) => {
          setMessages((current) => current ?? []);
          setError(caught instanceof Error ? caught.message : String(caught));
        });
    },
    [connection, projectId],
  );

  useEffect(() => {
    if (!open) return undefined;
    load();
    return connection.subscribe(projectChatTopic(projectId), (payload) => {
      const event = payload as TeamChatEvent;
      stick.current = true;
      if (event.kind === "chat-message") {
        setMessages((current) => (current?.some((m) => m.id === event.message.id) ? current : [...(current ?? []), event.message]));
      } else {
        setMessages((current) => current?.map((m) => (m.id === event.id ? { ...m, body: "", deletedAt: Date.now() } : m)));
      }
    });
  }, [open, connection, projectId, load]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    setDraft("");
    setError(undefined);
    try {
      await connection.call("chat.send", { project: projectId, body });
    } catch (caught) {
      setDraft(body);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  let lastDay = "";
  return (
    <>
      <div className="chat-lines" aria-live="polite">
        {cursor !== undefined ? (
          <button className="ghost small chat-older" onClick={() => load(cursor)}>
            {t("chatOlder")}
          </button>
        ) : null}
        {messages === undefined ? <p className="muted small chat-note">{t("loading")}</p> : null}
        {messages !== undefined && messages.length === 0 ? <p className="muted small chat-note">{t("chatChannelEmpty")}</p> : null}
        {(messages ?? []).map((message) => {
          const day = new Date(message.at).toLocaleDateString();
          const divider = day !== lastDay ? <div className="chat-day">{day}</div> : null;
          lastDay = day;
          const mine = message.author === account.username;
          return (
            <div key={message.id}>
              {divider}
              <div className={mine ? "chat-line mine" : "chat-line"}>
                {mine ? null : <Face name={message.author ?? "?"} size={24} />}
                <div className="chat-bubble">
                  {mine ? null : <span className="chat-who">{message.author ?? t("chatGone")}</span>}
                  {message.deletedAt !== undefined ? (
                    <span className="chat-text muted">{t("chatDeleted")}</span>
                  ) : (
                    <span className="chat-text">{withMentions(message.body, account.username)}</span>
                  )}
                  <span className="chat-at">
                    {new Date(message.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    {mine && message.deletedAt === undefined ? (
                      <button className="chat-undo" onClick={() => void connection.call("chat.delete", { message: message.id }).catch(() => undefined)}>
                        {t("chatTakeBack")}
                      </button>
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form className="chat-compose" onSubmit={(event) => void send(event)}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("chatChannelPlaceholder")}
          aria-label={t("chatChannelPlaceholder")}
          maxLength={CHAT_BODY_LIMIT}
        />
        <button className="primary icon-button" type="submit" aria-label={t("chatSend")} disabled={draft.trim() === ""}>
          <Icon name="send" />
        </button>
      </form>
      {error !== undefined ? <p className="error chat-error">{error}</p> : null}
    </>
  );
}

export function LiveChat({ connection, state, projectId, account }: { connection: TeamConnection; state: ConnectionState; projectId: string; account: ConsoleAccount }) {
  const instance = useMemo(() => tabInstance(), []);
  const hello = state.kind === "open" ? state.hello : undefined;
  const [announced, setAnnounced] = useState(false);
  const [sessions, setSessions] = useState<readonly TeamLiveSession[] | undefined>(undefined);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [joined, setJoined] = useState<Joined>("no");
  const [code, setCode] = useState("");
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const counter = useRef(0);
  const seen = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);

  // Say who this window is, on every connection: the server forgets a window
  // with the connection it arrived on.
  useEffect(() => {
    if (hello === undefined) return undefined;
    let alive = true;
    setAnnounced(false);
    connection
      .call("clients.announce", { instance, label: t("chatWindowLabel"), agent: "nlteam-console", project: projectId })
      .then(() => alive && setAnnounced(true))
      .catch((caught: unknown) => alive && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      alive = false;
      void connection.call("clients.withdraw", { project: projectId }).catch(() => undefined);
    };
  }, [connection, hello, instance, projectId]);

  const loadSessions = useCallback(() => {
    connection
      .call<{ sessions: TeamLiveSession[] }>("live.list", { project: projectId })
      .then((answer) => {
        setSessions(answer.sessions);
        setPicked((current) => (current !== undefined && answer.sessions.some((s) => s.id === current) ? current : answer.sessions[0]?.id));
      })
      .catch(() => setSessions([]));
  }, [connection, projectId]);

  useEffect(() => {
    if (!announced) return undefined;
    loadSessions();
    return connection.subscribe(projectLiveTopic(projectId), (payload) => {
      const event = payload as TeamLiveEvent;
      if (event.kind === "live-refused" && event.instance === instance) setJoined("refused");
      loadSessions();
    });
  }, [announced, connection, projectId, instance, loadSessions]);

  const session = sessions?.find((s) => s.id === picked);
  const member = session?.members.some((m) => m.instance === instance) ?? false;
  useEffect(() => {
    if (member) setJoined("yes");
    else setJoined((current) => (current === "yes" ? "no" : current));
  }, [member]);

  // While in the room: hear what is said, and leave when this panel goes.
  useEffect(() => {
    if (session === undefined || !member) return undefined;
    const id = session.id;
    const off = connection.subscribe(liveTopic(id), (payload) => {
      const message = payload as TeamLiveMessage;
      const said = message.payload as { kind?: unknown; id?: unknown; text?: unknown } | null;
      if (said === null || said.kind !== "chat" || typeof said.id !== "string" || typeof said.text !== "string") return;
      if (seen.current.has(said.id)) return;
      seen.current.add(said.id);
      const line: Line = { id: said.id, account: message.account, text: said.text, at: message.at, mine: message.from === instance };
      setLines((current) => [...current, line].slice(-CHAT_KEPT));
    });
    return () => {
      off();
      void connection.call("live.leave", { session: id }).catch(() => undefined);
    };
  }, [connection, session, member, instance]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  const join = async (event?: FormEvent) => {
    event?.preventDefault();
    if (session === undefined) return;
    setError(undefined);
    try {
      if (session.rule === "request") {
        setJoined("asking");
        await connection.call("live.requestJoin", { session: session.id });
      } else if (session.rule === "code") {
        await connection.call("live.join", { code: code.trim() });
      } else {
        await connection.call("live.join", { session: session.id });
      }
      loadSessions();
    } catch (caught) {
      setJoined("no");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const say = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (session === undefined || text === "" || text.length > CHAT_TEXT_LIMIT) return;
    counter.current += 1;
    const id = `${instance.slice(-12)}-${Date.now().toString(36)}-${counter.current}`;
    setDraft("");
    try {
      await connection.call("live.say", { session: session.id, payload: { kind: "chat", id, text } });
    } catch (caught) {
      setDraft(text);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <>
      {sessions === undefined ? (
        <p className="muted chat-note">{t("loading")}</p>
      ) : sessions.length === 0 ? (
        <div className="chat-empty">
          <p>{t("chatNoSession")}</p>
          <p className="muted small">{t("chatNoSessionLead")}</p>
        </div>
      ) : (
        <>
          {sessions.length > 1 ? (
            <label className="chat-pick">
              <span className="muted small">{t("chatSession")}</span>
              <select value={picked} onChange={(event) => setPicked(event.target.value)} disabled={joined === "yes"}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title ?? t("chatSessionBy", { who: s.openedBy })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {session !== undefined ? (
            <div className="chat-members">
              {session.members.map((m) => (
                <span key={m.instance} className="chat-member" title={`${m.account} · ${m.label}`}>
                  <Face name={m.account} size={22} />
                </span>
              ))}
              <span className="muted small">{t("chatMembers", { count: String(session.members.length) })}</span>
            </div>
          ) : null}
          {joined !== "yes" && session !== undefined ? (
            <form className="chat-join" onSubmit={(event) => void join(event)}>
              <p className="muted small">{t("chatJoinLead", { who: session.openedBy })}</p>
              {session.rule === "code" ? (
                <input value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("chatCode")} aria-label={t("chatCode")} required />
              ) : null}
              {joined === "asking" ? <p className="muted small">{t("chatAsking")}</p> : null}
              {joined === "refused" ? <p className="error">{t("chatRefused")}</p> : null}
              <button className="primary" type="submit" disabled={joined === "asking"}>
                {session.rule === "request" ? t("chatAsk") : t("chatJoin")}
              </button>
            </form>
          ) : null}
          {joined === "yes" ? (
            <>
              <div className="chat-lines" aria-live="polite">
                <p className="muted small chat-note">{t("chatNotKept")}</p>
                {lines.map((line) => (
                  <div key={line.id} className={line.mine ? "chat-line mine" : "chat-line"}>
                    {line.mine ? null : <Face name={line.account} size={24} />}
                    <div className="chat-bubble">
                      {line.mine ? null : <span className="chat-who">{line.account === account.username ? t("you") : line.account}</span>}
                      <span className="chat-text">{line.text}</span>
                      <span className="chat-at">{new Date(line.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <form className="chat-compose" onSubmit={(event) => void say(event)}>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t("chatPlaceholder")}
                  aria-label={t("chatPlaceholder")}
                  maxLength={CHAT_TEXT_LIMIT}
                />
                <button className="primary icon-button" type="submit" aria-label={t("chatSend")} disabled={draft.trim() === ""}>
                  <Icon name="send" />
                </button>
              </form>
            </>
          ) : null}
        </>
      )}
      {error !== undefined ? <p className="error chat-error">{error}</p> : null}
    </>
  );
}
