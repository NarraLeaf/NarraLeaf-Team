/**
 * One project, read-only: overview, story, blueprints, assets and history, at
 * the newest revision or at any revision picked from the history.
 *
 * Everything here reads files through src/web/files.ts and interprets them
 * with @narraleaf/project-view. Nothing on this page edits the project; that
 * is Studio's (docs/architecture.md, D1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assetRegisterType,
  CHARACTER_STORE_PATH,
  readAssetRegister,
  readBlueprints,
  readCharacters,
  readStoryDocument,
  readStoryLibrary,
  STORY_INDEX_PATH,
  UI_GRAPHS_PATH,
  type AssetView,
  type BlueprintGraphView,
  type BlueprintsView,
  type CharacterView,
  type StoryDocumentView,
  type StoryLibrary,
  type StoryRow,
  type Unsupported,
} from "@narraleaf/project-view";
import { projectDocTopic, type TeamProjectRole, type TeamVersionRole } from "@narraleaf/team-protocol";

import { fetchJson, fetchTree, rawUrl, type Tree } from "./files";
import { Face, Timeline, Todos } from "./Collab";
import { Icon, type IconName } from "./Icon";
import { ChatPanel } from "./LiveChat";
import { NODE_NAMES_EN, NODE_NAMES_ZH } from "./nodeNames";
import { rememberPlace } from "./TeamHome";
import { openInStudio } from "./studioLink";
import { LineComments, storyLineAnchor, useStoryThreads } from "./Comments";
import type { ConsoleAccount } from "./api";
import { language, t, type Phrase } from "./i18n";
import { isAutoVersion, MilestoneTags, Reviews, revisionTitle, useMilestones, type Revision } from "./Production";
import { CompareWithNow, OnlineNow, ProjectSettings, type ProjectSettingsSection } from "./Versions";
import { AskForMore } from "./Access";
import type { TeamConnection, ConnectionState } from "./socket";
import { ActionMenu, Checkbox, SelectPanel, toast } from "./ui";

export type ProjectTab = "overview" | "story" | "blueprints" | "assets" | "todos" | "reviews" | "history" | "settings";
/** The project's own page: what it is, how it got here, and what is waiting on review. */
const TABS: readonly ProjectTab[] = ["overview", "history", "reviews"];
/** Shown to the project's owners only. */
const OWNER_TABS: readonly ProjectTab[] = [...TABS, "settings"];
/** What opens in the workbench, Studio's layout, read-only. */
export const WORKBENCH_TABS: readonly ProjectTab[] = ["story", "blueprints", "assets", "todos"];
const WORKBENCH_ICON: Record<string, IconName> = { story: "book", blueprints: "graph", assets: "image", todos: "todo" };
const TAB_PHRASE: Record<ProjectTab, Phrase> = {
  overview: "tabOverview",
  story: "tabStory",
  blueprints: "tabBlueprints",
  assets: "tabAssets",
  todos: "tabTodos",
  reviews: "tabReviews",
  history: "tabHistory",
  settings: "tabSettings",
};

/** What each role may do, said on the badge that shows the caller's own. */
const ROLE_MEANING: Record<TeamProjectRole, Phrase> = {
  owner: "roleOwnerHint",
  editor: "roleEditorHint",
  reviewer: "roleReviewerHint",
  viewer: "roleViewerHint",
};

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role?: TeamProjectRole;
  readonly history?: { readonly revisions?: number; readonly lastAt?: number; readonly lastBy?: string; readonly lastMessage?: string };
  readonly saveRole?: TeamVersionRole;
  readonly restoreRole?: TeamVersionRole;
  readonly mayRemove?: boolean;
}

interface Member {
  readonly username: string;
  readonly displayName: string;
  readonly role: TeamProjectRole;
  readonly avatarUrl?: string;
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function when(at: number | undefined): string {
  return at === undefined ? "" : new Date(at).toLocaleString();
}

function Notice({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return <p className={tone === "error" ? "error" : "placeholder-card"}>{children}</p>;
}

function UnsupportedNotice({ value }: { value: Unsupported }) {
  return (
    <Notice tone="error">
      {value.reason === "newer" ? t("newerFormat", { version: String(value.schemaVersion ?? "?") }) : t("malformed")}
    </Notice>
  );
}

export function ProjectPage(props: {
  account: ConsoleAccount;
  connection: TeamConnection;
  state: ConnectionState;
  projectId: string;
  tab: ProjectTab;
  revision: string;
  section: ProjectSettingsSection;
  isOperator: boolean;
  go: (tab: ProjectTab, revision: string, section?: ProjectSettingsSection) => void;
  back: () => void;
}) {
  const { account, connection, state, projectId, tab, revision, section, isOperator, go, back } = props;
  const [project, setProject] = useState<ProjectSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tree, setTree] = useState<Tree | undefined>(undefined);
  const [treeError, setTreeError] = useState<string | undefined>(undefined);
  const open = state.kind === "open";

  useEffect(() => {
    if (!open) return;
    connection
      .call<{ project: ProjectSummary }>("projects.get", { project: projectId })
      .then((answer) => setProject(answer.project))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [open, connection, projectId]);

  // The newest view is what the server holds right now (`current`), not the last saved version;
  // a revision picked from the history is read as it was.
  const reading = revision === "head" ? "current" : revision;
  const [tick, setTick] = useState(0);
  // The address may name the project by name; its topics are by id.
  const projectKey = project?.id;
  useEffect(() => {
    if (!open || revision !== "head" || projectKey === undefined) return undefined;
    // Somebody edited, saved or restored: read again, at most every second and a half.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = connection.subscribe(projectDocTopic(projectKey), () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setTick((n) => n + 1);
      }, 1500);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, connection, projectKey, revision]);

  useEffect(() => {
    setTree(undefined);
    setTreeError(undefined);
  }, [projectId, reading]);
  useEffect(() => {
    let alive = true;
    fetchTree(projectId, reading)
      .then((next) => {
        if (alive) setTree(next);
      })
      .catch((caught: unknown) => {
        if (alive) setTreeError(errorText(caught));
      });
    return () => {
      alive = false;
    };
  }, [projectId, reading, tick]);

