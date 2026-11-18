/**
 * ⌘K: one box to go anywhere - a page, a project, and the scenes and lines of
 * every story, found by what is said or who says it. Inside a project only its
 * own story is searched; outside one, every project the caller can read. Lines
 * are read once per page load, the first time the box opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { CHARACTER_STORE_PATH, readCharacters, readStoryDocument, readStoryLibrary, STORY_INDEX_PATH } from "@narraleaf/project-view";

import { fetchJson, fetchTree } from "./files";
import { Icon, type IconName } from "./Icon";
import { t } from "./i18n";

export interface PaletteItem {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

interface Line {
  readonly project: string;
  readonly projectName: string;
  readonly scene: string;
  readonly sceneName: string;
  /** Empty for the scene itself. */
  readonly text: string;
  readonly speaker: string;
}

interface PaletteProject {
  readonly id: string;
  readonly name: string;
}

const lineCache = new Map<string, Promise<Line[]>>();

/** Every line of a project's stories, with who says it, read once per page load. */
function projectLines(project: PaletteProject): Promise<Line[]> {
  let found = lineCache.get(project.id);
  if (found === undefined) {
    found = (async () => {
      const tree = await fetchTree(project.id, "current");
      if (!tree.files.some((file) => file.path === STORY_INDEX_PATH)) return [];
      const library = readStoryLibrary(await fetchJson(project.id, tree.revision, STORY_INDEX_PATH));
      if (!library.supported) return [];
      const characters = tree.files.some((file) => file.path === CHARACTER_STORE_PATH)
        ? readCharacters(await fetchJson(project.id, tree.revision, CHARACTER_STORE_PATH).catch(() => undefined))
        : new Map();
      const lines: Line[] = [];
      for (const story of library.stories) {
        const document = readStoryDocument(await fetchJson(project.id, tree.revision, story.documentPath));
        if (!document.supported) continue;
        for (const id of document.order) {
          const scene = document.scenes[id];
          if (scene === undefined) continue;
          const base = { project: project.id, projectName: project.name, scene: id, sceneName: scene.name };
          lines.push({ ...base, text: "", speaker: "" });
          for (const row of scene.rows) {
            if (!("text" in row) || row.text === "") continue;
            const who = "speaker" in row ? row.speaker : undefined;
            const speaker =
              who === undefined || who === null || typeof who !== "object"
                ? ""
                : "characterId" in who
                  ? (characters.get(String(who.characterId))?.name ?? "")
                  : "name" in who
                    ? String(who.name)
                    : "";
            lines.push({ ...base, text: row.text, speaker });
          }
        }
      }
      return lines;
    })().catch(() => []);
    lineCache.set(project.id, found);
  }
  return found;
}

export function Palette({
  items,
  projects,
  project,
  openLine,
  close,
}: {
  items: readonly PaletteItem[];
  /** Every project the caller can read, searched when not inside one. */
  projects: readonly PaletteProject[];
  project?: PaletteProject | undefined;
  openLine: (project: string, scene: string) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [reading, setReading] = useState(true);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  const searched = useMemo(() => (project === undefined ? projects : [project]), [project, projects]);
  useEffect(() => {
    let alive = true;
    setReading(true);
    void Promise.all(searched.map(projectLines)).then((found) => {
      if (!alive) return;
      setLines(found.flat());
      setReading(false);
    });
    return () => {
      alive = false;
    };
  }, [searched]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = items.filter((item) => q === "" || item.label.toLowerCase().includes(q) || (item.hint ?? "").toLowerCase().includes(q));
    if (q === "") return matched.slice(0, 12);
    const many = project === undefined && searched.length > 1;
    const seen = new Set<string>();
    const fromStory: PaletteItem[] = [];
    for (const line of lines) {
      const hit =
        line.text === ""
          ? line.sceneName.toLowerCase().includes(q)
          : line.text.toLowerCase().includes(q) || (line.speaker !== "" && line.speaker.toLowerCase().includes(q));
      if (!hit) continue;
      const key = `${line.project}:${line.scene}:${line.speaker}:${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const where = line.text === "" ? t("paletteScene") : line.sceneName;
      fromStory.push({
        id: `line:${key}`,
        icon: line.text === "" ? "book" : "chat",
        label: line.text === "" ? line.sceneName : line.speaker === "" ? line.text : `${line.speaker}：${line.text}`,
        hint: many ? `${line.projectName} · ${where}` : where,
        run: () => openLine(line.project, line.scene),
      });
      if (fromStory.length >= 30) break;
    }
    return [...matched.slice(0, 8), ...fromStory];
  }, [query, items, lines, project, searched, openLine]);

  useEffect(() => setActive(0), [query]);

  const choose = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    close();
    item.run();
  };

  return (
    <div className="palette-backdrop" onClick={close} role="presentation">
      <div className="palette" role="dialog" aria-label={t("paletteTitle")} onClick={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={project === undefined ? t("palettePlaceholder") : t("palettePlaceholderProject", { project: project.name })}
            aria-label={t("paletteTitle")}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((at) => Math.min(results.length - 1, at + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((at) => Math.max(0, at - 1));
              }
              if (event.key === "Enter") choose(results[active]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-results" role="listbox">
          {results.length === 0 ? <li className="muted palette-empty">{reading ? t("paletteReading") : t("paletteNothing")}</li> : null}
          {results.map((item, index) => (
            <li key={item.id} role="option" aria-selected={index === active}>
              <button className={index === active ? "palette-item active" : "palette-item"} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
                <Icon name={item.icon} />
                <span className="palette-label">{item.label}</span>
                {item.hint === undefined ? null : <span className="muted small palette-hint">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
