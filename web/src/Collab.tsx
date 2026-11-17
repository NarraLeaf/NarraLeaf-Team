/**
 * The console's personal half: the home page (contribution graph, timeline,
 * my to-dos), a project's to-do board, notifications, and one's own settings.
 *
 * Everything is a call on the socket; what each viewer may see is decided by
 * the server (src/collab/), so nothing here hides anything.
 */
import { ApiTokens, TwoFactorPanel } from "./Security";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  accountNotificationsTopic,
  accountTodosTopic,
  projectTodosTopic,
  type TeamAccountDevice,
  type TeamAccountPolicy,
  type TeamActivity,
  type TeamActivityDay,
  type TeamNotification,
  type TeamProfile,
  type TeamSavedFilter,
  type TeamTodo,
  type TeamTodoKind,
  type TeamTodoStatus,
} from "@narraleaf/team-protocol";

import type { ConsoleAccount } from "./api";
import { AvatarCropper } from "./Cropper";
import { localTimeIn, NotificationSettings, timeZones } from "./Notify";
import { LockedNote } from "./Locked";
import { StudioConfigCard, useAccountPolicy } from "./Policy";
import { Icon, type IconName } from "./Icon";
import { useMilestoneList } from "./Progress";
import { byPriorityThenDue, DuePicker, dueLabel, dueTone, KIND_PHRASE, KINDS, labelHue, PRIORITIES, PRIORITY_PHRASE, PriorityFlag, TodoComposer } from "./TodoComposer";
import { studioConnectLink } from "./studioLink";
import { chooseLanguage, chosenLanguage, t, type Language, type Phrase } from "./i18n";
import { chooseTheme, chosenTheme, type ThemeChoice } from "./theme";
import { ago } from "./ui/time";
import { Blankslate, confirmAction, Flash, SelectPanel, SettingsLayout, Skeleton, Subhead, toast, toastError, UnderlineNav } from "./ui";
import type { ConnectionState, TeamConnection } from "./socket";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export { ago };

/*
 * Faces by username. Most places only know who did something, not where their
 * picture is, so a face asks for the profile once per username and every face
 * of that person shares the answer.
 */
let faceSource: TeamConnection | undefined;
const faceAsked = new Set<string>();
const faceKnown = new Map<string, string | undefined>();
const faceListeners = new Set<() => void>();

/** The socket faces ask through; the shell sets it once it has one. */
export function setFaceSource(connection: TeamConnection): void {
  if (faceSource === connection) return;
  faceSource = connection;
  faceAsked.clear();
  faceKnown.clear();
}

/** Ask again for a username's picture, as after it changes. */
export function forgetFace(username: string): void {
  faceAsked.delete(username);
  faceKnown.delete(username);
  for (const listener of faceListeners) listener();
}

function useAvatarOf(username: string | undefined): string | undefined {
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = () => redraw((n) => n + 1);
    faceListeners.add(listener);
    return () => void faceListeners.delete(listener);
  }, []);
  useEffect(() => {
    if (username === undefined || faceSource === undefined || faceAsked.has(username)) return;
    faceAsked.add(username);
    faceSource
      .call<{ profile: TeamProfile }>("account.profile.get", { username })
      .then(
        (answer) => {
          faceKnown.set(username, answer.profile.avatarUrl);
          for (const listener of faceListeners) listener();
        },
        (caught: unknown) => {
          // Not connected yet: ask again on a later draw. Anything else is an answer.
          if (caught instanceof Error && caught.message === "not connected") faceAsked.delete(username);
          else faceKnown.set(username, undefined);
        },
      );
  });
  return username === undefined ? undefined : faceKnown.get(username);
}