  const inWorkbench = WORKBENCH_TABS.includes(tab);
  const projectName = project?.name;
  useEffect(() => {
    if (inWorkbench && projectName !== undefined) {
      rememberPlace({ project: projectId, projectName, tab, at: Date.now() });
    }
  }, [inWorkbench, projectName, projectId, tab]);
  const remember = useCallback(
    (label: string) => {
      if (projectName !== undefined) rememberPlace({ project: projectId, projectName, tab, label, at: Date.now() });
    },
    [projectId, projectName, tab],
  );

  if (error !== undefined) {
    return <Notice tone="error">{t("loadFailed", { reason: error })}</Notice>;
  }

  const workbenchBody =
    tab === "todos" ? (
      <div className="wb-page">
        <ProjectTodos account={account} connection={connection} open={open} projectId={projectId} />
      </div>
    ) : treeError !== undefined ? (
      <Notice>{t("notReadYetLong")}</Notice>
    ) : tree === undefined ? (
      <p className="muted wb-loading">{t("loading")}</p>
    ) : tab === "story" ? (
      <Story
        projectId={projectId}
        tree={tree}
        connection={connection}
        open={open}
        canWrite={project?.role !== undefined && project.role !== "viewer"}
        remember={remember}
      />
    ) : tab === "blueprints" ? (
      <Blueprints projectId={projectId} tree={tree} />
    ) : (
      <div className="wb-page">
        <Assets projectId={projectId} tree={tree} />
      </div>
    );

  if (inWorkbench) {
    return (
      <Workbench
        account={account}
        connection={connection}
        state={state}
        projectId={projectId}
        projectName={project?.name ?? "…"}
        tab={tab}
        revision={revision}
        live={tree?.revision === "current"}
        go={go}
      >
        {workbenchBody}
      </Workbench>
    );
  }

  return (
    <section className="project">
      <header className="project-top">
        <div className="crumbs">
          <button className="crumb" onClick={back}>
            {t("projects")}
          </button>
          <span aria-hidden="true">/</span>
          <h1 className="crumb-current">{project?.name ?? "…"}</h1>
          {project?.role === undefined ? null : (
            <span
              className={`role role-${project.role}`}
              title={isOperator && project.role === "owner" ? t("roleViaAdminHint") : t(ROLE_MEANING[project.role])}
            >
              {t("yourRole", { role: isOperator && project.role === "owner" ? t("roleViaAdmin") : t(roleKey(project.role)) })}
            </span>
          )}
        </div>
        <div className="project-actions">
          {project === undefined ? null : <AskForMore connection={connection} project={projectId} role={project.role} />}
          <div className="btn-group">
            <button className="btn btn-primary" onClick={() => go("story", revision)} title={t("enterWorkbenchHint")}>
              <Icon name="workbench" size={16} />
              <span>{t("enterWorkbench")}</span>
            </button>
            <ActionMenu
              label={t("moreWaysToOpen")}
              trigger={<Icon name="caret" size={14} />}
              triggerClassName="btn btn-primary btn-icon"
              actions={[
                { label: t("openInStudio"), icon: "external", description: t("openInStudioHint"), run: () => void openInStudio(projectId) },
                {
                  label: t("copyProjectLink"),
                  icon: "link",
                  run: () =>
                    void navigator.clipboard
                      ?.writeText(`${window.location.origin}/console/p/${encodeURIComponent(projectId)}`)
                      .then(() => toast(t("copied")), () => undefined),
                },
              ]}
            />
          </div>
        </div>
      </header>
      {project?.description ? <p className="muted project-description">{project.description}</p> : null}
      {revision !== "head" ? (
        <div className="revision-bar">
          <span>{t("atRevision", { rev: revision.slice(0, 12) })}</span>
          <button className="ghost" onClick={() => go(tab, "head")}>
            {t("backToHead")}
          </button>
        </div>
      ) : null}
      <nav className="tabs" role="tablist">
        {(project?.role === "owner" ? OWNER_TABS : TABS).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "tab active" : "tab"}
            onClick={() => go(key, revision)}
          >
            {t(TAB_PHRASE[key])}
          </button>
        ))}
      </nav>
      {tab === "settings" && project !== undefined && project.role === "owner" ? (
        <ProjectSettings
          connection={connection}
          project={project}
          section={section}
          go={(next) => go("settings", revision, next)}
          changed={(next) => setProject({ ...project, ...next })}
          removed={back}
        />
      ) : tab === "history" ? (
        <History
          connection={connection}
          open={open}
          projectId={projectId}
          pick={(id) => go("story", id)}
          me={account.username}
          role={project?.role}
        />
      ) : tab === "reviews" ? (
        <Reviews connection={connection} open={open} projectId={projectId} me={account.username} role={project?.role} viewAt={(id) => go("story", id)} />
      ) : (
        <Overview connection={connection} open={open} projectId={projectId} project={project} tree={tree} />
      )}
    </section>
  );
}

/**
 * Studio's workbench, read-only: a strip of places down the left, the thing
 * being read in the middle, the project's live chat on the right when asked
 * for, and a status line along the bottom.
 */
