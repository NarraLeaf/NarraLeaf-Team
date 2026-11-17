/**
 * Taking part: reactions, watching, @mentions, who is about, and where notifications go.
 *
 *  - {@link ReactionBar}: the emoji under a comment or a chat message, and the picker that adds one.
 *  - {@link WatchToggle}: follow a project, or one scene of it.
 *  - {@link MentionField}: a text box that offers team members after an `@`.
 *  - {@link PersonHover}: an avatar that, hovered, says who it is, their local time, and whether they are on.
 *  - {@link NotificationSettings}: the switches, the digest, a personal address, and this browser's pushes.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import {
  projectChatTopic,
  projectThreadsTopic,
  TEAM_DIGEST_FREQUENCIES,
  TEAM_NOTIFICATION_CATEGORIES,
  TEAM_NOTIFICATION_CHANNELS,
  TEAM_REACTIONS,
  type TeamChatEvent,
  type TeamDigestFrequency,
  type TeamNotificationCategory,
  type TeamNotificationChannel,
  type TeamAccountPolicy,
  type TeamNotificationPrefs,
  type TeamProfile,
  type TeamReaction,
  type TeamReactionEmoji,
  type TeamThreadEvent,
  type TeamWatch,
} from "@narraleaf/team-protocol";

import { Face } from "./Collab";
import { Icon } from "./Icon";
import { t, type Phrase } from "./i18n";
import { LockedNote } from "./Locked";
import type { TeamConnection } from "./socket";
import { Checkbox, SelectPanel, Subhead, toast, toastError } from "./ui";

/** Whether the socket is open now: calls made before it is are refused, so asking waits for this. */
export function useOpen(connection: TeamConnection): boolean {
  const [open, setOpen] = useState(connection.state.kind === "open");
  useEffect(() => connection.onState((state) => setOpen(state.kind === "open")), [connection]);
  return open;
}

/* -------------------------------------------------------------- reactions */

export type ReactionKind = "comment" | "chat";

