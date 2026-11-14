/**
 * The console's shell: sign-in, then a top bar, a navigation rail and the
 * screen the address names. Screens beyond the project list arrive phase by
 * phase (docs/refactor-plan.zh.md §7); the rail already has their places.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { TOPIC_PROJECTS, type TeamProjectRole } from "@narraleaf/team-protocol";

import { currentAccount, signIn, signOut, SignInError, type ConsoleAccount } from "./api";
import { t, type Phrase } from "./i18n";
import { TeamConnection, type ConnectionState } from "./socket";
import { Authorize, Device } from "./OAuth";
import { ProjectPage, type ProjectTab } from "./Project";
import { Bell, Home, Settings } from "./Collab";
import { Admin, hexChannels } from "./Admin";

type Route =
  | { readonly screen: "home" }
  | { readonly screen: "projects" }
  | { readonly screen: "admin" }
  | { readonly screen: "settings" }
  | { readonly screen: "project"; readonly id: string; readonly tab: ProjectTab; readonly revision: string };

const PROJECT_TABS: readonly ProjectTab[] = ["overview", "story", "blueprints", "assets", "todos", "reviews", "history", "settings"];

function routeOf(location: Location): Route {
  const rest = location.pathname.replace(/^\/console\/?/, "");
  const project = /^p\/([^/]+)(?:\/([a-z]+))?/.exec(rest);
  if (project !== null) {
    const tab = PROJECT_TABS.find((key) => key === project[2]) ?? "overview";
    const revision = new URLSearchParams(location.search).get("rev") ?? "head";
    return { screen: "project", id: decodeURIComponent(project[1] ?? ""), tab, revision };
  }
  if (rest.startsWith("projects")) return { screen: "projects" };
  if (rest.startsWith("admin")) return { screen: "admin" };
  if (rest.startsWith("settings")) return { screen: "settings" };
  return { screen: "home" };
}

function pathOf(route: Route): string {
  if (route.screen === "project") {
    const query = route.revision === "head" ? "" : `?rev=${encodeURIComponent(route.revision)}`;
    return `/console/p/${encodeURIComponent(route.id)}/${route.tab}${query}`;
  }
  return route.screen === "home" ? "/console/" : `/console/${route.screen}`;
}

/** The team's look, from the discovery document: applied before anything is drawn. */
function useBrand(): { logo?: string; name?: string } {
  const [brand, setBrand] = useState<{ logo?: string; name?: string }>({});
  useEffect(() => {
    fetch("/.well-known/nlteam")
      .then((response) => response.json() as Promise<{ name?: string; brand?: { accent?: string; logoUrl?: string } }>)
      .then((document) => {
        if (document.brand?.accent !== undefined) {
          window.document.documentElement.style.setProperty("--nl-primary", hexChannels(document.brand.accent));
        }
        setBrand({
          ...(document.brand?.logoUrl === undefined ? {} : { logo: new URL(document.brand.logoUrl).pathname }),
          ...(document.name === undefined ? {} : { name: document.name }),
        });
      })
      .catch(() => undefined);
  }, []);
  return brand;
}

/** The team's mark: its logo where it has one, the leaf square otherwise. */
export function BrandMark({ logo }: { logo?: string | undefined }) {
  return logo === undefined ? <span className="brand-mark" aria-hidden="true" /> : <img className="brand-logo-mark" src={logo} alt="" />;
}

export function App() {
  const [account, setAccount] = useState<ConsoleAccount | null | undefined>(undefined);
  const brand = useBrand();

  useEffect(() => {
    currentAccount()
      .then((found) => setAccount(found ?? null))
      .catch(() => setAccount(null));
  }, []);

  if (account === undefined) {
    return <div className="splash" aria-busy="true" />;
  }
  const path = window.location.pathname;
  const standalone = path.startsWith("/console/oauth/authorize") ? "authorize" : path.startsWith("/console/device") ? "device" : undefined;
  if (account === null) {
    return <SignIn onSignedIn={setAccount} brand={brand} hint={standalone === undefined ? undefined : t("notSignedInHint")} />;
  }
  if (standalone === "authorize") {
    return <Authorize account={account} />;
  }
  if (standalone === "device") {
    return <Device />;
  }
  return <Shell account={account} brand={brand} onSignedOut={() => setAccount(null)} />;
}

function SignIn({
  onSignedIn,
  hint,
  brand,
}: {
  onSignedIn: (account: ConsoleAccount) => void;
  hint?: string | undefined;
  brand: { logo?: string; name?: string };
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await signIn(username.trim(), password));
    } catch (caught) {
      setError(caught instanceof SignInError ? caught.message : String(caught));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <form className="signin-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <BrandMark logo={brand.logo} />
          <span>{brand.name ?? t("appName")}</span>
        </div>
        <h1>{t("signInTitle")}</h1>
        <p className="muted">{hint ?? t("signInLead")}</p>
        <label>
          <span>{t("username")}</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          <span>{t("password")}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error === undefined ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t("signingIn") : t("signIn")}
        </button>
      </form>
    </main>
  );
}

