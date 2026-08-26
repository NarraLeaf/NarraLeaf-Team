/**
 * The windows drawn over a surface, and where each of them lands.
 *
 * One place works out both what a window says and the rectangle it occupies,
 * because the two have to agree: the interface draws the window, and the
 * snapshot reports the rectangle, and a discrepancy between them would show as
 * an overlay that passes every test while sitting somewhere else on screen.
 *
 * Every window is sized to the lines it was given. Ink shrinks children that
 * do not fit, and a shrunk row does not clip — it disappears and leaves its
 * margin behind, so the border stays intact and one line is simply gone from
 * the middle.
 */
import { ellipsis, plural, relativeTime, wrapText } from "./format.js";
import type { TeamView } from "../teamview.js";
import { centred, overBody, SPLIT_FROM, WIDE_RAIL_FROM, type Rect } from "./layout.js";
import { field, projectDetailLines, userDetailLines } from "./panels.js";
import { choicesOf } from "./state.js";
import type { Overlay, TuiSize } from "./state.js";
import { BLANK, lineWidth, span, type Line } from "./text.js";

/** A window: what it says, and the rectangle it covers. */
export interface WindowSpec {
  readonly rect: Rect;
  readonly title: string;
  readonly footer: string;
  readonly lines: readonly Line[];
}

/** The border and the padding either side of a window's content. */
export const CHROME = 4;

/** The rows a window spends on its border, its title and its footer. */
export const FURNITURE = 4;

/** How wide each kind of window would like its content to be. */
const PREFERRED = {
  detail: 54,
  confirm: 56,
  edit: 50,
  pick: 46,
  connection: 66,
  help: 52,
  log: 88,
} as const;

/**
 * The narrowest a window is drawn, however little is in it.
 *
 * A window shrunk to its own footer reads as something that failed to fill
 * rather than as something short.
 */
const MINIMUM_CONTENT = 28;

/** The widest a window may be at this size, leaving the surface visible around it. */
function room(size: TuiSize): number {
  return Math.max(8, size.columns - 6);
}

/**
 * Put a built window on the screen, no wider than the longest line in it.
 *
 * Content first and geometry second, so that a window with four short lines in
 * it is four lines tall rather than a box with a hole in the middle of it.
 */
/** What a picker is asking, in the words somebody would use to ask it. */
function pickerTitle(overlay: Extract<Overlay, { choice: number }>): string {
  switch (overlay.kind) {
    case "pick-owner":
      return `Who is making ${overlay.name}?`;
  }
}

function pickerFooter(overlay: Extract<Overlay, { choice: number }>): string {
  switch (overlay.kind) {
    case "pick-owner":
      return "⏎ create · esc cancel";
  }
}

/** Why a picker has nothing in it. */
function pickerEmpty(overlay: Extract<Overlay, { choice: number }>): string {
  switch (overlay.kind) {
    case "pick-owner":
      return "There are no accounts on this server yet.";
  }
}

function place(
  size: TuiSize,
  title: string,
  footer: string,
  lines: readonly Line[],
  inner: number,
): WindowSpec {
  const used = Math.max(
    MINIMUM_CONTENT,
    [...title].length,
    [...footer].length,
    ...lines.map((line) => lineWidth(line)),
  );
  const width = Math.min(used, inner) + CHROME;
  return { rect: centred(size, width, lines.length + FURNITURE), title, footer, lines };
}

/** A window filling the body, which is what a terminal too narrow to float one gets. */
function overWholeBody(
  size: TuiSize,
  title: string,
  footer: string,
  lines: readonly Line[],
): WindowSpec {
  return { rect: overBody(size), title, footer, lines };
}

function detailWindow(
  size: TuiSize,
  title: string,
  footer: string,
  build: (width: number) => readonly Line[],
): WindowSpec {
  if (size.columns < WIDE_RAIL_FROM) {
    const rect = overBody(size);
    return overWholeBody(size, title, footer, build(rect.width - CHROME));
  }
  const inner = Math.min(PREFERRED.detail, room(size) - CHROME);
  return place(size, title, footer, build(inner), inner);
}

function connectionLines(view: TeamView, width: number): Line[] {
  const lines: Line[] = [
    field("sign-in", ellipsis(view.reach.signIn, width - 11), 10),
    field("data", ellipsis(view.reach.data, width - 11), 10),
    field("authority", ellipsis(view.reach.fingerprint, width - 11), 10),
    BLANK,
    span(" reachable from this machine only", { dim: true }),
  ];
  for (const listener of view.reach.loopback) {
    lines.push(span(`   ${String(listener.port).padEnd(7, " ")} ${listener.what}`));
  }
  return lines;
}

/** Every key, in one place, for somebody who has stopped guessing. */
const HELP: ReadonlyArray<readonly [string, string]> = [
  ["1-4", "go to a surface"],
  ["tab", "the next surface"],
  ["↑ ↓ j k", "move the selection"],
  ["⏎", "open, or change"],
  ["esc", "close the window on top"],
  ["n", "new project"],
  ["d", "disable or enable an account"],
  ["x", "revoke an account's tokens"],
  ["c", "connection details"],
  ["l", "the log"],
  ["k", "rotate the signing key, on the dashboard"],
  ["R", "restart loreserver, on the dashboard"],
  ["?", "this"],
  ["q", "quit"],
];

function helpLines(): Line[] {
  return HELP.map(([key, what]) => [
    { text: ` ${key.padEnd(8, " ")}`, bold: true, color: "cyan" },
    { text: what, dim: true },
  ]);
}