function Workbench(props: {
  account: ConsoleAccount;
  connection: TeamConnection;
  state: ConnectionState;
  projectId: string;
  projectName: string;
  tab: ProjectTab;
  revision: string;
  live: boolean;
  go: (tab: ProjectTab, revision: string) => void;
  children: React.ReactNode;
}) {
  const { account, connection, state, projectId, projectName, tab, revision, live, go, children } = props;
  const [chat, setChat] = useState(() => {
    // On a phone the panel covers the page, so it opens only when asked for.
    if (window.innerWidth < 768) return false;
    try {
      return localStorage.getItem("nlteam.chatOpen") === "1";
    } catch {
      return false;
    }
  });
  const toggleChat = () =>
    setChat((value) => {
      try {
        localStorage.setItem("nlteam.chatOpen", value ? "0" : "1");
      } catch {
        /* nothing to remember with */
      }
      return !value;
    });
  return (
    <div className={chat ? "wb with-panel" : "wb"}>
      <header className="wb-top">
        <button className="wb-project" onClick={() => go("overview", "head")}>
          <Icon name="back" />
          <span>{projectName}</span>
        </button>
        <span className="wb-badge">{t("readOnlyBadge")}</span>
        {revision !== "head" ? (
          <span className="wb-revision">
            {t("atRevision", { rev: revision.slice(0, 12) })}
            <button className="ghost small" onClick={() => go(tab, "head")}>
              {t("backToHead")}
            </button>
          </span>
        ) : null}
        <button className="wb-search" onClick={() => window.dispatchEvent(new Event("nlteam:palette"))}>
          <Icon name="search" size={13} />
          <span>{t("palettePlaceholderProject", { project: projectName })}</span>
          <kbd>⌘K</kbd>
        </button>
        <button className="wb-studio" onClick={() => void openInStudio(projectId)}>
          <Icon name="external" size={13} />
          <span>{t("openInStudio")}</span>
        </button>
        <button className={chat ? "wb-tool active" : "wb-tool"} onClick={toggleChat} aria-pressed={chat}>
          <Icon name="chat" />
          <span>{t("chatTitle")}</span>
        </button>
      </header>
      <div className="wb-body">
        <nav className="wb-activity" aria-label={t("workbench")}>
          <button className="wb-activity-item" onClick={() => go("overview", "head")} aria-label={t("tabOverview")} title={t("tabOverview")}>
            <Icon name="grid" size={18} />
          </button>
          {WORKBENCH_TABS.map((key) => (
            <button
              key={key}
              className={tab === key ? "wb-activity-item active" : "wb-activity-item"}
              aria-current={tab === key ? "page" : undefined}
              aria-label={t(TAB_PHRASE[key])}
              title={t(TAB_PHRASE[key])}
              onClick={() => go(key, revision)}
            >
              <Icon name={WORKBENCH_ICON[key] ?? "book"} size={18} />
              <span className="wb-activity-label">{t(TAB_PHRASE[key])}</span>
            </button>
          ))}
          <span className="wb-spacer" />
          <button className={chat ? "wb-activity-item active" : "wb-activity-item"} onClick={toggleChat} aria-label={t("chatTitle")} title={t("chatTitle")}>
            <Icon name="chat" size={18} />
          </button>
        </nav>
        <div className="wb-main">{children}</div>
        {chat ? (
          <aside className="wb-panel">
            <button className="ghost icon-button wb-panel-close" onClick={toggleChat} aria-label={t("close")}>
              <Icon name="close" />
            </button>
            <ChatPanel connection={connection} state={state} projectId={projectId} account={account} />
          </aside>
        ) : null}
      </div>
      <footer className="wb-status">
        <span>{projectName}</span>
        <span>{t(TAB_PHRASE[tab])}</span>
        <span className="wb-spacer" />
        {revision === "head" ? <span className={live ? "status-live" : undefined}>{live ? t("liveNoteShort") : t("savedVersion")}</span> : null}
      </footer>
    </div>
  );
}

function roleKey(role: TeamProjectRole): Phrase {
  return ({ owner: "roleOwner", editor: "roleEditor", reviewer: "roleReviewer", viewer: "roleViewer" } as const)[role];
}

/* ---------------------------------------------------------------- to-dos */

function ProjectTodos(props: { account: ConsoleAccount; connection: TeamConnection; open: boolean; projectId: string }) {
  const { account, connection, open, projectId } = props;
  const [members, setMembers] = useState<readonly Member[]>([]);
  useEffect(() => {
    if (!open) return;
    connection
      .call<{ members: Member[] }>("projects.members.list", { project: projectId })
      .then((answer) => setMembers(answer.members))
      .catch(() => undefined);
  }, [open, connection, projectId]);
  return <Todos connection={connection} open={open} account={account} project={projectId} members={members} />;
}

/* ------------------------------------------------------------- overview */