/** The reactions on a set of comments or messages, by target, kept current by the project's topic. */
export function useReactions(
  connection: TeamConnection,
  projectId: string,
  kind: ReactionKind,
  targets: readonly string[],
): ReadonlyMap<string, readonly TeamReaction[]> {
  const [byTarget, setByTarget] = useState<ReadonlyMap<string, readonly TeamReaction[]>>(new Map());
  const key = targets.join(",");
  const open = useOpen(connection);
  useEffect(() => {
    if (!open || targets.length === 0) return;
    let alive = true;
    connection
      .call<{ reactions: TeamReaction[] }>("reactions.list", { project: projectId, kind, targets: targets.slice(-200) })
      .then((answer) => {
        if (!alive) return;
        const next = new Map<string, TeamReaction[]>();
        for (const reaction of answer.reactions) next.set(reaction.target, [...(next.get(reaction.target) ?? []), reaction]);
        setByTarget(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // `key` stands for `targets`, which is a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, projectId, kind, key]);
  useEffect(() => {
    const topic = kind === "comment" ? projectThreadsTopic(projectId) : projectChatTopic(projectId);
    return connection.subscribe(topic, (payload) => {
      const event = payload as TeamThreadEvent | TeamChatEvent;
      if (event.kind !== "reaction") return;
      setByTarget((current) => withReaction(current, event.reaction));
    });
  }, [connection, projectId, kind]);
  return byTarget;
}

/** The reactions with one emoji's count replaced, in the server's fixed emoji order. */
function withReaction(current: ReadonlyMap<string, readonly TeamReaction[]>, reaction: TeamReaction): ReadonlyMap<string, readonly TeamReaction[]> {
  const next = new Map(current);
  const others = (current.get(reaction.target) ?? []).filter((entry) => entry.emoji !== reaction.emoji);
  const all = reaction.by.length === 0 ? others : [...others, reaction];
  next.set(
    reaction.target,
    all.sort((a, b) => TEAM_REACTIONS.indexOf(a.emoji) - TEAM_REACTIONS.indexOf(b.emoji)),
  );
  return next;
}

/** The emoji on one comment or message: each a pill with its count, and a button to add one. */
export function ReactionBar(props: {
  connection: TeamConnection;
  projectId: string;
  kind: ReactionKind;
  target: string;
  reactions: readonly TeamReaction[] | undefined;
  me: string | undefined;
  canReact: boolean;
}) {
  const { connection, projectId, kind, target, reactions = [], me, canReact } = props;
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!picking) return undefined;
    const away = (event: MouseEvent) => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setPicking(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    // The picker floats over the page at a fixed place, so a scroll would leave it behind.
    const scrolled = (event: Event) => {
      if (picker.current === null || !picker.current.contains(event.target as Node)) setPicking(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [picking]);
  // Placed against the window rather than its box, so a scrolling list or a narrow panel never
  // cuts it off: above the button when there is room, below it when not, and kept inside the
  // window from side to side.
  const picker = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!picking) {
      setPlace(undefined);
      return;
    }
    const button = box.current?.querySelector(".reaction-add") ?? null;
    const menu = picker.current;
    if (button === null || menu === null) return;
    const at = button.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(at.left, window.innerWidth - size.width - margin));
    const above = at.top - size.height - 4;
    const top = above >= margin ? above : Math.min(at.bottom + 4, window.innerHeight - size.height - margin);
    setPlace({ left, top });
  }, [picking]);
  const toggle = (emoji: TeamReactionEmoji) => {
    setPicking(false);
    void connection.call("reactions.toggle", { project: projectId, kind, target, emoji }).catch(toastError);
  };
  if (reactions.length === 0 && !canReact) return null;
  return (
    <span className="reactions" ref={box}>
      {reactions.map((reaction) => {
        const mine = me !== undefined && reaction.by.includes(me);
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={mine ? "reaction mine" : "reaction"}
            title={reaction.by.join(", ")}
            aria-pressed={mine}
            disabled={!canReact}
            onClick={() => toggle(reaction.emoji)}
          >
            <span className="reaction-emoji">{reaction.emoji}</span>
            <span className="reaction-count">{reaction.by.length}</span>
          </button>
        );
      })}
      {canReact ? (
        <button type="button" className="reaction reaction-add" title={t("addReaction")} aria-label={t("addReaction")} aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
          <Icon name="smile" size={14} />
        </button>
      ) : null}
      {picking ? (
        <span className="reaction-picker" role="menu" ref={picker} style={place ?? { visibility: "hidden" }}>
          {TEAM_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" role="menuitem" className="reaction-choice" onClick={() => toggle(emoji)}>
              {emoji}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/* --------------------------------------------------------------- watching */

/** Follow a project (no scope) or one scene of it (`scene:{id}`). */
export function WatchToggle({ connection, projectId, scope, compact = false }: { connection: TeamConnection; projectId: string; scope?: string; compact?: boolean }) {
  const [watching, setWatching] = useState<boolean | undefined>(undefined);
  const open = useOpen(connection);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    connection
      .call<{ watches: TeamWatch[] }>("watches.list", { project: projectId })
      .then((answer) => alive && setWatching(answer.watches.some((watch) => (watch.scope ?? "") === (scope ?? ""))))
      .catch(() => alive && setWatching(undefined));
    return () => {
      alive = false;
    };
  }, [connection, open, projectId, scope]);
  if (watching === undefined) return null;
  const flip = () => {
    const next = !watching;
    setWatching(next);
    connection
      .call("watches.set", { project: projectId, ...(scope === undefined ? {} : { scope }), watching: next })
      .then(() => toast(t(next ? (scope === undefined ? "watchingProject" : "watchingScene") : "unwatched")))
      .catch((caught: unknown) => {
        setWatching(!next);
        toastError(caught);
      });
  };
  const label = t(watching ? "unwatch" : scope === undefined ? "watchProject" : "watchScene");
  return (
    <button
      type="button"
      className={`btn${compact ? " btn-invisible btn-icon btn-sm" : ""}${watching ? " is-watching" : ""}`}
      aria-pressed={watching}
      title={t(scope === undefined ? "watchProjectHint" : "watchSceneHint")}
      aria-label={label}
      onClick={flip}
    >
      <Icon name="eye" size={14} />
      {compact ? null : <span>{watching ? t("watching") : t("watch")}</span>}
    </button>
  );
}

/* --------------------------------------------------------------- mentions */

interface Person {
  readonly username: string;
  readonly displayName: string;
}

let peopleCache: Promise<readonly Person[]> | undefined;

/** The team's members, asked for once per page. */
function teamPeople(connection: TeamConnection): Promise<readonly Person[]> {
  peopleCache ??= connection
    .call<{ members: Person[] }>("members.list")
    .then((answer) => answer.members)
    .catch(() => {
      peopleCache = undefined;
      return [];
    });
  return peopleCache;
}

/** The `@word` being typed just before the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|[^A-Za-z0-9._@-])@([a-z0-9._-]{0,32})$/i.exec(text.slice(0, caret));
  if (match === null) return undefined;
  return { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() };
}

type FieldProps =
  | ({ as?: "textarea" } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">)
  | ({ as: "input" } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">);

/**
 * A text box that, after an `@`, offers the team's members by username or name: arrows move,
 * Enter or Tab puts the name in, Escape leaves the text as it is.
 */
export function MentionField(props: FieldProps & { connection: TeamConnection; value: string; onValue: (value: string) => void }) {
  const { connection, value, onValue, as = "textarea", onKeyDown, ...rest } = props as FieldProps & {
    connection: TeamConnection;
    value: string;
    onValue: (value: string) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  };
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [at, setAt] = useState<{ start: number; query: string } | undefined>(undefined);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const open = useOpen(connection);
  useEffect(() => {
    if (open) void teamPeople(connection).then(setPeople);
  }, [connection, open]);
  const offers = useMemo(() => {
    if (at === undefined) return [];
    return people
      .filter((person) => person.username.toLowerCase().startsWith(at.query) || person.displayName.toLowerCase().includes(at.query))
      .slice(0, 6);
  }, [people, at]);
  const change = (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    onValue(event.target.value);
    setAt(mentionAt(event.target.value, event.target.selectionStart ?? event.target.value.length));
    setActive(0);
  };
  const pick = (person: Person) => {
    if (at === undefined) return;
    const caret = at.start + 1 + at.query.length;
    const next = `${value.slice(0, at.start)}@${person.username} ${value.slice(caret)}`;
    onValue(next);
    setAt(undefined);
    const position = at.start + person.username.length + 2;
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(position, position);
    });
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (offers.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : offers.length - 1)) % offers.length);
        return;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        event.preventDefault();
        pick(offers[active] ?? offers[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setAt(undefined);
        return;
      }
    }
    onKeyDown?.(event);
  };
  const shared = {
    ref: field,
    value,
    onChange: change,
    onKeyDown: key,
    onBlur: () => setTimeout(() => setAt(undefined), 120),
    "aria-autocomplete": "list" as const,
    "aria-expanded": offers.length > 0,
  };
  return (
    <span className="mention-field">
      {as === "input" ? <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...shared} /> : <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...shared} />}
      {offers.length > 0 ? (
        <ul className="mention-offers" role="listbox">
          {offers.map((person, index) => (
            <li key={person.username} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={index === active ? "mention-offer active" : "mention-offer"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(person);
                }}
              >
                <Face name={person.displayName || person.username} user={person.username} size={22} />
                <strong>@{person.username}</strong>
                {person.displayName !== person.username ? <span className="muted small">{person.displayName}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------- who's about */

const profiles = new Map<string, Promise<TeamProfile | undefined>>();

function profileOf(connection: TeamConnection, username: string): Promise<TeamProfile | undefined> {
  let known = profiles.get(username);
  if (known === undefined) {
    known = connection
      .call<{ profile: TeamProfile }>("account.profile.get", { username })
      .then((answer) => answer.profile)
      .catch(() => undefined);
    profiles.set(username, known);
    // Online changes: ask again after a minute.
    setTimeout(() => profiles.delete(username), 60_000);
  }
  return known;
}

/** The time it is now where somebody is, and how far that is from here. */
export function localTimeIn(timezone: string, now = new Date()): string | undefined {
  try {
    const there = now.toLocaleTimeString(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
    const offset = (zone?: string) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(now);
      const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"));
    };
    const hours = Math.round((offset(timezone) - offset()) / 3_600_000);
    return hours === 0 ? there : `${there} (${hours > 0 ? "+" : ""}${hours}h)`;
  } catch {
    return undefined;
  }
}

/** Wrap an avatar or a name: hovered or focused, it says who it is, where it is now, and whether they are on. */
export function PersonHover({ connection, username, children }: { connection: TeamConnection; username: string | undefined; children: ReactNode }) {
  const [profile, setProfile] = useState<TeamProfile | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enter = useCallback(() => {
    if (username === undefined || username.startsWith("guest:")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setShown(true);
      void profileOf(connection, username).then(setProfile);
    }, 350);
  }, [connection, username]);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    setShown(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const local = profile?.timezone === undefined ? undefined : localTimeIn(profile.timezone);
  return (
    <span className="person-hover" onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
      {children}
      {shown && profile !== undefined ? (
        <span className="person-card" role="tooltip">
          <strong>{profile.displayName}</strong>
          <span className="muted small">@{profile.username}</span>
          {profile.online === undefined ? null : (
            <span className="small person-online">
              <span className={profile.online ? "dot-online" : "dot-offline"} aria-hidden="true" />
              {t(profile.online ? "online" : "offline")}
            </span>
          )}
          {local === undefined ? null : <span className="small">{t("localTime", { time: local })}</span>}
          {profile.bio ? <span className="small muted person-bio">{profile.bio}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------- push */

/** Whether this browser can be pushed to at all. */
export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

/** The service worker that shows pushes, registered once. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return Promise.resolve(undefined);
  return navigator.serviceWorker.register("/console/sw.js", { scope: "/console/" }).catch(() => undefined);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

function encoded(buffer: ArrayBuffer | null): string {
  if (buffer === null) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This browser's push subscription, if it has one. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await registerServiceWorker();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Ask the person, subscribe this browser, and tell the server where to push. */
async function subscribeBrowser(connection: TeamConnection): Promise<TeamNotificationPrefs> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(t("pushDenied"));
  const registration = await registerServiceWorker();
  if (registration === undefined) throw new Error(t("pushUnsupported"));
  const { key } = await connection.call<{ key: string }>("push.key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const answer = await connection.call<{ prefs: TeamNotificationPrefs }>("push.subscribe", {
    endpoint: subscription.endpoint,
    p256dh: encoded(subscription.getKey("p256dh")),
    auth: encoded(subscription.getKey("auth")),
  });
  return answer.prefs;
}

async function unsubscribeBrowser(connection: TeamConnection): Promise<TeamNotificationPrefs | undefined> {
  const subscription = await currentSubscription();
  if (subscription === null) return undefined;
  await subscription.unsubscribe().catch(() => undefined);
  const answer = await connection.call<{ prefs: TeamNotificationPrefs }>("push.unsubscribe", { endpoint: subscription.endpoint });
  return answer.prefs;
}

/* ---------------------------------------------------------------- settings */

export const CATEGORY_PHRASE: Record<TeamNotificationCategory, Phrase> = {
  mention: "catMention",
  reply: "catReply",
  assign: "catAssign",
  review: "catReview",
  watch: "catWatch",
  access: "catAccess",
};
export const CHANNEL_PHRASE: Record<TeamNotificationChannel, Phrase> = { inapp: "chanInapp", push: "chanPush", email: "chanEmail" };
export const DIGEST_PHRASE: Record<TeamDigestFrequency, Phrase> = { off: "digestOff", daily: "digestDaily", weekly: "digestWeekly" };

/** Where each kind of notification goes, the digest, a personal address, and this browser's pushes. */
export function NotificationSettings({ connection, open, policy }: { connection: TeamConnection; open: boolean; policy?: TeamAccountPolicy | undefined }) {
  const switchesLocked = policy?.notificationSwitches !== undefined;
  const digestLocked = policy?.digest !== undefined;
  const hookLocked = policy?.hook !== undefined;
  const [prefs, setPrefs] = useState<TeamNotificationPrefs | undefined>(undefined);
  const [hook, setHook] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  const took = (next: TeamNotificationPrefs) => {
    setPrefs(next);
    setHook(next.hook ?? "");
  };
  useEffect(() => {
    if (!open) return;
    connection
      .call<{ prefs: TeamNotificationPrefs }>("notifications.prefs")
      .then((answer) => took(answer.prefs))
      .catch(() => undefined);
    void currentSubscription().then((subscription) => setSubscribed(subscription !== null));
  }, [connection, open]);
  useEffect(() => {
    if (prefs !== undefined && window.location.pathname.endsWith("/settings/notifications")) section.current?.scrollIntoView({ block: "start" });
  }, [prefs === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  if (prefs === undefined) return null;
  const on = (category: TeamNotificationCategory, channel: TeamNotificationChannel) =>
    prefs.switches.find((entry) => entry.category === category && entry.channel === channel)?.enabled ?? true;
  const set = (change: Record<string, unknown>) =>
    connection
      .call<{ prefs: TeamNotificationPrefs }>("notifications.prefs.set", change)
      .then((answer) => {
        took(answer.prefs);
        return true;
      })
      .catch((caught: unknown) => {
        toastError(caught);
        return false;
      });
  const flip = (category: TeamNotificationCategory, channel: TeamNotificationChannel, enabled: boolean) => {
    setPrefs({ ...prefs, switches: [...prefs.switches.filter((entry) => entry.category !== category || entry.channel !== channel), { category, channel, enabled }] });
    void set({ switches: [{ category, channel, enabled }] });
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      toastError(caught);
    } finally {
      setBusy(false);
    }
  };
  const canPush = pushSupported();
  return (
    <div className="card settings-block" id="notifications" ref={section}>
      <Subhead title={t("notificationSettings")}>{t("notificationSettingsLead")}</Subhead>
      {switchesLocked ? (
        <p className="small">
          <LockedNote />
        </p>
      ) : null}
      <table className="notify-matrix">
        <thead>
          <tr>
            <th />
            {TEAM_NOTIFICATION_CHANNELS.map((channel) => (
              <th key={channel} scope="col">
                {t(CHANNEL_PHRASE[channel])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TEAM_NOTIFICATION_CATEGORIES.map((category) => (
            <tr key={category}>
              <th scope="row">{t(CATEGORY_PHRASE[category])}</th>
              {TEAM_NOTIFICATION_CHANNELS.map((channel) => (
                <td key={channel}>
                  <Checkbox
                    checked={on(category, channel)}
                    onChange={(enabled) => flip(category, channel, enabled)}
                    disabled={switchesLocked}
                    label={<span className="visually-hidden">{`${t(CATEGORY_PHRASE[category])} · ${t(CHANNEL_PHRASE[channel])}`}</span>}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("notifyMatrixHint")}</p>

      <h3 className="settings-sub">{t("chanPush")}</h3>
      {!canPush ? (
        <p className="muted small">{t("pushUnsupported")}</p>
      ) : (
        <div className="settings-row">
          <span className="muted small">{subscribed ? t("pushOnHere", { count: String(prefs.pushSubscriptions) }) : t("pushOffHere")}</span>
          <span className="settings-row-actions">
            {subscribed ? (
              <>
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => connection.call<{ reached: number }>("push.test").then((answer) => toast(t("pushTested", { count: String(answer.reached) }))))}>
                  {t("sendTest")}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await unsubscribeBrowser(connection);
                      if (next !== undefined) took(next);
                      setSubscribed(false);
                    })
                  }
                >
                  {t("pushTurnOff")}
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    took(await subscribeBrowser(connection));
                    setSubscribed(true);
                    toast(t("pushTurnedOn"));
                  })
                }
              >
                {t("pushTurnOn")}
              </button>
            )}
          </span>
        </div>
      )}

      <h3 className="settings-sub">
        {t("digest")} {digestLocked ? <LockedNote /> : null}
      </h3>
      <div className="settings-row">
        <span className="muted small">
          {prefs.mail ? (prefs.email === undefined ? t("digestNoEmail") : t("digestTo", { email: prefs.email })) : t("digestNoMail")}
        </span>
        <span className="settings-row-actions">
          <SelectPanel<TeamDigestFrequency>
            label={t("digest")}
            value={prefs.digest}
            options={TEAM_DIGEST_FREQUENCIES.map((value) => ({ value, label: t(DIGEST_PHRASE[value]) }))}
            onChange={(digest) => void set({ digest })}
            disabled={digestLocked}
            size="small"
          />
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                connection
                  .call<{ count: number; errors: string[] }>("notifications.digest.now", { period: prefs.digest === "weekly" ? "weekly" : "daily" })
                  .then((answer) => (answer.errors.length > 0 ? toastError(new Error(answer.errors.join("; "))) : toast(answer.count === 0 ? t("digestNothing") : t("digestSent", { count: String(answer.count) })))),
              )
            }
          >
            {t("digestNow")}
          </button>
        </span>
      </div>
      <form
        className="settings-row settings-row-field"
        onSubmit={(event) => {
          event.preventDefault();
          void set({ hook: hook.trim() === "" ? null : hook.trim() }).then((ok) => ok && toast(t("saved")));
        }}
      >
        <label className="grow">
          <span className="muted small">
            {t("personalHook")} {hookLocked ? <LockedNote /> : null}
          </span>
          <input type="url" value={hook} disabled={hookLocked} onChange={(event) => setHook(event.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" maxLength={2048} />
        </label>
        <span className="settings-row-actions">
          <button className="btn" type="button" disabled={busy || hook.trim() === ""} onClick={() => void run(() => connection.call("notifications.hook.test", { url: hook.trim() }).then(() => toast(t("hookTested"))))}>
            {t("sendTest")}
          </button>
          <button className="btn btn-primary" type="submit" disabled={hookLocked || (prefs.hook ?? "") === hook.trim()}>
            {t("save")}
          </button>
        </span>
      </form>
      <p className="muted small">{t("personalHookHint")}</p>
    </div>
  );
}

/** Time zones the browser knows, the person's own first. */
export function timeZones(): readonly string[] {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [here];
  return [here, ...all.filter((zone) => zone !== here)];
}
