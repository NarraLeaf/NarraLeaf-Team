/**
 * Adding a to-do the way a to-do app does: one line, typed, and Enter. What a
 * to-do carries besides its words - when it is due, how much it matters, who
 * does it, its labels, its milestone, its kind - is picked from the two
 * buttons at the end of the line, or typed into it: "#art", "@nora", "!high",
 * "tomorrow". Whatever was picked shows under the line, each with a ×.
 *
 * The date picker and the priority flags are also what a card uses to change
 * its own.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { TODO_LABEL_LENGTH, TODO_LABELS_LIMIT, type TeamMilestone, type TeamTodoKind, type TeamTodoPriority } from "@narraleaf/team-protocol";

import { Icon } from "./Icon";
import { language, t, type Phrase } from "./i18n";
import { toastError } from "./ui";
import { useAnchoredStyle, useDismiss, type Align } from "./ui/overlay";

export const KIND_PHRASE: Record<TeamTodoKind, Phrase> = { task: "kindTask", asset: "kindAsset", translation: "kindTranslation", voice: "kindVoice" };
export const KINDS: readonly TeamTodoKind[] = ["task", "asset", "translation", "voice"];

/* ------------------------------------------------------------------ dates */

const LOCALE = { zh: "zh-CN", en: "en", ja: "ja-JP" }[language];
const DAY = 86_400_000;

