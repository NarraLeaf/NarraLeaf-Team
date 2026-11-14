/**
 * The console's personal half: the home page (contribution graph, timeline,
 * my to-dos), a project's to-do board, notifications, and one's own settings.
 *
 * Everything is a call on the socket; what each viewer may see is decided by
 * the server (src/collab/), so nothing here hides anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  accountNotificationsTopic,
  accountTodosTopic,
  projectTodosTopic,
  type TeamAccountDevice,
  type TeamActivity,
  type TeamActivityDay,
  type TeamNotification,
  type TeamProfile,
  type TeamTodo,
  type TeamTodoStatus,
} from "@narraleaf/team-protocol";

import type { ConsoleAccount } from "./api";
import { t, type Phrase } from "./i18n";
import type { ConnectionState, TeamConnection } from "./socket";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  const format = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  if (seconds < 60) return format.format(-seconds, "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
  if (seconds < 86400 * 30) return format.format(-Math.round(seconds / 86400), "day");
  return new Date(at).toLocaleDateString();
}

/** A face: the account's picture, or a letter in the name's own colour. */
export function Face({ name, url, size = 26 }: { name: string; url?: string | undefined; size?: number }) {
  if (url !== undefined) {
    return <img className="avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return (
    <span className="avatar" style={{ background: `hsl(${hash} 42% 46%)`, width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {Array.from(name)[0]?.toUpperCase()}
    </span>
  );
}

/* --------------------------------------------------------------- heatmap */

/** A year of days in seven rows, most recent at the right, like any contribution graph. */
function Heatmap({ days }: { days: readonly TeamActivityDay[] }) {
  const counts = useMemo(() => new Map(days.map((day) => [day.day, day.count])), [days]);
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const max = Math.max(1, ...days.map((day) => day.count));
  const today = new Date();
  const cells: { key: string; count: number; title: string }[] = [];
  // 53 weeks back to the Sunday, so columns are weeks.
  const start = new Date(today);
  start.setDate(start.getDate() - 52 * 7 - start.getDay());
  for (let day = new Date(start); day <= today; day.setDate(day.getDate() + 1)) {
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const count = counts.get(key) ?? 0;
    cells.push({ key, count, title: `${key}: ${count}` });
  }
  const level = (count: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)));
  return (
    <div className="heatmap-card card">
      <div className="muted small">{t("contributions", { count: String(total) })}</div>
      <div className="heatmap" role="img" aria-label={t("contributions", { count: String(total) })}>
        {cells.map((cell) => (
          <span key={cell.key} className={`cell level-${level(cell.count)}`} title={cell.title} />
        ))}
      </div>
      <div className="heatmap-legend muted small">
        {t("less")}
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} className={`cell level-${n}`} />
        ))}
        {t("more")}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- timeline */

const ACTIVITY_PHRASE: Record<TeamActivity["kind"], Phrase> = {
  commit: "aCommit",
  thread: "aThread",
  comment: "aComment",
  resolve: "aResolve",
  "todo-created": "aTodoCreated",
  "todo-done": "aTodoDone",
};