function Shell({
  account,
  brand,
  onSignedOut,
}: {
  account: ConsoleAccount;
  brand: { logo?: string; name?: string };
  onSignedOut: () => void;
}) {
  const connection = useMemo(() => new TeamConnection(), []);
  const [state, setState] = useState<ConnectionState>(connection.state);
  const [route, setRoute] = useState<Route>(() => routeOf(window.location));

  useEffect(() => {
    const off = connection.onState((next) => {
      setState(next);
      if (next.kind === "closed") {
        // A refused handshake reaches a page as a bare close; asking whether
        // the session still stands is how the page tells "signed out" from
        // "server restarting".
        // A server that is down answers nothing at all; that is "restarting",
        // and the socket's own retry deals with it.
        void currentAccount()
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
    const back = () => setRoute(routeOf(window.location));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const go = useCallback((next: Route) => {
    window.history.pushState(null, "", pathOf(next));
    setRoute(next);
  }, []);

  const serverName = state.kind === "open" ? state.hello.server.name : t("appName");

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <BrandMark logo={brand.logo} />
          <span>{serverName}</span>
        </div>
        <ConnectionBadge state={state} />
        <div className="spacer" />
        <Bell connection={connection} state={state} />
        <div className="who">
          <Avatar name={account.displayName || account.username} />
          <span className="who-name">{account.displayName || account.username}</span>
          {account.operator ? <span className="tag">{t("operator")}</span> : null}
        </div>
        <button
          className="ghost"
          onClick={() => {
            connection.stop();
            void signOut().then(onSignedOut);
          }}
        >
          {t("signOut")}
        </button>
      </header>
      <nav className="rail">
        <RailLink active={route.screen === "home"} onClick={() => go({ screen: "home" })} label="home" />
        <RailLink
          active={route.screen === "projects" || route.screen === "project"}
          onClick={() => go({ screen: "projects" })}
          label="projects"
        />
        <RailLink active={route.screen === "settings"} onClick={() => go({ screen: "settings" })} label="settings" />
        {account.operator ? (
          <RailLink active={route.screen === "admin"} onClick={() => go({ screen: "admin" })} label="admin" />
        ) : null}
      </nav>
      <main className="content">
        {route.screen === "home" ? <Home connection={connection} state={state} account={account} /> : null}
        {route.screen === "settings" ? <Settings connection={connection} state={state} /> : null}
        {route.screen === "projects" ? (
          <Projects connection={connection} state={state} open={(id) => go({ screen: "project", id, tab: "overview", revision: "head" })} />
        ) : null}
        {route.screen === "project" ? (
          <ProjectPage
            account={account}
            connection={connection}
            state={state}
            projectId={route.id}
            tab={route.tab}
            revision={route.revision}
            go={(tab, revision) => go({ screen: "project", id: route.id, tab, revision })}
            back={() => go({ screen: "projects" })}
          />
        ) : null}
        {route.screen === "admin" ? <Admin connection={connection} state={state} /> : null}
      </main>
    </div>
  );
}

function RailLink({ active, onClick, label }: { active: boolean; onClick: () => void; label: Phrase }) {
  return (
    <button className={active ? "rail-link active" : "rail-link"} aria-current={active ? "page" : undefined} onClick={onClick}>
      {t(label)}
    </button>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const [phrase, tone] =
    state.kind === "open"
      ? (["connected", "ok"] as const)
      : state.kind === "connecting"
        ? (["connecting", "wait"] as const)
        : (["reconnecting", "bad"] as const);
  return (
    <span className={`status status-${tone}`} role="status">
      <span className="dot" aria-hidden="true" />
      {t(phrase)}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  // A letter until avatars land (plan §4.5); the hue is the name's, so a person
  // is the same colour everywhere.
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return (
    <span className="avatar" style={{ background: `hsl(${hash} 42% 46%)` }} aria-hidden="true">
      {Array.from(name)[0]?.toUpperCase()}
    </span>
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

function Projects({ connection, state, open: openProject }: { connection: TeamConnection; state: ConnectionState; open: (id: string) => void }) {
  const [rows, setRows] = useState<readonly ProjectRow[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const open = state.kind === "open";

  const load = useCallback(() => {
    connection
      .call<{ projects: ProjectRow[] }>("projects.list")
      .then((answer) => {
        setRows(answer.projects);
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
      <h1>{t("projects")}</h1>
      <p className="muted">{t("projectsLead")}</p>
      {error !== undefined ? <p className="error">{t("loadFailed", { reason: error })}</p> : null}
      {rows === undefined ? null : rows.length === 0 ? (
        <div className="placeholder-card">{t("noProjects")}</div>
      ) : (
        <ul className="project-list">
          {rows.map((row) => (
            <li key={row.id} className="project-row clickable" onClick={() => openProject(row.id)}>
              <div className="project-main">
                <span className="project-name">{row.name}</span>
                {row.description === "" ? null : <span className="muted">{row.description}</span>}
              </div>
              {row.role === undefined ? null : <span className={`role role-${row.role}`}>{t(ROLE_PHRASE[row.role])}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