function Overview(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  project: ProjectSummary | undefined;
  tree: Tree | undefined;
}) {
  const { connection, open, projectId, project, tree } = props;
  const [members, setMembers] = useState<readonly Member[] | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    connection
      .call<{ members: Member[] }>("projects.members.list", { project: projectId })
      .then((answer) => setMembers(answer.members))
      .catch(() => setMembers([]));
  }, [open, connection, projectId]);
  const history = project?.history;
  return (
    <div className="overview">
      <section className="hero-card" aria-label={t("lastChange")}>
        <div className="hero-main">
          <span className="muted small">{t("lastChange")}</span>
          <p className="hero-message">{history?.lastMessage ?? t("noChangesYet")}</p>
          {history?.lastAt !== undefined ? (
            <span className="muted small">{t("lastChangeBy", { who: history.lastBy ?? "?", when: when(history.lastAt) })}</span>
          ) : null}
        </div>
        <dl className="hero-facts">
          <div>
            <dt>{t("statRevisions")}</dt>
            <dd>{history?.revisions ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("statFiles")}</dt>
            <dd>{tree?.total ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("statState")}</dt>
            <dd className={tree?.revision === "current" ? "tone-success" : undefined}>{tree?.revision === "current" ? t("liveNoteShort") : t("savedVersion")}</dd>
          </div>
        </dl>
      </section>
      <div className="overview-grid">
        <section>
          <h2>{t("timeline")}</h2>
          <Timeline connection={connection} open={open} project={projectId} />
        </section>
        <aside className="overview-side">
          <OnlineNow connection={connection} open={open} projectId={projectId} />
          <section>
            <h2>{t("members")}</h2>
            <ul className="member-list">
              {(members ?? []).map((member) => (
                <li key={member.username}>
                  <span className="member-name">
                    <Face name={member.displayName || member.username} url={member.avatarUrl} size={26} />
                    {member.displayName || member.username}
                  </span>
                  <span className={`role role-${member.role}`}>{t(roleKey(member.role))}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- story */

function Story({
  projectId,
  tree,
  connection,
  open,
  canWrite,
  remember,
}: {
  projectId: string;
  tree: Tree;
  connection: TeamConnection;
  open: boolean;
  canWrite: boolean;
  remember: (label: string) => void;
}) {
  const [selected, setSelected] = useState<{ blockId: string; excerpt: string } | undefined>(undefined);
  const [library, setLibrary] = useState<StoryLibrary | Unsupported | undefined>(undefined);
  const [storyId, setStoryId] = useState<string | undefined>(undefined);
  const [document, setDocument] = useState<StoryDocumentView | Unsupported | undefined>(undefined);
  const [characters, setCharacters] = useState<ReadonlyMap<string, CharacterView>>(new Map());
  const [sceneId, setSceneId] = useState<string | undefined>(undefined);
  const [showCommands, setShowCommands] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const has = useCallback((path: string) => tree.files.some((file) => file.path === path), [tree]);

  useEffect(() => {
    if (!has(STORY_INDEX_PATH)) {
      setLibrary({ supported: true, stories: [] });
      return;
    }
    fetchJson(projectId, tree.revision, STORY_INDEX_PATH)
      .then((json) => {
        const read = readStoryLibrary(json);
        setLibrary(read);
        // A refresh keeps the story being read, unless it is gone.
        if (read.supported) {
          setStoryId((current) =>
            current !== undefined && read.stories.some((story) => story.id === current) ? current : (read.defaultStoryId ?? read.stories[0]?.id),
          );
        }
      })
      .catch((caught: unknown) => setError(errorText(caught)));
    if (has(CHARACTER_STORE_PATH)) {
      fetchJson(projectId, tree.revision, CHARACTER_STORE_PATH)
        .then((json) => setCharacters(readCharacters(json)))
        .catch(() => undefined);
    }
  }, [projectId, tree, has]);

  const entry = library?.supported ? library.stories.find((story) => story.id === storyId) : undefined;
  const documentPath = entry?.documentPath;
  useEffect(() => {
    setDocument(undefined);
  }, [documentPath]);
  useEffect(() => {
    if (documentPath === undefined) return;
    fetchJson(projectId, tree.revision, documentPath)
      .then((json) => {
        const read = readStoryDocument(json);
        setDocument(read);
        // A refresh keeps the scene being read, unless it is gone.
        if (read.supported) {
          const asked = new URLSearchParams(window.location.search).get("scene");
          setSceneId((current) =>
            asked !== null && read.order.includes(asked) ? asked : current !== undefined && read.order.includes(current) ? current : read.order[0],
          );
        }
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [projectId, tree, documentPath]);

  // The palette, opening a scene of the story already on screen.
  useEffect(() => {
    const go = (event: Event) => {
      const scene = (event as CustomEvent<string>).detail;
      setSceneId(scene);
      setSelected(undefined);
    };
    window.addEventListener("nlteam:scene", go);
    return () => window.removeEventListener("nlteam:scene", go);
  }, []);

  if (error !== undefined) return <Notice tone="error">{t("loadFailed", { reason: error })}</Notice>;
  if (library === undefined) return <p className="muted">{t("loading")}</p>;
  if (!library.supported) return <UnsupportedNotice value={library} />;
  if (library.stories.length === 0) return <Notice>{t("noStories")}</Notice>;

  const scene = document?.supported && sceneId !== undefined ? document.scenes[sceneId] : undefined;
  return (
    <StoryBody
      remember={remember}
      library={library}
      storyId={storyId}
      setStoryId={setStoryId}
      document={document}
      sceneId={sceneId}
      setSceneId={(id) => {
        setSceneId(id);
        setSelected(undefined);
      }}
      scene={scene}
      showCommands={showCommands}
      setShowCommands={setShowCommands}
      characters={characters}
      connection={connection}
      open={open}
      projectId={projectId}
      revision={tree.revision === "current" ? (tree.base ?? "") : tree.revision}
      canWrite={canWrite}
      selected={selected}
      setSelected={setSelected}
    />
  );
}

function StoryBody(props: {
  library: StoryLibrary;
  storyId: string | undefined;
  setStoryId: (id: string) => void;
  document: StoryDocumentView | Unsupported | undefined;
  sceneId: string | undefined;
  setSceneId: (id: string) => void;
  scene: StoryDocumentView["scenes"][string] | undefined;
  showCommands: boolean;
  setShowCommands: (update: (value: boolean) => boolean) => void;
  characters: ReadonlyMap<string, CharacterView>;
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  revision: string;
  canWrite: boolean;
  selected: { blockId: string; excerpt: string } | undefined;
  setSelected: (value: { blockId: string; excerpt: string } | undefined) => void;
  remember: (label: string) => void;
}) {
  const { remember } = props;
  const sceneName = props.scene?.name;
  useEffect(() => {
    if (sceneName !== undefined) remember(sceneName);
  }, [sceneName, remember]);
  const { library, storyId, setStoryId, document, sceneId, setSceneId, scene, showCommands, setShowCommands, characters } = props;
  const { connection, open, projectId, revision, canWrite, selected, setSelected } = props;
  const threads = useStoryThreads(connection, open, projectId, storyId);
  const threadsOn = (blockId: string) => (sceneId === undefined ? [] : (threads.get(storyLineAnchor(sceneId, blockId)) ?? []));
  return (
    <div className={selected === undefined ? "story" : "story with-comments"}>
      <aside className="story-outline">
        <div className="panel-head">
          <Icon name="book" />
          <span>{t("tabStory")}</span>
        </div>
        {library.stories.length > 1 ? (
          <SelectPanel
            className="story-pick"
            label={t("storyPick")}
            size="small"
            value={storyId}
            onChange={setStoryId}
            options={library.stories.map((story) => ({ value: story.id, label: story.name, icon: "book" }))}
          />
        ) : null}
        {document === undefined ? (
          <p className="muted">{t("loading")}</p>
        ) : !document.supported ? (
          <UnsupportedNotice value={document} />
        ) : (
          <>
            {document.chapters.map((chapter) => (
              <div key={chapter.id} className="outline-group">
                <div className="outline-title">
                  ▾ {chapter.name} <span className="outline-count">({chapter.sceneIds.length})</span>
                </div>
                {chapter.sceneIds.map((id) => (
                  <SceneLink
                    key={id}
                    name={document.scenes[id]?.name ?? id}
                    count={document.scenes[id]?.rows.filter((row) => row.kind !== "empty").length}
                    active={id === sceneId}
                    onClick={() => setSceneId(id)}
                  />
                ))}
              </div>
            ))}
            {document.unassignedSceneIds.length > 0 ? (
              <div className="outline-group">
                <div className="outline-title">{t("unassigned")}</div>
                {document.unassignedSceneIds.map((id) => (
                  <SceneLink
                    key={id}
                    name={document.scenes[id]?.name ?? id}
                    count={document.scenes[id]?.rows.filter((row) => row.kind !== "empty").length}
                    active={id === sceneId}
                    onClick={() => setSceneId(id)}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </aside>
      <div className="script">
        {scene === undefined ? null : (
          <>
            <div className="script-head">
              <div className="script-title">
                <h2>{scene.name}</h2>
                {document?.supported ? (
                  <span className="muted small">{document.chapters.find((chapter) => chapter.sceneIds.includes(sceneId ?? ""))?.name ?? ""}</span>
                ) : null}
              </div>
              <div className="segmented" role="group" aria-label={t("showCommands")}>
                <button aria-pressed={showCommands} className={showCommands ? "active" : undefined} onClick={() => setShowCommands(() => true)}>
                  {t("viewAll")}
                </button>
                <button aria-pressed={!showCommands} className={showCommands ? undefined : "active"} onClick={() => setShowCommands(() => false)}>
                  {t("viewLinesOnly")}
                </button>
              </div>
            </div>
            {scene.description ? <div className="scene-card"><strong>{scene.name}</strong><span className="muted small">{scene.description}</span></div> : null}
            <ol className="script-rows">
              {scene.rows
                .filter((row) => showCommands || (row.kind !== "command" && row.kind !== "empty"))
                .map((row, index) => (
                  <ScriptRow
                    key={row.id}
                    line={index + 1}
                    row={row}
                    characters={characters}
                    marks={threadsOn(row.id).filter((thread) => thread.status === "open").length}
                    selected={selected?.blockId === row.id}
                    onSelect={() => setSelected({ blockId: row.id, excerpt: "text" in row ? row.text : "" })}
                  />
                ))}
            </ol>
          </>
        )}
      </div>
      {selected !== undefined && sceneId !== undefined && storyId !== undefined ? (
        <LineComments
          connection={connection}
          projectId={projectId}
          storyId={storyId}
          sceneId={sceneId}
          blockId={selected.blockId}
          revision={revision}
          excerpt={selected.excerpt}
          threads={threadsOn(selected.blockId)}
          canWrite={canWrite}
          close={() => setSelected(undefined)}
        />
      ) : null}
    </div>
  );
}

function SceneLink({ name, active, onClick, count }: { name: string; active: boolean; onClick: () => void; count?: number | undefined }) {
  return (
    <button className={active ? "outline-link active" : "outline-link"} aria-current={active ? "true" : undefined} onClick={onClick}>
      <span className="outline-name">{name}</span>
      {count === undefined ? null : <span className="outline-count">{t("lineCount", { count: String(count) })}</span>}
    </button>
  );
}

function ScriptRow({
  row,
  line,
  characters,
  marks,
  selected,
  onSelect,
}: {
  row: StoryRow;
  line: number;
  characters: ReadonlyMap<string, CharacterView>;
  marks: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const indent = { paddingLeft: `${row.depth * 22}px` };
  const cls = `row row-${row.kind}${row.disabled ? " row-disabled" : ""}${selected ? " row-selected" : ""}`;
  const mark =
    marks > 0 ? (
      <span className="row-mark" title={t("openThreads", { count: String(marks) })}>
        <Icon name="chat" size={13} />
        {marks}
      </span>
    ) : null;
  const gutter = <span className="row-no">{line}</span>;
  const select = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
  const common = { className: cls, id: `row-${row.id}`, onClick: onSelect, onKeyDown: select, tabIndex: 0 };
  switch (row.kind) {
    case "dialogue": {
      const speaker =
        row.speaker === undefined
          ? "？"
          : "characterId" in row.speaker
            ? (characters.get(row.speaker.characterId)?.name ?? row.speaker.characterId.slice(0, 8))
            : row.speaker.name;
      return (
        <li {...common}>
          {gutter}
          <span className="row-body" style={indent}>
            <span className="row-glyph">
              <Face name={speaker} size={24} />
            </span>
            <span className="speaker">{speaker}</span>
            <span className="line">{row.text}</span>
          </span>
          {mark}
        </li>
      );
    }
    case "narration":
    case "note":
    case "invalid":
      return (
        <li {...common}>
          {gutter}
          <span className="row-body" style={indent}>
            <span className="row-glyph glyph-quote" aria-hidden="true">
              66
            </span>
            <span className="line">{row.text}</span>
          </span>
          {mark}
        </li>
      );
    case "choice":
      return (
        <li {...common}>
          {gutter}
          <span className="row-body" style={indent}>
            <span className="row-glyph glyph-command" aria-hidden="true">
              <Icon name="todo" size={15} />
            </span>
            <span className="cmd">@{t("menuCommand")}</span>
            <span className="line">{row.text}</span>
          </span>
          {mark}
        </li>
      );
    case "option":
      return (
        <li {...common}>
          {gutter}
          <span className="row-body" style={indent}>
            <span className="row-glyph glyph-option" aria-hidden="true">
              ⑂
            </span>
            <span className="option-label">{t("optionLabel")}</span>
            <span className="line">{row.text}</span>
          </span>
          {mark}
        </li>
      );
    case "command":
      return (
        <li {...common}>
          {gutter}
          <span className="row-body" style={indent}>
            <span className="row-glyph glyph-command" aria-hidden="true">
              @
            </span>
            <span className="cmd">@{row.command}</span>
            {row.detail ? <span className="cmd-detail"> {row.detail}</span> : null}
          </span>
          {mark}
        </li>
      );
    case "empty":
      return (
        <li className={cls}>
          {gutter}
        </li>
      );
  }
}

/* ----------------------------------------------------------- blueprints */

function Blueprints({ projectId, tree }: { projectId: string; tree: Tree }) {
  const [view, setView] = useState<BlueprintsView | Unsupported | undefined>(undefined);
  const [picked, setPicked] = useState<{ blueprint: string; graph: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!tree.files.some((file) => file.path === UI_GRAPHS_PATH)) {
      setView({ supported: true, blueprints: [] });
      return;
    }
    fetchJson(projectId, tree.revision, UI_GRAPHS_PATH)
      .then((json) => {
        const read = readBlueprints(json);
        setView(read);
        const first = read.supported ? read.blueprints.find((bp) => bp.graphs.length > 0) : undefined;
        if (first !== undefined && first.graphs[0] !== undefined) setPicked({ blueprint: first.id, graph: first.graphs[0].id });
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [projectId, tree]);

  if (error !== undefined) return <Notice tone="error">{t("loadFailed", { reason: error })}</Notice>;
  if (view === undefined) return <p className="muted">{t("loading")}</p>;
  if (!view.supported) return <UnsupportedNotice value={view} />;
  if (view.blueprints.length === 0) return <Notice>{t("noBlueprints")}</Notice>;
  const graph = view.blueprints.find((bp) => bp.id === picked?.blueprint)?.graphs.find((g) => g.id === picked?.graph);
  return (
    <div className="story">
      <aside className="story-outline">
        <div className="panel-head">
          <Icon name="graph" />
          <span>{t("tabBlueprints")}</span>
        </div>
        {view.blueprints.map((blueprint) => (
          <div key={blueprint.id} className="outline-group">
            <div className="outline-title" title={blueprint.owner}>
              {blueprint.name}
            </div>
            {blueprint.graphs.map((g) => (
              <SceneLink
                key={g.id}
                name={`${g.name} · ${t("nodes", { count: String(g.nodes.length) })}`}
                active={picked?.blueprint === blueprint.id && picked.graph === g.id}
                onClick={() => setPicked({ blueprint: blueprint.id, graph: g.id })}
              />
            ))}
          </div>
        ))}
      </aside>
      <div className="script graph-host">{graph === undefined ? null : <GraphCanvas key={graph.id} graph={graph} />}</div>
    </div>
  );
}

const NODE_W = 200;
const NODE_HEAD = 26;
const PORT_H = 18;

const NODE_NAMES = language === "zh" ? NODE_NAMES_ZH : NODE_NAMES_EN;
const NODE_ALIASES: Readonly<Record<string, string>> = { "fn.head": "functionEntry", "flow.comment": "comment", "fn.return": "fnReturn" };

/** What Studio calls a node of this type, or the type itself where Studio's catalogue has no name for it. */
function nodeLabel(type: string): string {
  const parts = type.replace(/^blueprint\./, "").split(".");
  const last = parts[parts.length - 1] ?? type;
  const tail = parts.slice(-2);
  const camel = (words: readonly string[]) => words.map((word, at) => (at === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  const tries = [NODE_ALIASES[parts.join(".")], last, camel([...tail].reverse()), camel(tail), camel(parts)];
  for (const key of tries) {
    if (key !== undefined && NODE_NAMES[key] !== undefined) return NODE_NAMES[key];
  }
  return last;
}

/** A node's family, for the colour of its title strip, as Studio groups them. */
function nodeTone(type: string): "event" | "flow" | "fn" | "data" | "action" | "comment" {
  if (type === "blueprint.flow.comment") return "comment";
  if (type.includes(".event.") || type.endsWith(".head") || type.includes(".head.")) return type.includes(".fn.") ? "fn" : "event";
  if (type.includes(".flow.") || type.includes(".branch") || type.includes(".loop")) return "flow";
  if (type.includes(".fn.") || type.includes(".call")) return "fn";
  if (/\.(get|var|math|compare|text|array|const|literal|convert)/.test(type)) return "data";
  return "action";
}

/** A parameter as a card shows it: short, and without the editor's own bookkeeping. */
function paramRows(params: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(params)
    .filter(([key]) => !key.startsWith("__") && key !== "width" && key !== "height")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return { key, value: text.length > 28 ? `${text.slice(0, 27)}…` : text };
    })
    .slice(0, 4);
}

/**
 * Whether a port carries the order nodes run in rather than a value. The saved
 * graph does not say - Studio knows from its node catalogue - so this reads the
 * names Studio gives its execution pins. A wire it gets wrong is only a colour.
 */
function isExecPort(port: string): boolean {
  return /^(exec|in|out|then|else|next|done|completed|true|false|body|loop|start|finished|onComplete|exec[A-Z_].*)$/i.test(port);
}

/**
 * A read-only node graph: placed nodes, their ports, and the wires between
 * them, on Studio's dotted canvas. Drag to pan, wheel or pinch to zoom, and
 * "fit" to see all of it; click a node for its settings.
 */
function GraphCanvas({ graph }: { graph: BlueprintGraphView }) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | undefined>(undefined);
  // The saved graph names a node's ports only where they are wired, so its
  // ports are its own list and every port an edge uses, in that order.
  const ports = useMemo(() => {
    const map = new Map<string, { inputs: string[]; outputs: string[] }>();
    for (const node of graph.nodes) map.set(node.id, { inputs: [...node.inputs], outputs: [...node.outputs] });
    for (const edge of graph.edges) {
      const from = map.get(edge.from.nodeId);
      if (from !== undefined && !from.outputs.includes(edge.from.port)) from.outputs.push(edge.from.port);
      const to = map.get(edge.to.nodeId);
      if (to !== undefined && !to.inputs.includes(edge.to.port)) to.inputs.push(edge.to.port);
    }
    return map;
  }, [graph]);
  const layout = useMemo(() => {
    // Nodes never placed are laid out in a column to the right of the placed ones.
    const placed = graph.nodes.filter((node) => node.x !== undefined && node.y !== undefined);
    const maxX = placed.reduce((max, node) => Math.max(max, node.x ?? 0), 0);
    let floating = 0;
    const boxes = new Map<string, { x: number; y: number; h: number; w: number }>();
    for (const node of graph.nodes) {
      const own = ports.get(node.id);
      const comment = node.type === "blueprint.flow.comment";
      const w = comment ? Math.max(200, Number(node.params["width"]) || 320) : NODE_W;
      const rows = Math.max(own?.inputs.length ?? 0, own?.outputs.length ?? 0, 1) + paramRows(node.params).length;
      const h = comment ? Math.max(60, Number(node.params["height"]) || 100) : NODE_HEAD + rows * PORT_H + 10;
      const x = node.x ?? maxX + NODE_W + 80;
      const y = node.y ?? (floating += h + 24) - h;
      boxes.set(node.id, { x, y, h, w });
    }
    const all = [...boxes.values()];
    const minX = Math.min(0, ...all.map((box) => box.x));
    const minY = Math.min(0, ...all.map((box) => box.y));
    const maxRight = Math.max(400, ...all.map((box) => box.x + box.w));
    const maxBottom = Math.max(300, ...all.map((box) => box.y + box.h));
    return { boxes, minX, minY, width: maxRight - minX, height: maxBottom - minY };
  }, [graph, ports]);

  const fit = useCallback(() => {
    const element = host.current;
    if (element === null) return;
    const pad = 48;
    const scale = Math.min(1.25, Math.max(0.2, Math.min((element.clientWidth - pad * 2) / layout.width, (element.clientHeight - pad * 2) / layout.height)));
    setView({
      scale,
      x: (element.clientWidth - layout.width * scale) / 2 - layout.minX * scale,
      y: (element.clientHeight - layout.height * scale) / 2 - layout.minY * scale,
    });
  }, [layout]);
  useEffect(() => fit(), [fit]);

  // A wheel listener that may call preventDefault, which React's cannot.
  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => {
        if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1) {
          return { ...current, x: current.x - event.deltaX };
        }
        const scale = Math.min(2.5, Math.max(0.15, current.scale * Math.exp(-event.deltaY * 0.0015)));
        const ratio = scale / current.scale;
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  if (graph.scriptRef !== undefined) return <Notice>{t("scriptLayer", { ref: graph.scriptRef })}</Notice>;

  const port = (nodeId: string, name: string, side: "in" | "out") => {
    const own = ports.get(nodeId);
    const box = layout.boxes.get(nodeId);
    if (own === undefined || box === undefined) return undefined;
    const list = side === "in" ? own.inputs : own.outputs;
    const index = Math.max(0, list.indexOf(name));
    return { x: side === "in" ? box.x : box.x + box.w, y: box.y + NODE_HEAD + index * PORT_H + PORT_H / 2 };
  };
  const chosen = graph.nodes.find((node) => node.id === selected);
  const zoom = (factor: number) => {
    const element = host.current;
    const cx = (element?.clientWidth ?? 0) / 2;
    const cy = (element?.clientHeight ?? 0) / 2;
    setView((current) => {
      const scale = Math.min(2.5, Math.max(0.15, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  };

  return (
    <div className="graph">
      <div
        ref={host}
        className="graph-canvas"
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.scale}px ${20 * view.scale}px` }}
        onPointerDown={(event) => {
          if ((event.target as Element).closest(".node") !== null) return;
          drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === undefined) return;
          setView((current) => ({ ...current, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y }));
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
      >
        <svg width="100%" height="100%" role="img" aria-label={graph.name}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {graph.edges.map((edge, index) => {
              const from = port(edge.from.nodeId, edge.from.port, "out");
              const to = port(edge.to.nodeId, edge.to.port, "in");
              if (from === undefined || to === undefined) return null;
              const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
              return (
                <path
                  key={index}
                  className={isExecPort(edge.from.port) ? "wire wire-exec" : "wire wire-data"}
                  d={`M${from.x},${from.y} C${from.x + bend},${from.y} ${to.x - bend},${to.y} ${to.x},${to.y}`}
                />
              );
            })}
            {graph.nodes.map((node) => {
              const box = layout.boxes.get(node.id);
              if (box === undefined) return null;
              const tone = nodeTone(node.type);
              if (tone === "comment") {
                return (
                  <g key={node.id} className="node node-comment" onClick={() => setSelected(node.id)}>
                    <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="comment-body" />
                    <foreignObject x={box.x + 10} y={box.y + 8} width={box.w - 20} height={box.h - 16}>
                      <div className="comment-text">{String(node.params["text"] ?? "")}</div>
                    </foreignObject>
                  </g>
                );
              }
              const own = ports.get(node.id) ?? { inputs: [], outputs: [] };
              const rows = Math.max(own.inputs.length, own.outputs.length, 1);
              const name = typeof node.params["name"] === "string" ? `${nodeLabel(node.type)} · ${node.params["name"]}` : nodeLabel(node.type);
              return (
                <g key={node.id} className={selected === node.id ? `node tone-${tone} selected` : `node tone-${tone}`} onClick={() => setSelected(node.id)}>
                  <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="node-body" />
                  <path d={`M${box.x},${box.y + NODE_HEAD} v-${NODE_HEAD - 6} a6,6 0 0 1 6,-6 h${box.w - 12} a6,6 0 0 1 6,6 v${NODE_HEAD - 6} z`} className="node-head" />
                  <text x={box.x + 10} y={box.y + 17} className="node-title">
                    {name.length > 24 ? `${name.slice(0, 23)}…` : name}
                  </text>
                  {own.inputs.map((pin, index) => (
                    <g key={`i${pin}`}>
                      {isExecPort(pin) ? (
                        <path d={`M${box.x - 4},${box.y + NODE_HEAD + index * PORT_H + PORT_H / 2 - 5} l7,5 l-7,5 z`} className="pin pin-exec" />
                      ) : (
                        <circle cx={box.x} cy={box.y + NODE_HEAD + index * PORT_H + PORT_H / 2} r={4} className="pin pin-data" />
                      )}
                      <text x={box.x + 10} y={box.y + NODE_HEAD + index * PORT_H + 13} className="node-port">
                        {isExecPort(pin) ? "" : pin}
                      </text>
                    </g>
                  ))}
                  {own.outputs.map((pin, index) => (
                    <g key={`o${pin}`}>
                      {isExecPort(pin) ? (
                        <path d={`M${box.x + box.w - 3},${box.y + NODE_HEAD + index * PORT_H + PORT_H / 2 - 5} l7,5 l-7,5 z`} className="pin pin-exec" />
                      ) : (
                        <circle cx={box.x + box.w} cy={box.y + NODE_HEAD + index * PORT_H + PORT_H / 2} r={4} className="pin pin-data" />
                      )}
                      <text x={box.x + box.w - 10} y={box.y + NODE_HEAD + index * PORT_H + 13} className="node-port" textAnchor="end">
                        {pin === "then" || pin === "out" ? "" : pin}
                      </text>
                    </g>
                  ))}
                  {paramRows(node.params).map((row, index) => (
                    <g key={`p${row.key}`}>
                      <rect x={box.x + 8} y={box.y + NODE_HEAD + (rows + index) * PORT_H + 1} width={box.w - 16} height={PORT_H - 3} rx={3} className="param-field" />
                      <text x={box.x + 13} y={box.y + NODE_HEAD + (rows + index) * PORT_H + 12} className="param-text">
                        <tspan className="param-key">{row.key}</tspan> {row.value}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="graph-zoom" role="group" aria-label={t("zoom")}>
          <button className="ghost" onClick={() => zoom(1 / 1.2)} aria-label={t("zoomOut")}>
            −
          </button>
          <span className="muted small">{Math.round(view.scale * 100)}%</span>
          <button className="ghost" onClick={() => zoom(1.2)} aria-label={t("zoomIn")}>
            +
          </button>
          <button className="ghost small" onClick={fit}>
            {t("zoomFit")}
          </button>
        </div>
        <div className="graph-legend" aria-hidden="true">
          <span>
            <i className="legend-exec" />
            {t("wireExec")}
          </span>
          <span>
            <i className="legend-data" />
            {t("wireData")}
          </span>
        </div>
      </div>
      {chosen === undefined ? null : (
        <aside className="graph-props">
          <div className="panel-head">
            <Icon name="gear" />
            <span>{t("properties")}</span>
            <button className="ghost icon-button" onClick={() => setSelected(undefined)} aria-label={t("close")}>
              <Icon name="close" />
            </button>
          </div>
          <div className="graph-props-body">
            <strong>{nodeLabel(chosen.type)}</strong>
            <span className="muted small mono">{chosen.type}</span>
            <span className="muted small">
              {t("portsIn")}: {chosen.inputs.join(", ") || "—"}
            </span>
            <span className="muted small">
              {t("portsOut")}: {chosen.outputs.join(", ") || "—"}
            </span>
            <pre>{JSON.stringify(chosen.params, null, 2)}</pre>
          </div>
        </aside>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- assets */

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"]);
const AUDIO_EXT = new Set(["mp3", "ogg", "wav", "m4a", "flac"]);

function Assets({ projectId, tree }: { projectId: string; tree: Tree }) {
  const [assets, setAssets] = useState<readonly AssetView[] | undefined>(undefined);
  const [type, setType] = useState<string>("");
  useEffect(() => {
    const registers = tree.files.flatMap((file) => {
      const kind = assetRegisterType(file.path);
      return kind === undefined ? [] : [{ kind, path: file.path }];
    });
    Promise.all(
      registers.map((register) =>
        fetchJson(projectId, tree.revision, register.path)
          .then((json) => readAssetRegister(register.kind, json))
          .catch(() => []),
      ),
    ).then((lists) => setAssets(lists.flat().sort((a, b) => a.name.localeCompare(b.name))));
  }, [projectId, tree]);

  const present = useMemo(() => new Set(tree.files.map((file) => file.path)), [tree]);
  if (assets === undefined) return <p className="muted">{t("loading")}</p>;
  if (assets.length === 0) return <Notice>{t("noAssets")}</Notice>;
  const types = [...new Set(assets.map((asset) => asset.type))].sort();
  const shown = assets.filter((asset) => type === "" || asset.type === type);
  return (
    <div className="assets">
      <div className="chips">
        <button className={type === "" ? "chip active" : "chip"} onClick={() => setType("")}>
          {t("allTypes")} {assets.length}
        </button>
        {types.map((kind) => (
          <button key={kind} className={type === kind ? "chip active" : "chip"} onClick={() => setType(kind)}>
            {kind} {assets.filter((asset) => asset.type === kind).length}
          </button>
        ))}
      </div>
      <ul className="asset-grid">
        {shown.map((asset) => {
          const there = present.has(asset.contentPath);
          const url = there ? rawUrl(projectId, tree.revision, asset.contentPath, asset.ext) : undefined;
          return (
            <li key={asset.id} className="asset">
              <div className="asset-preview">
                {url !== undefined && asset.ext !== undefined && IMAGE_EXT.has(asset.ext) ? (
                  <img src={url} alt={asset.name} loading="lazy" />
                ) : url !== undefined && asset.ext !== undefined && AUDIO_EXT.has(asset.ext) ? (
                  <audio src={url} controls preload="none" />
                ) : (
                  <span className="muted">{asset.ext ?? asset.type}</span>
                )}
              </div>
              <div className="asset-name" title={asset.name}>
                {asset.name}
              </div>
              <div className="muted small">
                {asset.type}
                {asset.tags.length > 0 ? ` · ${asset.tags.join(", ")}` : ""}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- history */

function History(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  pick: (id: string) => void;
  me: string;
  role: TeamProjectRole | undefined;
}) {
  const { connection, open, projectId, pick, me, role } = props;
  const milestones = useMilestones(connection, open, projectId);
  const [revisions, setRevisions] = useState<readonly Revision[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [showAuto, setShowAuto] = useState(false);
  const [comparing, setComparing] = useState<string | undefined>(undefined);
  const load = useCallback(
    (after?: string) => {
      connection
        .call<{ revisions: Revision[]; cursor?: string }>("projects.history", { project: projectId, limit: 30, ...(after === undefined ? {} : { cursor: after }) })
        .then((page) => {
          setRevisions((current) => [...(after === undefined ? [] : (current ?? [])), ...page.revisions]);
          setCursor(page.cursor);
        })
        .catch(() => setRevisions((current) => current ?? []));
    },
    [connection, projectId],
  );
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  if (revisions === undefined) return <p className="muted">{t("loading")}</p>;
  if (revisions.length === 0) return <Notice>{t("noHistory")}</Notice>;
  // Automatic snapshots come every few minutes of editing; folded away unless asked for.
  const shown = revisions.filter((revision) => showAuto || !isAutoVersion(revision));
  const hidden = revisions.length - shown.length;
  return (
    <>
      <Checkbox
        className="small history-toggle"
        checked={showAuto}
        onChange={setShowAuto}
        label={
          <>
            {t("showAuto")}
            {!showAuto && hidden > 0 ? <span className="muted"> ({hidden})</span> : null}
          </>
        }
      />
      {comparing !== undefined ? <CompareWithNow projectId={projectId} revision={comparing} close={() => setComparing(undefined)} /> : null}
      <ol className="history">
        {shown.map((revision) => {
          const version = revision.version;
          const title = revisionTitle(revision);
          // A version's commit is under the account the server reads as: who saved it and whose
          // edits it holds say who did the work.
          const who = version === undefined
            ? (revision.by ?? "?")
            : [
                version.savedBy !== undefined ? t("versionSavedBy", { who: version.savedBy }) : undefined,
                version.participants.length > 0 ? t("versionWith", { names: version.participants.join("、") }) : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(" · ") || "—";
          return (
            <li key={revision.id} className="history-row">
              <div className="history-main">
                <div>
                  {isAutoVersion(revision) ? <span className="badge">{t("versionAuto")}</span> : null}{" "}
                  {title || (isAutoVersion(revision) ? null : <span className="muted">—</span>)}
                </div>
                <div className="muted small">
                  {who} · {when(revision.at)} · <code>{revision.id.slice(0, 12)}</code>{" "}
                  <MilestoneTags
                    connection={connection}
                    projectId={projectId}
                    revision={revision.id}
                    milestones={milestones}
                    canName={role === "owner" || role === "editor"}
                    me={me}
                    role={role}
                  />
                </div>
              </div>
              <div className="history-actions">
                <button className="ghost" onClick={() => pick(revision.id)}>
                  {t("viewThisRevision")}
                </button>
                <button className="ghost" onClick={() => setComparing(revision.id)}>
                  {t("compareWithNow")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {cursor !== undefined ? (
        <button className="ghost" onClick={() => load(cursor)}>
          {t("loadMore")}
        </button>
      ) : null}
    </>
  );
}
