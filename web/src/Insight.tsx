/**
 * Looking across a project rather than at one page of it: two revisions side
 * by side, the checks a story should pass before it ships, and where each asset
 * is used. All of it is read in the browser from the revision's files.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AssetView, BlueprintGraphView, StoryRow } from "@narraleaf/project-view";

import { rawUrl, type Tree, type TreeFile } from "./files";
import { t, type Phrase } from "./i18n";
import { Icon, type IconName } from "./Icon";
import {
  CHECK_SEVERITY,
  mergeOrder,
  projectDataAt,
  runChecks,
  sameFile,
  useProjectData,
  wordDiff,
  type CheckKind,
  type Finding,
  type Piece,
  type Place,
  type ProjectData,
} from "./projectData";
import { revisionTitle, isAutoVersion, type Revision } from "./Production";
import { describeCommand, type CommandLookups } from "./storyCommands";
import type { TeamConnection } from "./socket";
import { Blankslate, Flash, SelectPanel, Skeleton, UnderlineNav, type SelectOption } from "./ui";
import { assetAs, assetKindName, AUDIO_EXT, IMAGE_EXT, MiniPlayer, nodeLabel } from "./Project";

/** Where a place is, read out: story · scene · line. */
export function placeText(place: Place, stories = 1): string {
  const parts = [stories > 1 ? place.storyName : undefined, place.sceneName, place.line === undefined ? undefined : t("lineNo", { line: String(place.line) })];
  return parts.filter((part) => part !== undefined && part !== "").join(" · ");
}

function lookupsOf(data: ProjectData, storyId: string): CommandLookups {
  const document = data.stories.find((story) => story.entry.id === storyId)?.document;
  return {
    characters: data.characters,
    variables: data.variables,
    assets: data.assets,
    sceneName: (id) => document?.scenes[id]?.name,
  };
}

/** A row as one line of text, the way the story view reads it. */
function rowLine(row: StoryRow, lookups: CommandLookups): string {
  switch (row.kind) {
    case "dialogue": {
      const speaker =
        row.speaker === undefined ? "？" : "characterId" in row.speaker ? (lookups.characters.get(row.speaker.characterId)?.name ?? "？") : row.speaker.name;
      return `${speaker}：${row.text}`;
    }
    case "command": {
      const view = describeCommand(row, lookups);
      return [`@${view.name}`, ...view.args.map((arg) => (arg.key === undefined ? arg.value : `${arg.key}=${arg.value}`))].join(" ");
    }
    case "choice":
      return `@${t("menuCommand")} ${row.text}`;
    case "option":
      return `${t("optionLabel")} ${row.text}`;
    case "empty":
      return "";
    default:
      return row.text;
  }
}

function signature(row: StoryRow): string {
  const { id: _id, ...rest } = row;
  return JSON.stringify(rest);
}

function Pieces({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "same" ? (
          <span key={index}>{piece.text}</span>
        ) : piece.kind === "added" ? (
          <ins key={index}>{piece.text}</ins>
        ) : (
          <del key={index}>{piece.text}</del>
        ),
      )}
    </>
  );
}

/* --------------------------------------------------------------- compare */

type FileStatus = "added" | "removed" | "modified";
type FileGroup = "story" | "assets" | "blueprints" | "other";

function groupOf(path: string): FileGroup {
  if (path.startsWith("editor/story/") || path === "editor/services/character.json" || path === "editor/variables.json") return "story";
  if (path.startsWith("assets/")) return "assets";
  if (path.startsWith("editor/ui/")) return "blueprints";
  return "other";
}

async function sameText(projectId: string, a: string, b: string, path: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [a, b].map((revision) => fetch(rawUrl(projectId, revision, path), { credentials: "same-origin" }).then((response) => (response.ok ? response.text() : Promise.reject(new Error(response.statusText))))),
  );
  return left === right;
}

