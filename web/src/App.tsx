/**
 * The console's shell: setting up or signing in, then a quiet side menu, the
 * screen the address names, and a tab bar instead of the menu on a phone. The
 * project workbench (story, blueprints, assets, to-dos) takes the whole window,
 * the way Studio's does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { TOPIC_PROJECTS, type TeamProjectRole } from "@narraleaf/team-protocol";

import { currentSession, signOut, type ConsoleAccount, type Watermark } from "./api";
import { t, type Phrase } from "./i18n";
import { TeamConnection, type ConnectionState } from "./socket";
import { Authorize, Device } from "./OAuth";
import { ProjectPage, WORKBENCH_TABS, type ProjectSection, type ProjectTab } from "./Project";
import { Face, MyTodos, Notifications, Profile, Settings, setFaceSource, useNotifications, type NotificationTarget } from "./Collab";
import { Admin, ADMIN_PHRASE, ADMIN_SECTIONS, type AdminSection } from "./Admin";
import { PROJECT_SETTINGS_SECTIONS } from "./Versions";
import { PROGRESS_SECTIONS } from "./Progress";
import { JoinProjects } from "./Access";
import { Icon } from "./Icon";
import { teamName, teamNameUnset, useLook, type TeamLook } from "./look";
import { Setup, SignIn, TeamMark } from "./SignIn";
import { ShareView } from "./Builds";
import { projectHue, TeamHome } from "./TeamHome";
import { Palette, type PaletteItem } from "./Palette";
import { Blankslate, Flash, UiHost } from "./ui";

type Route =
  | { readonly screen: "home" }
  | { readonly screen: "projects" }
  | { readonly screen: "me" }
  | { readonly screen: "todos" }
  | { readonly screen: "notifications" }
  | { readonly screen: "admin"; readonly section: AdminSection }
  | { readonly screen: "settings" }
  | { readonly screen: "notFound" }
  | {
      readonly screen: "project";
      readonly id: string;
      readonly tab: ProjectTab;
      readonly revision: string;
      readonly section?: ProjectSection;
      /** The compare page's `<from>...<to>`. */
      readonly range?: string;
    };

const PROJECT_TABS: readonly ProjectTab[] = ["overview", "discussion", "story", "blueprints", "assets", "todos", "reviews", "history", "compare", "checks", "progress", "builds", "settings"];
const PLAIN_SCREENS = ["projects", "me", "todos", "notifications", "settings"] as const;

/** The screen an address names; one that names nothing is "not found", never quietly the home page. */
function routeOf(location: Location): Route {
  const rest = location.pathname.replace(/^\/console\/?/, "").replace(/\/+$/, "");
  const parts = rest === "" ? [] : rest.split("/");
  const [first, second, third, ...more] = parts;
  if (first === undefined) return { screen: "home" };
  if (first === "p" && second !== undefined) {
    const tab = third === undefined ? "overview" : PROJECT_TABS.find((key) => key === third);
    const section = more[0];
    if (tab === undefined) return { screen: "notFound" };
    const revision = new URLSearchParams(location.search).get("rev") ?? "head";
    const base = { screen: "project", id: decodeURIComponent(second), tab, revision } as const;
    if (section === undefined) return more.length === 0 ? base : { screen: "notFound" };
    if (tab === "compare") return more.length > 1 ? { screen: "notFound" } : { ...base, range: decodeURIComponent(section) };
    const known: ProjectSection | undefined =
      tab === "settings"
        ? PROJECT_SETTINGS_SECTIONS.find((key) => key === section)
        : tab === "progress"
          ? PROGRESS_SECTIONS.find((key) => key === section)
          : undefined;
    return known === undefined || more.length > 1 ? { screen: "notFound" } : { ...base, section: known };
  }
  if (first === "admin" && third === undefined) {
    const section = second === undefined ? "accounts" : ADMIN_SECTIONS.find((key) => key === second);
    return section === undefined ? { screen: "notFound" } : { screen: "admin", section };
  }
  const plain = PLAIN_SCREENS.find((key) => key === first);
  if (plain !== undefined && second === undefined) return { screen: plain };
  // The notification settings live on the settings page; a push's "test" link names them.
  if (first === "settings" && second === "notifications" && third === undefined) return { screen: "settings" };
  return { screen: "notFound" };
}