export function Timeline({
  connection,
  open,
  account,
  project,
  projectNames,
}: {
  connection: TeamConnection;
  open: boolean;
  account?: string;
  project?: string;
  projectNames?: ReadonlyMap<string, string>;
}) {
  const [rows, setRows] = useState<readonly TeamActivity[] | undefined>(undefined);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const load = useCallback(
    (before?: number) => {
      connection
        .call<{ activity: TeamActivity[]; cursor?: number }>("activity.list", {
          ...(account === undefined ? {} : { account }),
          ...(project === undefined ? {} : { project }),
          limit: 30,
          ...(before === undefined ? {} : { cursor: before }),
        })
        .then((page) => {
          setRows((current) => [...(before === undefined ? [] : (current ?? [])), ...page.activity]);
          setCursor(page.cursor);
        })
        .catch(() => setRows((current) => current ?? []));
    },
    [connection, account, project],
  );
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  if (rows === undefined) return <p className="muted">{t("loading")}</p>;
  if (rows.length === 0) return <p className="placeholder-card">{t("noActivity")}</p>;
  return (
    <>
      <ol className="timeline">
        {rows.map((row) => (
          <li key={row.id} className={`timeline-row kind-${row.kind}`}>
            <span className="dot" aria-hidden="true" />
            <div className="timeline-main">
              <div>
                <strong>{row.actor}</strong> {t(ACTIVITY_PHRASE[row.kind])}
                {row.project !== undefined && projectNames?.get(row.project) !== undefined ? (
                  <span className="muted"> · {projectNames.get(row.project)}</span>
                ) : null}
              </div>
              {row.summary ? <div className="muted timeline-summary">{row.summary}</div> : null}
            </div>
            <span className="muted small">{ago(row.at)}</span>
          </li>
        ))}
      </ol>
      {cursor !== undefined ? (
        <button className="ghost" onClick={() => load(cursor)}>
          {t("loadMore")}
        </button>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- todos */

const STATUS_PHRASE: Record<TeamTodoStatus, Phrase> = { open: "todoOpen", doing: "todoDoing", done: "todoDone" };
const NEXT_STATUS: Record<TeamTodoStatus, TeamTodoStatus> = { open: "doing", doing: "done", done: "open" };

/**
 * A list of to-dos, kept current by the topic it lives on: the account's own,
 * or a project's. A project's is drawn as three columns.
 */
export function Todos({
  connection,
  open,
  account,
  project,
  members,
}: {
  connection: TeamConnection;
  open: boolean;
  account: ConsoleAccount & { readonly id?: string };
  project?: string;
  members?: readonly { username: string; displayName: string }[];
}) {
  const [todos, setTodos] = useState<readonly TeamTodo[] | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [shared, setShared] = useState(project !== undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    connection
      .call<{ todos: TeamTodo[] }>("todos.list", { ...(project === undefined ? {} : { project }), includeDone: true })
      .then((answer) => setTodos(answer.todos))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [connection, project]);

  useEffect(() => {
    if (!open || (project === undefined && account.id === undefined)) return undefined;
    load();
    const topic = project === undefined ? accountTodosTopic(account.id ?? "") : projectTodosTopic(project);
    return connection.subscribe(topic, () => load());
  }, [open, load, connection, project, account.id]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (text === "") return;
    setTitle("");
    try {
      await connection.call("todos.create", {
        title: text,
        ...(project === undefined ? {} : { project, visibility: shared ? "project" : "private" }),
      });
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  const update = (todo: TeamTodo, fields: Record<string, unknown>) =>
    connection.call("todos.update", { todo: todo.id, ...fields }).catch((caught: unknown) => setError(errorText(caught)));
  const remove = (todo: TeamTodo) => connection.call("todos.delete", { todo: todo.id }).catch((caught: unknown) => setError(errorText(caught)));

  const card = (todo: TeamTodo) => (
    <li key={todo.id} className={`todo status-${todo.status}`}>
      <button
        className="todo-check"
        title={t(STATUS_PHRASE[NEXT_STATUS[todo.status]])}
        aria-label={t(STATUS_PHRASE[todo.status])}
        onClick={() => void update(todo, { status: NEXT_STATUS[todo.status] })}
      >
        {todo.status === "done" ? "✓" : todo.status === "doing" ? "◐" : ""}
      </button>
      <div className="todo-main">
        <div className="todo-title">{todo.title}</div>
        <div className="muted small">
          {todo.visibility === "private" ? t("visibilityPrivate") : t("visibilityProject")}
          {todo.assignee !== undefined ? ` · → ${todo.assignee}` : ""}
          {todo.doneRevision !== undefined && todo.project !== undefined ? (
            <>
              {" · "}
              <a href={`/console/p/${encodeURIComponent(todo.project)}/history?rev=${encodeURIComponent(todo.doneRevision)}`}>
                {t("doneIn", { rev: todo.doneRevision.slice(0, 8) })}
              </a>
            </>
          ) : null}
        </div>
      </div>
      {project !== undefined && todo.owner === account.username && members !== undefined && todo.visibility === "project" ? (
        <select
          className="todo-assign"
          aria-label={t("assignTo")}
          value={todo.assignee ?? ""}
          onChange={(event) => void update(todo, { assignee: event.target.value === "" ? null : event.target.value })}
        >
          <option value="">{t("nobody")}</option>
          {members.map((member) => (
            <option key={member.username} value={member.username}>
              {member.displayName || member.username}
            </option>
          ))}
        </select>
      ) : null}
      {todo.owner === account.username ? (
        <button className="ghost small" onClick={() => void remove(todo)}>
          {t("remove")}
        </button>
      ) : null}
    </li>
  );

  return (
    <div className="todos">
      {error !== undefined ? <p className="error">{error}</p> : null}
      <form className="todo-new" onSubmit={(event) => void add(event)}>
        <input value={title} placeholder={t("newTodo")} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
        {project !== undefined ? (
          <label className="muted small todo-share">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
            {t("visibilityProject")}
          </label>
        ) : null}
        <button className="primary" type="submit">
          {t("add")}
        </button>
      </form>
      {todos === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : todos.length === 0 ? (
        <p className="placeholder-card">{t("noTodos")}</p>
      ) : project === undefined ? (
        <ul className="todo-list">{todos.map(card)}</ul>
      ) : (
        <div className="board">
          {(["open", "doing", "done"] as const).map((status) => (
            <section key={status} className="board-column">
              <div className="outline-title">
                {t(STATUS_PHRASE[status])} {todos.filter((todo) => todo.status === status).length}
              </div>
              <ul className="todo-list">{todos.filter((todo) => todo.status === status).map(card)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- home */

export function Home({ connection, state, account }: { connection: TeamConnection; state: ConnectionState; account: ConsoleAccount }) {
  const open = state.kind === "open";
  const accountId = state.kind === "open" ? state.hello.account.id : undefined;
  const [days, setDays] = useState<readonly TeamActivityDay[]>([]);
  const [profile, setProfile] = useState<TeamProfile | undefined>(undefined);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!open) return;
    connection
      .call<{ days: TeamActivityDay[] }>("activity.heatmap", { tzOffsetMinutes: new Date().getTimezoneOffset() })
      .then((answer) => setDays(answer.days))
      .catch(() => undefined);
    connection
      .call<{ profile: TeamProfile }>("account.profile.get", {})
      .then((answer) => setProfile(answer.profile))
      .catch(() => undefined);
    connection
      .call<{ projects: { id: string; name: string }[] }>("projects.list")
      .then((answer) => setNames(new Map(answer.projects.map((p) => [p.id, p.name]))))
      .catch(() => undefined);
  }, [open, connection]);
  return (
    <section className="home">
      <header className="home-head">
        <Face name={account.displayName || account.username} url={profile?.avatarUrl} size={56} />
        <div>
          <h1>{t("welcome", { name: account.displayName || account.username })}</h1>
          {profile?.bio ? <p className="muted">{profile.bio}</p> : <p className="muted">@{account.username}</p>}
        </div>
      </header>
      <Heatmap days={days} />
      <div className="home-columns">
        <div>
          <h2>{t("timeline")}</h2>
          <Timeline connection={connection} open={open} account={account.username} projectNames={names} />
        </div>
        <div>
          <h2>{t("myTodos")}</h2>
          <Todos connection={connection} open={open} account={{ ...account, ...(accountId === undefined ? {} : { id: accountId }) }} />
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- notifications */

const NOTIFICATION_PHRASE: Record<TeamNotification["kind"], Phrase> = { mention: "nMention", reply: "nReply", assigned: "nAssigned" };

/** The bell: a count of unread notifications, and the list when opened. */
export function Bell({ connection, state }: { connection: TeamConnection; state: ConnectionState }) {
  const [unread, setUnread] = useState(0);
  const [list, setList] = useState<readonly TeamNotification[] | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const accountId = state.kind === "open" ? state.hello.account.id : undefined;
  const load = useCallback(() => {
    connection
      .call<{ notifications: TeamNotification[]; unread: number }>("notifications.list", { limit: 30 })
      .then((answer) => {
        setUnread(answer.unread);
        setList(answer.notifications);
      })
      .catch(() => undefined);
  }, [connection]);
  useEffect(() => {
    if (accountId === undefined) return undefined;
    load();
    return connection.subscribe(accountNotificationsTopic(accountId), () => load());
  }, [accountId, connection, load]);
  return (
    <div className="bell">
      <button className="ghost bell-button" aria-label={t("notifications")} onClick={() => setShown((value) => !value)}>
        🔔{unread > 0 ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {shown ? (
        <div className="bell-panel card">
          <div className="bell-head">
            <strong>{t("notifications")}</strong>
            {unread > 0 ? (
              <button className="ghost small" onClick={() => void connection.call("notifications.read", { all: true })}>
                {t("markAllRead")}
              </button>
            ) : null}
          </div>
          {list === undefined || list.length === 0 ? (
            <p className="muted">{t("noNotifications")}</p>
          ) : (
            <ul className="bell-list">
              {list.map((n) => (
                <li key={n.id} className={n.readAt === undefined ? "unread" : ""}>
                  <div>{t(NOTIFICATION_PHRASE[n.kind], { who: n.actor ?? "?" })}</div>
                  {n.summary ? <div className="muted small">{n.summary}</div> : null}
                  <div className="muted small">{ago(n.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- settings */

/** Crop a picked image to a centred square and re-encode it as a 256px WebP, which drops its metadata. */
async function squareWebp(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("this browser cannot draw");
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob === null ? reject(new Error("could not encode")) : resolve(blob)), "image/webp", 0.88),
  );
}

export function Settings({ connection, state }: { connection: TeamConnection; state: ConnectionState }) {
  const open = state.kind === "open";
  const [profile, setProfile] = useState<TeamProfile | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const [devices, setDevices] = useState<readonly TeamAccountDevice[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    connection
      .call<{ profile: TeamProfile }>("account.profile.get", {})
      .then((answer) => {
        setProfile(answer.profile);
        setDisplayName(answer.profile.displayName);
        setBio(answer.profile.bio ?? "");
      })
      .catch(() => undefined);
    connection
      .call<{ devices: TeamAccountDevice[] }>("account.devices.list")
      .then((answer) => setDevices(answer.devices))
      .catch(() => undefined);
  }, [connection]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await connection.call("account.profile.update", { displayName, bio });
      setNote(t("saved"));
      load();
    } catch (caught) {
      setNote(errorText(caught));
    }
  };
  const upload = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      const body = await squareWebp(file);
      const response = await fetch("/api/console/v1/avatar", { method: "PUT", credentials: "same-origin", headers: { "content-type": "image/webp" }, body });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? response.statusText);
      load();
    } catch (caught) {
      setNote(errorText(caught));
    }
  };
  const removeAvatar = async () => {
    await fetch("/api/console/v1/avatar", { method: "DELETE", credentials: "same-origin" });
    load();
  };
  const connectLink = `narraleaf://team/connect?server=${encodeURIComponent(window.location.origin)}`;

  return (
    <section className="settings">
      <h1>{t("settings")}</h1>
      <div className="card settings-block">
        <h2>{t("profile")}</h2>
        <div className="avatar-row">
          <Face name={profile?.displayName || profile?.username || "?"} url={profile?.avatarUrl} size={64} />
          <button className="ghost" onClick={() => picker.current?.click()}>
            {t("changeAvatar")}
          </button>
          {profile?.avatarUrl !== undefined ? (
            <button className="ghost" onClick={() => void removeAvatar()}>
              {t("removeAvatar")}
            </button>
          ) : null}
          <input ref={picker} type="file" accept="image/*" hidden onChange={(event) => void upload(event.target.files?.[0])} />
        </div>
        <form className="stack" onSubmit={(event) => void save(event)}>
          <label>
            <span className="muted small">{t("displayName")}</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={128} required />
          </label>
          <label>
            <span className="muted small">{t("bio")}</span>
            <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={400} rows={3} />
          </label>
          <div className="actions">
            {note !== undefined ? <span className="muted small">{note}</span> : null}
            <button className="primary" type="submit">
              {t("save")}
            </button>
          </div>
        </form>
      </div>
      <div className="card settings-block">
        <h2>{t("devices")}</h2>
        {devices.length === 0 ? (
          <p className="muted">{t("noDevices")}</p>
        ) : (
          <ul className="member-list">
            {devices.map((device) => (
              <li key={device.id}>
                <span>
                  {device.name} <span className="muted small">· {device.client} · {ago(device.lastUsedAt)}</span>
                </span>
                <button
                  className="ghost small"
                  onClick={() => void connection.call("account.devices.revoke", { device: device.id }).then(load)}
                >
                  {t("signOutDevice")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card settings-block">
        <h2>{t("connectStudio")}</h2>
        <p className="muted">{t("connectStudioLead")}</p>
        <a className="primary link-button" href={connectLink}>
          {t("connectStudio")}
        </a>
      </div>
    </section>
  );
}