/** Which files differ between two trees: by content address where both have one, by size, and by reading the file when neither tells. */
async function fileChanges(projectId: string, before: Tree, after: Tree): Promise<Map<string, FileStatus>> {
  const changes = new Map<string, FileStatus>();
  const old = new Map<string, TreeFile>(before.files.map((file) => [file.path, file]));
  const unsure: string[] = [];
  for (const file of after.files) {
    const was = old.get(file.path);
    old.delete(file.path);
    if (was === undefined) changes.set(file.path, "added");
    else {
      const same = sameFile(was, file);
      if (same === false) changes.set(file.path, "modified");
      else if (same === undefined) unsure.push(file.path);
    }
  }
  for (const path of old.keys()) changes.set(path, "removed");
  // Read the few whose bytes nothing else vouches for: what the server holds right now has no address yet.
  const readable = unsure.filter((path) => /\.(json|txt|md|ts|js|css|ya?ml)$/i.test(path)).slice(0, 60);
  await Promise.all(
    readable.map(async (path) => {
      try {
        if (!(await sameText(projectId, before.revision, after.revision, path))) changes.set(path, "modified");
      } catch {
        changes.set(path, "modified");
      }
    }),
  );
  return changes;
}

interface SceneChange {
  readonly key: string;
  readonly storyName: string;
  readonly sceneId: string;
  readonly sceneName: string;
  readonly status: "added" | "removed" | "changed";
  readonly renamedFrom?: string;
  readonly rows: readonly RowEntry[];
}

type RowEntry =
  | { readonly kind: "added" | "removed"; readonly id: string; readonly line: number; readonly text: string }
  | { readonly kind: "changed"; readonly id: string; readonly line: number; readonly pieces: readonly Piece[] }
  | { readonly kind: "gap"; readonly count: number };

function storyChanges(before: ProjectData, after: ProjectData): SceneChange[] {
  const out: SceneChange[] = [];
  const storyIds = mergeOrder(
    before.stories.map((story) => story.entry.id),
    after.stories.map((story) => story.entry.id),
  );
  for (const { id: storyId } of storyIds) {
    const was = before.stories.find((story) => story.entry.id === storyId);
    const now = after.stories.find((story) => story.entry.id === storyId);
    const storyName = now?.entry.name ?? was?.entry.name ?? storyId;
    const oldLookups = lookupsOf(before, storyId);
    const newLookups = lookupsOf(after, storyId);
    for (const { id: sceneId } of mergeOrder(was?.document.order ?? [], now?.document.order ?? [])) {
      const a = was?.document.scenes[sceneId];
      const b = now?.document.scenes[sceneId];
      if (a === undefined && b === undefined) continue;
      const oldRows = new Map((a?.rows ?? []).map((row) => [row.id, row]));
      const newRows = new Map((b?.rows ?? []).map((row) => [row.id, row]));
      const oldLine = new Map((a?.rows ?? []).map((row, index) => [row.id, index + 1]));
      const newLine = new Map((b?.rows ?? []).map((row, index) => [row.id, index + 1]));
      const rows: RowEntry[] = [];
      let gap = 0;
      const flush = () => {
        if (gap > 0) rows.push({ kind: "gap", count: gap });
        gap = 0;
      };
      for (const step of mergeOrder(
        (a?.rows ?? []).map((row) => row.id),
        (b?.rows ?? []).map((row) => row.id),
      )) {
        const left = oldRows.get(step.id);
        const right = newRows.get(step.id);
        if (step.kind === "removed" && left !== undefined) {
          if (left.kind === "empty") continue;
          flush();
          rows.push({ kind: "removed", id: step.id, line: oldLine.get(step.id) ?? 0, text: rowLine(left, oldLookups) });
        } else if (step.kind === "added" && right !== undefined) {
          if (right.kind === "empty") continue;
          flush();
          rows.push({ kind: "added", id: step.id, line: newLine.get(step.id) ?? 0, text: rowLine(right, newLookups) });
        } else if (left !== undefined && right !== undefined) {
          if (signature(left) === signature(right)) {
            gap += 1;
            continue;
          }
          const before = rowLine(left, oldLookups);
          const after = rowLine(right, newLookups);
          if (before === after) {
            gap += 1;
            continue;
          }
          flush();
          rows.push({ kind: "changed", id: step.id, line: newLine.get(step.id) ?? 0, pieces: wordDiff(before, after) });
        }
      }
      const renamed = a !== undefined && b !== undefined && a.name !== b.name ? a.name : undefined;
      const touched = rows.some((row) => row.kind !== "gap");
      if (!touched && renamed === undefined && a !== undefined && b !== undefined) continue;
      // The untouched rows before the first change say nothing; those after the last are never flushed.
      if (rows[0]?.kind === "gap") rows.shift();
      out.push({
        key: `${storyId}/${sceneId}`,
        storyName,
        sceneId,
        sceneName: b?.name ?? a?.name ?? sceneId,
        status: a === undefined ? "added" : b === undefined ? "removed" : "changed",
        ...(renamed === undefined ? {} : { renamedFrom: renamed }),
        rows,
      });
    }
  }
  return out;
}

