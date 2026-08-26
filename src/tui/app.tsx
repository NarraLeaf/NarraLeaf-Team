/**
 * The interface itself: a header, a rail, one of four surfaces, a line of
 * keys, and whatever windows are open over the top.
 *
 * Nothing here works anything out. Every line was worded in ./panels.ts and
 * every rectangle in ./layout.ts and ./window.ts, so this file only puts them
 * on the screen — which is what lets the same tree be rendered to a string and
 * compared, without a terminal anywhere near it.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { ellipsis } from "./format.js";
import type { TeamView } from "../teamview.js";
import { frameOf, RAIL_WIDTH, type Frame } from "./layout.js";
import {
  dashboardLines,
  footerLine,
  headerLine,
  projectDetailLines,
  projectListHeader,
  projectRow,
  railLines,
  railStrip,
  scrollTo,
  settingsLines,
  userDetailLines,
  userListHeader,
  userRow,
} from "./panels.js";
import type { Overlay, TuiSize, TuiState } from "./state.js";
import { fitBlock, fitLine, visibleWindow, type Line, type Span } from "./text.js";
import { CHROME, FURNITURE, overlayWindow, type WindowSpec } from "./window.js";

/** Ink's props for one run of characters. */
function styleOf(part: Span): {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  inverse?: boolean;
} {
  return {
    ...(part.color === undefined ? {} : { color: part.color }),
    ...(part.dim === true ? { dimColor: true } : {}),
    ...(part.bold === true ? { bold: true } : {}),
    ...(part.inverse === true ? { inverse: true } : {}),
  };
}

