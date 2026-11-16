/**
 * How far a project has come: how long its script is, how much of it is translated and
 * recorded, the words its translators agreed on, and its milestones on a calendar.
 *
 * The script, the translations and the voice files are read in the browser from the
 * revision's files, as every other page does; the server keeps only what it has to - the
 * glossary, where each recording stands, milestones, to-dos and templates.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  projectMilestonesTopic,
  projectTodosTopic,
  type TeamGlossaryEntry,
  type TeamMilestone,
  type TeamProjectRole,
  type TeamProjectTemplate,
  type TeamTodo,
  type TeamVoiceLine,
  type TeamVoiceStatus,
} from "@narraleaf/team-protocol";

import { fetchJson, type Tree } from "./files";
import { t, type Phrase } from "./i18n";
import { Icon } from "./Icon";
import { eachScene, useProjectData, type Place, type ProjectData } from "./projectData";
import type { TeamConnection } from "./socket";
import { Blankslate, confirmAction, Flash, SelectPanel, Skeleton, toast, toastError, UnderlineNav } from "./ui";

export type ProgressSection = "stats" | "localization" | "glossary" | "voice" | "roadmap" | "templates";
export const PROGRESS_SECTIONS: readonly ProgressSection[] = ["stats", "localization", "glossary", "voice", "roadmap", "templates"];
const SECTION_PHRASE: Record<ProgressSection, Phrase> = {
  stats: "progressStats",
  localization: "progressLocalization",
  glossary: "progressGlossary",
  voice: "progressVoice",
  roadmap: "progressRoadmap",
  templates: "progressTemplates",
};

/* ------------------------------------------------------------- the script */

/** One line a player reads, wherever it is. */
interface Line {
  readonly textId: string | undefined;
  readonly text: string;
  readonly kind: "narration" | "dialogue" | "choice" | "option";
  /** A character id, a bare name, or nothing for narration. */
  readonly speaker: string | undefined;
  readonly speakerName: string;
  readonly place: Place;
}

function linesOf(data: ProjectData): Line[] {
  return eachScene(data).flatMap(({ scene, place }) =>
    scene.rows.flatMap((row, index): Line[] => {
      if (row.disabled) return [];
      const at = { ...place, rowId: row.id, line: index + 1 };
      switch (row.kind) {
        case "narration":
        case "choice":
        case "option":
          return row.text.trim() === "" ? [] : [{ textId: row.textId, text: row.text, kind: row.kind, speaker: undefined, speakerName: "", place: at }];
        case "dialogue": {
          const speaker = row.speaker === undefined ? undefined : "characterId" in row.speaker ? row.speaker.characterId : row.speaker.name;
          const speakerName =
            row.speaker === undefined ? "？" : "characterId" in row.speaker ? (data.characters.get(row.speaker.characterId)?.name ?? "？") : row.speaker.name;
          return row.text.trim() === "" ? [] : [{ textId: row.textId, text: row.text, kind: "dialogue", speaker, speakerName, place: at }];
        }
        default:
          return [];
      }
    }),
  );
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/gu;

/** How long a piece of text is: characters without spaces, and words (each CJK character one). */
function measure(text: string): { chars: number; cjk: number; words: number } {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return { chars: text.replace(/\s+/gu, "").length, cjk, words: cjk + latin };
}

/** Reading at about 400 CJK characters or 230 words a minute, and half a second per click. */
function minutesOf(lines: readonly Line[]): number {
  let cjk = 0;
  let latin = 0;
  for (const line of lines) {
    const size = measure(line.text);
    cjk += size.cjk;
    latin += size.words - size.cjk;
  }
  return cjk / 400 + latin / 230 + (lines.length * 0.5) / 60;
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return t("progressUnderMinute");
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours === 0 ? t("progressMinutes", { minutes: String(rest) }) : t("progressHours", { hours: String(hours), minutes: String(rest) });
}

/* ------------------------------------------------- translation and voice files */

type UnitStatus = "untranslated" | "machine" | "translated" | "reviewed";
interface Unit {
  readonly target: string;
  readonly status: UnitStatus;
}
interface Clip {
  readonly assetId: string;
  readonly status: string;
}

const LOCALIZATION_FILE = /^editor\/localization\/([A-Za-z0-9_-]+)\.json$/u;
const VOICE_FILE = /^editor\/voice\/([A-Za-z0-9_-]+)\.json$/u;
const UNIT_STATUSES: readonly UnitStatus[] = ["untranslated", "machine", "translated", "reviewed"];

function unitsOf<T>(json: unknown, read: (value: Record<string, unknown>) => T | undefined): ReadonlyMap<string, T> {
  const units = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["units"] : undefined;
  const out = new Map<string, T>();
  if (typeof units !== "object" || units === null) return out;
  for (const [id, value] of Object.entries(units as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const unit = read(value as Record<string, unknown>);
    if (unit !== undefined) out.set(id, unit);
  }
  return out;
}

function readUnit(value: Record<string, unknown>): Unit | undefined {
  const target = typeof value["target"] === "string" ? value["target"] : "";
  const status = UNIT_STATUSES.find((name) => name === value["status"]) ?? (target === "" ? "untranslated" : "translated");
  return { target, status };
}

function readClip(value: Record<string, unknown>): Clip | undefined {
  return typeof value["assetId"] === "string" ? { assetId: value["assetId"], status: typeof value["status"] === "string" ? value["status"] : "linked" } : undefined;
}

/** Every `<locale>.json` under one folder of the revision, read. */
function useLocaleFiles<T>(projectId: string, tree: Tree | undefined, pattern: RegExp, read: (value: Record<string, unknown>) => T | undefined) {
  const [files, setFiles] = useState<ReadonlyMap<string, ReadonlyMap<string, T>> | undefined>(undefined);
  useEffect(() => {
    if (tree === undefined) return undefined;
    let live = true;
    const wanted = tree.files.flatMap((file) => {
      const locale = pattern.exec(file.path)?.[1];
      return locale === undefined || locale === "keys" ? [] : [{ locale, path: file.path }];
    });
    void Promise.all(
      wanted.map(async ({ locale, path }) => {
        try {
          return [locale, unitsOf(await fetchJson(projectId, tree.revision, path), read)] as const;
        } catch {
          return [locale, new Map<string, T>()] as const;
        }
      }),
    ).then((read) => {
      if (live) setFiles(new Map(read));
    });
    return () => {
      live = false;
    };
  }, [projectId, tree, pattern, read]);
  return files;
}

/* ------------------------------------------------------------------ page */

export function ProgressPage(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  tree: Tree | undefined;
  role: TeamProjectRole | undefined;
  me: string;
  operator: boolean;
  section: ProgressSection;
  go: (section: ProgressSection) => void;
}) {
  const { connection, open, projectId, tree, role, me, operator, section, go } = props;
  const data = useProjectData(projectId, tree);
  const lines = useMemo(() => (data === undefined || data instanceof Error ? undefined : linesOf(data)), [data]);
  const translations = useLocaleFiles(projectId, tree, LOCALIZATION_FILE, readUnit);
  const clips = useLocaleFiles(projectId, tree, VOICE_FILE, readClip);
  const canWrite = role === "owner" || role === "editor";
  const tabs = PROGRESS_SECTIONS.filter((key) => key !== "templates" || role === "owner").map((key) => ({ key, label: t(SECTION_PHRASE[key]) }));
  let body: ReactNode;
  if (section === "roadmap") body = <Roadmap connection={connection} open={open} projectId={projectId} canWrite={canWrite} />;
  else if (section === "templates" && role === "owner") body = <Templates connection={connection} open={open} projectId={projectId} me={me} operator={operator} />;
  else if (data instanceof Error) body = <Flash error={data} />;
  else if (data === undefined || lines === undefined) body = <Skeleton rows={6} />;
  else if (section === "localization") body = <Localization data={data} lines={lines} translations={translations} />;
  else if (section === "glossary")
    body = <Glossary connection={connection} open={open} projectId={projectId} canWrite={canWrite} lines={lines} translations={translations} />;
  else if (section === "voice")
    body = <Voice connection={connection} open={open} projectId={projectId} canWrite={canWrite} lines={lines} translations={translations} clips={clips} />;
  else body = <Stats data={data} lines={lines} />;
  return (
    <div className="progress-page">
      <UnderlineNav label={t("tabProgress")} tabs={tabs} active={section} onSelect={go} />
      {body}
    </div>
  );
}

/* ----------------------------------------------------------------- stats */

function Bar({ share, tone }: { share: number; tone?: "accent" | "success" | "warning" | "danger" }) {
  return (
    <span className={`share-bar tone-${tone ?? "accent"}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, Math.round(share * 100)))}%` }} />
    </span>
  );
}

