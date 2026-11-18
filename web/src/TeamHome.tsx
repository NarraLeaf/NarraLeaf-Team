/**
 * The home page: where the person left off, what is waiting on them, and what
 * the whole team has been doing, a day at a time.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { TOPIC_PROJECTS, type TeamActivity, type TeamClientInstance, type TeamMilestone, type TeamReview, type TeamTodo } from "@narraleaf/team-protocol";

import type { ConsoleAccount } from "./api";
import { ACTIVITY_PHRASE, ago, Face, useNotifications } from "./Collab";
import { Icon } from "./Icon";
import { t, type Phrase } from "./i18n";
import { Flash, Hash } from "./ui";
import type { ConnectionState, TeamConnection } from "./socket";

/** Where somebody last read in the workbench, kept in this browser by the workbench. */
export interface LastPlace {
  readonly project: string;
  readonly projectName: string;
  readonly tab: string;
  readonly label?: string;
  readonly at: number;
}

const LAST_KEY = "nlteam.lastPlace";

export function rememberPlace(place: LastPlace): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(place));
  } catch {
    /* a private window: nothing to remember with */
  }
}

function lastPlace(): LastPlace | undefined {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as LastPlace);
  } catch {
    return undefined;
  }
}

const BETA_KEY = "nlteam.betaNoticeDismissed";
const ISSUES_URL = "https://github.com/NarraLeaf/NarraLeaf-Team/issues";

/** The console is a beta: say so on the home page until the person asks not to see it again. */
function BetaNotice() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(BETA_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(BETA_KEY, "1");
    } catch {
      /* a private window: hide it for this visit only */
    }
    setHidden(true);
  };
  const [before, after = ""] = t("betaNotice").split("{link}");
  return (
    <div className="beta-notice">
      <Flash
        tone="warning"
        action={
          <button className="btn btn-sm" type="button" onClick={dismiss}>
            {t("dontShowAgain")}
          </button>
        }
      >
        {before}
        <a href={ISSUES_URL} target="_blank" rel="noreferrer">
          {t("betaNoticeLink")}
        </a>
        {after}
      </Flash>
    </div>
  );
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly history?: { readonly lastAt?: number; readonly lastBy?: string };
}

type Filter = "all" | "story" | "comments" | "todos" | "versions";
const FILTERS: readonly Filter[] = ["all", "story", "comments", "todos", "versions"];
const FILTER_PHRASE: Record<Filter, Phrase> = {
  all: "filterAll",
  story: "filterEdits",
  comments: "filterComments",
  todos: "filterTodos",
  versions: "filterVersions",
};
const FILTER_KINDS: Record<Exclude<Filter, "all">, readonly TeamActivity["kind"][]> = {
  story: ["edit", "commit"],
  comments: ["thread", "comment", "resolve", "review", "approved", "sent-back"],
  todos: ["todo-created", "todo-done"],
  versions: ["version", "milestone", "build"],
};