interface GraphChange {
  readonly key: string;
  readonly title: string;
  readonly status: "added" | "removed" | "changed";
  readonly nodes: readonly { kind: "added" | "removed" | "changed" | "moved"; label: string; detail?: string }[];
  readonly edges: readonly { kind: "added" | "removed"; label: string }[];
}

function blueprintChanges(before: ProjectData, after: ProjectData): GraphChange[] {
  const graphs = (data: ProjectData) => {
    const map = new Map<string, { title: string; graph: BlueprintGraphView }>();
    for (const blueprint of data.blueprints?.blueprints ?? []) {
      for (const graph of blueprint.graphs) map.set(`${blueprint.id}/${graph.id}`, { title: `${blueprint.name} · ${graph.name}`, graph });
    }
    return map;
  };
  const was = graphs(before);
  const now = graphs(after);
  const out: GraphChange[] = [];
  for (const key of new Set([...now.keys(), ...was.keys()])) {
    const a = was.get(key)?.graph;
    const b = now.get(key)?.graph;
    const title = now.get(key)?.title ?? was.get(key)?.title ?? key;
    const nodeName = (graph: BlueprintGraphView | undefined, id: string) => {
      const node = graph?.nodes.find((candidate) => candidate.id === id);
      return node === undefined ? id.slice(0, 6) : nodeLabel(node.type);
    };
    const oldNodes = new Map((a?.nodes ?? []).map((node) => [node.id, node]));
    const nodes: GraphChange["nodes"][number][] = [];
    for (const node of b?.nodes ?? []) {
      const old = oldNodes.get(node.id);
      oldNodes.delete(node.id);
      if (old === undefined) nodes.push({ kind: "added", label: nodeLabel(node.type) });
      else if (JSON.stringify(old.params) !== JSON.stringify(node.params) || old.type !== node.type) {
        const keys = [...new Set([...Object.keys(old.params), ...Object.keys(node.params)])].filter(
          (name) => JSON.stringify(old.params[name]) !== JSON.stringify(node.params[name]),
        );
        nodes.push({ kind: "changed", label: nodeLabel(node.type), detail: keys.slice(0, 4).join(", ") });
      } else if (old.x !== node.x || old.y !== node.y) nodes.push({ kind: "moved", label: nodeLabel(node.type) });
    }
    for (const node of oldNodes.values()) nodes.push({ kind: "removed", label: nodeLabel(node.type) });
    const edgeKey = (edge: BlueprintGraphView["edges"][number]) => `${edge.from.nodeId}:${edge.from.port}>${edge.to.nodeId}:${edge.to.port}`;
    const oldEdges = new Map((a?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
    const newEdges = new Map((b?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
    const edges: GraphChange["edges"][number][] = [];
    const edgeLabel = (graph: BlueprintGraphView | undefined, edge: BlueprintGraphView["edges"][number]) =>
      `${nodeName(graph, edge.from.nodeId)}.${edge.from.port} → ${nodeName(graph, edge.to.nodeId)}.${edge.to.port}`;
    for (const [keyOf, edge] of newEdges) if (!oldEdges.has(keyOf)) edges.push({ kind: "added", label: edgeLabel(b, edge) });
    for (const [keyOf, edge] of oldEdges) if (!newEdges.has(keyOf)) edges.push({ kind: "removed", label: edgeLabel(a, edge) });
    if (a !== undefined && b !== undefined && nodes.length === 0 && edges.length === 0) continue;
    out.push({ key, title, status: a === undefined ? "added" : b === undefined ? "removed" : "changed", nodes, edges });
  }
  return out;
}

interface AssetChange {
  readonly id: string;
  readonly status: "added" | "removed" | "content" | "renamed";
  readonly before?: AssetView;
  readonly after?: AssetView;
}

function assetChanges(before: ProjectData, after: ProjectData, files: ReadonlyMap<string, FileStatus>): AssetChange[] {
  const out: AssetChange[] = [];
  for (const [id, asset] of after.assets) {
    const old = before.assets.get(id);
    if (old === undefined) out.push({ id, status: "added", after: asset });
    else if (files.get(asset.contentPath) === "modified" || (files.get(asset.contentPath) === "added" && before.present.has(old.contentPath) === false))
      out.push({ id, status: "content", before: old, after: asset });
    else if (old.name !== asset.name) out.push({ id, status: "renamed", before: old, after: asset });
  }
  for (const [id, asset] of before.assets) if (!after.assets.has(id)) out.push({ id, status: "removed", before: asset });
  return out;
}

interface Comparison {
  readonly files: ReadonlyMap<string, FileStatus>;
  readonly scenes: readonly SceneChange[];
  readonly graphs: readonly GraphChange[];
  readonly assets: readonly AssetChange[];
  readonly before: ProjectData;
  readonly after: ProjectData;
}

const STATUS_PHRASE: Record<string, Phrase> = {
  added: "compareAdded",
  removed: "compareRemoved",
  modified: "compareChanged",
  changed: "compareChanged",
  content: "compareContentChanged",
  renamed: "compareRenamed",
  moved: "compareMoved",
};

function StatusBadge({ status }: { status: string }) {
  const phrase = STATUS_PHRASE[status];
  return <span className={`diff-badge diff-${status}`}>{phrase === undefined ? status : t(phrase)}</span>;
}

export function parseRange(range: string | undefined): { from: string; to: string } | undefined {
  if (range === undefined) return undefined;
  const [from, to] = range.split("...");
  return from === undefined || from === "" ? undefined : { from, to: to === undefined || to === "" ? "current" : to };
}

type CompareTab = "story" | "assets" | "blueprints" | "other";

export function ComparePage(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  range: string | undefined;
  setRange: (range: string) => void;
  openAt: (place: Place, revision: string) => void;
}) {
  const { connection, open, projectId, range, setRange, openAt } = props;
  const [revisions, setRevisions] = useState<readonly Revision[] | undefined>(undefined);
  const [result, setResult] = useState<Comparison | Error | undefined>(undefined);
  const [tab, setTab] = useState<CompareTab>("story");
  const parsed = parseRange(range);

  useEffect(() => {
    if (!open) return;
    connection
      .call<{ revisions: Revision[] }>("projects.history", { project: projectId, limit: 60 })
      .then((page) => setRevisions(page.revisions))
      .catch(() => setRevisions([]));
  }, [open, connection, projectId]);

  // With no range named, the newest version saved by hand against what the project holds now.
  useEffect(() => {
    if (parsed !== undefined || revisions === undefined) return;
    const first = revisions.find((revision) => !isAutoVersion(revision)) ?? revisions[0];
    if (first !== undefined) setRange(`${first.id}...current`);
  }, [parsed, revisions, setRange]);

  const from = parsed?.from;
  const to = parsed?.to;
  useEffect(() => {
    if (from === undefined || to === undefined) return undefined;
    let live = true;
    setResult(undefined);
    void (async () => {
      try {
        const [before, after] = await Promise.all([projectDataAt(projectId, from), projectDataAt(projectId, to)]);
        const files = await fileChanges(projectId, before.tree, after.tree);
        const next: Comparison = {
          files,
          scenes: storyChanges(before, after),
          graphs: blueprintChanges(before, after),
          assets: assetChanges(before, after, files),
          before,
          after,
        };
        if (live) setResult(next);
      } catch (caught) {
        if (live) setResult(caught instanceof Error ? caught : new Error(String(caught)));
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, from, to]);

  const options = useMemo<SelectOption<string>[]>(
    () => [
      { value: "current", label: t("compareNow"), description: t("compareNowHint"), icon: "dot" },
      ...(revisions ?? []).map((revision) => ({
        value: revision.id,
        label: revisionTitle(revision) || revision.id.slice(0, 7),
        description: [revision.version?.savedBy ?? revision.by, revision.at === undefined ? undefined : new Date(revision.at).toLocaleString(), revision.id.slice(0, 7)]
          .filter((part) => part !== undefined)
          .join(" · "),
        icon: isAutoVersion(revision) ? ("history" as const) : ("tag" as const),
      })),
    ],
    [revisions],
  );
  const picker = (value: string | undefined, onChange: (next: string) => void, label: string) => (
    <SelectPanel
      label={label}
      options={value !== undefined && !options.some((option) => option.value === value) ? [...options, { value, label: value.slice(0, 7) }] : options}
      value={value}
      onChange={onChange}
      filterFrom={6}
      renderButton={(summary) => (
        <span className="compare-ref">
          <span className="muted small">{label}</span> <strong>{summary}</strong>
        </span>
      )}
    />
  );

  const comparison = result instanceof Error ? undefined : result;
  const otherFiles = comparison === undefined ? [] : [...comparison.files].filter(([path]) => groupOf(path) === "other");
  const tabs = [
    { key: "story" as const, label: t("compareStory"), icon: "book" as IconName, count: comparison?.scenes.length },
    { key: "assets" as const, label: t("tabAssets"), icon: "image" as IconName, count: comparison?.assets.length },
    { key: "blueprints" as const, label: t("tabBlueprints"), icon: "graph" as IconName, count: comparison?.graphs.length },
    { key: "other" as const, label: t("compareOtherFiles"), icon: "file" as IconName, count: otherFiles.length },
  ];
  const stories = comparison?.after.stories.length ?? 1;
  const openRevision = (kind: "before" | "after") => (kind === "before" ? (from ?? "current") : (to ?? "current"));

  return (
    <div className="compare-page">
      <div className="compare-bar">
        <Icon name="compare" size={16} />
        {picker(from, (next) => setRange(`${next}...${to ?? "current"}`), t("compareBase"))}
        <span className="muted" aria-hidden="true">
          ←
        </span>
        {picker(to, (next) => setRange(`${from ?? "current"}...${next}`), t("compareTarget"))}
        <button
          className="btn btn-sm"
          disabled={from === undefined || to === undefined}
          onClick={() => from !== undefined && to !== undefined && setRange(`${to}...${from}`)}
          title={t("compareSwap")}
        >
          <Icon name="swap" size={14} />
          <span>{t("compareSwap")}</span>
        </button>
      </div>
      {result instanceof Error ? (
        <Flash error={result} />
      ) : parsed === undefined && revisions !== undefined && revisions.length === 0 ? (
        <Blankslate icon="history" title={t("noHistory")}>
          {t("noHistoryHint")}
        </Blankslate>
      ) : comparison === undefined ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <p className="muted small compare-summary">
            {t("compareSummary", {
              files: String(comparison.files.size),
              scenes: String(comparison.scenes.length),
              assets: String(comparison.assets.length),
              graphs: String(comparison.graphs.length),
            })}
          </p>
          <UnderlineNav tabs={tabs} active={tab} onSelect={setTab} label={t("compareTitleShort")} />
          {tab === "story" ? (
            comparison.scenes.length === 0 ? (
              <Blankslate icon="book" title={t("compareNone")} compact />
            ) : (
              <div className="diff-list">
                {comparison.scenes.map((scene) => (
                  <section key={scene.key} className="diff-file">
                    <header className="diff-file-head">
                      <StatusBadge status={scene.status} />
                      <strong>{scene.sceneName}</strong>
                      {stories > 1 ? <span className="muted small">{scene.storyName}</span> : null}
                      {scene.renamedFrom !== undefined ? <span className="muted small">{t("compareRenamedFrom", { name: scene.renamedFrom })}</span> : null}
                    </header>
                    <ol className="diff-rows">
                      {scene.rows.map((row, index) =>
                        row.kind === "gap" ? (
                          <li key={index} className="diff-gap">
                            {t("compareUnchangedRows", { count: String(row.count) })}
                          </li>
                        ) : (
                          <li key={index} className={`diff-row diff-row-${row.kind}`}>
                            <button
                              className="diff-line-no"
                              title={t("compareOpenRow")}
                              onClick={() =>
                                openAt(
                                  { storyId: scene.key.split("/")[0] ?? "", storyName: scene.storyName, sceneId: scene.sceneId, sceneName: scene.sceneName, rowId: row.id, line: row.line },
                                  openRevision(row.kind === "removed" ? "before" : "after"),
                                )
                              }
                            >
                              {row.line}
                            </button>
                            <span className="diff-sign" aria-hidden="true">
                              {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : "~"}
                            </span>
                            <span className="diff-text">{row.kind === "changed" ? <Pieces pieces={row.pieces} /> : row.text}</span>
                          </li>
                        ),
                      )}
                    </ol>
                  </section>
                ))}
              </div>
            )
          ) : tab === "assets" ? (
            comparison.assets.length === 0 ? (
              <Blankslate icon="image" title={t("compareNoAssets")} compact />
            ) : (
              <div className="diff-list">
                {comparison.assets.map((change) => (
                  <AssetDiff key={change.id} projectId={projectId} change={change} before={comparison.before.tree} after={comparison.after.tree} />
                ))}
              </div>
            )
          ) : tab === "blueprints" ? (
            comparison.graphs.length === 0 ? (
              <Blankslate icon="graph" title={t("compareNoBlueprints")} compact />
            ) : (
              <div className="diff-list">
                {comparison.graphs.map((graph) => (
                  <section key={graph.key} className="diff-file">
                    <header className="diff-file-head">
                      <StatusBadge status={graph.status} />
                      <strong>{graph.title}</strong>
                      <span className="muted small">{t("compareGraphCounts", { nodes: String(graph.nodes.length), edges: String(graph.edges.length) })}</span>
                    </header>
                    <ul className="diff-rows">
                      {graph.nodes.map((node, index) => (
                        <li key={`n${index}`} className={`diff-row diff-row-${node.kind === "moved" ? "changed" : node.kind}`}>
                          <StatusBadge status={node.kind} />
                          <span className="diff-text">
                            {node.label}
                            {node.detail ? <span className="muted small"> · {node.detail}</span> : null}
                          </span>
                        </li>
                      ))}
                      {graph.edges.map((edge, index) => (
                        <li key={`e${index}`} className={`diff-row diff-row-${edge.kind}`}>
                          <span className="diff-sign" aria-hidden="true">
                            {edge.kind === "added" ? "+" : "−"}
                          </span>
                          <span className="diff-text mono small">{edge.label}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )
          ) : otherFiles.length === 0 ? (
            <Blankslate icon="file" title={t("compareNoFiles")} compact />
          ) : (
            <ul className="diff-files">
              {otherFiles.map(([path, status]) => (
                <li key={path}>
                  <StatusBadge status={status} />
                  <span className="mono small">{path}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function AssetPreview({ projectId, tree, asset }: { projectId: string; tree: Tree; asset: AssetView }) {
  const as = assetAs(asset);
  const there = tree.files.some((file) => file.path === asset.contentPath);
  const url = there ? rawUrl(projectId, tree.revision, asset.contentPath, as) : undefined;
  if (url !== undefined && as !== undefined && IMAGE_EXT.has(as)) return <img src={url} alt={asset.name} loading="lazy" />;
  if (url !== undefined && as !== undefined && AUDIO_EXT.has(as)) return <MiniPlayer src={url} />;
  return (
    <span className="asset-kind">
      <Icon name="file" size={20} />
      {there ? null : <span className="small">{t("assetNotSynced")}</span>}
    </span>
  );
}

function AssetDiff({ projectId, change, before, after }: { projectId: string; change: AssetChange; before: Tree; after: Tree }) {
  const [mode, setMode] = useState<"side" | "slider">("side");
  const [split, setSplit] = useState(50);
  const asset = change.after ?? change.before;
  if (asset === undefined) return null;
  const as = assetAs(asset);
  const image = as !== undefined && IMAGE_EXT.has(as);
  const both = change.before !== undefined && change.after !== undefined && change.status === "content";
  const beforeUrl = change.before === undefined ? undefined : rawUrl(projectId, before.revision, change.before.contentPath, assetAs(change.before));
  const afterUrl = change.after === undefined ? undefined : rawUrl(projectId, after.revision, change.after.contentPath, assetAs(change.after));
  return (
    <section className="diff-file">
      <header className="diff-file-head">
        <StatusBadge status={change.status} />
        <strong>{asset.name}</strong>
        <span className="muted small">{assetKindName(asset.type)}</span>
        {change.status === "renamed" && change.before !== undefined ? (
          <span className="muted small">{t("compareRenamedFrom", { name: change.before.name })}</span>
        ) : null}
        {both && image ? (
          <span className="segmented diff-file-tools" role="group">
            <button className={mode === "side" ? "active" : undefined} onClick={() => setMode("side")}>
              {t("compareSideBySide")}
            </button>
            <button className={mode === "slider" ? "active" : undefined} onClick={() => setMode("slider")}>
              {t("compareSlider")}
            </button>
          </span>
        ) : null}
      </header>
      {both && image && mode === "slider" && beforeUrl !== undefined && afterUrl !== undefined ? (
        <div className="image-slider">
          <div className="image-slider-frame">
            <img src={beforeUrl} alt={t("compareBefore")} />
            <img src={afterUrl} alt={t("compareAfter")} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
            <span className="image-slider-line" style={{ left: `${split}%` }} aria-hidden="true" />
          </div>
          <input type="range" min={0} max={100} value={split} onChange={(event) => setSplit(Number(event.currentTarget.value))} aria-label={t("compareSlider")} />
        </div>
      ) : both ? (
        <div className="asset-pair">
          <figure>
            <figcaption className="muted small">{t("compareBefore")}</figcaption>
            <div className="asset-preview">{change.before === undefined ? null : <AssetPreview projectId={projectId} tree={before} asset={change.before} />}</div>
          </figure>
          <figure>
            <figcaption className="muted small">{t("compareAfter")}</figcaption>
            <div className="asset-preview">{change.after === undefined ? null : <AssetPreview projectId={projectId} tree={after} asset={change.after} />}</div>
          </figure>
        </div>
      ) : (
        <div className="asset-pair single">
          <div className="asset-preview">
            <AssetPreview projectId={projectId} tree={change.after === undefined ? before : after} asset={asset} />
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- checks */

const CHECK_PHRASE: Record<CheckKind, Phrase> = {
  missingAsset: "checkMissingAsset",
  unsyncedAsset: "checkUnsyncedAsset",
  missingScene: "checkMissingScene",
  missingLabel: "checkMissingLabel",
  duplicateLabel: "checkDuplicateLabel",
  undeclaredVariable: "checkUndeclaredVariable",
  missingCharacter: "checkMissingCharacter",
  noPortrait: "checkNoPortrait",
  invalidRow: "checkInvalidRow",
};

const CHECK_ORDER: readonly CheckKind[] = [
  "missingAsset",
  "missingScene",
  "missingLabel",
  "duplicateLabel",
  "undeclaredVariable",
  "missingCharacter",
  "unsyncedAsset",
  "noPortrait",
  "invalidRow",
];

export function ChecksPage({ projectId, tree, openAt }: { projectId: string; tree: Tree | undefined; openAt: (place: Place, revision: string) => void }) {
  const data = useProjectData(projectId, tree);
  const [filter, setFilter] = useState<"all" | "error" | "warning">("all");
  const findings = useMemo(() => (data === undefined || data instanceof Error ? undefined : runChecks(data)), [data]);
  if (data instanceof Error) return <Flash error={data} />;
  if (findings === undefined || data === undefined) return <Skeleton rows={5} />;
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  if (findings.length === 0) {
    return (
      <Blankslate icon="tick" title={t("checksClean")}>
        {t("checksCleanHint", { scenes: String(data.stories.reduce((sum, story) => sum + story.document.order.length, 0)) })}
      </Blankslate>
    );
  }
  const shown = findings.filter((finding) => filter === "all" || finding.severity === filter);
  const groups = CHECK_ORDER.map((kind) => ({ kind, items: shown.filter((finding) => finding.kind === kind) })).filter((group) => group.items.length > 0);
  const revision = tree?.revision ?? "current";
  return (
    <div className="checks">
      <div className="chips">
        <button className={filter === "all" ? "chip active" : "chip"} onClick={() => setFilter("all")}>
          {t("checksAll")} <span className="chip-count">{findings.length}</span>
        </button>
        <button className={filter === "error" ? "chip active" : "chip"} onClick={() => setFilter("error")}>
          <Icon name="alert" size={13} /> {t("checksErrors")} <span className="chip-count">{errors}</span>
        </button>
        <button className={filter === "warning" ? "chip active" : "chip"} onClick={() => setFilter("warning")}>
          <Icon name="info" size={13} /> {t("checksWarnings")} <span className="chip-count">{warnings}</span>
        </button>
      </div>
      {groups.map((group) => (
        <section key={group.kind} className="check-group">
          <h3 className={`check-head check-${CHECK_SEVERITY[group.kind]}`}>
            <Icon name={CHECK_SEVERITY[group.kind] === "error" ? "alert" : "info"} size={14} />
            <span>{t(`${CHECK_PHRASE[group.kind]}Title` as Phrase)}</span>
            <span className="chip-count">{group.items.length}</span>
          </h3>
          <ul className="check-list">
            {group.items.slice(0, 200).map((finding, index) => (
              <CheckItem key={index} finding={finding} stories={data.stories.length} open={() => openAt(finding.place, revision === "current" ? "current" : revision)} />
            ))}
            {group.items.length > 200 ? <li className="muted small">{t("checksMore", { count: String(group.items.length - 200) })}</li> : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CheckItem({ finding, stories, open }: { finding: Finding; stories: number; open: () => void }): ReactNode {
  return (
    <li className="check-item">
      <button className="check-open" onClick={open}>
        <span className="check-text">{t(CHECK_PHRASE[finding.kind], { subject: finding.subject.length > 60 ? `${finding.subject.slice(0, 60)}…` : finding.subject })}</span>
        <span className="muted small">{placeText(finding.place, stories)}</span>
      </button>
    </li>
  );
}