function pathOf(route: Route): string {
  if (route.screen === "project") {
    const query = route.revision === "head" ? "" : `?rev=${encodeURIComponent(route.revision)}`;
    const section =
      (route.tab === "settings" && route.section !== undefined && route.section !== "general") ||
      (route.tab === "progress" && route.section !== undefined && route.section !== "stats")
        ? `/${route.section ?? ""}`
        : route.tab === "compare" && route.range !== undefined
          ? `/${encodeURIComponent(route.range).replaceAll("%2E", ".")}`
          : "";
    return `/console/p/${encodeURIComponent(route.id)}/${route.tab}${section}${query}`;
  }
  if (route.screen === "admin") return route.section === "accounts" ? "/console/admin" : `/console/admin/${route.section}`;
  if (route.screen === "notFound") return window.location.pathname;
  return route.screen === "home" ? "/console/" : `/console/${route.screen}`;
}

/** The team's mark, as the older screens ask for it. */
export function BrandMark({ logo }: { logo?: string | undefined }) {
  return logo === undefined ? <span className="brand-mark" aria-hidden="true" /> : <img className="brand-logo-mark" src={logo} alt="" />;
}

export function App() {
  return (
    <>
      <AppBody />
      <UiHost />
    </>
  );
}

function AppBody() {
  const [session, setSession] = useState<{ account: ConsoleAccount; watermark: Watermark } | null | undefined>(undefined);
  const look = useLook();

  const refresh = useCallback(() => {
    currentSession()
      .then((found) => setSession(found ?? null))
      .catch(() => setSession(null));
  }, []);
  useEffect(() => refresh(), [refresh]);

  if (session === undefined || look === undefined) {
    return <div className="splash" aria-busy="true" />;
  }
  const path = window.location.pathname;
  // A share link is for somebody with no account: it opens whether or not anybody is signed in.
  const shared = /^\/console\/s\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  if (shared !== null) return <ShareView token={shared[1]!} />;
  const standalone = path.startsWith("/console/oauth/authorize") ? "authorize" : path.startsWith("/console/device") ? "device" : undefined;
  if (session === null) {
    if (look.setupNeeded) {
      return (
        <Setup
          look={look}
          onDone={() => {
            window.history.replaceState(null, "", "/console/");
            refresh();
          }}
        />
      );
    }
    if (path.startsWith("/console/setup")) window.history.replaceState(null, "", "/console/");
    return <SignIn look={look} onSignedIn={() => refresh()} hint={standalone === undefined ? undefined : t("notSignedInHint")} />;
  }
  if (path.startsWith("/console/setup")) window.history.replaceState(null, "", "/console/");
  const mark = <WatermarkLayer watermark={session.watermark} account={session.account} />;
  if (standalone === "authorize") {
    return (
      <>
        <Authorize account={session.account} look={look} />
        {mark}
      </>
    );
  }
  if (standalone === "device") {
    return (
      <>
        <Device />
        {mark}
      </>
    );
  }
  return (
    <>
      <Shell account={session.account} look={look} onSignedOut={() => setSession(null)} />
      {mark}
    </>
  );
}

/**
 * The username of whoever is looking, across every page, when an operator has
 * turned it on: a photograph of a screen then says whose screen it was. Drawn
 * as a tiled picture under nothing - it takes no clicks and no layout.
 */