/** A stable colour for a project, so its tag is the same on every page. */
export function projectHue(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 45% 55%)`;
}

/** Which page of a project a feed row is about. */
const FEED_TAB: Record<TeamActivity["kind"], string> = {
  commit: "history",
  edit: "story",
  version: "history",
  milestone: "history",
  thread: "story",
  comment: "story",
  resolve: "story",
  review: "reviews",
  "todo-created": "todos",
  "todo-done": "todos",
  approved: "story",
  "sent-back": "story",
  build: "builds",
};

/** The phrase for several of one kind of thing in a row, where one phrase cannot count them. */
const MANY_PHRASE: Record<TeamActivity["kind"], Phrase> = {
  commit: "aCommitMany",
  thread: "aThreadMany",
  comment: "aCommentMany",
  resolve: "aResolveMany",
  "todo-created": "aTodoCreatedMany",
  "todo-done": "aTodoDoneMany",
  review: "aReviewMany",
  milestone: "aMilestoneMany",
  edit: "aEdit",
  version: "aVersionMany",
  approved: "aApprovedMany",
  "sent-back": "aSentBackMany",
  build: "aBuildMany",
};

/** Someone in the feed: a team account where one matches, else the name a git commit carries. */
export interface Who {
  readonly name: string;
  readonly user?: string;
  readonly title?: string;
}

/**
 * Who an activity's actor is. Commits made outside Team carry a git identity,
 * "Name <email>"; that is a team account when the name or the email's local
 * part is an account's username or display name, and otherwise just the name.
 */
export function useWho(connection: TeamConnection, open: boolean): (actor: string) => Who {
  const [accounts, setAccounts] = useState<readonly { username: string; displayName: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    connection
      .call<{ members: { username: string; displayName: string }[] }>("members.list")
      .then((answer) => setAccounts(answer.members))
      .catch(() => undefined);
  }, [connection, open]);
  return useCallback(
    (actor: string): Who => {
      const git = /^(.*?)\s*<([^>]*)>$/.exec(actor);
      if (git === null) return { name: actor, user: actor };
      const name = (git[1] ?? "").trim() || actor;
      const local = (git[2] ?? "").split("@")[0]?.toLowerCase() ?? "";
      const lower = name.toLowerCase();
      const match = accounts.find(
        (account) => account.username.toLowerCase() === lower || account.displayName.toLowerCase() === lower || account.username.toLowerCase() === local,
      );
      return match === undefined ? { name, title: actor } : { name: match.username, user: match.username, title: actor };
    },
    [accounts],
  );
}

/** One line of the feed: an action, or a run of the same action by the same person on the same project. */
interface FeedEntry {
  readonly first: TeamActivity;
  readonly rows: TeamActivity[];
  readonly who: Who;
}

/** A row's note, with a restore's long revision cut to a short, copyable hash. */
function FeedNote({ summary }: { summary: string }) {
  const restored = /^Restored ([0-9a-f]{7,40})$/i.exec(summary.trim());
  if (restored !== null) {
    return (
      <span className="feed-note">
        <Icon name="history" size={13} /> {t("restoredTo")} <Hash value={restored[1] ?? ""} />
      </span>
    );
  }
  return <span className="feed-quote">{summary}</span>;
}

/** A note worth a line: not empty, and not a lone digit or mark someone typed to get past the save box. */
function worthShowing(summary: string | undefined): summary is string {
  return summary !== undefined && summary.trim().length > 1;
}

function dayLabel(at: number): string {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (day.toDateString() === today.toDateString()) return t("today");
  if (day.toDateString() === yesterday.toDateString()) return t("yesterday");
  return day.toLocaleDateString(undefined, { month: "long", day: "numeric", weekday: "short" });
}

export function TeamHome(props: {
  connection: TeamConnection;
  state: ConnectionState;
  account: ConsoleAccount;
  openProject: (id: string, tab?: string) => void;
  openNotifications: () => void;
  openProfile: () => void;
}) {
  const { connection, state, account, openProject, openNotifications, openProfile } = props;
  const open = state.kind === "open";
  const [projects, setProjects] = useState<readonly ProjectRow[] | undefined>(undefined);
  const [rows, setRows] = useState<readonly TeamActivity[] | undefined>(undefined);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>("all");
  const [reviews, setReviews] = useState<readonly TeamReview[]>([]);
  const [todos, setTodos] = useState<readonly TeamTodo[]>([]);
  const { unread } = useNotifications(connection, state);
  const [clients, setClients] = useState<readonly TeamClientInstance[]>([]);
  const [milestones, setMilestones] = useState<readonly TeamMilestone[]>([]);
  const place = useMemo(() => lastPlace(), []);
  const whoIs = useWho(connection, open);
  const [unfolded, setUnfolded] = useState<ReadonlySet<TeamActivity["id"]>>(new Set());

  const loadProjects = useCallback(() => {
    connection
      .call<{ projects: ProjectRow[] }>("projects.list")
      .then((answer) => setProjects(answer.projects))
      .catch(() => setProjects((current) => current ?? []));
  }, [connection]);

  const loadActivity = useCallback(
    (before?: number) => {
      connection
        .call<{ activity: TeamActivity[]; cursor?: number }>("activity.list", { limit: 40, ...(before === undefined ? {} : { cursor: before }) })
        .then((page) => {
          setRows((current) => [...(before === undefined ? [] : (current ?? [])), ...page.activity]);
          setCursor(page.cursor);
        })
        .catch(() => setRows((current) => current ?? []));
    },
    [connection],
  );

  useEffect(() => {
    if (!open) return undefined;
    loadProjects();
    loadActivity();
    connection
      .call<{ reviews: TeamReview[] }>("reviews.list", {})
      .then((answer) => setReviews(answer.reviews))
      .catch(() => undefined);
    connection
      .call<{ todos: TeamTodo[] }>("todos.list", {})
      .then((answer) => setTodos(answer.todos))
      .catch(() => undefined);
    const loadClients = () =>
      connection
        .call<{ clients: TeamClientInstance[] }>("clients.list", {})
        .then((answer) => setClients(answer.clients))
        .catch(() => undefined);
    void loadClients();
    const timer = setInterval(() => void loadClients(), 30_000);
    const off = connection.subscribe(TOPIC_PROJECTS, () => loadProjects());
    return () => {
      clearInterval(timer);
      off();
    };
  }, [open, connection, loadProjects, loadActivity]);

  // The newest names put on revisions, across every project.
  const projectIds = (projects ?? []).map((row) => row.id).join(",");
  useEffect(() => {
    if (!open || projectIds === "") return;
    Promise.all(
      projectIds.split(",").map((id) =>
        connection
          .call<{ milestones: TeamMilestone[] }>("milestones.list", { project: id })
          .then((answer) => answer.milestones)
          .catch(() => [] as TeamMilestone[]),
      ),
    ).then((lists) => setMilestones(lists.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)));
  }, [open, connection, projectIds]);

  const names = useMemo(() => new Map((projects ?? []).map((row) => [row.id, row.name])), [projects]);
  const askedOfMe = reviews.filter((review) => review.status === "open" && review.reviewer === account.username);
  const myTodos = todos.filter((todo) => todo.status !== "done");

  const shown = (rows ?? []).filter((row) => filter === "all" || FILTER_KINDS[filter].includes(row.kind));
  // A day at a time, and in a day, one line for a run of the same thing by the same person on the same project.
  const days: { label: string; items: FeedEntry[] }[] = [];
  for (const row of shown) {
    const label = dayLabel(row.at);
    const who = whoIs(row.actor);
    let day = days[days.length - 1];
    if (day === undefined || day.label !== label) {
      day = { label, items: [] };
      days.push(day);
    }
    const last = day.items[day.items.length - 1];
    if (last !== undefined && last.first.kind === row.kind && last.first.project === row.project && last.who.name === who.name) last.rows.push(row);
    else day.items.push({ first: row, rows: [row], who });
  }
  const phraseOf = (entry: FeedEntry) => {
    const kind = entry.first.kind;
    if (kind === "edit") return t("aEdit", { count: String(entry.rows.reduce((sum, row) => sum + (row.count ?? 1), 0)) });
    return entry.rows.length > 1 ? t(MANY_PHRASE[kind], { count: String(entry.rows.length) }) : t(ACTIVITY_PHRASE[kind], { count: String(entry.first.count ?? 1) });
  };
  // Who has worked on each project lately, newest first, for the faces on its card.
  const editorsOf = (project: string) => [...new Set((rows ?? []).filter((row) => row.project === project).map((row) => whoIs(row.actor).name))].slice(0, 4);
  const allClear = unread === 0 && askedOfMe.length === 0 && myTodos.length === 0;

  // People in Studio, not this console's own windows; one each, however many windows.
  const studio = clients.filter((client) => client.agent !== "nlteam-console");
  const people = [...new Set(studio.map((client) => client.account))];
  const onlineIn = (project: string) => new Set(studio.filter((client) => client.project === project).map((client) => client.account)).size;
  const name = account.displayName || account.username;
  const placeProject = place === undefined ? undefined : names.has(place.project) || projects === undefined ? place : undefined;

  return (
    <section className="team-home">
      <header className="page-head">
        <div>
          <p className="muted small">{new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</p>
          <h1 className="page-title">{t("welcome", { name })}</h1>
        </div>
        {people.length > 0 ? (
          <div className="online-people" aria-label={t("inStudioNow", { count: String(people.length) })}>
            <span className="face-stack">
              {people.slice(0, 5).map((person) => (
                <Face key={person} name={person} user={person} size={28} />
              ))}
            </span>
            <span className="muted small">
              <span className="online-dot" aria-hidden="true" /> {t("inStudioNow", { count: String(people.length) })}
            </span>
          </div>
        ) : null}
      </header>

      <BetaNotice />

      {placeProject !== undefined ? (
        <button className="continue-card" onClick={() => openProject(placeProject.project, placeProject.tab)}>
          <span className="continue-icon">
            <Icon name="workbench" size={22} />
          </span>
          <span className="continue-text">
            <span className="continue-kicker">{t("continueKicker")}</span>
            <span className="continue-title">
              {placeProject.projectName}
              {placeProject.label === undefined ? null : ` · ${placeProject.label}`}
            </span>
            <span className="muted small">{t("continueWhen", { when: ago(placeProject.at) })}</span>
          </span>
          <span className="continue-go">{t("enterWorkbench")} →</span>
        </button>
      ) : null}

      <div className="home-grid">
        <section className="home-feed" aria-label={t("teamActivity")}>
          <div className="section-head">
            <h2>{t("teamActivity")}</h2>
            <div className="chip-row" role="group" aria-label={t("filter")}>
              {FILTERS.map((key) => (
                <button key={key} className={filter === key ? "chip active" : "chip"} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {t(FILTER_PHRASE[key])}
                </button>
              ))}
            </div>
          </div>
          {rows === undefined ? (
            <p className="muted">{t("loading")}</p>
          ) : days.length === 0 ? (
            <div className="placeholder-card">{t("noActivity")}</div>
          ) : (
            days.map((day) => (
              <div key={day.label} className="feed-day">
                <h3 className="feed-day-label">{day.label}</h3>
                <ol className="feed-list">
                  {day.items.map((entry) => {
                    const row = entry.first;
                    const notes = entry.rows.filter((one) => worthShowing(one.summary));
                    const expanded = unfolded.has(row.id);
                    const visible = expanded ? notes : notes.slice(0, 1);
                    return (
                      <li
                        key={row.id}
                        className={row.project !== undefined ? "feed-row clickable" : "feed-row"}
                        onClick={() => row.project !== undefined && openProject(row.project, FEED_TAB[row.kind])}
                      >
                        <Face name={entry.who.name} user={entry.who.user} size={28} />
                        <div className="feed-main">
                          <span>
                            <strong title={entry.who.title}>{entry.who.name}</strong> <span className="muted">{phraseOf(entry)}</span>
                            {row.project !== undefined ? (
                              <button
                                className="project-tag"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openProject(row.project ?? "");
                                }}
                              >
                                <span className="project-dot" style={{ background: projectHue(row.project) }} />
                                {names.get(row.project) ?? row.project}
                              </button>
                            ) : null}
                          </span>
                          {visible.map((one) => (
                            <FeedNote key={one.id} summary={one.summary ?? ""} />
                          ))}
                          {notes.length > 1 ? (
                            <button
                              className="feed-fold"
                              onClick={(event) => {
                                event.stopPropagation();
                                setUnfolded((current) => {
                                  const next = new Set(current);
                                  if (expanded) next.delete(row.id);
                                  else next.add(row.id);
                                  return next;
                                });
                              }}
                            >
                              {expanded ? t("hideFolded") : t("showFolded", { count: String(notes.length - 1) })}
                            </button>
                          ) : null}
                        </div>
                        <span className="muted small nowrap" title={new Date(row.at).toLocaleString()}>
                          {ago(row.at)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))
          )}
          {cursor !== undefined ? (
            <button className="ghost more" onClick={() => loadActivity(cursor)}>
              {t("loadMore")}
            </button>
          ) : null}
        </section>

        <aside className="home-side">
          <section aria-label={t("waitingOnYou")}>
            <h2>{t("waitingOnYou")}</h2>
            {allClear ? (
              <p className="all-clear">
                <span className="all-clear-icon">
                  <Icon name="tick" size={14} />
                </span>
                <span>
                  <strong>{t("allClear")}</strong>
                  <span className="muted small">{t("allClearHint")}</span>
                </span>
              </p>
            ) : (
              <div className="waiting">
                <button className="waiting-row" onClick={openNotifications} disabled={unread === 0}>
                  <span className="waiting-count tone-warning">{unread}</span>
                  <span className="waiting-text">{t("waitingNotifications")}</span>
                </button>
                <button className="waiting-row" onClick={() => askedOfMe[0] !== undefined && openProject(askedOfMe[0].project, "reviews")} disabled={askedOfMe.length === 0}>
                  <span className="waiting-count tone-binding">{askedOfMe.length}</span>
                  <span className="waiting-text">{t("waitingReviews")}</span>
                </button>
                <button className="waiting-row" onClick={openProfile} disabled={myTodos.length === 0}>
                  <span className="waiting-count tone-primary">{myTodos.length}</span>
                  <span className="waiting-text">{t("waitingTodos")}</span>
                </button>
              </div>
            )}
          </section>

          <section aria-label={t("projects")}>
            <h2>{t("projects")}</h2>
            {projects === undefined ? (
              <p className="muted">{t("loading")}</p>
            ) : projects.length === 0 ? (
              <div className="placeholder-card">{t("noProjects")}</div>
            ) : (
              <div className="project-cards">
                {projects.map((row) => (
                  <button key={row.id} className="project-card" onClick={() => openProject(row.id)}>
                    <span className="project-card-head">
                      <span className="project-dot big" style={{ background: projectHue(row.id) }} />
                      <span className="project-card-name">{row.title ?? row.name}</span>
                      {onlineIn(row.id) > 0 ? <span className="online-count">● {t("onlineCount", { count: String(onlineIn(row.id)) })}</span> : null}
                    </span>
                    <span className="project-card-foot">
                      {editorsOf(row.id).length > 0 ? (
                        <span className="face-stack" title={t("recentEditors", { names: editorsOf(row.id).join("、") })}>
                          {editorsOf(row.id).map((person) => (
                            <Face key={person} name={person} user={person} size={20} />
                          ))}
                        </span>
                      ) : null}
                      <span className="muted small">
                        {row.history?.lastAt === undefined ? row.description || t("noChangesYet") : t("lastChangeShort", { when: ago(row.history.lastAt) })}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {milestones.length > 0 ? (
            <section aria-label={t("recentVersions")}>
              <h2>{t("recentVersions")}</h2>
              <ul className="version-list">
                {milestones.map((milestone) => (
                  <li key={milestone.id}>
                    <button className="version-row" onClick={() => openProject(milestone.project, "history")}>
                      <span className="version-tag">{milestone.name}</span>
                      <span className="muted small version-project">{names.get(milestone.project) ?? ""}</span>
                      <span className="muted small">{ago(milestone.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