function Row({ line }: { line: Line }): ReactNode {
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate">
        {line.map((part, index) => (
          <Text key={index} {...styleOf(part)}>
            {part.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/**
 * A block of lines, every one of them exactly `width` wide.
 *
 * `rows` given, the block is that tall whatever it was handed: short content
 * is padded and anything past the end is dropped here, where the caller chose
 * the order, rather than by a layout that would take a line out of the middle.
 */
function Block({
  lines,
  width,
  rows,
}: {
  lines: readonly Line[];
  width: number;
  rows?: number;
}): ReactNode {
  const block = rows === undefined ? lines.map((line) => fitLine(line, width)) : fitBlock(lines, rows, width);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {block.map((line, index) => (
        <Row key={index} line={line} />
      ))}
    </Box>
  );
}

/**
 * A window over the surface.
 *
 * The background colour is not decoration. An absolutely positioned box paints
 * only the cells it writes to, so without it every blank cell of the window
 * shows whatever is underneath. Every line inside is padded to the full width
 * for the same reason, which is the half of it that survives a terminal with
 * no colour at all.
 */
function Window({ spec }: { spec: WindowSpec }): ReactNode {
  const inner = Math.max(1, spec.rect.width - CHROME);
  return (
    <Box position="absolute" marginLeft={spec.rect.left} marginTop={spec.rect.top}>
      <Box
        width={spec.rect.width}
        height={spec.rect.height}
        borderStyle="round"
        backgroundColor="black"
        paddingX={1}
        flexDirection="column"
        flexShrink={0}
      >
        <Box flexShrink={0}>
          <Text bold wrap="truncate">
            {ellipsis(spec.title, inner).padEnd(inner, " ")}
          </Text>
        </Box>
        <Block lines={spec.lines} width={inner} rows={Math.max(0, spec.rect.height - FURNITURE)} />
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">
            {ellipsis(spec.footer, inner).padEnd(inner, " ")}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * How wide the block on the left is drawn.
 *
 * Only a surface with a detail panel beside it gives up part of the body. The
 * dashboard and the settings have none, so they keep the whole width — and it
 * has to be the same number their lines were laid out at, because a line laid
 * out wider than the box it goes in loses its right-hand end without saying
 * so. That is how two of the dashboard's quick actions went missing above a
 * hundred and fifty columns and nowhere below it.
 */
function primaryWidth(surface: TuiState["surface"], frame: Frame): number {
  return surface === "dashboard" || surface === "settings" ? frame.bodyWidth : frame.listWidth;
}

/** The rows of the list on the left, or of the whole body when nothing is beside it. */
function listLines(state: TuiState, view: TeamView, frame: Frame): Line[] {
  const width = primaryWidth(state.surface, frame);
  if (state.surface === "dashboard") {
    return dashboardLines(view, frame.bodyWidth, frame.bodyHeight);
  }
  if (state.surface === "settings") {
    const { lines, rowLines } = settingsLines(view, frame.bodyWidth, state.selection);
    return scrollTo(lines, frame.bodyHeight, rowLines[state.selection] ?? 0);
  }
  const rows = Math.max(1, frame.bodyHeight - 1);
  if (state.surface === "users") {
    const { first, last } = visibleWindow(view.users.length, rows, state.selection);
    return [
      userListHeader(width),
      ...view.users
        .slice(first, last)
        .map((user, index) => userRow(user, view, width, first + index === state.selection)),
    ];
  }
  const { first, last } = visibleWindow(view.projects.length, rows, state.selection);
  return [
    projectListHeader(width),
    ...view.projects
      .slice(first, last)
      .map((project, index) => projectRow(project, view, width, first + index === state.selection)),
  ];
}

/**
 * The panel beside the list, where there is room for one.
 *
 * It follows the selection rather than waiting to be opened: at this width the
 * space is there whether or not it is used, and a panel that appears only on a
 * key press would leave a third of the screen blank for no reason.
 */
function detailLines(state: TuiState, view: TeamView, frame: Frame): Line[] | undefined {
  const width = frame.detailWidth;
  if (state.surface === "users") {
    const named = state.overlays.find(
      (overlay): overlay is Extract<Overlay, { kind: "user-detail" }> =>
        overlay.kind === "user-detail",
    );
    const user =
      view.users.find((candidate) => candidate.username === named?.username) ??
      view.users[state.selection];
    return user === undefined ? undefined : userDetailLines(user, view, width, true);
  }
  if (state.surface === "projects") {
    const named = state.overlays.find(
      (overlay): overlay is Extract<Overlay, { kind: "project-detail" }> =>
        overlay.kind === "project-detail",
    );
    const project =
      view.projects.find((candidate) => candidate.name === named?.project) ??
      view.projects[state.selection];
    return project === undefined ? undefined : projectDetailLines(project, view, width, true);
  }
  return undefined;
}

export interface InterfaceProps {
  readonly state: TuiState;
  readonly size: TuiSize;
  readonly view: TeamView;
  /** What is being typed into the setting editor, while one is open. */
  readonly draft?: string;
  /**
   * What the last thing somebody asked for did, drawn in place of the keys.
   *
   * It is not part of the state a snapshot is taken of: what an operation
   * reported is not a property of the screen it was asked from.
   */
  readonly status?: string;
}

export function Interface({ state, size, view, draft, status }: InterfaceProps): ReactNode {
  const frame = frameOf(size);
  const detail = frame.split ? detailLines(state, view, frame) : undefined;
  const windows = state.overlays
    .map((overlay) => overlayWindow(overlay, size, view, draft))
    .filter((spec): spec is WindowSpec => spec !== undefined);

  return (
    <Box width={size.columns} height={size.rows} flexDirection="column">
      <Block lines={[headerLine(view, size.columns)]} width={size.columns} rows={1} />
      {frame.wideRail ? null : (
        <Block lines={[railStrip(state.surface)]} width={size.columns} rows={1} />
      )}
      <Box flexGrow={1} flexShrink={0}>
        {frame.wideRail ? (
          <Block lines={railLines(state.surface)} width={RAIL_WIDTH} rows={frame.bodyHeight} />
        ) : null}
        <Box flexDirection="row" width={frame.bodyWidth} flexShrink={0}>
          <Block
            lines={listLines(state, view, frame)}
            width={primaryWidth(state.surface, frame)}
            rows={frame.bodyHeight}
          />
          {detail === undefined ? null : (
            <Box marginLeft={2} flexShrink={0}>
              <Block lines={detail} width={frame.detailWidth} rows={frame.bodyHeight} />
            </Box>
          )}
        </Box>
      </Box>
      <Block
        lines={[
          status === undefined
            ? footerLine(state, view, size.columns)
            : [{ text: ` ${ellipsis(status, size.columns - 1)}` }],
        ]}
        width={size.columns}
        rows={1}
      />
      {windows.map((spec, index) => (
        <Window key={index} spec={spec} />
      ))}
    </Box>
  );
}
