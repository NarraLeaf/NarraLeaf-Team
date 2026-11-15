/**
 * ⌘K: one box to go anywhere - a page, a project, and inside a project its
 * scenes and the lines in them. Lines are searched in what this browser has
 * already read of the project, so the first search in a project reads its story.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { readStoryDocument, readStoryLibrary, STORY_INDEX_PATH } from "@narraleaf/project-view";

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
  readonly scene: string;
  readonly sceneName: string;
  readonly text: string;
}

const lineCache = new Map<string, Promise<Line[]>>();

/** Every line of a project's stories, read once per page load. */
function projectLines(project: string): Promise<Line[]> {
  let found = lineCache.get(project);
  if (found === undefined) {
    found = (async () => {
      const tree = await fetchTree(project, "current");
      if (!tree.files.some((file) => file.path === STORY_INDEX_PATH)) return [];
      const library = readStoryLibrary(await fetchJson(project, tree.revision, STORY_INDEX_PATH));
      if (!library.supported) return [];
      const lines: Line[] = [];
      for (const story of library.stories) {
        const document = readStoryDocument(await fetchJson(project, tree.revision, story.documentPath));
        if (!document.supported) continue;
        for (const id of document.order) {
          const scene = document.scenes[id];
          if (scene === undefined) continue;
          lines.push({ scene: id, sceneName: scene.name, text: "" });
          for (const row of scene.rows) {
            if ("text" in row && row.text !== "") lines.push({ scene: id, sceneName: scene.name, text: row.text });
          }
        }
      }
      return lines;
    })().catch(() => []);
    lineCache.set(project, found);
  }
  return found;
}

export function Palette({
  items,
  project,
  openLine,
  close,
}: {
  items: readonly PaletteItem[];
  project?: { id: string; name: string } | undefined;
  openLine: (project: string, scene: string) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (project === undefined) return;
    let alive = true;
    void projectLines(project.id).then((found) => alive && setLines(found));
    return () => {
      alive = false;
    };
  }, [project]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = items.filter((item) => q === "" || item.label.toLowerCase().includes(q) || (item.hint ?? "").toLowerCase().includes(q));
    if (q === "" || project === undefined) return matched.slice(0, 12);
    const seen = new Set<string>();
    const fromStory: PaletteItem[] = [];
    for (const line of lines) {
      const hit = line.text === "" ? line.sceneName.toLowerCase().includes(q) : line.text.toLowerCase().includes(q);
      if (!hit) continue;
      const key = `${line.scene}:${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fromStory.push({
        id: `line:${key}`,
        icon: line.text === "" ? "book" : "chat",
        label: line.text === "" ? line.sceneName : line.text,
        hint: line.text === "" ? t("paletteScene") : line.sceneName,
        run: () => openLine(project.id, line.scene),
      });
      if (fromStory.length >= 30) break;
    }
    return [...matched.slice(0, 8), ...fromStory];
  }, [query, items, lines, project, openLine]);

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
          {results.length === 0 ? <li className="muted palette-empty">{t("paletteNothing")}</li> : null}
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
