/**
 * One project, read-only: overview, story, blueprints, assets and history, at
 * the newest revision or at any revision picked from the history.
 *
 * Everything here reads files through src/web/files.ts and interprets them
 * with @narraleaf/project-view. Nothing on this page edits the project; that
 * is Studio's (docs/architecture.md, D1).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

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
import type { TeamProjectRole } from "@narraleaf/team-protocol";

import { fetchJson, fetchTree, rawUrl, type Tree } from "./files";
import { Face, Timeline, Todos } from "./Collab";
import { LineComments, storyLineAnchor, useStoryThreads } from "./Comments";
import type { ConsoleAccount } from "./api";
import { t, type Phrase } from "./i18n";
import type { TeamConnection, ConnectionState } from "./socket";

export type ProjectTab = "overview" | "story" | "blueprints" | "assets" | "todos" | "history";
const TABS: readonly ProjectTab[] = ["overview", "story", "blueprints", "assets", "todos", "history"];
const TAB_PHRASE: Record<ProjectTab, Phrase> = {
  overview: "tabOverview",
  story: "tabStory",
  blueprints: "tabBlueprints",
  assets: "tabAssets",
  todos: "tabTodos",
  history: "tabHistory",
};

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role?: TeamProjectRole;
  readonly history?: { readonly revisions?: number; readonly lastAt?: number; readonly lastBy?: string; readonly lastMessage?: string };
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
  go: (tab: ProjectTab, revision: string) => void;
  back: () => void;
}) {
  const { account, connection, state, projectId, tab, revision, go, back } = props;
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

  useEffect(() => {
    setTree(undefined);
    setTreeError(undefined);
    fetchTree(projectId, revision)
      .then(setTree)
      .catch((caught: unknown) => setTreeError(errorText(caught)));
  }, [projectId, revision]);

  if (error !== undefined) {
    return <Notice tone="error">{t("loadFailed", { reason: error })}</Notice>;
  }

  return (
    <section className="project">
      <button className="ghost back" onClick={back}>
        ← {t("backToProjects")}
      </button>
      <header className="project-head">
        <h1>{project?.name ?? "…"}</h1>
        {project?.role === undefined ? null : <span className={`role role-${project.role}`}>{t(roleKey(project.role))}</span>}
      </header>
      {project?.description ? <p className="muted">{project.description}</p> : null}
      {revision !== "head" ? (
        <div className="revision-bar">
          <span>{t("atRevision", { rev: revision.slice(0, 12) })}</span>
          <button className="ghost" onClick={() => go(tab, "head")}>
            {t("backToHead")}
          </button>
        </div>
      ) : null}
      <nav className="tabs" role="tablist">
        {TABS.map((key) => (
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
      {tab === "history" ? (
        <History connection={connection} open={open} projectId={projectId} pick={(id) => go("story", id)} />
      ) : tab === "todos" ? (
        <ProjectTodos account={account} connection={connection} open={open} projectId={projectId} />
      ) : tab === "overview" ? (
        <Overview connection={connection} open={open} projectId={projectId} project={project} tree={tree} />
      ) : treeError !== undefined ? (
        <Notice>{t("notReadYetLong")}</Notice>
      ) : tree === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : tab === "story" ? (
        <Story
          projectId={projectId}
          tree={tree}
          connection={connection}
          open={open}
          canWrite={project?.role !== undefined && project.role !== "viewer"}
        />
      ) : tab === "blueprints" ? (
        <Blueprints projectId={projectId} tree={tree} />
      ) : (
        <Assets projectId={projectId} tree={tree} />
      )}
    </section>
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

function Overview(props: { connection: TeamConnection; open: boolean; projectId: string; project: ProjectSummary | undefined; tree: Tree | undefined }) {
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
      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{history?.revisions ?? "—"}</span>
          <span className="muted">{t("revisions", { count: String(history?.revisions ?? 0) })}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{tree?.total ?? "—"}</span>
          <span className="muted">files</span>
        </div>
      </div>
      {history?.lastMessage ? (
        <div className="card">
          <div className="muted">{t("lastChange")}</div>
          <div>{history.lastMessage}</div>
          <div className="muted small">{t("lastChangeBy", { who: history.lastBy ?? "?", when: when(history.lastAt) })}</div>
        </div>
      ) : null}
      <h2>{t("timeline")}</h2>
      <Timeline connection={connection} open={open} project={projectId} />
      <h2>{t("members")}</h2>
      <ul className="member-list">
        {(members ?? []).map((member) => (
          <li key={member.username}>
            <span className="member-name">
              <Face name={member.displayName || member.username} url={member.avatarUrl} size={22} />
              {member.displayName || member.username}
            </span>
            <span className={`role role-${member.role}`}>{t(roleKey(member.role))}</span>
          </li>
        ))}
      </ul>
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
}: {
  projectId: string;
  tree: Tree;
  connection: TeamConnection;
  open: boolean;
  canWrite: boolean;
}) {
  const [selected, setSelected] = useState<{ blockId: string; excerpt: string } | undefined>(undefined);
  const [library, setLibrary] = useState<StoryLibrary | Unsupported | undefined>(undefined);
  const [storyId, setStoryId] = useState<string | undefined>(undefined);
  const [document, setDocument] = useState<StoryDocumentView | Unsupported | undefined>(undefined);
  const [characters, setCharacters] = useState<ReadonlyMap<string, CharacterView>>(new Map());
  const [sceneId, setSceneId] = useState<string | undefined>(undefined);
  const [showCommands, setShowCommands] = useState(false);
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
        if (read.supported) setStoryId(read.defaultStoryId ?? read.stories[0]?.id);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
    if (has(CHARACTER_STORE_PATH)) {
      fetchJson(projectId, tree.revision, CHARACTER_STORE_PATH)
        .then((json) => setCharacters(readCharacters(json)))
        .catch(() => undefined);
    }
  }, [projectId, tree, has]);

  const entry = library?.supported ? library.stories.find((story) => story.id === storyId) : undefined;
  useEffect(() => {
    if (entry === undefined) return;
    setDocument(undefined);
    fetchJson(projectId, tree.revision, entry.documentPath)
      .then((json) => {
        const read = readStoryDocument(json);
        setDocument(read);
        if (read.supported) setSceneId(read.order[0]);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [projectId, tree, entry]);

  if (error !== undefined) return <Notice tone="error">{t("loadFailed", { reason: error })}</Notice>;
  if (library === undefined) return <p className="muted">{t("loading")}</p>;
  if (!library.supported) return <UnsupportedNotice value={library} />;
  if (library.stories.length === 0) return <Notice>{t("noStories")}</Notice>;

  const scene = document?.supported && sceneId !== undefined ? document.scenes[sceneId] : undefined;
  return (
    <StoryBody
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
      revision={tree.revision}
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
}) {
  const { library, storyId, setStoryId, document, sceneId, setSceneId, scene, showCommands, setShowCommands, characters } = props;
  const { connection, open, projectId, revision, canWrite, selected, setSelected } = props;
  const threads = useStoryThreads(connection, open, projectId, storyId);
  const threadsOn = (blockId: string) => (sceneId === undefined ? [] : (threads.get(storyLineAnchor(sceneId, blockId)) ?? []));
  return (
    <div className={selected === undefined ? "story" : "story with-comments"}>
      <aside className="story-outline">
        {library.stories.length > 1 ? (
          <select value={storyId} onChange={(event) => setStoryId(event.target.value)}>
            {library.stories.map((story) => (
              <option key={story.id} value={story.id}>
                {story.name}
              </option>
            ))}
          </select>
        ) : null}
        {document === undefined ? (
          <p className="muted">{t("loading")}</p>
        ) : !document.supported ? (
          <UnsupportedNotice value={document} />
        ) : (
          <>
            {document.chapters.map((chapter) => (
              <div key={chapter.id} className="outline-group">
                <div className="outline-title">{chapter.name}</div>
                {chapter.sceneIds.map((id) => (
                  <SceneLink key={id} name={document.scenes[id]?.name ?? id} active={id === sceneId} onClick={() => setSceneId(id)} />
                ))}
              </div>
            ))}
            {document.unassignedSceneIds.length > 0 ? (
              <div className="outline-group">
                <div className="outline-title">{t("unassigned")}</div>
                {document.unassignedSceneIds.map((id) => (
                  <SceneLink key={id} name={document.scenes[id]?.name ?? id} active={id === sceneId} onClick={() => setSceneId(id)} />
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
              <h2>{scene.name}</h2>
              <button className="ghost" onClick={() => setShowCommands((value) => !value)}>
                {showCommands ? t("hideCommands") : t("showCommands")}
              </button>
            </div>
            {scene.description ? <p className="muted">{scene.description}</p> : null}
            <ol className="script-rows">
              {scene.rows
                .filter((row) => showCommands || (row.kind !== "command" && row.kind !== "empty"))
                .map((row) => (
                  <ScriptRow
                    key={row.id}
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

function SceneLink({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? "outline-link active" : "outline-link"} onClick={onClick}>
      {name}
    </button>
  );
}

function ScriptRow({
  row,
  characters,
  marks,
  selected,
  onSelect,
}: {
  row: StoryRow;
  characters: ReadonlyMap<string, CharacterView>;
  marks: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const indent = { paddingLeft: `${row.depth * 20 + 12}px` };
  const cls = `row row-${row.kind}${row.disabled ? " row-disabled" : ""}${selected ? " row-selected" : ""}`;
  const mark = marks > 0 ? <span className="row-mark" title={String(marks)}>{marks}</span> : null;
  switch (row.kind) {
    case "dialogue": {
      const speaker =
        row.speaker === undefined
          ? "？"
          : "characterId" in row.speaker
            ? (characters.get(row.speaker.characterId)?.name ?? row.speaker.characterId.slice(0, 8))
            : row.speaker.name;
      return (
        <li className={cls} style={indent} id={`row-${row.id}`} onClick={onSelect}>
          <span className="speaker">{speaker}</span>
          <span className="line">{row.text}</span>
          {mark}
        </li>
      );
    }
    case "narration":
    case "choice":
    case "option":
    case "note":
    case "invalid":
      return (
        <li className={cls} style={indent} id={`row-${row.id}`} onClick={onSelect}>
          {row.kind === "option" ? <span className="marker">▸</span> : null}
          <span className="line">{row.text}</span>
          {mark}
        </li>
      );
    case "command":
      return (
        <li className={cls} style={indent} id={`row-${row.id}`} onClick={onSelect}>
          <code>/{row.command}</code>
          {row.detail ? <span className="muted"> {row.detail}</span> : null}
          {mark}
        </li>
      );
    case "empty":
      return <li className={cls} style={indent} />;
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
      <div className="script">{graph === undefined ? null : <GraphCanvas graph={graph} />}</div>
    </div>
  );
}

const NODE_W = 200;
const NODE_HEAD = 26;
const PORT_H = 18;

/** A read-only node graph: placed nodes, their ports, and the wires between them. Scroll to pan. */
function GraphCanvas({ graph }: { graph: BlueprintGraphView }) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const layout = useMemo(() => {
    // Nodes never placed are laid out in a column to the right of the placed ones.
    const placed = graph.nodes.filter((node) => node.x !== undefined && node.y !== undefined);
    const maxX = placed.reduce((max, node) => Math.max(max, node.x ?? 0), 0);
    let floating = 0;
    const boxes = new Map<string, { x: number; y: number; h: number }>();
    for (const node of graph.nodes) {
      const h = NODE_HEAD + Math.max(node.inputs.length, node.outputs.length, 1) * PORT_H + 8;
      const x = node.x ?? maxX + NODE_W + 80;
      const y = node.y ?? (floating += h + 24) - h;
      boxes.set(node.id, { x, y, h });
    }
    const xs = [...boxes.values()].map((box) => box.x);
    const ys = [...boxes.values()].map((box) => box.y);
    const minX = Math.min(0, ...xs) - 40;
    const minY = Math.min(0, ...ys) - 40;
    const width = Math.max(...xs.map((x) => x + NODE_W), 400) - minX + 40;
    const height = Math.max(...[...boxes.values()].map((box) => box.y + box.h), 300) - minY + 40;
    return { boxes, minX, minY, width, height };
  }, [graph]);

  if (graph.scriptRef !== undefined) return <Notice>{t("scriptLayer", { ref: graph.scriptRef })}</Notice>;

  const portY = (nodeId: string, port: string, side: "in" | "out") => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const box = layout.boxes.get(nodeId);
    if (node === undefined || box === undefined) return undefined;
    const ports = side === "in" ? node.inputs : node.outputs;
    const index = Math.max(0, ports.indexOf(port));
    return { x: side === "in" ? box.x : box.x + NODE_W, y: box.y + NODE_HEAD + index * PORT_H + PORT_H / 2 };
  };
  const chosen = graph.nodes.find((node) => node.id === selected);

  return (
    <div className="graph">
      <div className="graph-scroll">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}
          role="img"
          aria-label={graph.name}
        >
          {graph.edges.map((edge, index) => {
            const from = portY(edge.from.nodeId, edge.from.port, "out");
            const to = portY(edge.to.nodeId, edge.to.port, "in");
            if (from === undefined || to === undefined) return null;
            const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
            return (
              <path
                key={index}
                className="wire"
                d={`M${from.x},${from.y} C${from.x + bend},${from.y} ${to.x - bend},${to.y} ${to.x},${to.y}`}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const box = layout.boxes.get(node.id);
            if (box === undefined) return null;
            return (
              <g key={node.id} className={selected === node.id ? "node selected" : "node"} onClick={() => setSelected(node.id)}>
                <rect x={box.x} y={box.y} width={NODE_W} height={box.h} rx={6} className="node-body" />
                <rect x={box.x} y={box.y} width={NODE_W} height={NODE_HEAD} rx={6} className="node-head" />
                <text x={box.x + 8} y={box.y + 17} className="node-title">
                  {node.type.length > 28 ? `${node.type.slice(0, 27)}…` : node.type}
                </text>
                {node.inputs.map((port, index) => (
                  <text key={`i${port}`} x={box.x + 10} y={box.y + NODE_HEAD + index * PORT_H + 13} className="node-port">
                    ● {port}
                  </text>
                ))}
                {node.outputs.map((port, index) => (
                  <text
                    key={`o${port}`}
                    x={box.x + NODE_W - 10}
                    y={box.y + NODE_HEAD + index * PORT_H + 13}
                    className="node-port"
                    textAnchor="end"
                  >
                    {port} ●
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {chosen === undefined ? null : (
        <aside className="graph-props">
          <div className="outline-title">{chosen.type}</div>
          <pre>{JSON.stringify(chosen.params, null, 2)}</pre>
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

interface Revision {
  readonly id: string;
  readonly at?: number;
  readonly by?: string;
  readonly message?: string;
}

function History({ connection, open, projectId, pick }: { connection: TeamConnection; open: boolean; projectId: string; pick: (id: string) => void }) {
  const [revisions, setRevisions] = useState<readonly Revision[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
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
  return (
    <>
      <ol className="history">
        {revisions.map((revision) => (
          <li key={revision.id} className="history-row">
            <div className="history-main">
              <div>{revision.message || <span className="muted">—</span>}</div>
              <div className="muted small">
                {revision.by ?? "?"} · {when(revision.at)} · <code>{revision.id.slice(0, 12)}</code>
              </div>
            </div>
            <button className="ghost" onClick={() => pick(revision.id)}>
              {t("viewThisRevision")}
            </button>
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