function WatermarkLayer({ watermark, account }: { watermark: Watermark; account: ConsoleAccount }) {
  const image = useMemo(() => {
    if (!watermark.enabled) return undefined;
    // The username, which is unique and does not change, unlike a display name.
    const lines = [account.username, watermark.text ?? ""];
    const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220">` +
      `<g transform="rotate(-24 180 110)" fill="rgb(128,128,128)" fill-opacity="0.14" font-family="sans-serif" font-size="15" text-anchor="middle">` +
      `<text x="180" y="104">${escape(lines[0] ?? "")}</text><text x="180" y="126" font-size="12">${escape(lines[1] ?? "")}</text></g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }, [watermark, account]);
  if (image === undefined) return null;
  return <div className="watermark" aria-hidden="true" style={{ backgroundImage: image }} />;
}

interface SideProject {
  readonly id: string;
  readonly name: string;
}

function Shell({ account, look, onSignedOut }: { account: ConsoleAccount; look: TeamLook; onSignedOut: () => void }) {
  const connection = useMemo(() => new TeamConnection(), []);
  setFaceSource(connection);
  const [state, setState] = useState<ConnectionState>(connection.state);
  const [route, setRoute] = useState<Route>(() => routeOf(window.location));
  const [projects, setProjects] = useState<readonly SideProject[]>([]);
  const [palette, setPalette] = useState(false);
  const open = state.kind === "open";

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
      }
    };
    const ask = () => setPalette(true);
    window.addEventListener("keydown", key);
    window.addEventListener("nlteam:palette", ask);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("nlteam:palette", ask);
    };
  }, []);

  useEffect(() => {
    const off = connection.onState((next) => {
      setState(next);
      if (next.kind === "closed") {
        // A refused handshake reaches a page as a bare close; asking whether
        // the session still stands is how the page tells "signed out" from
        // "server restarting". A server that is down answers nothing at all;
        // that is "restarting", and the socket's own retry deals with it.
        void currentSession()
          .then((still) => {
            if (still === undefined) {
              connection.stop();
              onSignedOut();
            }
          })
          .catch(() => undefined);
      }
    });
    connection.start();
    return () => {
      off();
      connection.stop();
    };
  }, [connection, onSignedOut]);

  useEffect(() => {
    if (!open) return undefined;
    // A layout picked while setting up waits for the first socket to send it.
    const layout = sessionStorage.getItem("nlteam.setupLayout");
    if (layout !== null) {
      sessionStorage.removeItem("nlteam.setupLayout");
      void connection.call("admin.brand.set", { signinLayout: layout }).catch(() => undefined);
    }
    const load = () =>
      connection
        .call<{ projects: SideProject[] }>("projects.list")
        .then((answer) => setProjects(answer.projects))
        .catch(() => undefined);
    void load();
    return connection.subscribe(TOPIC_PROJECTS, () => void load());
  }, [open, connection]);

  useEffect(() => {
    const back = () => setRoute(routeOf(window.location));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const go = useCallback((next: Route) => {
    window.history.pushState(null, "", pathOf(next));
    setRoute(next);
    window.scrollTo(0, 0);
  }, []);

  const rawName = state.kind === "open" ? state.hello.server.name : look.name;
  const serverName = teamName(rawName);
  const nameUnset = teamNameUnset(rawName) && teamNameUnset(look.name);
  const openProject = (id: string, tab?: string) =>
    go({ screen: "project", id, tab: PROJECT_TABS.find((key) => key === tab) ?? "overview", revision: "head" });
  const followNotification = (target: NotificationTarget) => {
    if (target.chat === true) {
      try {
        localStorage.setItem("nlteam.chatOpen", "1");
        localStorage.setItem("nlteam.chatTab", "channel");
      } catch {
        /* nothing to remember with */
      }
    }
    if (target.project !== undefined) openProject(target.project, target.tab);
    else if (target.tab === "admin" && account.operator) go({ screen: "admin", section: "requests" });
    else go({ screen: target.tab === "me" ? "todos" : target.tab === "projects" ? "projects" : "home" });
  };
  const { unread } = useNotifications(connection, state);
  const name = account.displayName || account.username;
  const workbench = route.screen === "project" && WORKBENCH_TABS.includes(route.tab);
  const signOutNow = () => {
    connection.stop();
    void signOut().then(onSignedOut);
  };

  const currentProject = route.screen === "project" ? projects.find((project) => project.id === route.id) : undefined;
  const paletteItems: PaletteItem[] = [
    { id: "home", icon: "home", label: t("home"), run: () => go({ screen: "home" }) },
    { id: "notifications", icon: "bell", label: t("notifications"), run: () => go({ screen: "notifications" }) },
    { id: "todos", icon: "check", label: t("myTodos"), run: () => go({ screen: "todos" }) },
    { id: "me", icon: "people", label: t("myProfile"), run: () => go({ screen: "me" }) },
    { id: "settings", icon: "gear", label: t("settings"), run: () => go({ screen: "settings" }) },
    ...(account.operator
      ? ADMIN_SECTIONS.map((section) => ({
          id: `admin:${section}`,
          icon: "shield" as const,
          label: `${t("admin")} · ${t(ADMIN_PHRASE[section])}`,
          run: () => go({ screen: "admin", section }),
        }))
      : []),
    ...projects.flatMap((project) => [
      { id: `p:${project.id}`, icon: "folder" as const, label: project.name, hint: t("projects"), run: () => openProject(project.id) },
      { id: `w:${project.id}`, icon: "workbench" as const, label: `${project.name} · ${t("enterWorkbench")}`, run: () => openProject(project.id, "story") },
    ]),
  ];
  const openLine = (project: string, scene: string) => {
    go({ screen: "project", id: project, tab: "story", revision: "head" });
    window.history.replaceState(null, "", `${window.location.pathname}?scene=${encodeURIComponent(scene)}`);
    window.dispatchEvent(new CustomEvent("nlteam:scene", { detail: scene }));
  };
  const paletteView = palette ? (
    <Palette
      items={paletteItems}
      projects={projects}
      project={currentProject === undefined ? undefined : { id: currentProject.id, name: currentProject.name }}
      openLine={openLine}
      close={() => setPalette(false)}
    />
  ) : null;

  const content = (
    <>
      {route.screen === "home" ? (
        <TeamHome
          connection={connection}
          state={state}
          account={account}
          openProject={openProject}
          openNotifications={() => go({ screen: "notifications" })}
          openProfile={() => go({ screen: "me" })}
        />
      ) : null}
      {route.screen === "me" ? <Profile connection={connection} state={state} account={account} /> : null}
      {route.screen === "todos" ? <MyTodos connection={connection} state={state} account={account} /> : null}
      {route.screen === "notFound" ? <NotFound home={() => go({ screen: "home" })} /> : null}
      {route.screen === "notifications" ? <Notifications connection={connection} state={state} open={followNotification} /> : null}
      {route.screen === "settings" ? <Settings connection={connection} state={state} /> : null}
      {route.screen === "projects" ? <Projects connection={connection} state={state} operator={account.operator} open={(id) => openProject(id)} /> : null}
      {route.screen === "project" ? (
        <ProjectPage
          account={account}
          connection={connection}
          state={state}
          projectId={route.id}
          tab={route.tab}
          revision={route.revision}
          section={route.section}
          isOperator={account.operator}
          range={route.range}
          go={(tab, revision, section) => go({ screen: "project", id: route.id, tab, revision, ...(section === undefined ? {} : { section }) })}
          compare={(range) => {
            const next: Route = { screen: "project", id: route.id, tab: "compare", revision: "head", range };
            // Picking another end of the same comparison replaces the address rather than stacking up history.
            if (route.tab === "compare") {
              window.history.replaceState(null, "", pathOf(next));
              setRoute(next);
            } else go(next);
          }}
          back={() => go({ screen: "home" })}
        />
      ) : null}
      {route.screen === "admin" ? (
        <Admin connection={connection} state={state} me={account.username} section={route.section} go={(section) => go({ screen: "admin", section })} />
      ) : null}
    </>
  );

  if (workbench) {
    return (
      <div className="app app-workbench">
        {content}
        {paletteView}
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="side" aria-label={t("mainNav")}>
        <div className="side-brand">
          <TeamMark look={look} size={24} />
          <span className="side-brand-text">
            <span className="side-brand-name">{serverName}</span>
            {nameUnset && account.operator ? (
              <button className="side-brand-setup" onClick={() => go({ screen: "admin", section: "brand" })}>
                {t("setTeamName")}
              </button>
            ) : null}
          </span>
        </div>
        <button className="side-search" onClick={() => setPalette(true)}>
          <Icon name="search" />
          <span className="side-link-text">{t("searchHint")}</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="side-group">
          <SideLink icon="home" label="home" active={route.screen === "home"} onClick={() => go({ screen: "home" })} />
          <SideLink icon="bell" label="notifications" count={unread} active={route.screen === "notifications"} onClick={() => go({ screen: "notifications" })} />
          <SideLink icon="check" label="myTodos" active={route.screen === "todos"} onClick={() => go({ screen: "todos" })} />
        </div>
        <div className="side-group">
          <button className="side-heading" onClick={() => go({ screen: "projects" })}>
            {t("projects")}
          </button>
          {projects.map((project) => (
            <button
              key={project.id}
              className={route.screen === "project" && route.id === project.id ? "side-link active" : "side-link"}
              aria-current={route.screen === "project" && route.id === project.id ? "page" : undefined}
              onClick={() => openProject(project.id)}
            >
              <span className="project-dot" style={{ background: projectHue(project.id) }} />
              <span className="side-link-text">{project.name}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          {account.operator ? <SideLink icon="shield" label="admin" active={route.screen === "admin"} onClick={() => go({ screen: "admin", section: "accounts" })} /> : null}
          <SideLink icon="gear" label="settings" active={route.screen === "settings"} onClick={() => go({ screen: "settings" })} />
          <ConnectionBadge state={state} connection={connection} />
          <div className="side-user">
            <button className={route.screen === "me" ? "side-user-main active" : "side-user-main"} title={t("myProfile")} onClick={() => go({ screen: "me" })}>
              <Face name={name} user={account.username} size={28} />
              <span className="side-link-text">{name}</span>
            </button>
            <button className="ghost icon-button" onClick={signOutNow} aria-label={t("signOut")} title={t("signOut")}>
              <Icon name="out" />
            </button>
          </div>
        </div>
      </nav>
      <main className="main">{content}</main>
      {paletteView}
      <TabBar route={route} go={go} unread={unread} name={name} user={account.username} />
    </div>
  );
}

function SideLink({
  icon,
  label,
  active,
  onClick,
  count,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: Phrase;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button className={active ? "side-link active" : "side-link"} aria-current={active ? "page" : undefined} onClick={onClick}>
      <Icon name={icon} />
      <span className="side-link-text">{t(label)}</span>
      {count === undefined || count === 0 ? null : <span className="counter side-count">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

/** The phone's navigation: four places at the bottom, where a thumb is. */
function TabBar({ route, go, unread, name, user }: { route: Route; go: (route: Route) => void; unread: number; name: string; user: string }) {
  const tab = (screen: "home" | "projects" | "notifications" | "me", icon: Parameters<typeof Icon>[0]["name"] | undefined, label: Phrase) => {
    const active = route.screen === screen || (screen === "projects" && route.screen === "project");
    return (
      <button className={active ? "tab-item active" : "tab-item"} aria-current={active ? "page" : undefined} onClick={() => go({ screen })}>
        {icon === undefined ? <Face name={name} user={user} size={22} /> : <Icon name={icon} size={22} />}
        <span>{t(label)}</span>
        {screen === "notifications" && unread > 0 ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
    );
  };
  return (
    <nav className="tabbar" aria-label={t("mainNav")}>
      {tab("home", "home", "home")}
      {tab("projects", "folder", "projects")}
      {tab("notifications", "bell", "notifications")}
      {tab("me", undefined, "me")}
    </nav>
  );
}

/** How often the header times a round trip to the server. */
const PING_EVERY_MS = 5_000;
/** How many round trips the shown figure is the middle of, so one slow answer does not jump it. */
const PING_SAMPLES = 5;

/**
 * The round trip to the server, in milliseconds, kept up to date while the socket is open: the
 * middle of the last few `server.ping` calls, timed on the same socket every other call takes.
 * Not asked while the tab is hidden; undefined while there is no connection or no answer yet.
 */
function useLatency(connection: TeamConnection, open: boolean): { median: number; last: number } | undefined {
  const [latency, setLatency] = useState<{ median: number; last: number } | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      setLatency(undefined);
      return undefined;
    }
    let alive = true;
    const samples: number[] = [];
    const once = async () => {
      if (document.visibilityState === "hidden") return;
      const started = performance.now();
      try {
        await connection.call("server.ping", { sent: Date.now() });
      } catch {
        return;
      }
      const last = performance.now() - started;
      samples.push(last);
      if (samples.length > PING_SAMPLES) samples.shift();
      const sorted = [...samples].sort((a, b) => a - b);
      if (alive) setLatency({ median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? last), last: Math.round(last) });
    };
    void once();
    const timer = setInterval(() => void once(), PING_EVERY_MS);
    const onShow = () => {
      if (document.visibilityState === "visible") void once();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [connection, open]);
  return latency;
}

function ConnectionBadge({ state, connection }: { state: ConnectionState; connection: TeamConnection }) {
  const latency = useLatency(connection, state.kind === "open");
  const [phrase, tone] =
    state.kind === "open"
      ? (["connected", latency === undefined || latency.median < 150 ? "ok" : latency.median < 400 ? "wait" : "bad"] as const)
      : state.kind === "connecting"
        ? (["connecting", "wait"] as const)
        : (["reconnecting", "bad"] as const);
  return (
    <span
      className={`status status-${tone}`}
      role="status"
      title={latency === undefined ? undefined : t("latencyTitle", { median: String(latency.median), last: String(latency.last) })}
    >
      <span className="dot" aria-hidden="true" />
      {t(phrase)}
      {/* A good connection is just a green dot; the round trip is named only once it is slow enough to notice. */}
      {state.kind === "open" && latency !== undefined && tone !== "ok" ? <span className="latency">{t("latency", { ms: String(latency.median) })}</span> : null}
    </span>
  );
}

/** An address that names nothing: say so, and offer the way home. */
function NotFound({ home }: { home: () => void }) {
  return (
    <section className="page-narrow not-found">
      <Blankslate
        icon="search"
        title={t("notFoundTitle")}
        action={
          <button className="btn btn-primary" onClick={home}>
            {t("backHome")}
          </button>
        }
      >
        {t("notFoundLead", { path: window.location.pathname })}
      </Blankslate>
    </section>
  );
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role?: TeamProjectRole;
  readonly history?: { readonly head?: { readonly at?: number; readonly message?: string } };
}

const ROLE_PHRASE: Record<TeamProjectRole, Phrase> = {
  owner: "roleOwner",
  editor: "roleEditor",
  reviewer: "roleReviewer",
  viewer: "roleViewer",
};

function Projects({
  connection,
  state,
  operator,
  open: openProject,
}: {
  connection: TeamConnection;
  state: ConnectionState;
  operator: boolean;
  open: (id: string) => void;
}) {
  const [rows, setRows] = useState<readonly ProjectRow[] | undefined>(undefined);
  const [mayCreate, setMayCreate] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const open = state.kind === "open";

  const load = useCallback(() => {
    connection
      .call<{ projects: ProjectRow[]; mayCreate?: boolean }>("projects.list")
      .then((answer) => {
        setRows(answer.projects);
        setMayCreate(answer.mayCreate !== false);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [connection]);

  useEffect(() => {
    if (!open) return undefined;
    load();
    return connection.subscribe(TOPIC_PROJECTS, () => load());
  }, [open, load, connection]);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("projects")}</h1>
          <p className="muted">{t("projectsLead")}</p>
        </div>
      </header>
      {error !== undefined ? <Flash error={error} /> : null}
      {rows === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <div className="placeholder-card">{t("noProjects")}</div>
      ) : (
        <div className="project-grid">
          {rows.map((row) => (
            <button key={row.id} className="project-tile" onClick={() => openProject(row.id)}>
              <span className="project-tile-head">
                <span className="project-tile-mark" style={{ background: projectHue(row.id) }}>
                  {Array.from(row.name)[0]?.toUpperCase()}
                </span>
                <span className="project-tile-name">{row.name}</span>
                {row.role === undefined ? null : <span className={`role role-${row.role}`}>{t(ROLE_PHRASE[row.role])}</span>}
              </span>
              <span className="muted small project-tile-desc">{row.description === "" ? t("noDescription") : row.description}</span>
              <span className="muted small">
                {row.history?.head?.at === undefined ? t("noChangesYet") : t("lastChangeShort", { when: new Date(row.history.head.at).toLocaleString() })}
              </span>
            </button>
          ))}
        </div>
      )}
      {open ? <JoinProjects connection={connection} operator={operator} mayCreate={mayCreate} /> : null}
    </section>
  );
}