function startOfDay(at: Date | number): Date {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** A day picked is due at its last moment, so it is late only once it is over. */
function endOfDay(day: Date): number {
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

function addDays(day: Date, count: number): Date {
  const next = new Date(day);
  next.setDate(next.getDate() + count);
  return next;
}

/** Whole local days from today to `at`: 0 today, 1 tomorrow, -1 yesterday. */
function daysFromToday(at: number, now = Date.now()): number {
  return Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / DAY);
}

function sameDay(a: number, b: number): boolean {
  return daysFromToday(a, b) === 0;
}

/** The next given weekday (0 Sunday … 6 Saturday), today included; a week later with `later`. */
function nextWeekday(weekday: number, later = false): Date {
  const today = startOfDay(Date.now());
  if (later) {
    // "Next Friday": the Friday of next week, weeks starting on Monday.
    const sinceMonday = (today.getDay() + 6) % 7;
    return addDays(today, 7 - sinceMonday + ((weekday + 6) % 7));
  }
  return addDays(today, (weekday - today.getDay() + 7) % 7);
}

/** A due day in words: today, tomorrow, a weekday this week, else the date. */
export function dueLabel(at: number): string {
  const days = daysFromToday(at);
  if (days === 0) return t("todoDueToday");
  if (days === 1) return t("todoDueTomorrow");
  if (days === -1) return t("todoDueYesterday");
  const date = new Date(at);
  if (days > 1 && days < 7) return date.toLocaleDateString(LOCALE, { weekday: "short" });
  if (date.getFullYear() === new Date().getFullYear()) return date.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
  return date.toLocaleDateString(LOCALE, { year: "numeric", month: "short", day: "numeric" });
}

/** How a due day should look: past it, due today, or later. */
export function dueTone(at: number): "late" | "today" | "later" {
  const days = daysFromToday(at);
  return days < 0 ? "late" : days === 0 ? "today" : "later";
}

/* --------------------------------------------------------------- priority */

export const PRIORITIES: readonly TeamTodoPriority[] = [3, 2, 1, 0];
export const PRIORITY_PHRASE: Record<TeamTodoPriority, Phrase> = { 3: "priorityHigh", 2: "priorityMedium", 1: "priorityLow", 0: "priorityNone" };

/** A flag in the priority's colour, filled where there is one. */
export function PriorityFlag({ priority, size = 16 }: { priority: TeamTodoPriority; size?: number }) {
  return (
    <svg className={`icon prio-flag prio-${priority}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 21V4h12l-2.5 4L17 12H5"
        fill={priority === 0 ? "none" : "currentColor"}
        fillOpacity={0.9}
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The four flags in a row, the way a to-do app offers them. */
function PriorityRow({ value, onChange }: { value: TeamTodoPriority; onChange: (priority: TeamTodoPriority) => void }) {
  return (
    <div className="prio-row" role="radiogroup" aria-label={t("todoPriority")}>
      {PRIORITIES.map((priority) => (
        <button
          key={priority}
          type="button"
          role="radio"
          aria-checked={value === priority}
          className={value === priority ? "prio-pick on" : "prio-pick"}
          title={t(PRIORITY_PHRASE[priority])}
          aria-label={t(PRIORITY_PHRASE[priority])}
          onClick={() => onChange(priority)}
        >
          <PriorityFlag priority={priority} size={18} />
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- popover */

/** A button and the layer it opens beside it, closed by a click away or Escape. */
function usePopover(align: Align, minWidth?: number) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss([button, layer], open, close, button);
  const style = useAnchoredStyle(button, layer, open, align, minWidth);
  return { open, setOpen, close, button, layer, style };
}

function Layer({ layer, style, label, className, children }: { layer: RefObject<HTMLDivElement | null>; style: CSSProperties; label: string; className: string; children: ReactNode }) {
  return createPortal(
    <div ref={layer} className={`overlay ${className}`} style={style} role="dialog" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- due picker */

/**
 * A due day: today, tomorrow or next Monday at one press, or any day from a
 * month laid out as a calendar. The button is drawn by the caller.
 */
export function DuePicker({
  value,
  onChange,
  align = "end",
  className,
  title,
  children,
}: {
  value: number | undefined;
  onChange: (at: number | undefined) => void;
  align?: Align;
  className: string;
  title?: string;
  children: ReactNode;
}) {
  const pop = usePopover(align, 260);
  const [month, setMonth] = useState(() => startOfDay(value ?? Date.now()));
  const pick = (day: Date | undefined) => {
    onChange(day === undefined ? undefined : endOfDay(day));
    pop.close();
    pop.button.current?.focus();
  };
  const today = startOfDay(Date.now());
  const quick: { phrase: Phrase; day: Date; hint: string }[] = [
    { phrase: "todoDueToday", day: today, hint: today.toLocaleDateString(LOCALE, { weekday: "short" }) },
    { phrase: "todoDueTomorrow", day: addDays(today, 1), hint: addDays(today, 1).toLocaleDateString(LOCALE, { weekday: "short" }) },
    { phrase: "todoDueNextWeek", day: nextWeekday(1, true), hint: nextWeekday(1, true).toLocaleDateString(LOCALE, { month: "numeric", day: "numeric" }) },
  ];
  return (
    <>
      <button
        ref={pop.button}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={title ?? t("todoDue")}
        title={title ?? t("todoDue")}
        onClick={() => {
          setMonth(startOfDay(value ?? Date.now()));
          pop.setOpen(!pop.open);
        }}
      >
        {children}
      </button>
      {pop.open ? (
        <Layer layer={pop.layer} style={pop.style} label={t("todoDue")} className="due-picker">
          <div className="due-quick">
            {quick.map((one) => (
              <button
                key={one.phrase}
                type="button"
                className={value !== undefined && sameDay(value, one.day.getTime()) ? "due-quick-pick on" : "due-quick-pick"}
                onClick={() => pick(one.day)}
              >
                <span>{t(one.phrase)}</span>
                <span className="muted small">{one.hint}</span>
              </button>
            ))}
          </div>
          <MonthGrid month={month} setMonth={setMonth} value={value} pick={pick} />
          {value === undefined ? null : (
            <div className="due-foot">
              <button type="button" className="btn btn-invisible btn-sm" onClick={() => pick(undefined)}>
                <Icon name="close" size={14} /> {t("todoDueClear")}
              </button>
            </div>
          )}
        </Layer>
      ) : null}
    </>
  );
}

function MonthGrid({ month, setMonth, value, pick }: { month: Date; setMonth: (month: Date) => void; value: number | undefined; pick: (day: Date) => void }) {
  // Chinese weeks start on Monday, English ones on Sunday.
  const weekStart = language === "zh" ? 1 : 0;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  const now = Date.now();
  const names = Array.from({ length: 7 }, (_, index) => addDays(start, index).toLocaleDateString(LOCALE, { weekday: "narrow" }));
  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  return (
    <div className="month">
      <div className="month-head">
        <button type="button" className="btn btn-invisible btn-icon btn-sm" aria-label={t("monthPrevious")} onClick={() => shift(-1)}>
          <Icon name="back" size={14} />
        </button>
        <span>{first.toLocaleDateString(LOCALE, { year: "numeric", month: "long" })}</span>
        <button type="button" className="btn btn-invisible btn-icon btn-sm month-next" aria-label={t("monthNext")} onClick={() => shift(1)}>
          <Icon name="back" size={14} />
        </button>
      </div>
      <div className="month-grid" role="grid">
        {names.map((name, index) => (
          <span key={`name-${index}`} className="month-name muted small" role="columnheader">
            {name}
          </span>
        ))}
        {days.map((day) => {
          const at = day.getTime();
          const classes = [
            "month-day",
            day.getMonth() !== month.getMonth() ? "outside" : "",
            sameDay(at, now) ? "today" : "",
            value !== undefined && sameDay(at, value) ? "on" : "",
            at < startOfDay(now).getTime() ? "past" : "",
          ].filter((one) => one !== "");
          return (
            <button key={at} type="button" role="gridcell" className={classes.join(" ")} aria-label={day.toLocaleDateString(LOCALE, { dateStyle: "full" })} onClick={() => pick(day)}>
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- smart words */

interface Member {
  readonly username: string;
  readonly displayName: string;
}

type Found =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "assignee"; readonly username: string }
  | { readonly kind: "priority"; readonly priority: TeamTodoPriority }
  | { readonly kind: "due"; readonly at: number };

const PRIORITY_WORDS: Record<string, TeamTodoPriority> = {
  "3": 3, 高: 3, high: 3, h: 3, "!!": 3,
  "2": 2, 中: 2, medium: 2, med: 2, m: 2, "!": 2,
  "1": 1, 低: 1, low: 1, l: 1,
  "0": 0, 无: 0, なし: 0, none: 0,
};

const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
/** Japanese weekday kanji: 月火水木金土日. */
const WEEKDAYS_JA: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function dueWord(word: string): Date | undefined {
  const today = startOfDay(Date.now());
  const lower = word.toLowerCase();
  if (lower === "今天" || lower === "今日" || lower === "today") return today;
  if (lower === "明天" || lower === "明日" || lower === "tomorrow" || lower === "tmr") return addDays(today, 1);
  if (lower === "后天" || lower === "明後日") return addDays(today, 2);
  if (lower === "大后天") return addDays(today, 3);
  if (lower === "下周" || lower === "来週") return nextWeekday(1, true);
  if (lower === "周末" || lower === "週末") return nextWeekday(6);
  const weekday = /^(下)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(word);
  if (weekday !== null) return nextWeekday(WEEKDAYS[weekday[2] ?? ""] ?? 1, weekday[1] !== undefined);
  const youbi = /^(来週)?([月火水木金土日])(?:曜日?)?$/.exec(word);
  if (youbi !== null) return nextWeekday(WEEKDAYS_JA[youbi[2] ?? ""] ?? 1, youbi[1] !== undefined);
  return undefined;
}

/** What one typed word sets, if it is one of the words that set something. */
function readWord(word: string, members: readonly Member[] | undefined): Found | undefined {
  if (word.length > 1 && (word.startsWith("#") || word.startsWith("＃"))) {
    const label = word.slice(1).trim();
    return label === "" || label.length > TODO_LABEL_LENGTH ? undefined : { kind: "label", label };
  }
  if (word.length > 1 && (word.startsWith("@") || word.startsWith("＠")) && members !== undefined) {
    const name = word.slice(1).toLowerCase();
    const member = members.find((one) => one.username.toLowerCase() === name) ?? members.find((one) => one.displayName !== "" && one.displayName.toLowerCase() === name);
    return member === undefined ? undefined : { kind: "assignee", username: member.username };
  }
  if (word.length > 1 && (word.startsWith("!") || word.startsWith("！"))) {
    const priority = PRIORITY_WORDS[word.slice(1).toLowerCase().replace(/！/g, "!")];
    return priority === undefined ? undefined : { kind: "priority", priority };
  }
  const day = dueWord(word);
  return day === undefined ? undefined : { kind: "due", at: endOfDay(day) };
}

/** The word the caret is at the end of, when it starts with one of the signs that open a list. */
interface Typing {
  readonly sign: "@" | "#" | "!";
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

function typingAt(text: string, caret: number | null): Typing | undefined {
  if (caret === null) return undefined;
  const after = text.charAt(caret);
  if (after !== "" && !/\s/.test(after)) return undefined;
  const start = text.slice(0, caret).search(/\S+$/);
  if (start < 0) return undefined;
  const word = text.slice(start, caret);
  const head = word.charAt(0);
  const sign = head === "@" || head === "＠" ? "@" : head === "#" || head === "＃" ? "#" : head === "!" || head === "！" ? "!" : undefined;
  return sign === undefined ? undefined : { sign, query: word.slice(1), start, end: caret };
}

interface Suggestion {
  readonly key: string;
  readonly leading: ReactNode;
  readonly label: string;
  readonly description?: string | undefined;
  readonly found: Found;
}

let measurer: CanvasRenderingContext2D | null | undefined;

/** How far into `input` the start of `before` sits, so a list can open under the word being typed. */
function textLeft(input: HTMLInputElement, before: string): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  const style = getComputedStyle(input);
  let width = 0;
  if (measurer !== null) {
    measurer.font = style.font;
    width = measurer.measureText(before).width;
  }
  const left = input.offsetLeft + Number.parseFloat(style.paddingLeft) + width - input.scrollLeft;
  return Math.max(input.offsetLeft, Math.min(left, input.offsetLeft + input.clientWidth - 8));
}

/** The list under a word being typed after @, # or !: arrows move, Enter or Tab takes, a click takes. */
function Suggestions({
  anchor,
  id,
  caption,
  items,
  active,
  setActive,
  pick,
  empty,
}: {
  anchor: RefObject<HTMLElement | null>;
  id: string;
  caption: string;
  items: readonly Suggestion[];
  active: number;
  setActive: (index: number) => void;
  pick: (item: Suggestion) => void;
  empty: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const style = useAnchoredStyle(anchor, layer, true, "start", 220);
  useEffect(() => {
    layer.current?.querySelector(".cmenu-option.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return createPortal(
    // A press inside keeps the caret in the line.
    <div ref={layer} className="overlay cmenu todo-suggest" style={style} onMouseDown={(event) => event.preventDefault()}>
      <div className="cmenu-caption muted small">{caption}</div>
      {items.length === 0 ? (
        <p className="cmenu-empty muted small">{empty}</p>
      ) : (
        <div className="cmenu-list" role="listbox" id={id} aria-label={caption}>
          {items.map((item, index) => (
            <div
              key={item.key}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "cmenu-option active" : "cmenu-option"}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(item)}
            >
              {item.leading}
              <span className="cmenu-option-text">
                <span>{item.label}</span>
                {item.description === undefined ? null : <span className="muted small">{item.description}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

const SMART_KEY = "nlteam.todoSmartInput";

function smartOn(): boolean {
  try {
    return localStorage.getItem(SMART_KEY) !== "off";
  } catch {
    return true;
  }
}

/* --------------------------------------------------------------- composer */

export interface TodoComposerProps {
  /** The project it adds to; a personal to-do where not given. */
  readonly project?: string | undefined;
  readonly members?: readonly Member[] | undefined;
  readonly milestones?: readonly TeamMilestone[] | undefined;
  /** Labels already on other to-dos, offered first. */
  readonly knownLabels: readonly string[];
  /** The kind a new to-do starts as: the one the board is showing. */
  readonly defaultKind?: TeamTodoKind;
  /** Draws a member's face. */
  readonly face: (member: Member, size: number) => ReactNode;
  /** Sends the parameters of todos.create; a refusal is shown as a toast. */
  readonly create: (fields: Record<string, unknown>) => Promise<unknown>;
  /**
   * Only private to-dos may be added — a viewer's, which the server refuses to show to the project — so a
   * project to-do here is a plain task for the account alone, with no assignee, milestone or kind to choose.
   */
  readonly privateOnly?: boolean;
}

export function TodoComposer({ project, members, milestones, knownLabels, defaultKind = "task", face, create, privateOnly = false }: TodoComposerProps) {
  const [text, setText] = useState("");
  const [due, setDue] = useState<number | undefined>(undefined);
  const [priority, setPriority] = useState<TeamTodoPriority>(0);
  const [assignee, setAssignee] = useState<string | undefined>(undefined);
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [milestone, setMilestone] = useState<string | undefined>(undefined);
  const [chosenKind, setKind] = useState<TeamTodoKind>(defaultKind);
  const [locale, setLocale] = useState("");
  const [onlyMe, setOnlyMe] = useState(false);
  const [smart, setSmart] = useState(smartOn);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [localeMissing, setLocaleMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const localeInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(0);
  const [active, setActive] = useState(0);
  // Where the word was whose list Escape closed; it stays closed until the caret is at another word.
  const [dismissed, setDismissed] = useState<number | undefined>(undefined);
  /** Where the caret goes once the text a pick left behind is on screen. */
  const placeCaret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === undefined) return;
    placeCaret.current = undefined;
    input.current?.focus();
    input.current?.setSelectionRange(at, at);
  });

  useEffect(() => setKind(defaultKind), [defaultKind]);

  // What a project to-do may carry beyond a personal one: an assignee, a milestone, a kind, the project seeing it.
  const inProject = project !== undefined && !privateOnly;
  const kind: TeamTodoKind = privateOnly ? "task" : chosenKind;
  const needsLocale = kind === "translation" || kind === "voice";
  // Somebody else's work, or an asset, translation or voice request, is for the project to see.
  const forcedShared = kind !== "task" || assignee !== undefined;
  const memberOf = (username: string | undefined) => members?.find((member) => member.username === username);
  const milestoneName = milestones?.find((one) => one.id === milestone)?.name;

  const addLabel = (label: string) =>
    setLabels((current) => (current.includes(label) || current.length >= TODO_LABELS_LIMIT ? current : [...current, label]));

  const take = (found: Found) => {
    if (found.kind === "label") addLabel(found.label);
    else if (found.kind === "assignee") setAssignee(found.username);
    else if (found.kind === "priority") setPriority(found.priority);
    else setDue(found.at);
  };

  const typed = (next: string, composing: boolean, caret: number | null) => {
    // A word that sets something turns into its chip once a space ends it, at the end of the line;
    // a pasted line has every finished word read at once.
    if (smart && !composing && next.length > text.length && caret === next.length && /\s$/.test(next)) {
      const words = next.split(/\s+/).filter((word) => word !== "");
      const kept: string[] = [];
      let changed = false;
      for (const word of words) {
        const found = readWord(word, inProject ? members : undefined);
        if (found === undefined) kept.push(word);
        else {
          take(found);
          changed = true;
        }
      }
      if (changed) {
        const rest = kept.length === 0 ? "" : `${kept.join(" ")} `;
        setText(rest);
        setCaret(rest.length);
        return;
      }
    }
    setText(next);
  };

  /* What the word at the caret could be, listed under it while it is typed. */
  const typing = smart && focused ? typingAt(text, caret) : undefined;
  const typingStart = typing?.start;
  const typingQuery = typing === undefined ? undefined : `${typing.sign}${typing.query}`;
  useEffect(() => setDismissed(undefined), [typingStart]);
  useEffect(() => setActive(0), [typingStart, typingQuery]);

  const listFor = (word: Typing): { caption: string; empty: string; items: Suggestion[] } | undefined => {
    const q = word.query.trim().toLowerCase();
    const rank = (name: string) => {
      const lower = name.toLowerCase();
      return lower === q ? 0 : lower.startsWith(q) ? 1 : 2;
    };
    if (word.sign === "@") {
      if (!inProject || members === undefined || members.length === 0) return undefined;
      const items = members
        .filter((one) => q === "" || one.username.toLowerCase().includes(q) || one.displayName.toLowerCase().includes(q))
        .sort((a, b) => Math.min(rank(a.username), rank(a.displayName)) - Math.min(rank(b.username), rank(b.displayName)))
        .map((one) => ({
          key: `@${one.username}`,
          leading: face(one, 20),
          label: one.displayName || one.username,
          description: one.displayName ? `@${one.username}` : undefined,
          found: { kind: "assignee", username: one.username } as const,
        }));
      return { caption: t("assignTo"), empty: t("todoSuggestNoMember"), items };
    }
    if (word.sign === "#") {
      if (labels.length >= TODO_LABELS_LIMIT) return { caption: t("todoLabels"), empty: t("todoLabelLimit", { count: String(TODO_LABELS_LIMIT) }), items: [] };
      const pool = [...new Set(knownLabels)].filter((one) => !labels.includes(one));
      const items: Suggestion[] = pool
        .filter((one) => q === "" || one.toLowerCase().includes(q))
        .sort((a, b) => rank(a) - rank(b))
        .map((one) => ({
          key: `#${one}`,
          leading: <span className="cmenu-dot" style={{ ["--label-hue" as string]: String(labelHue(one)) }} />,
          label: one,
          found: { kind: "label", label: one } as const,
        }));
      const typedLabel = word.query.trim();
      const known = [...pool, ...labels].some((one) => one.toLowerCase() === typedLabel.toLowerCase());
      if (typedLabel !== "" && typedLabel.length <= TODO_LABEL_LENGTH && !known) {
        items.push({ key: "#new", leading: <Icon name="plus" size={14} />, label: t("todoLabelCreate", { label: typedLabel }), found: { kind: "label", label: typedLabel } });
      }
      return { caption: t("todoLabels"), empty: t("todoLabelNone"), items };
    }
    const items = PRIORITIES.filter((one) => q === "" || PRIORITY_WORDS[q] === one || t(PRIORITY_PHRASE[one]).toLowerCase().includes(q)).map((one) => ({
      key: `!${one}`,
      leading: <PriorityFlag priority={one} size={14} />,
      label: t(PRIORITY_PHRASE[one]),
      found: { kind: "priority", priority: one } as const,
    }));
    // "!" that matches no priority is most likely just an exclamation mark.
    return items.length === 0 ? undefined : { caption: t("todoPriority"), empty: "", items };
  };
  const list = typing !== undefined && typing.start !== dismissed ? listFor(typing) : undefined;
  const chosen = list === undefined ? 0 : Math.min(active, Math.max(0, list.items.length - 1));
  const anchorLeft = list !== undefined && typing !== undefined && input.current !== null ? textLeft(input.current, text.slice(0, typing.start)) : 0;

  /** Takes what was picked from the list and drops the word that asked for it. */
  const pick = (item: Suggestion) => {
    if (typing === undefined) return;
    take(item.found);
    const before = text.slice(0, typing.start).replace(/\s+$/, "");
    const after = text.slice(typing.end).replace(/^\s+/, "");
    const head = before === "" ? "" : `${before} `;
    setText(`${head}${after}`);
    setCaret(head.length);
    placeCaret.current = head.length;
  };

  const reset = () => {
    setText("");
    setDue(undefined);
    setPriority(0);
    setAssignee(undefined);
    setLabels([]);
    setMilestone(undefined);
    setKind(defaultKind);
    setLocale("");
    setLocaleMissing(false);
  };

  const submit = async () => {
    if (busy) return;
    // Words still in the line that set something are read on Enter too, as a pasted line's would be.
    let title = text.trim();
    const picked = { due, priority, assignee, labels: [...labels] };
    if (smart) {
      const kept: string[] = [];
      for (const word of title.split(/\s+/)) {
        const found = word === "" ? undefined : readWord(word, inProject ? members : undefined);
        if (found === undefined) kept.push(word);
        else if (found.kind === "label") {
          if (!picked.labels.includes(found.label) && picked.labels.length < TODO_LABELS_LIMIT) picked.labels.push(found.label);
        } else if (found.kind === "assignee") picked.assignee = found.username;
        else if (found.kind === "priority") picked.priority = found.priority;
        else picked.due = found.at;
      }
      title = kept.join(" ").trim();
    }
    if (title === "") {
      input.current?.focus();
      return;
    }
    if (inProject && needsLocale && locale.trim() === "") {
      setLocaleMissing(true);
      localeInput.current?.focus();
      return;
    }
    const shared = !privateOnly && (forcedShared || picked.assignee !== undefined || !onlyMe);
    const fields: Record<string, unknown> = {
      title,
      ...(picked.due === undefined ? {} : { dueAt: picked.due }),
      ...(picked.priority === 0 ? {} : { priority: picked.priority }),
      ...(picked.labels.length === 0 ? {} : { labels: picked.labels }),
      ...(project === undefined
        ? {}
        : {
            project,
            visibility: shared ? "project" : "private",
            kind,
            ...(needsLocale ? { locale: locale.trim() } : {}),
            ...(picked.assignee === undefined ? {} : { assignee: picked.assignee }),
            ...(milestone === undefined ? {} : { milestone }),
          }),
    };
    setBusy(true);
    try {
      await create(fields);
      reset();
    } catch (caught) {
      toastError(caught);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const chips: ReactNode[] = [];
  if (due !== undefined) {
    chips.push(
      <Chip key="due" className={`due-${dueTone(due)}`} icon={<Icon name="calendar" size={13} />} onRemove={() => setDue(undefined)}>
        {dueLabel(due)}
      </Chip>,
    );
  }
  if (priority !== 0) {
    chips.push(
      <Chip key="priority" icon={<PriorityFlag priority={priority} size={13} />} onRemove={() => setPriority(0)}>
        {t(PRIORITY_PHRASE[priority])}
      </Chip>,
    );
  }
  if (assignee !== undefined) {
    const member = memberOf(assignee);
    chips.push(
      <Chip key="assignee" icon={face(member ?? { username: assignee, displayName: "" }, 16)} onRemove={() => setAssignee(undefined)}>
        {member?.displayName || assignee}
      </Chip>,
    );
  }
  for (const label of labels) {
    chips.push(
      <Chip key={`label-${label}`} className="label" hue={labelHue(label)} onRemove={() => setLabels(labels.filter((one) => one !== label))}>
        #{label}
      </Chip>,
    );
  }
  if (milestone !== undefined) {
    chips.push(
      <Chip key="milestone" icon={<Icon name="diamond" size={13} />} onRemove={() => setMilestone(undefined)}>
        {milestoneName ?? "…"}
      </Chip>,
    );
  }
  if (inProject && kind !== "task") {
    chips.push(
      <Chip key="kind" className={`kind kind-${kind}`} onRemove={() => setKind("task")}>
        {t(KIND_PHRASE[kind])}
        {needsLocale ? (
          <input
            ref={localeInput}
            className={localeMissing ? "chip-input missing" : "chip-input"}
            value={locale}
            placeholder={t("todoLocaleShort")}
            aria-label={t("todoLocale")}
            maxLength={35}
            size={6}
            onChange={(event) => {
              setLocale(event.target.value);
              setLocaleMissing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        ) : null}
      </Chip>,
    );
  }
  if (inProject && !forcedShared && onlyMe) {
    chips.push(
      <Chip key="private" icon={<Icon name="lock" size={13} />} onRemove={() => setOnlyMe(false)}>
        {t("todoOnlyMe")}
      </Chip>,
    );
  } else if (privateOnly && project !== undefined && (focused || text !== "")) {
    chips.push(
      <Chip key="private" icon={<Icon name="lock" size={13} />}>
        {t("todoOnlyMe")}
      </Chip>,
    );
  }

  return (
    <div className={`todo-composer${focused ? " is-focused" : ""}`}>
      <div className="todo-composer-row">
        <span className="todo-composer-plus" aria-hidden="true">
          <Icon name="plus" size={16} />
        </span>
        <input
          ref={input}
          value={text}
          maxLength={300}
          role="combobox"
          aria-label={t("todoNewTitle")}
          aria-autocomplete="list"
          aria-expanded={list !== undefined}
          aria-controls={list === undefined ? undefined : listId}
          aria-activedescendant={list !== undefined && list.items.length > 0 ? `${listId}-${chosen}` : undefined}
          placeholder={focused && smart ? t("todoQuickAddExample") : t("todoQuickAdd")}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setCaret(event.target.selectionStart);
            typed(event.target.value, (event.nativeEvent as InputEvent).isComposing === true, event.target.selectionStart);
          }}
          onSelect={(event) => {
            const field = event.currentTarget;
            setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);
          }}
          onKeyDown={(event) => {
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (list !== undefined && typing !== undefined && !composing) {
              const count = list.items.length;
              if (count > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setActive((chosen + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
                return;
              }
              const item = list.items[chosen];
              if (item !== undefined && (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))) {
                event.preventDefault();
                pick(item);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissed(typing.start);
                return;
              }
            }
            // Enter that ends an IME composition picks the word; it does not add the to-do.
            if (event.key === "Enter" && !composing) {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape" && text === "") {
              input.current?.blur();
            }
          }}
        />
        <DuePicker value={due} onChange={setDue} className={due === undefined ? "composer-tool" : `composer-tool on due-${dueTone(due)}`}>
          <Icon name="calendar" size={16} />
        </DuePicker>
        <ComposerMenu
          inProject={inProject}
          members={members}
          milestones={milestones}
          knownLabels={knownLabels}
          face={face}
          priority={priority}
          setPriority={setPriority}
          assignee={assignee}
          setAssignee={setAssignee}
          labels={labels}
          toggleLabel={(label) => (labels.includes(label) ? setLabels(labels.filter((one) => one !== label)) : addLabel(label))}
          milestone={milestone}
          setMilestone={setMilestone}
          kind={kind}
          setKind={(next) => {
            setKind(next);
            // A translation or voice request asks for its language straight away.
            if (next === "translation" || next === "voice") requestAnimationFrame(() => localeInput.current?.focus());
          }}
          onlyMe={onlyMe}
          setOnlyMe={setOnlyMe}
          forcedShared={forcedShared}
          smart={smart}
          setSmart={(on) => {
            setSmart(on);
            try {
              localStorage.setItem(SMART_KEY, on ? "on" : "off");
            } catch {
              /* nowhere to remember it */
            }
          }}
        />
        {text.trim() !== "" ? (
          <button type="button" className="btn btn-primary btn-sm todo-composer-add" disabled={busy} onClick={() => void submit()}>
            {t("add")}
          </button>
        ) : null}
      </div>
      {chips.length > 0 ? <div className="todo-composer-chips">{chips}</div> : null}
      {/* The list opens below the whole box, so the chips just taken stay in sight. */}
      <span ref={anchor} className="todo-suggest-anchor" style={{ left: anchorLeft }} aria-hidden="true" />
      {list !== undefined && typing !== undefined ? (
        <Suggestions
          // A list for another word is placed afresh, under that word.
          key={typing.start}
          anchor={anchor}
          id={listId}
          caption={list.caption}
          items={list.items}
          active={chosen}
          setActive={setActive}
          pick={pick}
          empty={list.empty}
        />
      ) : null}
    </div>
  );
}

/** A steady colour for a label, from its name. */
export function labelHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** A chip without `onRemove` is one the composer holds to, with nothing to take away. */
function Chip({ icon, className, hue, onRemove, children }: { icon?: ReactNode; className?: string; hue?: number; onRemove?: () => void; children: ReactNode }) {
  return (
    <span className={`composer-chip${className === undefined ? "" : ` ${className}`}`} style={hue === undefined ? undefined : { ["--label-hue" as string]: String(hue) }}>
      {icon}
      <span className="composer-chip-text">{children}</span>
      {onRemove === undefined ? null : (
        <button type="button" className="composer-chip-remove" aria-label={t("remove")} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------- menu */

type MenuView = "main" | "assignee" | "labels" | "milestone" | "kind";

function ComposerMenu(props: {
  inProject: boolean;
  members: readonly Member[] | undefined;
  milestones: readonly TeamMilestone[] | undefined;
  knownLabels: readonly string[];
  face: (member: Member, size: number) => ReactNode;
  priority: TeamTodoPriority;
  setPriority: (priority: TeamTodoPriority) => void;
  assignee: string | undefined;
  setAssignee: (username: string | undefined) => void;
  labels: readonly string[];
  toggleLabel: (label: string) => void;
  milestone: string | undefined;
  setMilestone: (id: string | undefined) => void;
  kind: TeamTodoKind;
  setKind: (kind: TeamTodoKind) => void;
  onlyMe: boolean;
  setOnlyMe: (on: boolean) => void;
  forcedShared: boolean;
  smart: boolean;
  setSmart: (on: boolean) => void;
}) {
  const pop = usePopover("end", 248);
  const [view, setView] = useState<MenuView>("main");
  const [query, setQuery] = useState("");
  const { inProject, members, milestones, face } = props;
  const go = (next: MenuView) => {
    setQuery("");
    setView(next);
  };
  const done = () => {
    pop.close();
    pop.button.current?.focus();
  };
  const member = members?.find((one) => one.username === props.assignee);
  const milestoneName = milestones?.find((one) => one.id === props.milestone)?.name;

  const q = query.trim().toLowerCase();
  const shownMembers = useMemo(
    () => (members ?? []).filter((one) => q === "" || one.username.toLowerCase().includes(q) || one.displayName.toLowerCase().includes(q)),
    [members, q],
  );
  const labelChoices = useMemo(() => {
    const all = [...new Set([...props.labels, ...props.knownLabels])];
    return all.filter((one) => q === "" || one.toLowerCase().includes(q));
  }, [props.labels, props.knownLabels, q]);
  const typedLabel = query.trim().replace(/^[#＃]/, "");

  const back = (title: string) => (
    <div className="cmenu-head">
      <button type="button" className="btn btn-invisible btn-icon btn-sm" aria-label={t("back")} onClick={() => go("main")}>
        <Icon name="back" size={14} />
      </button>
      <span>{title}</span>
    </div>
  );

  const row = (icon: ReactNode, label: string, value: string | undefined, to: MenuView) => (
    <button type="button" className="cmenu-row" onClick={() => go(to)}>
      {icon}
      <span className="cmenu-row-label">{label}</span>
      {value === undefined ? null : <span className="cmenu-row-value muted">{value}</span>}
      <span className="cmenu-row-go" aria-hidden="true">
        <Icon name="back" size={14} />
      </span>
    </button>
  );

  const option = (key: string, on: boolean, leading: ReactNode, label: string, pick: () => void, description?: string) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={on} className={on ? "cmenu-option on" : "cmenu-option"} onClick={pick}>
      {leading}
      <span className="cmenu-option-text">
        <span>{label}</span>
        {description === undefined ? null : <span className="muted small">{description}</span>}
      </span>
      {on ? <Icon name="tick" size={14} /> : null}
    </button>
  );

  return (
    <>
      <button
        ref={pop.button}
        type="button"
        className="composer-tool"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={t("todoMoreOptions")}
        title={t("todoMoreOptions")}
        onClick={() => {
          go("main");
          pop.setOpen(!pop.open);
        }}
      >
        <Icon name="caret" size={16} />
      </button>
      {pop.open ? (
        <Layer layer={pop.layer} style={pop.style} label={t("todoMoreOptions")} className="cmenu">
          {view === "main" ? (
            <>
              <div className="cmenu-section">
                <div className="cmenu-caption muted small">{t("todoPriority")}</div>
                <PriorityRow value={props.priority} onChange={props.setPriority} />
              </div>
              <div className="menu-rule" role="separator" />
              <div className="cmenu-section">
                {inProject && members !== undefined && members.length > 0
                  ? row(<Icon name="people" size={16} />, t("assignTo"), member === undefined ? undefined : member.displayName || member.username, "assignee")
                  : null}
                {row(<Icon name="tag" size={16} />, t("todoLabels"), props.labels.length === 0 ? undefined : String(props.labels.length), "labels")}
                {inProject && (milestones ?? []).length > 0 ? row(<Icon name="diamond" size={16} />, t("todoMilestone"), milestoneName, "milestone") : null}
                {inProject ? row(<Icon name="todo" size={16} />, t("todoKind"), t(KIND_PHRASE[props.kind]), "kind") : null}
              </div>
              <div className="menu-rule" role="separator" />
              <div className="cmenu-section">
                {inProject ? (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={!props.forcedShared && props.onlyMe}
                    aria-disabled={props.forcedShared}
                    className="cmenu-toggle"
                    title={props.forcedShared ? t("todoOnlyMeForced") : undefined}
                    onClick={() => !props.forcedShared && props.setOnlyMe(!props.onlyMe)}
                  >
                    <Icon name="lock" size={16} />
                    <span className="cmenu-option-text">
                      <span>{t("todoOnlyMe")}</span>
                      <span className="muted small">{props.forcedShared ? t("todoOnlyMeForced") : t("todoOnlyMeHint")}</span>
                    </span>
                    <span className={!props.forcedShared && props.onlyMe ? "cmenu-switch on" : "cmenu-switch"} aria-hidden="true" />
                  </button>
                ) : null}
                <button type="button" role="menuitemcheckbox" aria-checked={props.smart} className="cmenu-toggle" onClick={() => props.setSmart(!props.smart)}>
                  <Icon name="sparkle" size={16} />
                  <span className="cmenu-option-text">
                    <span>{t("todoSmart")}</span>
                    <span className="muted small">{inProject ? t("todoSmartHint") : t("todoSmartHintPersonal")}</span>
                  </span>
                  <span className={props.smart ? "cmenu-switch on" : "cmenu-switch"} aria-hidden="true" />
                </button>
              </div>
            </>
          ) : view === "assignee" ? (
            <>
              {back(t("assignTo"))}
              {(members ?? []).length > 8 ? <FilterBox value={query} onChange={setQuery} /> : null}
              <div className="cmenu-list" role="menu">
                {q === "" ? option("", props.assignee === undefined, <span className="cmenu-blank" />, t("nobody"), () => { props.setAssignee(undefined); done(); }) : null}
                {shownMembers.map((one) =>
                  option(
                    one.username,
                    props.assignee === one.username,
                    face(one, 20),
                    one.displayName || one.username,
                    () => { props.setAssignee(one.username); done(); },
                    one.displayName ? `@${one.username}` : undefined,
                  ),
                )}
              </div>
            </>
          ) : view === "labels" ? (
            <>
              {back(t("todoLabels"))}
              <form
                className="cmenu-filter"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (typedLabel !== "" && typedLabel.length <= TODO_LABEL_LENGTH) {
                    if (!props.labels.includes(typedLabel)) props.toggleLabel(typedLabel);
                    setQuery("");
                  }
                }}
              >
                <Icon name="tag" size={14} />
                <input autoFocus value={query} maxLength={TODO_LABEL_LENGTH + 1} placeholder={t("todoLabelNew")} aria-label={t("todoLabelNew")} onChange={(event) => setQuery(event.target.value)} />
              </form>
              <div className="cmenu-list" role="menu">
                {typedLabel !== "" && !labelChoices.includes(typedLabel) ? (
                  <button type="button" className="cmenu-option" onClick={() => { props.toggleLabel(typedLabel); setQuery(""); }}>
                    <Icon name="plus" size={14} />
                    <span className="cmenu-option-text">{t("todoLabelCreate", { label: typedLabel })}</span>
                  </button>
                ) : null}
                {labelChoices.length === 0 && typedLabel === "" ? <p className="cmenu-empty muted small">{t("todoLabelNone")}</p> : null}
                {labelChoices.map((one) =>
                  option(
                    one,
                    props.labels.includes(one),
                    <span className="cmenu-dot" style={{ ["--label-hue" as string]: String(labelHue(one)) }} />,
                    one,
                    () => props.toggleLabel(one),
                  ),
                )}
              </div>
              {props.labels.length >= TODO_LABELS_LIMIT ? <p className="cmenu-empty muted small">{t("todoLabelLimit", { count: String(TODO_LABELS_LIMIT) })}</p> : null}
            </>
          ) : view === "milestone" ? (
            <>
              {back(t("todoMilestone"))}
              <div className="cmenu-list" role="menu">
                {option("", props.milestone === undefined, <span className="cmenu-blank" />, t("todoNoMilestone"), () => { props.setMilestone(undefined); done(); })}
                {(milestones ?? []).map((one) =>
                  option(
                    one.id,
                    props.milestone === one.id,
                    <Icon name="diamond" size={14} />,
                    one.name,
                    () => { props.setMilestone(one.id); done(); },
                    one.dueAt === undefined ? undefined : dueLabel(one.dueAt),
                  ),
                )}
              </div>
            </>
          ) : (
            <>
              {back(t("todoKind"))}
              <div className="cmenu-list" role="menu">
                {KINDS.map((one) => option(one, props.kind === one, <span className={`cmenu-kind kind-${one}`} />, t(KIND_PHRASE[one]), () => { props.setKind(one); done(); }, t(KIND_HINT[one])))}
              </div>
            </>
          )}
        </Layer>
      ) : null}
    </>
  );
}

const KIND_HINT: Record<TeamTodoKind, Phrase> = { task: "kindTaskHint", asset: "kindAssetHint", translation: "kindTranslationHint", voice: "kindVoiceHint" };

function FilterBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="cmenu-filter">
      <Icon name="search" size={14} />
      <input autoFocus value={value} placeholder={t("selectFilter")} aria-label={t("selectFilter")} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/* ------------------------------------------------------------------ cards */

/** Open work first by how much it matters, then by when it is due; finished work keeps its order. */
export function byPriorityThenDue<T extends { status: string; priority?: TeamTodoPriority; dueAt?: number }>(todos: readonly T[]): T[] {
  const rank = (todo: T) => (todo.status === "done" ? 1 : 0);
  return [...todos].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.status === "done") return 0;
    return (b.priority ?? 0) - (a.priority ?? 0) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });
}