function logLines(view: TeamView, width: number): Line[] {
  if (view.audit.length === 0) {
    return [span(" nothing has been asked of Team yet", { dim: true })];
  }
  return [...view.audit]
    .sort((left, right) => right.at - left.at)
    .map((entry) => [
      { text: ` ${relativeTime(entry.at, view.now).padStart(9, " ")}  `, dim: true },
      { text: entry.username.padEnd(9, " ") },
      { text: entry.resource.padEnd(13, " "), dim: true },
      {
        text: ellipsis(
          `${entry.allowed ? "allowed" : "refused"} (${entry.detail})`,
          Math.max(1, width - 34),
        ),
        ...(entry.allowed ? {} : { color: "red" }),
      },
    ]);
}

/**
 * The words on the confirmation for revoking somebody's tokens.
 *
 * Two sentences, and no more: what this reaches, and what it does not. Team
 * refuses a stale token wherever Team is the one asked, and a data connection
 * already open is checked by loreserver rather than by Team, so it may last
 * until the token it was opened with expires. "Every token stops working at
 * once" would be shorter and wrong, and the reach is the half of this an
 * operator gets wrong.
 */
function revokeLines(width: number): Line[] {
  return [
    ...wrapText("Every token Team has issued stops being accepted.", width).map((text) =>
      span(text),
    ),
    ...wrapText("An open connection may last until its token expires.", width).map((text) =>
      span(text, { dim: true }),
    ),
    BLANK,
  ];
}

/**
 * Work out the window an overlay draws, if it draws one.
 *
 * A detail panel is a window only where there is no room beside the list for
 * it; from {@link SPLIT_FROM} columns it is drawn there instead, and this
 * returns nothing.
 */
export function overlayWindow(
  overlay: Overlay,
  size: TuiSize,
  view: TeamView,
  draft?: string,
): WindowSpec | undefined {
  switch (overlay.kind) {
    case "project-detail": {
      if (size.columns >= SPLIT_FROM) {
        return undefined;
      }
      const project = view.projects.find((candidate) => candidate.name === overlay.project);
      if (project === undefined) {
        return undefined;
      }
      return detailWindow(size, project.name, "esc close · g grant · r revoke", (width) =>
        projectDetailLines(project, view, width, false),
      );
    }
    case "user-detail": {
      if (size.columns >= SPLIT_FROM) {
        return undefined;
      }
      const user = view.users.find((candidate) => candidate.username === overlay.username);
      if (user === undefined) {
        return undefined;
      }
      return detailWindow(size, user.username, "esc close · d disable · x revoke tokens", (width) =>
        userDetailLines(user, view, width, false),
      );
    }
    case "revoke-tokens": {
      const inner = Math.min(PREFERRED.confirm, room(size) - CHROME);
      return place(
        size,
        `Revoke every token issued to ${overlay.username}?`,
        "⏎ revoke · esc cancel",
        revokeLines(inner),
        inner,
      );
    }
    case "edit-setting": {
      const setting = view.settings[overlay.index];
      if (setting === undefined || !setting.editable) {
        return undefined;
      }
      const inner = Math.min(PREFERRED.edit, room(size) - CHROME);
      const lines: Line[] = [span(`${draft ?? setting.value}▏`)];
      if (setting.restartRequired === true) {
        lines.push(BLANK, span("Written now; loreserver takes it up when it is", { dim: true }));
        lines.push(span("next started.", { dim: true }));
      }
      if (setting.caution !== undefined) {
        lines.push(BLANK, ...wrapText(setting.caution, inner).map((text) => span(text, { dim: true })));
      }
      return place(size, setting.label, "⏎ save · esc cancel", lines, inner);
    }
    case "name-project": {
      const inner = Math.min(PREFERRED.edit, room(size) - CHROME);
      return place(
        size,
        "Name the new project",
        "⏎ create · esc cancel",
        [
          span(`${draft ?? ""}▏`),
          BLANK,
          span("A repository of this name is made on loreserver.", { dim: true }),
        ],
        inner,
      );
    }
    case "pick-owner": {
      const rows = choicesOf(overlay, view);
      const inner = Math.min(PREFERRED.pick, room(size) - CHROME);
      if (rows.length === 0) {
        return place(size, pickerTitle(overlay), "esc close", [span(pickerEmpty(overlay), { dim: true })], inner);
      }
      const widest = Math.max(...rows.map((choice) => [...choice.name].length));
      const lines = rows.map((choice, index): Line => [
        { text: ` ${choice.name.padEnd(widest, " ")}  `, inverse: index === overlay.choice },
        { text: choice.note, dim: index !== overlay.choice },
      ]);
      return place(size, pickerTitle(overlay), pickerFooter(overlay), lines, inner);
    }
    case "connection": {
      const inner = Math.min(PREFERRED.connection, room(size) - CHROME);
      return place(size, "connection details", "esc close", connectionLines(view, inner), inner);
    }
    case "help": {
      const inner = Math.min(PREFERRED.help, room(size) - CHROME);
      return place(size, "keys", "esc close", helpLines(), inner);
    }
    case "log": {
      const inner = Math.min(PREFERRED.log, room(size) - CHROME);
      return place(
        size,
        `log · ${plural(view.audit.length, "decision")}`,
        "esc close",
        logLines(view, inner),
        inner,
      );
    }
  }
}