/** A face: the account's picture, or a letter in the name's own colour. */
export function Face({ name, url, user, size = 26 }: { name: string; url?: string | undefined; user?: string | undefined; size?: number }) {
  const looked = useAvatarOf(url === undefined ? user : undefined);
  const picture = url ?? looked;
  // A picture that will not load shows the initial instead of a broken image.
  const [broken, setBroken] = useState<string | undefined>(undefined);
  if (picture !== undefined && picture !== broken) {
    return <img className="avatar" src={picture} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(picture)} />;
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
  // Where the year does not fit, the weeks scroll and open on the latest ones.
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (grid.current !== null) grid.current.scrollLeft = grid.current.scrollWidth;
  }, [days]);
  return (
    <div className="heatmap-card card">
      <div className="muted small">{t("contributions", { count: String(total) })}</div>
      <div className="heatmap" ref={grid} role="img" aria-label={t("contributions", { count: String(total) })}>
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

export const ACTIVITY_PHRASE: Record<TeamActivity["kind"], Phrase> = {
  commit: "aCommit",
  thread: "aThread",
  comment: "aComment",
  resolve: "aResolve",
  "todo-created": "aTodoCreated",
  "todo-done": "aTodoDone",
  review: "aReview",
  milestone: "aMilestone",
  edit: "aEdit",
  version: "aVersion",
  approved: "aApproved",
  "sent-back": "aSentBack",
  build: "aBuild",
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
                <strong>{row.actor}</strong> {t(ACTIVITY_PHRASE[row.kind], { count: String(row.count ?? 1) })}
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
  assetPreview,
}: {
  connection: TeamConnection;
  open: boolean;
  account: ConsoleAccount & { readonly id?: string };
  project?: string;
  members?: readonly { username: string; displayName: string }[];
  /** Draws the asset that answered an asset request, where the project's files are at hand. */
  assetPreview?: (asset: string) => ReactNode;
}) {
  const [todos, setTodos] = useState<readonly TeamTodo[] | undefined>(undefined);
  const [only, setOnly] = useState<TeamTodoKind | "all">("all");
  const [label, setLabel] = useState<string | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const milestones = useMilestoneList(connection, open && project !== undefined, project ?? "");
  const [labelling, setLabelling] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const labelsInUse = useMemo(() => [...new Set((todos ?? []).flatMap((todo) => todo.labels ?? []))].sort((a, b) => a.localeCompare(b)), [todos]);
  const filter: TodoFilter = { kind: only, ...(label === undefined ? {} : { label }), ...(mine ? { mine } : {}) };
  const applyFilter = (next: TodoFilter) => {
    setOnly(next.kind);
    setLabel(next.label);
    setMine(next.mine === true);
  };
  const passes = (todo: TeamTodo) =>
    (only === "all" || (todo.kind ?? "task") === only) &&
    (label === undefined || (todo.labels ?? []).includes(label)) &&
    (!mine || todo.assignee === account.username || (todo.assignee === undefined && todo.owner === account.username));

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

  const create = (fields: Record<string, unknown>) => connection.call("todos.create", fields);
  /** Open work in the order a to-do app keeps it: what matters most, then what is due soonest. */
  const ordered = useMemo(() => byPriorityThenDue(todos ?? []), [todos]);
  const own = (todo: TeamTodo) => todo.owner === account.username;
  const update = (todo: TeamTodo, fields: Record<string, unknown>) =>
    connection.call("todos.update", { todo: todo.id, ...fields }).catch((caught: unknown) => setError(errorText(caught)));
  const remove = (todo: TeamTodo) => connection.call("todos.delete", { todo: todo.id }).catch((caught: unknown) => setError(errorText(caught)));

  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [over, setOver] = useState<TeamTodoStatus | undefined>(undefined);
  const dropOn = (status: TeamTodoStatus) => {
    const todo = todos?.find((one) => one.id === dragging);
    setDragging(undefined);
    setOver(undefined);
    if (todo !== undefined && todo.status !== status) void update(todo, { status });
  };
  const card = (todo: TeamTodo) => (
    <li
      key={todo.id}
      className={`todo status-${todo.status} prio-${todo.priority ?? 0}${dragging === todo.id ? " dragging" : ""}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", todo.id);
        setDragging(todo.id);
      }}
      onDragEnd={() => {
        setDragging(undefined);
        setOver(undefined);
      }}
    >
      <button
        className="todo-check"
        title={t(STATUS_PHRASE[NEXT_STATUS[todo.status]])}
        aria-label={todo.priority === undefined ? t(STATUS_PHRASE[todo.status]) : `${t(STATUS_PHRASE[todo.status])} · ${t(PRIORITY_PHRASE[todo.priority])}`}
        onClick={() => void update(todo, { status: NEXT_STATUS[todo.status] })}
      >
        {todo.status === "done" ? "✓" : todo.status === "doing" ? "◐" : ""}
      </button>
      <div className="todo-main">
        <div className="todo-title">
          {todo.kind !== undefined && todo.kind !== "task" ? (
            <span className={`badge kind-${todo.kind}`}>
              {t(KIND_PHRASE[todo.kind])}
              {todo.locale ? ` · ${todo.locale}` : ""}
            </span>
          ) : null}{" "}
          {todo.title}
        </div>
        {(todo.labels ?? []).length > 0 || labelling === todo.id ? (
          <div className="todo-labels">
            {(todo.labels ?? []).map((name) => (
              <button key={name} className={label === name ? "todo-label active" : "todo-label"} style={{ ["--label-hue" as string]: String(labelHue(name)) }} onClick={() => setLabel(label === name ? undefined : name)}>
                {name}
              </button>
            ))}
            {labelling === todo.id ? (
              <LabelEditor
                labels={todo.labels ?? []}
                known={labelsInUse}
                done={(labels) => {
                  setLabelling(undefined);
                  if (labels !== undefined) void update(todo, { labels });
                }}
              />
            ) : null}
          </div>
        ) : null}
        {todo.kind === "asset" && todo.asset !== undefined ? (
          <div className="todo-answer">{assetPreview === undefined ? <span className="muted small">{t("todoAssetLinked")}</span> : assetPreview(todo.asset)}</div>
        ) : null}
        <div className="todo-meta muted small">
          {todo.dueAt === undefined ? null : own(todo) ? (
            <DuePicker
              value={todo.dueAt}
              onChange={(at) => void update(todo, { dueAt: at ?? null })}
              align="start"
              className={`todo-due due-${todo.status === "done" ? "later" : dueTone(todo.dueAt)}`}
              title={`${t("todoDue")}: ${new Date(todo.dueAt).toLocaleDateString()}`}
            >
              <Icon name="calendar" size={12} /> {dueLabel(todo.dueAt)}
            </DuePicker>
          ) : (
            <span className={`todo-due due-${todo.status === "done" ? "later" : dueTone(todo.dueAt)}`} title={`${t("todoDue")}: ${new Date(todo.dueAt).toLocaleDateString()}`}>
              <Icon name="calendar" size={12} /> {dueLabel(todo.dueAt)}
            </span>
          )}
          {todo.priority === undefined || own(todo) ? null : (
            <span className="todo-prio" title={t(PRIORITY_PHRASE[todo.priority])}>
              <PriorityFlag priority={todo.priority} size={12} /> {t(PRIORITY_PHRASE[todo.priority])}
            </span>
          )}
          <span>{todo.visibility === "private" ? t("visibilityPrivate") : t("visibilityProject")}</span>
          {todo.assignee !== undefined ? <span>→ {todo.assignee}</span> : null}
          {todo.milestone === undefined ? null : (
            <span>
              <Icon name="diamond" size={12} /> {milestones?.find((milestone) => milestone.id === todo.milestone)?.name ?? "…"}
            </span>
          )}
          {todo.doneRevision !== undefined && todo.project !== undefined ? (
            <a href={`/console/p/${encodeURIComponent(todo.project)}/history?rev=${encodeURIComponent(todo.doneRevision)}`}>
              {t("doneIn", { rev: todo.doneRevision.slice(0, 8) })}
            </a>
          ) : null}
        </div>
      </div>
      <div className="todo-tools">
        {own(todo) ? (
          <SelectPanel
            className={todo.priority === undefined ? "todo-prio-pick todo-tool-quiet" : "todo-prio-pick"}
            size="small"
            align="end"
            label={t("todoPriority")}
            value={String(todo.priority ?? 0)}
            onChange={(value) => void update(todo, { priority: Number(value) })}
            renderButton={() => (
              <span className="btn btn-invisible btn-icon btn-sm" title={`${t("todoPriority")}: ${t(PRIORITY_PHRASE[todo.priority ?? 0])}`}>
                <PriorityFlag priority={todo.priority ?? 0} size={14} />
              </span>
            )}
            options={PRIORITIES.map((priority) => ({ value: String(priority), label: t(PRIORITY_PHRASE[priority]), leading: <PriorityFlag priority={priority} size={14} /> }))}
          />
        ) : null}
        {own(todo) && todo.dueAt === undefined ? (
          <DuePicker value={undefined} onChange={(at) => void update(todo, { dueAt: at ?? null })} className="btn btn-invisible btn-icon btn-sm todo-tool-quiet">
            <Icon name="calendar" size={14} />
          </DuePicker>
        ) : null}
        {project !== undefined && todo.owner === account.username && members !== undefined && todo.visibility === "project" ? (
          <SelectPanel
            className="todo-assign"
            size="small"
            align="end"
            label={t("assignTo")}
            value={todo.assignee ?? ""}
            onChange={(username) => void update(todo, { assignee: username === "" ? null : username })}
            options={[
              { value: "", label: t("nobody") },
              ...members.map((member) => ({
                value: member.username,
                label: member.displayName || member.username,
                description: member.displayName ? `@${member.username}` : undefined,
                leading: <Face name={member.displayName || member.username} user={member.username} size={18} />,
              })),
            ]}
          />
        ) : null}
        {project !== undefined && todo.visibility === "project" && todo.owner === account.username && (milestones ?? []).length > 0 ? (
          <SelectPanel
            className="todo-milestone"
            size="small"
            align="end"
            label={t("todoMilestone")}
            value={todo.milestone ?? ""}
            onChange={(id) => void update(todo, { milestone: id === "" ? null : id })}
            options={[
              { value: "", label: t("todoNoMilestone") },
              ...(milestones ?? []).map((milestone) => ({
                value: milestone.id,
                label: milestone.name,
                icon: "diamond" as const,
                description: milestone.dueAt === undefined ? undefined : new Date(milestone.dueAt).toLocaleDateString(),
              })),
            ]}
          />
        ) : null}
        {own(todo) && labelling !== todo.id ? (
          <button className={(todo.labels ?? []).length === 0 ? "btn btn-invisible btn-icon btn-sm todo-tool-quiet" : "btn btn-invisible btn-icon btn-sm"} aria-label={t("todoLabelsEdit")} title={t("todoLabelsEdit")} onClick={() => setLabelling(todo.id)}>
            <Icon name="tag" size={14} />
          </button>
        ) : null}
        {todo.owner === account.username ? (
          <button className="btn btn-invisible btn-icon btn-sm todo-remove" aria-label={t("remove")} title={t("remove")} onClick={() => void remove(todo)}>
            <Icon name="trash" size={14} />
          </button>
        ) : null}
      </div>
    </li>
  );

  return (
    <div className="todos">
      {error !== undefined ? <Flash error={error} /> : null}
      <TodoComposer
        project={project}
        members={members}
        milestones={milestones}
        knownLabels={labelsInUse}
        defaultKind={only === "all" ? "task" : only}
        face={(member, size) => <Face name={member.displayName || member.username} user={member.username} size={size} />}
        create={create}
      />
      {todos === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : todos.length === 0 ? (
        <Blankslate icon="todo" title={t("noTodos")} compact>
          {t("noTodosHint")}
        </Blankslate>
      ) : project === undefined ? (
        <Board todos={ordered} card={card} over={over} setOver={setOver} dropOn={dropOn} />
      ) : (
        <>
        <div className="kind-filter-row">
          <nav className="kind-filter">
            {(["all", ...KINDS] as const).map((name) => (
              <button key={name} className={only === name ? "tab active" : "tab"} onClick={() => setOnly(name)}>
                {name === "all" ? t("kindAll") : t(KIND_PHRASE[name])} {name === "all" ? todos.length : todos.filter((todo) => (todo.kind ?? "task") === name).length}
              </button>
            ))}
          </nav>
        </div>
        <div className="todo-filters">
          <button className={mine ? "chip active" : "chip"} aria-pressed={mine} onClick={() => setMine(!mine)}>
            {t("todoMine")}
          </button>
          {labelsInUse.map((name) => (
            <button
              key={name}
              className={label === name ? "chip todo-label-chip active" : "chip todo-label-chip"}
              style={{ ["--label-hue" as string]: String(labelHue(name)) }}
              aria-pressed={label === name}
              onClick={() => setLabel(label === name ? undefined : name)}
            >
              {name}
            </button>
          ))}
          <SavedFilters connection={connection} open={open} scope={`todos:${project}`} current={filter} apply={applyFilter} />
        </div>
        {only === "translation" || only === "voice" ? <LocaleProgress todos={todos.filter((todo) => todo.kind === only)} /> : null}
        <Board todos={ordered.filter(passes)} card={card} over={over} setOver={setOver} dropOn={dropOn} />
        </>
      )}
    </div>
  );
}

interface TodoFilter {
  readonly kind: TeamTodoKind | "all";
  readonly label?: string;
  readonly mine?: boolean;
}

function readFilter(query: string): TodoFilter | undefined {
  try {
    const value = JSON.parse(query) as Partial<TodoFilter>;
    return {
      kind: typeof value.kind === "string" ? (value.kind as TodoFilter["kind"]) : "all",
      ...(typeof value.label === "string" ? { label: value.label } : {}),
      ...(value.mine === true ? { mine: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Labels typed with commas between them; the ones already in use offered below. */
function LabelEditor({ labels, known, done }: { labels: readonly string[]; known: readonly string[]; done: (labels: string[] | undefined) => void }) {
  const [text, setText] = useState(labels.join(", "));
  const typed = text
    .split(/[,，]/)
    .map((one) => one.trim())
    .filter((one) => one !== "");
  const offered = known.filter((one) => !typed.includes(one)).slice(0, 8);
  return (
    <form
      className="label-editor"
      onSubmit={(event) => {
        event.preventDefault();
        done([...new Set(typed)]);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") done(undefined);
      }}
    >
      <input autoFocus value={text} placeholder={t("todoLabelsHint")} maxLength={300} onChange={(event) => setText(event.target.value)} />
      {offered.length > 0 ? (
        <span className="label-offers">
          {offered.map((one) => (
            <button key={one} type="button" className="todo-label" style={{ ["--label-hue" as string]: String(labelHue(one)) }} onClick={() => setText([...typed, one].join(", "))}>
              + {one}
            </button>
          ))}
        </span>
      ) : null}
      <button className="btn btn-primary btn-sm" type="submit">
        {t("save")}
      </button>
      <button className="btn btn-sm" type="button" onClick={() => done(undefined)}>
        {t("cancel")}
      </button>
    </form>
  );
}

/** Filters kept by name, for this person, and a way to keep the one on screen. */
function SavedFilters({
  connection,
  open,
  scope,
  current,
  apply,
}: {
  connection: TeamConnection;
  open: boolean;
  scope: string;
  current: TodoFilter;
  apply: (filter: TodoFilter) => void;
}) {
  const [filters, setFilters] = useState<readonly TeamSavedFilter[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const load = useCallback(() => {
    connection
      .call<{ filters: TeamSavedFilter[] }>("filters.list", { scope })
      .then((answer) => setFilters(answer.filters))
      .catch(() => setFilters([]));
  }, [connection, scope]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const query = JSON.stringify(current);
  const plain = current.kind === "all" && current.label === undefined && current.mine !== true;
  const save = (event: FormEvent) => {
    event.preventDefault();
    void connection
      .call("filters.save", { scope, name: name.trim(), query })
      .then(() => {
        setNaming(false);
        setName("");
        toast(t("filterSaved"));
        load();
      })
      .catch(toastError);
  };
  return (
    <span className="saved-filters">
      {filters.map((filter) => {
        const read = readFilter(filter.query);
        return (
          <span key={filter.id} className={filter.query === query ? "chip saved-filter active" : "chip saved-filter"}>
            <button className="saved-filter-name" onClick={() => read !== undefined && apply(read)}>
              <Icon name="search" size={12} /> {filter.name}
            </button>
            <button
              className="saved-filter-remove"
              aria-label={t("remove")}
              onClick={() =>
                void connection
                  .call("filters.delete", { filter: filter.id })
                  .then(load)
                  .catch(toastError)
              }
            >
              ×
            </button>
          </span>
        );
      })}
      {naming ? (
        <form className="saved-filter-new" onSubmit={save}>
          <input autoFocus value={name} placeholder={t("filterName")} maxLength={60} onChange={(event) => setName(event.target.value)} />
          <button className="btn btn-primary btn-sm" type="submit" disabled={name.trim() === ""}>
            {t("save")}
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setNaming(false)}>
            {t("cancel")}
          </button>
        </form>
      ) : plain || filters.some((filter) => filter.query === query) ? null : (
        <button className="btn btn-invisible btn-sm" onClick={() => setNaming(true)}>
          + {t("filterSave")}
        </button>
      )}
    </span>
  );
}

/** Three columns a card can be dragged between, or moved with its check button. */
function Board({
  todos,
  card,
  over,
  setOver,
  dropOn,
}: {
  todos: readonly TeamTodo[];
  card: (todo: TeamTodo) => React.ReactNode;
  over: TeamTodoStatus | undefined;
  setOver: (status: TeamTodoStatus | undefined) => void;
  dropOn: (status: TeamTodoStatus) => void;
}) {
  return (
    <div className="board">
      {(["open", "doing", "done"] as const).map((status) => (
        <section
          key={status}
          className={over === status ? "board-column drop-here" : "board-column"}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (over !== status) setOver(status);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dropOn(status);
          }}
        >
          <div className="board-head">
            <span>{t(STATUS_PHRASE[status])}</span>
            <span className="muted small">{todos.filter((todo) => todo.status === status).length}</span>
          </div>
          <ul className="todo-list">{todos.filter((todo) => todo.status === status).map(card)}</ul>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- home */

export function Profile({ connection, state, account }: { connection: TeamConnection; state: ConnectionState; account: ConsoleAccount }) {
  const open = state.kind === "open";
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
  const name = account.displayName || account.username;
  return (
    <section className="profile-page">
      <aside className="profile-card">
        <Face name={name} url={profile?.avatarUrl} size={112} />
        <div className="profile-names">
          <h1>{name}</h1>
          <span className="muted">@{account.username}</span>
        </div>
        {profile?.bio ? <p className="profile-bio">{profile.bio}</p> : null}
        <a className="button-outline" href="/console/settings" onClick={(event) => {
          event.preventDefault();
          window.history.pushState(null, "", "/console/settings");
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}>
          {t("editProfile")}
        </a>
        {names.size > 0 ? (
          <div className="profile-projects">
            <h2 className="muted small">{t("myProjects")}</h2>
            {[...names.entries()].map(([id, projectName]) => (
              <a
                key={id}
                className="profile-project"
                href={`/console/p/${encodeURIComponent(id)}/overview`}
                onClick={(event) => {
                  event.preventDefault();
                  window.history.pushState(null, "", `/console/p/${encodeURIComponent(id)}/overview`);
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              >
                {projectName}
              </a>
            ))}
          </div>
        ) : null}
      </aside>
      <div className="profile-main">
        <section>
          <h2>{t("contributionsTitle")}</h2>
          <Heatmap days={days} />
        </section>
        <section>
          <h2>{t("timeline")}</h2>
          <Timeline connection={connection} open={open} account={account.username} projectNames={names} />
        </section>
      </div>
    </section>
  );
}

/** Per language: how many of its translation or voice to-dos are done. */
function LocaleProgress({ todos }: { todos: readonly TeamTodo[] }) {
  const byLocale = new Map<string, { done: number; all: number }>();
  for (const todo of todos) {
    const key = todo.locale ?? "?";
    const entry = byLocale.get(key) ?? { done: 0, all: 0 };
    entry.all += 1;
    if (todo.status === "done") entry.done += 1;
    byLocale.set(key, entry);
  }
  return (
    <div className="locale-progress">
      {[...byLocale.entries()].sort().map(([locale, { done, all }]) => (
        <div key={locale} className="locale-row">
          <span className="locale-name">{locale}</span>
          <span className="meter">
            <span style={{ width: `${Math.round((done / all) * 100)}%` }} />
          </span>
          <span className="muted small">
            {done}/{all}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- notifications */

const NOTIFICATION_PHRASE: Record<TeamNotification["kind"], Phrase> = {
  mention: "nMention",
  reply: "nReply",
  assigned: "nAssigned",
  "review-requested": "nReviewRequested",
  "review-answered": "nReviewAnswered",
  "access-requested": "nAccessRequested",
  "access-decided": "nAccessDecided",
  watch: "nWatch",
};


/** The caller's notifications and how many are unread, kept current by their topic. */
export function useNotifications(connection: TeamConnection, state: ConnectionState): {
  unread: number;
  list: readonly TeamNotification[] | undefined;
  readAll: () => void;
} {
  const [unread, setUnread] = useState(0);
  const [list, setList] = useState<readonly TeamNotification[] | undefined>(undefined);
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
  return { unread, list, readAll: () => void connection.call("notifications.read", { all: true }).catch(() => undefined) };
}

/** Where a notification leads, as the shell routes it. */
export type NotificationTarget = { readonly project?: string; readonly tab: string; readonly chat?: boolean };

export function notificationTarget(n: TeamNotification): NotificationTarget {
  if (n.ref?.startsWith("chat:") === true) return { ...(n.project === undefined ? {} : { project: n.project }), tab: "story", chat: true };
  if (n.kind === "assigned") return { ...(n.project === undefined ? {} : { project: n.project }), tab: n.project === undefined ? "me" : "todos" };
  if (n.kind === "review-requested" || n.kind === "review-answered") return { ...(n.project === undefined ? {} : { project: n.project }), tab: "reviews" };
  // A request waits in its project's settings, or the back office for leave to make projects; an answer lands on the project or the project list.
  if (n.kind === "access-requested") return n.project === undefined ? { tab: "admin" } : { project: n.project, tab: "settings" };
  if (n.kind === "access-decided") return n.project === undefined ? { tab: "projects" } : { project: n.project, tab: "overview" };
  return { ...(n.project === undefined ? {} : { project: n.project }), tab: "story" };
}

export function NotificationList({
  list,
  connection,
  open,
}: {
  list: readonly TeamNotification[] | undefined;
  connection?: TeamConnection;
  open?: (target: NotificationTarget) => void;
}) {
  if (list === undefined || list.length === 0) return <p className="muted">{t("noNotifications")}</p>;
  return (
    <ul className="bell-list">
      {list.map((n) => (
        <li key={n.id} className={n.readAt === undefined ? "unread" : ""}>
          <button
            className="bell-item"
            onClick={() => {
              if (n.readAt === undefined) void connection?.call("notifications.read", { ids: [n.id] }).catch(() => undefined);
              open?.(notificationTarget(n));
            }}
          >
            <Face name={n.actor ?? "?"} user={n.actor} size={26} />
            <span className="bell-item-text">
              <span>{t(NOTIFICATION_PHRASE[n.kind], { who: n.actor ?? "?" })}</span>
              {n.summary ? <span className="muted small bell-summary">{n.summary}</span> : null}
              <span className="muted small">{ago(n.at)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The notifications as a page of their own: an inbox, unread first, as GitHub keeps one. */
export function Notifications({ connection, state, open }: { connection: TeamConnection; state: ConnectionState; open?: (target: NotificationTarget) => void }) {
  const { unread, list, readAll } = useNotifications(connection, state);
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const shown = list === undefined ? undefined : filter === "unread" ? list.filter((n) => n.readAt === undefined) : list;
  return (
    <section className="page-narrow inbox">
      <header className="page-head">
        <h1 className="page-title">{t("notifications")}</h1>
        <button className="btn btn-sm" disabled={unread === 0} onClick={readAll}>
          <Icon name="tick" size={14} />
          {t("markAllRead")}
        </button>
      </header>
      <UnderlineNav
        label={t("notifications")}
        active={filter}
        onSelect={setFilter}
        tabs={[
          { key: "unread", label: t("inboxUnread"), count: unread },
          { key: "all", label: t("inboxAll") },
        ]}
      />
      {shown === undefined ? (
        <Skeleton rows={4} />
      ) : shown.length === 0 ? (
        <Blankslate icon="bell" title={filter === "unread" ? t("inboxZero") : t("noNotifications")}>
          {filter === "unread" ? t("inboxZeroLead") : t("inboxEmptyLead")}
        </Blankslate>
      ) : (
        <NotificationList list={shown} connection={connection} {...(open === undefined ? {} : { open })} />
      )}
    </section>
  );
}

/** The to-dos of whoever is looking, across every project, as a board. */
export function MyTodos({ connection, state, account }: { connection: TeamConnection; state: ConnectionState; account: ConsoleAccount }) {
  const accountId = state.kind === "open" ? state.hello.account.id : undefined;
  return (
    <section className="my-todos">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("myTodos")}</h1>
          <p className="muted">{t("myTodosLead")}</p>
        </div>
      </header>
      <Todos connection={connection} open={state.kind === "open"} account={{ ...account, ...(accountId === undefined ? {} : { id: accountId }) }} />
    </section>
  );
}

/* --------------------------------------------------------------- settings */

/** The parts of the personal settings, each on a page of its own, the way GitHub's are. */
export const PERSONAL_SECTIONS = ["profile", "appearance", "notifications", "security", "tokens", "studio"] as const;
export type PersonalSection = (typeof PERSONAL_SECTIONS)[number];
const PERSONAL_PHRASE: Record<PersonalSection, Phrase> = {
  profile: "profile",
  appearance: "appearance",
  notifications: "notifications",
  security: "adminSecurity",
  tokens: "tokensTitle",
  studio: "settingsStudio",
};
const PERSONAL_ICON: Record<PersonalSection, IconName> = {
  profile: "people",
  appearance: "palette",
  notifications: "bell",
  security: "shield",
  tokens: "key",
  studio: "leaf",
};

/** This browser's look and language: kept here, not on the account. */
function Appearance() {
  const [theme, setTheme] = useState<ThemeChoice>(() => chosenTheme());
  return (
    <div>
      <Subhead title={t("appearance")}>{t("appearanceLead")}</Subhead>
      <div className="box">
        <div className="box-row">
          <div className="box-row-text">
            <strong>{t("theme")}</strong>
            <span>{t("themeLead")}</span>
          </div>
          <div className="segmented" role="group" aria-label={t("theme")}>
            {(["system", "light", "dark"] as const).map((choice) => (
              <button
                key={choice}
                aria-pressed={theme === choice}
                className={theme === choice ? "active" : undefined}
                onClick={() => {
                  chooseTheme(choice);
                  setTheme(choice);
                }}
              >
                {t(choice === "system" ? "themeSystem" : choice === "light" ? "themeLight" : "themeDark")}
              </button>
            ))}
          </div>
        </div>
        <div className="box-row">
          <div className="box-row-text">
            <strong>{t("languageLabel")}</strong>
            <span>{t("languageHint")}</span>
          </div>
          <LanguageSelect />
        </div>
      </div>
    </div>
  );
}

function LanguageSelect() {
  const current = chosenLanguage();
  return (
    <SelectPanel<"" | Language>
      label={t("languageLabel")}
      align="end"
      value={current ?? ""}
      onChange={(chosen) => chooseLanguage(chosen === "" ? undefined : chosen)}
      options={[
        { value: "", label: t("languageAuto") },
        { value: "zh", label: "中文" },
        { value: "en", label: "English" },
        { value: "ja", label: "日本語" },
      ]}
    />
  );
}

export function LanguagePicker() {
  return (
    <div className="setting-row">
      <span>{t("languageLabel")}</span>
      <LanguageSelect />
    </div>
  );
}

/** Name, words about oneself, time zone and picture: what the rest of the team sees. */
function ProfileSettings({ connection, open, policy }: { connection: TeamConnection; open: boolean; policy?: TeamAccountPolicy | undefined }) {
  const [profile, setProfile] = useState<TeamProfile | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | undefined>(undefined);
  const nameLocked = policy?.displayName !== undefined;
  const bioLocked = policy?.bio !== undefined;
  const zoneLocked = policy?.timezone !== undefined;
  const avatarLocked = policy?.lockAvatar === true;

  const load = useCallback(() => {
    connection
      .call<{ profile: TeamProfile }>("account.profile.get", {})
      .then((answer) => {
        setProfile(answer.profile);
        setDisplayName(answer.profile.displayName);
        setBio(answer.profile.bio ?? "");
        setTimezone(answer.profile.timezone ?? "");
      })
      .catch(() => undefined);
  }, [connection]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const unchanged =
    profile !== undefined && displayName === profile.displayName && bio === (profile.bio ?? "") && timezone === (profile.timezone ?? "");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await connection.call("account.profile.update", {
        ...(nameLocked ? {} : { displayName }),
        ...(bioLocked ? {} : { bio }),
        ...(zoneLocked ? {} : { timezone }),
      });
      toast(t("saved"));
      load();
    } catch (caught) {
      toastError(caught);
    } finally {
      setSaving(false);
    }
  };
  const upload = async (body: Blob | undefined) => {
    if (body === undefined) return;
    try {
      const response = await fetch("/api/console/v1/avatar", { method: "PUT", credentials: "same-origin", headers: { "content-type": "image/webp" }, body });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? response.statusText);
      load();
      if (profile !== undefined) forgetFace(profile.username);
    } catch (caught) {
      toastError(caught);
    }
  };
  const removeAvatar = async () => {
    await fetch("/api/console/v1/avatar", { method: "DELETE", credentials: "same-origin" });
    load();
    if (profile !== undefined) forgetFace(profile.username);
  };
  const localTime = timezone === "" ? undefined : localTimeIn(timezone);

  return (
    <div>
      <Subhead title={t("profile")}>{t("profileLead")}</Subhead>
      <div className="profile-grid">
        <form className="profile-fields" onSubmit={(event) => void save(event)}>
          <label className="form-field">
            <span className="form-label">
              {t("displayName")} {nameLocked ? <LockedNote /> : null}
            </span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={128} required disabled={nameLocked} />
          </label>
          <label className="form-field">
            <span className="form-label">
              {t("bio")} {bioLocked ? <LockedNote /> : null}
            </span>
            <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={400} rows={3} disabled={bioLocked} />
          </label>
          <div className="form-field">
            <span className="form-label">
              {t("timezone")} {zoneLocked ? <LockedNote /> : null}
            </span>
            <SelectPanel<string>
              label={t("timezone")}
              value={timezone === "" ? "-" : timezone}
              filterFrom={0}
              options={[{ value: "-", label: t("timezoneUnset") }, ...timeZones().map((zone) => ({ value: zone, label: zone }))]}
              onChange={(zone) => setTimezone(zone === "-" ? "" : zone)}
              disabled={zoneLocked}
            />
            <span className="form-hint">{localTime === undefined ? t("timezoneHint") : t("timezoneNow", { time: localTime })}</span>
          </div>
          <div className="profile-save">
            <button className="btn btn-primary" type="submit" disabled={saving || unchanged || (nameLocked && bioLocked && zoneLocked)}>
              {saving ? t("sending") : t("saveProfile")}
            </button>
          </div>
        </form>
        <div className="profile-picture">
          <span className="form-label">
            {t("avatar")} {avatarLocked ? <LockedNote /> : null}
          </span>
          <Face name={profile?.displayName || profile?.username || "?"} url={profile?.avatarUrl} size={160} />
          {avatarLocked ? null : (
            <div className="profile-picture-actions">
              <button className="btn btn-sm" onClick={() => picker.current?.click()}>
                <Icon name="upload" size={14} /> {t("changeAvatar")}
              </button>
              {profile?.avatarUrl === undefined ? null : (
                <button className="btn btn-invisible btn-sm" onClick={() => void removeAvatar()}>
                  {t("removeAvatar")}
                </button>
              )}
            </div>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              setCropping(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </div>
      {cropping !== undefined ? (
        <AvatarCropper
          file={cropping}
          cancel={() => setCropping(undefined)}
          done={(blob) => {
            setCropping(undefined);
            void upload(blob);
          }}
        />
      ) : null}
    </div>
  );
}

/** Two-step sign-in and the Studio apps signed in to this account. */
function SecuritySettings({ connection, open }: { connection: TeamConnection; open: boolean }) {
  const [devices, setDevices] = useState<readonly TeamAccountDevice[] | undefined>(undefined);
  const load = useCallback(() => {
    connection
      .call<{ devices: TeamAccountDevice[] }>("account.devices.list")
      .then((answer) => setDevices(answer.devices))
      .catch(() => setDevices([]));
  }, [connection]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const signOut = (device: TeamAccountDevice) =>
    void confirmAction({ title: t("signOutDeviceTitle", { name: device.name }), body: t("signOutDeviceBody"), confirmLabel: t("signOutDevice"), danger: true }).then(
      (yes) =>
        yes &&
        void connection
          .call("account.devices.revoke", { device: device.id })
          .then(load)
          .catch(toastError),
    );
  return (
    <>
      <div>
        <Subhead title={t("adminSecurity")}>{t("securityLead")}</Subhead>
        {open ? <TwoFactorPanel connection={connection} /> : <Skeleton />}
      </div>
      <div>
        <Subhead title={t("devices")}>{t("devicesLead")}</Subhead>
        {devices === undefined ? (
          <Skeleton />
        ) : devices.length === 0 ? (
          <div className="box">
            <Blankslate icon="workbench" title={t("noDevices")} compact />
          </div>
        ) : (
          <div className="box">
            {devices.map((device) => (
              <div key={device.id} className="box-row">
                <Icon name="workbench" size={18} />
                <div className="box-row-text">
                  <strong>{device.name}</strong>
                  <span>
                    {device.client} · {t("lastUsed", { when: ago(device.lastUsedAt) })}
                  </span>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => signOut(device)}>
                  {t("signOutDevice")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Opening Studio already pointed at this server, and the Studio settings kept here. */
function StudioSettings({ connection, open }: { connection: TeamConnection; open: boolean }) {
  const [connectLink, setConnectLink] = useState<string | undefined>(undefined);
  useEffect(() => {
    void studioConnectLink().then(setConnectLink);
  }, []);
  return (
    <>
      <div>
        <Subhead title={t("connectStudioTitle")}>{t("settingsStudioLead")}</Subhead>
        <div className="box">
          <div className="box-row">
            <Icon name="leaf" size={18} />
            <div className="box-row-text">
              <strong>{t("connectStudio")}</strong>
              <span>{t("connectStudioLead")}</span>
            </div>
            <a className="btn btn-primary btn-sm" href={connectLink}>
              <Icon name="external" size={14} /> {t("connectStudioOpen")}
            </a>
          </div>
        </div>
      </div>
      <StudioConfigCard connection={connection} open={open} />
    </>
  );
}

export function Settings({
  connection,
  state,
  section,
  go,
}: {
  connection: TeamConnection;
  state: ConnectionState;
  section: PersonalSection;
  go: (section: PersonalSection) => void;
}) {
  const open = state.kind === "open";
  const policy = useAccountPolicy(connection, open)?.policy;
  const item = (key: PersonalSection) => ({ key, label: t(PERSONAL_PHRASE[key]), icon: PERSONAL_ICON[key] });
  return (
    <section className="settings-page">
      <header className="page-head">
        <h1 className="page-title">{t("settings")}</h1>
      </header>
      <SettingsLayout
        label={t("settings")}
        active={section}
        onSelect={go}
        groups={[(["profile", "appearance", "notifications"] as const).map(item), (["security", "tokens"] as const).map(item), (["studio"] as const).map(item)]}
      >
        {section === "profile" ? <ProfileSettings connection={connection} open={open} policy={policy} /> : null}
        {section === "appearance" ? <Appearance /> : null}
        {section === "notifications" ? <NotificationSettings connection={connection} open={open} policy={policy} /> : null}
        {section === "security" ? <SecuritySettings connection={connection} open={open} /> : null}
        {section === "tokens" ? open ? <ApiTokens connection={connection} policy={policy} /> : <Skeleton /> : null}
        {section === "studio" ? <StudioSettings connection={connection} open={open} /> : null}
      </SettingsLayout>
    </section>
  );
}