function Stats({ data, lines }: { data: ProjectData; lines: readonly Line[] }) {
  const scenes = eachScene(data);
  if (lines.length === 0) {
    return (
      <Blankslate icon="book" title={t("progressNoLines")}>
        {t("progressNoLinesHint")}
      </Blankslate>
    );
  }
  const words = lines.reduce((sum, line) => sum + measure(line.text).words, 0);
  const choices = lines.filter((line) => line.kind === "choice").length;
  const options = lines.filter((line) => line.kind === "option").length;
  const bySpeaker = new Map<string, { name: string; lines: number; words: number; chars: number }>();
  for (const line of lines) {
    if (line.kind !== "dialogue" && line.kind !== "narration") continue;
    const key = line.kind === "narration" ? "" : (line.speaker ?? "?");
    const entry = bySpeaker.get(key) ?? { name: line.kind === "narration" ? t("progressNarration") : line.speakerName, lines: 0, words: 0, chars: 0 };
    const size = measure(line.text);
    bySpeaker.set(key, { ...entry, lines: entry.lines + 1, words: entry.words + size.words, chars: entry.chars + size.chars });
  }
  const speakers = [...bySpeaker.values()].sort((a, b) => b.words - a.words);
  const mostWords = Math.max(1, ...speakers.map((speaker) => speaker.words));
  const sceneRows = scenes.map(({ scene, place }) => {
    const here = lines.filter((line) => line.place.storyId === place.storyId && line.place.sceneId === place.sceneId);
    return {
      key: `${place.storyId}/${place.sceneId}`,
      name: data.stories.length > 1 ? `${place.storyName} · ${scene.name}` : scene.name,
      lines: here.length,
      words: here.reduce((sum, line) => sum + measure(line.text).words, 0),
      choices: here.filter((line) => line.kind === "choice").length,
      minutes: minutesOf(here),
    };
  });
  const mostSceneWords = Math.max(1, ...sceneRows.map((row) => row.words));
  return (
    <div className="progress-stats">
      <div className="stat-tiles">
        <Tile label={t("progressLines")} value={lines.length.toLocaleString()} />
        <Tile label={t("progressWords")} value={words.toLocaleString()} />
        <Tile label={t("progressScenes")} value={scenes.length.toLocaleString()} />
        <Tile label={t("progressChoices")} value={t("progressChoicesValue", { choices: String(choices), options: String(options) })} />
        <Tile label={t("progressPlayTime")} value={formatMinutes(minutesOf(lines))} hint={t("progressPlayTimeHint")} />
      </div>
      <section>
        <h3>{t("progressBySpeaker")}</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("progressSpeaker")}</th>
              <th className="num">{t("progressLines")}</th>
              <th className="num">{t("progressWords")}</th>
              <th className="num">{t("progressChars")}</th>
              <th aria-hidden />
            </tr>
          </thead>
          <tbody>
            {speakers.map((speaker) => (
              <tr key={speaker.name}>
                <td>{speaker.name}</td>
                <td className="num">{speaker.lines.toLocaleString()}</td>
                <td className="num">{speaker.words.toLocaleString()}</td>
                <td className="num">{speaker.chars.toLocaleString()}</td>
                <td className="bar-cell">
                  <Bar share={speaker.words / mostWords} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t("progressByScene")}</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("progressScene")}</th>
              <th className="num">{t("progressLines")}</th>
              <th className="num">{t("progressWords")}</th>
              <th className="num">{t("progressChoicesShort")}</th>
              <th className="num">{t("progressPlayTime")}</th>
              <th aria-hidden />
            </tr>
          </thead>
          <tbody>
            {sceneRows.map((row) => (
              <tr key={row.key}>
                <td>{row.name}</td>
                <td className="num">{row.lines.toLocaleString()}</td>
                <td className="num">{row.words.toLocaleString()}</td>
                <td className="num">{row.choices}</td>
                <td className="num">{row.lines === 0 ? "—" : formatMinutes(row.minutes)}</td>
                <td className="bar-cell">
                  <Bar share={row.words / mostSceneWords} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-tile" title={hint}>
      <span className="stat-value">{value}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

/* ---------------------------------------------------------- localization */

type Translations = ReadonlyMap<string, ReadonlyMap<string, Unit>> | undefined;

function statusOf(units: ReadonlyMap<string, Unit> | undefined, textId: string): UnitStatus {
  const unit = units?.get(textId);
  return unit === undefined || unit.target.trim() === "" ? "untranslated" : unit.status;
}

function counts(lines: readonly Line[], units: ReadonlyMap<string, Unit> | undefined): Record<UnitStatus, number> {
  const out: Record<UnitStatus, number> = { untranslated: 0, machine: 0, translated: 0, reviewed: 0 };
  for (const line of lines) if (line.textId !== undefined) out[statusOf(units, line.textId)] += 1;
  return out;
}

function doneShare(count: Record<UnitStatus, number>): number {
  const total = count.untranslated + count.machine + count.translated + count.reviewed;
  return total === 0 ? 1 : (count.translated + count.reviewed) / total;
}

const STATUS_PHRASE: Record<UnitStatus, Phrase> = {
  untranslated: "l10nUntranslated",
  machine: "l10nMachine",
  translated: "l10nTranslated",
  reviewed: "l10nReviewed",
};

function Localization({ data, lines, translations }: { data: ProjectData; lines: readonly Line[]; translations: Translations }) {
  const locales = useMemo(() => [...(translations?.keys() ?? [])].sort(), [translations]);
  const [memoryLocale, setMemoryLocale] = useState<string | undefined>(undefined);
  if (translations === undefined) return <Skeleton rows={4} />;
  if (locales.length === 0) {
    return (
      <Blankslate icon="book" title={t("l10nNone")}>
        {t("l10nNoneHint")}
      </Blankslate>
    );
  }
  const tracked = lines.filter((line) => line.textId !== undefined);
  const scenes = eachScene(data);
  const locale = memoryLocale ?? locales[0] ?? "";
  return (
    <div className="progress-l10n">
      <div className="stat-tiles">
        {locales.map((name) => {
          const count = counts(tracked, translations.get(name));
          return (
            <div key={name} className="stat-tile" title={UNIT_STATUSES.map((status) => `${t(STATUS_PHRASE[status])} ${count[status]}`).join(" · ")}>
              <span className="stat-value">{Math.floor(doneShare(count) * 100)}%</span>
              <span className="muted small">
                {name} · {t("l10nDoneOf", { done: String(count.translated + count.reviewed), total: String(tracked.length) })}
              </span>
              <Bar share={doneShare(count)} tone={doneShare(count) === 1 ? "success" : "accent"} />
            </div>
          );
        })}
      </div>
      <section>
        <h3>{t("l10nMatrix")}</h3>
        <div className="matrix-scroll">
          <table className="data-table matrix">
            <thead>
              <tr>
                <th>{t("progressScene")}</th>
                {locales.map((name) => (
                  <th key={name} className="num">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenes.map(({ scene, place }) => {
                const here = tracked.filter((line) => line.place.storyId === place.storyId && line.place.sceneId === place.sceneId);
                return (
                  <tr key={`${place.storyId}/${place.sceneId}`}>
                    <td>{data.stories.length > 1 ? `${place.storyName} · ${scene.name}` : scene.name}</td>
                    {locales.map((name) => {
                      const count = counts(here, translations.get(name));
                      const share = doneShare(count);
                      return (
                        <td
                          key={name}
                          className={`num matrix-cell ${here.length === 0 ? "" : share === 1 ? "cell-done" : share === 0 ? "cell-none" : "cell-part"}`}
                          title={UNIT_STATUSES.map((status) => `${t(STATUS_PHRASE[status])} ${count[status]}`).join(" · ")}
                        >
                          {here.length === 0 ? "—" : `${Math.floor(share * 100)}%`}
                          {count.machine > 0 ? <span className="muted small"> · {t("l10nMachineCount", { count: String(count.machine) })}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <div className="section-head">
          <h3>{t("l10nMemory")}</h3>
          <SelectPanel label={t("l10nLocale")} value={locale} onChange={setMemoryLocale} options={locales.map((name) => ({ value: name, label: name }))} size="small" />
        </div>
        <p className="muted small">{t("l10nMemoryHint")}</p>
        <Memory lines={tracked} units={translations.get(locale)} />
      </section>
    </div>
  );
}

/** Letter pairs, for telling how alike two lines are. */
function pairs(text: string): Map<string, number> {
  const plain = text.toLowerCase().replace(/\s+/gu, "");
  const out = new Map<string, number>();
  for (let index = 0; index < plain.length - 1; index += 1) {
    const pair = plain.slice(index, index + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

function alike(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let total = 0;
  for (const [pair, count] of a) {
    shared += Math.min(count, b.get(pair) ?? 0);
    total += count;
  }
  for (const count of b.values()) total += count;
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * Translation memory: untranslated lines whose text was translated elsewhere already, word for
 * word or nearly, with what it was translated as.
 */
function Memory({ lines, units }: { lines: readonly Line[]; units: ReadonlyMap<string, Unit> | undefined }) {
  const [query, setQuery] = useState("");
  const done = useMemo(
    () => lines.filter((line) => line.textId !== undefined && statusOf(units, line.textId) !== "untranslated" && statusOf(units, line.textId) !== "machine"),
    [lines, units],
  );
  const suggestions = useMemo(() => {
    const byText = new Map<string, Line>();
    for (const line of done) if (!byText.has(line.text.trim())) byText.set(line.text.trim(), line);
    const out: { line: Line; from: Line; score: number }[] = [];
    const indexed = done.slice(0, 3000).map((line) => ({ line, pairs: pairs(line.text) }));
    for (const line of lines) {
      if (line.textId === undefined || statusOf(units, line.textId) === "translated" || statusOf(units, line.textId) === "reviewed") continue;
      const same = byText.get(line.text.trim());
      if (same !== undefined) {
        out.push({ line, from: same, score: 1 });
        continue;
      }
      if (line.text.length < 6 || out.length >= 200) continue;
      const mine = pairs(line.text);
      let best: { from: Line; score: number } | undefined;
      for (const other of indexed) {
        const score = alike(mine, other.pairs);
        if (score >= 0.75 && (best === undefined || score > best.score)) best = { from: other.line, score };
      }
      if (best !== undefined) out.push({ line, ...best });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 100);
  }, [lines, units, done]);
  const found = useMemo(() => {
    const wanted = query.trim();
    if (wanted === "") return [];
    const mine = pairs(wanted);
    return done
      .map((line) => ({ line, score: line.text.includes(wanted) ? 1 : alike(mine, pairs(line.text)) }))
      .filter((hit) => hit.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }, [query, done]);
  const target = (line: Line) => (line.textId === undefined ? "" : (units?.get(line.textId)?.target ?? ""));
  return (
    <div className="memory">
      <input className="memory-search" value={query} placeholder={t("l10nMemorySearch")} onChange={(event) => setQuery(event.target.value)} />
      {query.trim() !== "" ? (
        found.length === 0 ? (
          <p className="muted small">{t("l10nMemoryNothing")}</p>
        ) : (
          <ul className="memory-list">
            {found.map(({ line, score }) => (
              <li key={line.textId}>
                <span className="memory-source">{line.text}</span>
                <span className="memory-target">{target(line)}</span>
                <span className="muted small">{Math.round(score * 100)}%</span>
              </li>
            ))}
          </ul>
        )
      ) : suggestions.length === 0 ? (
        <p className="muted small">{t("l10nMemoryNone")}</p>
      ) : (
        <ul className="memory-list">
          {suggestions.map(({ line, from, score }) => (
            <li key={line.textId}>
              <span className="memory-source">
                {line.text}
                <span className="muted small"> · {line.place.sceneName}</span>
              </span>
              <span className="memory-target">{target(from)}</span>
              <span className={score === 1 ? "badge tone-success" : "badge"}>{score === 1 ? t("l10nExact") : `${Math.round(score * 100)}%`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- glossary */

function Glossary(props: { connection: TeamConnection; open: boolean; projectId: string; canWrite: boolean; lines: readonly Line[]; translations: Translations }) {
  const { connection, open, projectId, canWrite, lines, translations } = props;
  const [entries, setEntries] = useState<readonly TeamGlossaryEntry[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [editing, setEditing] = useState<TeamGlossaryEntry | "new" | undefined>(undefined);
  const load = useCallback(() => {
    connection
      .call<{ entries: TeamGlossaryEntry[] }>("glossary.list", { project: projectId })
      .then((answer) => setEntries(answer.entries))
      .catch(setError);
  }, [connection, projectId]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const locales = useMemo(
    () => [...new Set([...(translations?.keys() ?? []), ...(entries ?? []).flatMap((entry) => Object.keys(entry.translations))])].sort(),
    [translations, entries],
  );
  // A translated line whose source says the term, and whose translation does not say the agreed word.
  const misses = useMemo(() => {
    const out: { entry: TeamGlossaryEntry; locale: string; line: Line; target: string }[] = [];
    for (const entry of entries ?? []) {
      for (const [locale, word] of Object.entries(entry.translations)) {
        const units = translations?.get(locale);
        if (units === undefined || word.trim() === "") continue;
        for (const line of lines) {
          if (line.textId === undefined || !line.text.includes(entry.term)) continue;
          const target = units.get(line.textId)?.target ?? "";
          if (target.trim() !== "" && !target.toLowerCase().includes(word.toLowerCase())) out.push({ entry, locale, line, target });
          if (out.length >= 100) return out;
        }
      }
    }
    return out;
  }, [entries, translations, lines]);
  const remove = async (entry: TeamGlossaryEntry) => {
    if (!(await confirmAction({ title: t("glossaryDeleteTitle", { term: entry.term }), danger: true, confirmLabel: t("remove") }))) return;
    connection.call("glossary.delete", { project: projectId, id: entry.id }).then(load).catch(toastError);
  };
  if (error !== undefined) return <Flash error={error} />;
  if (entries === undefined) return <Skeleton rows={4} />;
  return (
    <div className="glossary">
      <div className="section-head">
        <p className="muted small">{t("glossaryHint")}</p>
        {canWrite ? (
          <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} /> {t("glossaryAdd")}
          </button>
        ) : null}
      </div>
      {editing === undefined ? null : (
        <GlossaryEditor
          connection={connection}
          projectId={projectId}
          entry={editing === "new" ? undefined : editing}
          locales={locales}
          close={(saved) => {
            setEditing(undefined);
            if (saved) load();
          }}
        />
      )}
      {entries.length === 0 ? (
        <Blankslate icon="tag" title={t("glossaryEmpty")} compact>
          {t("glossaryEmptyHint")}
        </Blankslate>
      ) : (
        <div className="matrix-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("glossaryTerm")}</th>
                {locales.map((name) => (
                  <th key={name}>{name}</th>
                ))}
                <th>{t("glossaryNote")}</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.term}</strong>
                  </td>
                  {locales.map((name) => (
                    <td key={name}>{entry.translations[name] ?? <span className="muted">—</span>}</td>
                  ))}
                  <td className="muted small">{entry.note ?? ""}</td>
                  <td className="row-actions">
                    {canWrite ? (
                      <>
                        <button className="btn btn-invisible btn-sm" onClick={() => setEditing(entry)}>
                          {t("edit")}
                        </button>
                        <button className="btn btn-invisible btn-icon btn-sm" aria-label={t("remove")} title={t("remove")} onClick={() => void remove(entry)}>
                          <Icon name="trash" size={14} />
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {misses.length === 0 ? null : (
        <section>
          <h3 className="check-head check-warning">
            <Icon name="info" size={14} /> {t("glossaryMisses")} <span className="chip-count">{misses.length}</span>
          </h3>
          <ul className="check-list">
            {misses.map(({ entry, locale, line, target }) => (
              <li key={`${entry.id}/${locale}/${line.textId}`} className="check-item">
                <div className="glossary-miss">
                  <span className="check-text">{t("glossaryMiss", { term: entry.term, locale, word: entry.translations[locale] ?? "" })}</span>
                  <span className="muted small">
                    {line.place.sceneName} · {line.text} → {target}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GlossaryEditor(props: { connection: TeamConnection; projectId: string; entry: TeamGlossaryEntry | undefined; locales: readonly string[]; close: (saved: boolean) => void }) {
  const { connection, projectId, entry, close } = props;
  const [term, setTerm] = useState(entry?.term ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [words, setWords] = useState<Record<string, string>>({ ...entry?.translations });
  const [extra, setExtra] = useState("");
  const locales = [...new Set([...props.locales, ...Object.keys(words)])].sort();
  const save = (event: FormEvent) => {
    event.preventDefault();
    const translations = Object.fromEntries(Object.entries(words).filter(([, word]) => word.trim() !== "").map(([locale, word]) => [locale, word.trim()]));
    connection
      .call("glossary.set", {
        project: projectId,
        ...(entry === undefined ? {} : { id: entry.id }),
        term: term.trim(),
        translations,
        note: note.trim() === "" ? null : note.trim(),
      })
      .then(() => {
        toast(t("saved"));
        close(true);
      })
      .catch(toastError);
  };
  return (
    <form className="glossary-editor card" onSubmit={save}>
      <label>
        <span>{t("glossaryTerm")}</span>
        <input value={term} maxLength={200} required autoFocus onChange={(event) => setTerm(event.target.value)} />
      </label>
      {locales.map((locale) => (
        <label key={locale}>
          <span>{locale}</span>
          <input value={words[locale] ?? ""} maxLength={1000} onChange={(event) => setWords({ ...words, [locale]: event.target.value })} />
        </label>
      ))}
      <label>
        <span>{t("glossaryAddLocale")}</span>
        <span className="inline-field">
          <input value={extra} maxLength={35} placeholder="en, ja, zh-TW…" onChange={(event) => setExtra(event.target.value)} />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!/^[A-Za-z0-9_-]{1,35}$/u.test(extra.trim())}
            onClick={() => {
              setWords({ ...words, [extra.trim()]: words[extra.trim()] ?? "" });
              setExtra("");
            }}
          >
            {t("add")}
          </button>
        </span>
      </label>
      <label>
        <span>{t("glossaryNote")}</span>
        <input value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => close(false)}>
          {t("cancel")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={term.trim() === ""}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- voice */

const VOICE_PHRASE: Record<TeamVoiceStatus | "clip" | "none", Phrase> = {
  recorded: "voiceRecorded",
  retake: "voiceRetake",
  clip: "voiceClip",
  none: "voiceNotYet",
};

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function download(name: string, text: string): void {
  // A BOM so a spreadsheet reads the CJK text as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Voice(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  canWrite: boolean;
  lines: readonly Line[];
  translations: Translations;
  clips: ReadonlyMap<string, ReadonlyMap<string, Clip>> | undefined;
}) {
  const { connection, open, projectId, canWrite, lines, translations, clips } = props;
  const [marks, setMarks] = useState<readonly TeamVoiceLine[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const load = useCallback(() => {
    connection
      .call<{ lines: TeamVoiceLine[] }>("voice.list", { project: projectId })
      .then((answer) => setMarks(answer.lines))
      .catch(setError);
  }, [connection, projectId]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const locales = useMemo(
    () =>
      [
        ...new Set([
          ...(clips?.keys() ?? []),
          ...(translations?.keys() ?? []),
          ...(marks ?? []).map((mark) => mark.locale),
          ...(chosen === undefined ? [] : [chosen]),
        ]),
      ].sort(),
    [clips, translations, marks, chosen],
  );
  const locale = chosen ?? locales[0];
  const spoken = useMemo(() => lines.filter((line) => line.kind === "dialogue" && line.textId !== undefined), [lines]);
  const markOf = useMemo(() => {
    const out = new Map<string, TeamVoiceLine>();
    for (const mark of marks ?? []) if (mark.locale === locale) out.set(mark.line, mark);
    return out;
  }, [marks, locale]);
  if (error !== undefined) return <Flash error={error} />;
  if (marks === undefined || clips === undefined) return <Skeleton rows={4} />;
  if (spoken.length === 0) {
    return (
      <Blankslate icon="music" title={t("voiceNoLines")}>
        {t("voiceNoLinesHint")}
      </Blankslate>
    );
  }
  const statusOfLine = (line: Line): TeamVoiceStatus | "clip" | "none" => {
    const mark = markOf.get(line.textId ?? "");
    if (mark !== undefined) return mark.status;
    return locale !== undefined && clips.get(locale)?.has(line.textId ?? "") ? "clip" : "none";
  };
  // What the actor reads: the line in the language they record, when it is translated.
  const script = (line: Line) => {
    const target = locale === undefined || line.textId === undefined ? undefined : translations?.get(locale)?.get(line.textId)?.target;
    return target !== undefined && target.trim() !== "" ? target : line.text;
  };
  const groups = [...new Set(spoken.map((line) => line.speaker ?? "?"))].map((speaker) => {
    const own = spoken.filter((line) => (line.speaker ?? "?") === speaker);
    return { speaker, name: own[0]?.speakerName ?? "？", lines: own };
  });
  const mark = (ids: readonly string[], status: TeamVoiceStatus | "none") => {
    if (locale === undefined) return;
    connection.call("voice.set", { project: projectId, locale, lines: ids, status }).then(load).catch(toastError);
  };
  const exportCsv = (rows: readonly Line[], name: string) => {
    const head = ["id", "scene", "line", "character", "text", "source", "status", "take", "note"];
    const body = rows.map((line) => {
      const current = markOf.get(line.textId ?? "");
      return [line.textId, line.place.sceneName, line.place.line, line.speakerName, script(line), line.text, t(VOICE_PHRASE[statusOfLine(line)]), current?.take, current?.note]
        .map(csvCell)
        .join(",");
    });
    download(`${name}-${locale ?? "voice"}.csv`, [head.join(","), ...body].join("\r\n"));
  };
  return (
    <div className="voice">
      <div className="section-head">
        {locales.length > 0 ? (
          <SelectPanel label={t("voiceLocale")} value={locale} onChange={setChosen} options={locales.map((name) => ({ value: name, label: name }))} size="small" />
        ) : (
          <span className="muted small">{t("voiceNoLocale")}</span>
        )}
        {canWrite ? (
          <form
            className="inline-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (/^[A-Za-z0-9_-]{1,35}$/u.test(typed.trim())) setChosen(typed.trim());
              setTyped("");
            }}
          >
            <input value={typed} maxLength={35} placeholder={t("voiceAddLocale")} onChange={(event) => setTyped(event.target.value)} />
          </form>
        ) : null}
        <span className="spacer" />
        {locale === undefined ? null : (
          <button className="btn btn-sm" onClick={() => exportCsv(spoken, "script")}>
            <Icon name="download" size={14} /> {t("voiceExportAll")}
          </button>
        )}
      </div>
      {locale === undefined ? null : (
        <table className="data-table voice-table">
          <thead>
            <tr>
              <th>{t("progressSpeaker")}</th>
              <th className="num">{t("progressLines")}</th>
              <th className="num">{t("voiceClip")}</th>
              <th className="num">{t("voiceRecorded")}</th>
              <th className="num">{t("voiceRetake")}</th>
              <th aria-hidden />
              <th aria-hidden />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const statuses = group.lines.map(statusOfLine);
              const recorded = statuses.filter((status) => status === "recorded").length;
              const done = statuses.filter((status) => status === "recorded" || status === "clip").length;
              return [
                <tr key={group.speaker}>
                  <td>
                    <button className="link" onClick={() => setExpanded(expanded === group.speaker ? undefined : group.speaker)} aria-expanded={expanded === group.speaker}>
                      <Icon name="caret" size={12} /> {group.name}
                    </button>
                  </td>
                  <td className="num">{group.lines.length}</td>
                  <td className="num">{statuses.filter((status) => status === "clip").length}</td>
                  <td className="num">{recorded}</td>
                  <td className="num">{statuses.filter((status) => status === "retake").length}</td>
                  <td className="bar-cell">
                    <Bar share={done / group.lines.length} tone={done === group.lines.length ? "success" : "accent"} />
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-invisible btn-sm" onClick={() => exportCsv(group.lines, group.name)}>
                      <Icon name="download" size={14} /> CSV
                    </button>
                  </td>
                </tr>,
                expanded === group.speaker ? (
                  <tr key={`${group.speaker}-lines`} className="voice-lines-row">
                    <td colSpan={7}>
                      {canWrite ? (
                        <div className="voice-bulk">
                          <button className="btn btn-sm" onClick={() => mark(group.lines.map((line) => line.textId ?? ""), "recorded")}>
                            {t("voiceMarkAllRecorded")}
                          </button>
                          <button className="btn btn-sm" onClick={() => mark(group.lines.map((line) => line.textId ?? ""), "none")}>
                            {t("voiceClearAll")}
                          </button>
                        </div>
                      ) : null}
                      <ul className="voice-lines">
                        {group.lines.map((line) => {
                          const status = statusOfLine(line);
                          return (
                            <li key={line.textId}>
                              <span className={`badge voice-${status}`}>{t(VOICE_PHRASE[status])}</span>
                              <span className="voice-text">{script(line)}</span>
                              <span className="muted small">{line.place.sceneName}</span>
                              {canWrite ? (
                                <span className="row-actions">
                                  <button className="btn btn-invisible btn-sm" disabled={status === "recorded"} onClick={() => mark([line.textId ?? ""], "recorded")}>
                                    {t("voiceMarkRecorded")}
                                  </button>
                                  <button className="btn btn-invisible btn-sm" disabled={status === "retake"} onClick={() => mark([line.textId ?? ""], "retake")}>
                                    {t("voiceMarkRetake")}
                                  </button>
                                  {markOf.has(line.textId ?? "") ? (
                                    <button className="btn btn-invisible btn-sm" onClick={() => mark([line.textId ?? ""], "none")}>
                                      {t("voiceClear")}
                                    </button>
                                  ) : null}
                                </span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">{t("voiceHint")}</p>
    </div>
  );
}

/* --------------------------------------------------------------- roadmap */

const DAY = 24 * 60 * 60 * 1000;

function dateInput(at: number): string {
  const day = new Date(at);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** A project's to-dos, kept current. */
function useProjectTodos(connection: TeamConnection, open: boolean, projectId: string): readonly TeamTodo[] | undefined {
  const [todos, setTodos] = useState<readonly TeamTodo[] | undefined>(undefined);
  useEffect(() => {
    if (!open) return undefined;
    const load = () =>
      void connection
        .call<{ todos: TeamTodo[] }>("todos.list", { project: projectId, includeDone: true })
        .then((answer) => setTodos(answer.todos))
        .catch(() => setTodos([]));
    load();
    return connection.subscribe(projectTodosTopic(projectId), load);
  }, [connection, open, projectId]);
  return todos;
}

/** A project's milestones, kept current; undefined while they load. */
export function useMilestoneList(connection: TeamConnection, open: boolean, projectId: string): readonly TeamMilestone[] | undefined {
  const [milestones, setMilestones] = useState<readonly TeamMilestone[] | undefined>(undefined);
  useEffect(() => {
    if (!open) return undefined;
    const load = () =>
      void connection
        .call<{ milestones: TeamMilestone[] }>("milestones.list", { project: projectId })
        .then((answer) => setMilestones(answer.milestones))
        .catch(() => setMilestones([]));
    load();
    return connection.subscribe(projectMilestonesTopic(projectId), load);
  }, [connection, open, projectId]);
  return milestones;
}

function Roadmap({ connection, open, projectId, canWrite }: { connection: TeamConnection; open: boolean; projectId: string; canWrite: boolean }) {
  const milestones = useMilestoneList(connection, open, projectId);
  const todos = useProjectTodos(connection, open, projectId);
  const [adding, setAdding] = useState(false);
  if (milestones === undefined || todos === undefined) return <Skeleton rows={4} />;
  const now = Date.now();
  const ordered = [...milestones].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  const loose = todos.filter((todo) => todo.milestone === undefined && todo.status !== "done").length;
  return (
    <div className="roadmap">
      <div className="section-head">
        <p className="muted small">{t("roadmapHint")}</p>
        {canWrite ? (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Icon name="flag" size={14} /> {t("roadmapPlan")}
          </button>
        ) : null}
      </div>
      {adding ? <PlanMilestone connection={connection} projectId={projectId} close={() => setAdding(false)} /> : null}
      {ordered.length === 0 ? (
        <Blankslate icon="flag" title={t("roadmapEmpty")} compact>
          {t("roadmapEmptyHint")}
        </Blankslate>
      ) : (
        <ol className="roadmap-list">
          {ordered.map((milestone) => {
            const own = todos.filter((todo) => todo.milestone === milestone.id);
            const done = own.filter((todo) => todo.status === "done").length;
            const late = milestone.dueAt !== undefined && milestone.dueAt < now && done < own.length;
            return (
              <li key={milestone.id} className={`roadmap-item${late ? " late" : ""}`}>
                <div className="roadmap-head">
                  <span className="roadmap-name">
                    <Icon name="flag" size={14} /> {milestone.name}
                  </span>
                  {milestone.revision === "" ? <span className="badge">{t("roadmapPlanned")}</span> : <span className="badge tone-success">{t("roadmapReached", { rev: milestone.revision.slice(0, 7) })}</span>}
                  <span className={late ? "tone-danger small" : "muted small"}>
                    {milestone.dueAt === undefined
                      ? t("milestoneNoDate")
                      : milestone.dueAt < now
                        ? t("roadmapWasDue", { when: new Date(milestone.dueAt).toLocaleDateString() })
                        : t("roadmapDueIn", { days: String(Math.floor((milestone.dueAt - new Date(now).setHours(0, 0, 0, 0)) / DAY)), when: new Date(milestone.dueAt).toLocaleDateString() })}
                  </span>
                </div>
                {milestone.note === undefined ? null : <p className="muted small">{milestone.note}</p>}
                {own.length === 0 ? (
                  <p className="muted small">{t("roadmapNoTodos")}</p>
                ) : (
                  <div className="roadmap-body">
                    <div className="roadmap-count">
                      <Bar share={done / own.length} tone={done === own.length ? "success" : late ? "danger" : "accent"} />
                      <span className="small">{t("roadmapDone", { done: String(done), total: String(own.length) })}</span>
                    </div>
                    <Burndown milestone={milestone} todos={own} now={now} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {loose > 0 ? <p className="muted small">{t("roadmapLoose", { count: String(loose) })}</p> : null}
    </div>
  );
}

/** Open to-dos over time, from when the milestone's work began to its date, beside the straight line to none. */
function Burndown({ milestone, todos, now }: { milestone: TeamMilestone; todos: readonly TeamTodo[]; now: number }) {
  const start = Math.min(milestone.createdAt, ...todos.map((todo) => todo.createdAt));
  const end = Math.max(now, milestone.dueAt ?? now, start + DAY);
  const events = todos
    .flatMap((todo) => [
      { at: todo.createdAt, delta: 1 },
      ...(todo.status === "done" && todo.doneAt !== undefined ? [{ at: todo.doneAt, delta: -1 }] : []),
    ])
    .sort((a, b) => a.at - b.at);
  const width = 320;
  const height = 72;
  const x = (at: number) => ((at - start) / (end - start)) * width;
  const most = Math.max(1, todos.length);
  const y = (open: number) => height - (open / most) * (height - 4) - 2;
  let open = 0;
  let path = `M0,${y(0)}`;
  for (const event of events) {
    path += ` L${x(event.at).toFixed(1)},${y(open).toFixed(1)}`;
    open += event.delta;
    path += ` L${x(event.at).toFixed(1)},${y(open).toFixed(1)}`;
  }
  path += ` L${x(Math.min(now, end)).toFixed(1)},${y(open).toFixed(1)}`;
  return (
    <svg className="burndown" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("roadmapBurndown")}>
      {milestone.dueAt === undefined ? null : <line className="burndown-ideal" x1={0} y1={y(todos.length)} x2={x(milestone.dueAt)} y2={y(0)} />}
      {now < end ? <line className="burndown-now" x1={x(now)} y1={0} x2={x(now)} y2={height} /> : null}
      <path className="burndown-line" d={path} />
      <title>{t("roadmapBurndownTitle", { open: String(open), total: String(todos.length) })}</title>
    </svg>
  );
}

function PlanMilestone({ connection, projectId, close }: { connection: TeamConnection; projectId: string; close: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [due, setDue] = useState(dateInput(Date.now() + 14 * DAY));
  const save = (event: FormEvent) => {
    event.preventDefault();
    connection
      .call("milestones.create", {
        project: projectId,
        name: name.trim(),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        ...(due === "" ? {} : { dueAt: new Date(`${due}T23:59:59`).getTime() }),
      })
      .then(() => {
        toast(t("saved"));
        close();
      })
      .catch(toastError);
  };
  return (
    <form className="card plan-milestone" onSubmit={save}>
      <label>
        <span>{t("roadmapName")}</span>
        <input value={name} maxLength={100} required autoFocus onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{t("roadmapDue")}</span>
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
      </label>
      <label>
        <span>{t("glossaryNote")}</span>
        <input value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={close}>
          {t("cancel")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={name.trim() === ""}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- templates */

function Templates({ connection, open, projectId, me, operator }: { connection: TeamConnection; open: boolean; projectId: string; me: string; operator: boolean }) {
  const [templates, setTemplates] = useState<readonly TeamProjectTemplate[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const load = useCallback(() => {
    connection
      .call<{ templates: TeamProjectTemplate[] }>("templates.list", {})
      .then((answer) => setTemplates(answer.templates))
      .catch(setError);
  }, [connection]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const apply = async (template: TeamProjectTemplate) => {
    const ok = await confirmAction({
      title: t("templateApplyTitle", { name: template.name }),
      body: t("templateApplyBody", {
        members: String(template.body.members?.length ?? 0),
        milestones: String(template.body.milestones?.length ?? 0),
        todos: String(template.body.todos?.length ?? 0),
      }),
      confirmLabel: t("templateApply"),
    });
    if (!ok) return;
    connection
      .call<{ members: string[]; milestones: number; todos: number; skipped: string[] }>("templates.apply", { project: projectId, template: template.id })
      .then((answer) =>
        toast(
          t("templateApplied", { members: String(answer.members.length), milestones: String(answer.milestones), todos: String(answer.todos) }),
          "success",
          answer.skipped.length === 0 ? undefined : t("templateSkipped", { names: answer.skipped.join("、") }),
        ),
      )
      .catch(toastError);
  };
  const remove = async (template: TeamProjectTemplate) => {
    if (!(await confirmAction({ title: t("templateDeleteTitle", { name: template.name }), danger: true, confirmLabel: t("remove") }))) return;
    connection.call("templates.delete", { template: template.id }).then(load).catch(toastError);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    connection
      .call("templates.save", { name: name.trim(), fromProject: projectId, ...(description.trim() === "" ? {} : { description: description.trim() }) })
      .then(() => {
        toast(t("saved"));
        setName("");
        setDescription("");
        load();
      })
      .catch(toastError);
  };
  if (error !== undefined) return <Flash error={error} />;
  if (templates === undefined) return <Skeleton rows={3} />;
  return (
    <div className="templates">
      <p className="muted small">{t("templatesHint")}</p>
      {templates.length === 0 ? (
        <Blankslate icon="grid" title={t("templatesEmpty")} compact>
          {t("templatesEmptyHint")}
        </Blankslate>
      ) : (
        <ul className="template-list">
          {templates.map((template) => (
            <li key={template.id} className="card template-item">
              <div>
                <strong>{template.name}</strong>
                {template.description === undefined ? null : <p className="muted small">{template.description}</p>}
                <p className="muted small">
                  {t("templateCounts", {
                    members: String(template.body.members?.length ?? 0),
                    milestones: String(template.body.milestones?.length ?? 0),
                    todos: String(template.body.todos?.length ?? 0),
                  })}
                  {template.createdBy === undefined ? "" : ` · @${template.createdBy}`}
                </p>
              </div>
              <div className="row-actions">
                <button className="btn btn-sm" onClick={() => void apply(template)}>
                  {t("templateApply")}
                </button>
                {template.createdBy === me || operator ? (
                  <button className="btn btn-invisible btn-icon btn-sm" aria-label={t("remove")} title={t("remove")} onClick={() => void remove(template)}>
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="card template-save" onSubmit={save}>
        <h3>{t("templateSaveTitle")}</h3>
        <p className="muted small">{t("templateSaveHint")}</p>
        <label>
          <span>{t("templateName")}</span>
          <input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>{t("templateDescription")}</span>
          <input value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={name.trim() === ""}>
            {t("templateSave")}
          </button>
        </div>
      </form>
    </div>
  );
}
