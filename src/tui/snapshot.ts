/**
 * The interface as a grid of characters, worked out without a terminal.
 *
 * This is a pure function of a described state, a size and a view: no clock,
 * no filesystem, no process, no database. Every relative time on screen comes
 * from `view.now`, so the same three arguments always draw the same grid, and
 * a test can say what is on screen rather than that something was rendered.
 */
import { renderToString } from "ink";
import { createElement } from "react";

import { Interface } from "./app.js";
import type { TeamView } from "../teamview.js";
import { topOverlay, type Overlay, type TuiSize, type TuiState } from "./state.js";
import { overlayWindow } from "./window.js";

export type { Overlay, TuiSize, TuiState } from "./state.js";

export interface Snapshot {
  /** The drawn grid with styling removed, exactly `size.rows` long. */
  readonly rows: string[];
  /** The topmost overlay's rectangle, if one is open. */
  readonly overlay?: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  };
  /** The settings surface's rows, in the order drawn. */
  readonly settings?: ReadonlyArray<{ readonly label: string; readonly editable: boolean }>;
}

/**
 * Anything that styles rather than prints.
 *
 * Ink writes colour as an escape sequence around the characters it applies to,
 * and everything of that kind has to come out before the result can be read as
 * a grid. What is left is what a person sees. The sequences are written here
 * as `\u001B` rather than as themselves: a source file with a control
 * character in it is one git treats as binary, and its contents stop appearing
 * in a review.
 */
const ESCAPE_SEQUENCE =
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * The rendered text as a rectangle.
 *
 * Every row is padded to the full width and the grid is exactly as tall as the
 * terminal, because a caller comparing one screen with another compares cells:
 * a row that stopped at its last character would make two screens differ where
 * the terminal shows the same thing.
 */
function toGrid(rendered: string, size: TuiSize): string[] {
  const lines = rendered.replace(ESCAPE_SEQUENCE, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const rows: string[] = [];
  for (let index = 0; index < size.rows; index += 1) {
    const characters = [...(lines[index] ?? "")];
    rows.push(
      characters.length >= size.columns
        ? characters.slice(0, size.columns).join("")
        : characters.join("").padEnd(size.columns, " "),
    );
  }
  return rows;
}

/** Draw one state at one size, and report what was drawn. */
export function snapshot(state: TuiState, size: TuiSize, view: TeamView): Snapshot {
  const rendered = renderToString(createElement(Interface, { state, size, view }), {
    columns: size.columns,
  });
  const rows = toGrid(rendered, size);

  const top: Overlay | undefined = topOverlay(state);
  const window = top === undefined ? undefined : overlayWindow(top, size, view);
  const settings =
    state.surface === "settings"
      ? view.settings.map((setting) => ({ label: setting.label, editable: setting.editable }))
      : undefined;

  return {
    rows,
    ...(window === undefined ? {} : { overlay: window.rect }),
    ...(settings === undefined ? {} : { settings }),
  };
}
