/**
 * Every panel the interface draws, as lines of styled text.
 *
 * A panel is built here and rendered somewhere else, so what it says can be
 * read without a terminal, and so that the number of lines it will occupy is
 * known before anything is drawn. Nothing in this file decides anything: it is
 * handed a view and it words it.
 */
import {
  ellipsis,
  fileSize,
  groupDigits,
  plural,
  relativeTime,
  shortDate,
  shortFingerprint,
  shortUptime,
  clockTime,
  uptime,
  UNKNOWN,
  withoutScheme,
  wrapText,
} from "./format.js";
import type { TeamView, ProjectView, UserView } from "../teamview.js";
import type { Surface, TuiState } from "./state.js";
import { SURFACES, SURFACE_NAMES } from "./state.js";
import { BLANK, span, type Line, type Span } from "./text.js";

/** Below this the header drops the part that is nice to have. */
const HEADER_WIDE_FROM = 90;

/** Below this a field's value is the short spelling of itself. */
const FIELD_WIDE_FROM = 90;

/** Below this a list drops the columns that are not the point of it. */
const LIST_WIDE_FROM = 62;

/** Below this the settings surface drops the notes beside a value. */
const SETTINGS_WIDE_FROM = 74;

/** How far a field's label is padded before its value. */
const FIELD_PAD = 13;

/* ---------------------------------------------------------------- chrome */

/** A section rule: the label, then a line to the right edge. */
export function section(label: string, width: number): Line {
  const rule = Math.max(0, width - label.length - 3);
  return span(` ${label} ${"─".repeat(rule)}`, { dim: true });
}

/** A labelled value, with the labels of a block lining up. */
export function field(label: string, value: string | Line, pad = FIELD_PAD): Line {
  const head: Span = { text: ` ${label.padEnd(pad, " ")}`, dim: true };
  return typeof value === "string" ? [head, { text: value }] : [head, ...value];
}

export function headerLine(view: TeamView, width: number): Line {
  const left = `nlteam ${view.teamVersion}`;
  // What this line carries is which Team you are looking at. It used to carry
  // loreserver's version and a green word for its health as well, and both
  // were already on the first line of the dashboard — the health twice over,
  // since the same check is what "running" is worked out from. A screen that
  // says a thing in two places has to be read twice to find out it said
  // nothing new.
  const right = view.root;
  const gap = Math.max(1, width - left.length - right.length - 2);
  const room = width - left.length - gap - 1;
  return [
    { text: " " + left, bold: true },
    { text: " ".repeat(gap) },
    { text: ellipsis(right, Math.max(0, room)), dim: true },
  ];
}

/**
 * The keys each surface answers to.
 *
 * Every one of them ends in the way out, because a person who cannot tell
 * where they are can at least tell how to leave.
 */
const KEYS: Readonly<Record<Surface, string>> = {
  dashboard: " 1-4 surface · n new project · c connection · l log · ? keys · q quit",
  users: " ↑↓ move · ⏎ open · DISABLE · x revoke tokens · q quit",
  projects: " ↑↓ move · ⏎ open · n new · l log · q quit",
  settings: " ↑↓ move · ⏎ change · l log · q quit  (· cannot be changed here)",
};

/**
 * The keys, with the one that changes meaning saying which it means.
 *
 * `d` toggles, and a footer that reads "disable" over an account already
 * disabled is telling the operator the opposite of what the key will do.
 */
export function footerLine(state: TuiState, view: TeamView, width: number): Line {
  let keys = KEYS[state.surface];
  if (state.surface === "users") {
    const user = view.users[state.selection];
    keys = keys.replace("DISABLE", user?.disabled === true ? "d enable" : "d disable");
  }
  return span(ellipsis(keys, width), { dim: true });
}

/** The rail down the left, one line per surface, each twelve columns wide. */
export function railLines(active: Surface): Line[] {
  return SURFACES.map((surface) =>
    span(` ${SURFACE_NAMES[surface].padEnd(11, " ")}`, {
      ...(surface === active ? { inverse: true, bold: true } : {}),
    }),
  );
}

/** The rail across the top, which is what a narrow terminal gets instead. */
export function railStrip(active: Surface): Line {
  return SURFACES.map((surface) => ({
    text: ` ${SURFACE_NAMES[surface]} `,
    ...(surface === active ? { inverse: true } : {}),
  }));
}

/* ------------------------------------------------------------- dashboard */

const QUICK: ReadonlyArray<readonly [string, string]> = [
  ["n", "new project"],
  ["c", "connection details"],
  ["l", "follow the log"],
  ["k", "rotate signing key"],
  ["R", "restart loreserver"],
];

function quickLines(width: number): Line[] {
  const columns = width >= 100 ? 3 : width >= 66 ? 2 : 1;
  const cell = Math.max(4, Math.floor((width - 1) / columns));
  const lines: Line[] = [];
  for (let index = 0; index < QUICK.length; index += columns) {
    const parts: Span[] = [{ text: " " }];
    for (const [key, what] of QUICK.slice(index, index + columns)) {
      parts.push({ text: key, bold: true, color: "cyan" });
      parts.push({ text: ` ${what}`.padEnd(cell - 1, " ") });
    }
    lines.push(parts);
  }
  return lines;
}

/** One decision out of the log, as one line. */
function auditLine(entry: TeamView["audit"][number], width: number): Line {
  const verdict = `${entry.allowed ? "allowed" : "refused"} (${entry.detail})`;
  const text = ` ${clockTime(entry.at)}  ${entry.username.padEnd(5, " ")} ${entry.resource.padEnd(
    11,
    " ",
  )} ${verdict}`;
  return span(ellipsis(text, width), entry.allowed ? { dim: true } : { color: "red" });
}

/** The log, newest first, which is the order somebody looking for a refusal reads in. */
function newestFirst(view: TeamView): TeamView["audit"] {
  return [...view.audit].sort((left, right) => right.at - left.at);
}

/** When anybody last pushed to any project. */
function lastPush(view: TeamView): string {
  const times = view.projects
    .map((project) => project.history.lastAt)
    .filter((at): at is number => at !== undefined);
  if (times.length === 0) {
    return view.projects.every((project) => project.history.revisions === 0) ? "never" : UNKNOWN;

  }
  return relativeTime(Math.max(...times), view.now);
}

/** What the projects add up to, counting only the ones Team has a size for. */
function projectBytes(view: TeamView): number | undefined {
  const sizes = view.projects
    .map((project) => project.history.bytes)
    .filter((bytes): bytes is number => bytes !== undefined);
  return sizes.length === 0 ? undefined : sizes.reduce((total, bytes) => total + bytes, 0);
}

/**
 * The line that answers "is it working", and it is loud only when the answer
 * is no.
 *
 * There is no separate health row because there was never a second fact in it:
 * the gatherer works `running` out from whether the health check answered, so
 * a screen carrying both said the same thing twice — and a word that says
 * "fine" on every screen is one the reader stops seeing, which is exactly the
 * word you need them to notice on the day it changes.
 */
function serverLine(view: TeamView, wide: boolean): Line {
  const { server } = view;
  const parts: Span[] = [{ text: " " + "loreserver".padEnd(FIELD_PAD, " "), dim: true }];

  if (!server.running) {
    parts.push({ text: server.version + "  " });
    parts.push({ text: "not running", color: "red", bold: true });
    const checked = relativeTime(server.healthCheckedAt, view.now);
    parts.push({ text: `  no answer on the health check, ${checked}`, dim: true });
    return parts;
  }

  const said = [`${server.version}  running`];
  if (wide && server.pid !== undefined) {
    said.push(`pid ${server.pid}`);
  }
  if (server.startedAt !== undefined) {
    const since = view.now - server.startedAt;
    said.push(`up ${wide ? uptime(since) : shortUptime(since)}`);
  }
  if (wide && server.startedAt !== undefined && server.restarts > 0) {
    // Nought restarts is the ordinary case and saying it fills a screen with a
    // number nobody is looking for. A restart is worth reading about.
    said.push(plural(server.restarts, "restart"));
  }
  parts.push({ text: said.join("  ") });
  return parts;
}

/**
 * The loopback ports, which are worth knowing are not reachable.
 *
 * Each keeps its name at every width. Three bare numbers fit more easily and
 * tell a reader nothing they can act on, and the row has room for the words on
 * the narrowest terminal this interface supports.
 */
function loopbackValue(view: TeamView): string {
  return view.reach.loopback
    .map((listener) => `${listener.port} ${listener.what}`)
    .join("   ");
}

export function dashboardLines(view: TeamView, width: number, height: number): Line[] {
  const wide = width >= FIELD_WIDE_FROM;
  const { server, reach } = view;
  const disabled = view.users.filter((user) => user.disabled).length;

  // No headings over these groups. "server", "at a glance", "quick" and
  // "recent" told a reader nothing they could not see, and four rules across
  // an eighty-column screen cost four of its twenty-four rows to say it. A
  // blank line separates a group; the labels down the left name the facts.
  const lines: Line[] = [
    serverLine(view, wide),

    BLANK,
    field("data", wide ? reach.data : withoutScheme(reach.data)),
    field("sign-in", wide ? reach.signIn : withoutScheme(reach.signIn)),
    field("authority", shortFingerprint(reach.fingerprint)),
    field("loopback", span(loopbackValue(view), { dim: true })),
    field(
      "storage",
      wide
        ? `${fileSize(server.storageBytes)}   ${plural(view.projects.length, "repository", "repositories")}`
        : `${fileSize(server.storageBytes)}   ${view.projects.length} repos`,
    ),

    BLANK,
    field("accounts", `${view.users.length}    ${disabled} disabled`),
    field("projects", `${view.projects.length}    last push ${lastPush(view)}`),

    BLANK,
    ...quickLines(width),

    BLANK,
  ];

  // Whatever is left over goes to the log, and it is the only part that
  // shrinks: an operator who cannot see the state of the server has lost the
  // point of the screen, and one who can see two decisions instead of six has
  // not.
  const room = Math.max(0, height - lines.length);
  const recent = newestFirst(view).slice(0, room);
  if (recent.length === 0 && room > 0) {
    lines.push(span("  nothing has been asked of this server yet", { dim: true }));
    return lines;
  }
  return [...lines, ...recent.map((entry) => auditLine(entry, width))];
}

/* ----------------------------------------------------------------- users */

function userState(user: UserView): string {
  return user.disabled ? "disabled" : "active";
}

/** The columns of the account list, in one place so the header cannot drift. */
const WHO = 19;
const DISPLAY_NAME = 16;
const ROLE = 8;

export function userListHeader(width: number): Line {
  const wide = width >= LIST_WIDE_FROM;
  return span(
    wide
      ? ` ${"who".padEnd(WHO, " ")} ${"name".padEnd(DISPLAY_NAME, " ")} ${"role".padEnd(ROLE, " ")} last seen`
      : ` ${"who".padEnd(WHO, " ")} ${"role".padEnd(ROLE, " ")} last seen`,
    { dim: true },
  );
}

export function userRow(user: UserView, view: TeamView, width: number, selected: boolean): Line {
  const wide = width >= LIST_WIDE_FROM;
  const seen = relativeTime(user.lastSeenAt, view.now);
  // Disabled goes beside the name rather than in a column of its own: it is
  // the only state there is, so a column headed "state" spent its width saying
  // "active" about almost every row.
  const who = user.disabled ? `${user.username} (disabled)` : user.username;
  const text = wide
    ? ` ${who.padEnd(WHO, " ")} ${user.displayName.padEnd(DISPLAY_NAME, " ")} ${user.role.padEnd(
        ROLE,
        " ",
      )} ${seen}`
    : ` ${who.padEnd(WHO, " ")} ${user.role.padEnd(ROLE, " ")} ${seen}`;
  return span(ellipsis(text, width).padEnd(width, " "), {
    ...(selected ? { inverse: true } : {}),
    ...(user.disabled ? { color: "red" } : {}),
  });
}

export function userDetailLines(
  user: UserView,
  view: TeamView,
  width: number,
  heading: boolean,
): Line[] {
  const named = user.email === undefined ? user.displayName : `${user.displayName} · ${user.email}`;
  const lines: Line[] = [];
  if (heading) {
    lines.push(span(user.username, { bold: true }));
  }
  lines.push(span(` ${named}`, { dim: true }));
  lines.push(BLANK);
  lines.push([
    { text: " state    ", dim: true },
    { text: userState(user), color: user.disabled ? "red" : "green" },
    ...(user.serviceAccount ? [{ text: " · service account", dim: true }] : []),
  ]);
  lines.push(field("role", user.role, 9));
  lines.push(field("joined", shortDate(user.createdAt), 9));
  lines.push(field("seen", relativeTime(user.lastSeenAt, view.now), 9));
  lines.push(
    field(
      "tokens",
      user.tokensInvalidatedAt === undefined
        ? UNKNOWN
        : `last invalidated ${relativeTime(user.tokensInvalidatedAt, view.now)}`,
      9,
    ),
  );
  return lines;
}

/* -------------------------------------------------------------- projects */

/**
 * A project's size, and when it was last touched.
 *
 * A project with no revisions has neither, and that is not the same as Team
 * failing to work them out: a dash is nothing, the word unknown is a gap.
 */
function projectSize(project: ProjectView): string {
  if (project.history.bytes !== undefined) {
    return fileSize(project.history.bytes);
  }
  return project.history.revisions === 0 ? "—" : UNKNOWN;
}

/** The revision count, or a mark for a count nobody has taken. */
function revisionCount(project: ProjectView): string {
  return project.history.revisions === undefined ? "?" : String(project.history.revisions);
}

function projectLast(project: ProjectView, view: TeamView): string {
  if (project.history.lastAt !== undefined) {
    return relativeTime(project.history.lastAt, view.now);
  }
  return project.history.revisions === 0 ? "never" : UNKNOWN;
}

/** The columns of the project list, in one place so the header cannot drift. */
const PROJECT_NAME = 13;
const OWNER = 7;

export function projectListHeader(width: number): Line {
  const wide = width >= LIST_WIDE_FROM;
  return span(
    wide
      ? ` ${"name".padEnd(PROJECT_NAME, " ")} ${"made by".padEnd(OWNER, " ")} ${"revs".padStart(5, " ")}   ${"size".padEnd(9, " ")} last activity`
      : ` ${"name".padEnd(PROJECT_NAME, " ")} ${"revs".padStart(4, " ")}   size`,
    { dim: true },
  );
}

export function projectRow(
  project: ProjectView,
  view: TeamView,
  width: number,
  selected: boolean,
): Line {
  const wide = width >= LIST_WIDE_FROM;
  const revisions = revisionCount(project);
  const text = wide
    ? ` ${project.name.padEnd(PROJECT_NAME, " ")} ${project.owner.padEnd(OWNER, " ")} ${revisions.padStart(
        5,
        " ",
      )}   ${projectSize(project).padEnd(9, " ")} ${projectLast(project, view)}`
    : ` ${project.name.padEnd(PROJECT_NAME, " ")} ${revisions.padStart(4, " ")}   ${projectSize(project)}`;
  return span(ellipsis(text, width).padEnd(width, " "), selected ? { inverse: true } : {});
}

/** What the revision history says, which does not depend on Studio at all. */
function historyLines(project: ProjectView, view: TeamView, width: number): Line[] {
  const { history } = project;
  const parts = [
    history.revisions === undefined ? UNKNOWN : plural(history.revisions, "revision"),
  ];
  if (history.branch !== undefined) {
    parts.push(history.branch);
  }
  if (history.bytes !== undefined) {
    parts.push(fileSize(history.bytes));
  }
  const lines: Line[] = [[{ text: " T0  ", dim: true }, { text: parts.join(" · ") }]];
  if (history.lastAt === undefined) {
    lines.push(
      span(`     ${history.revisions === 0 ? "nothing pushed yet" : UNKNOWN}`, { dim: true }),
    );
    return lines;
  }
  const who = history.lastBy ?? UNKNOWN;
  const message = history.lastMessage ?? "";
  lines.push(
    span(
      ellipsis(`     ${relativeTime(history.lastAt, view.now)}  ${who}  ${message}`.trimEnd(), width),
      { dim: true },
    ),
  );
  return lines;
}

/** What the project file says, or the word unknown and the reason for it. */
function fileLines(project: ProjectView, width: number): Line[] {
  const { file } = project;
  if (!file.readable) {
    return [
      [
        { text: " T1  ", dim: true },
        { text: UNKNOWN, color: "yellow" },
      ],
      ...(file.reason === undefined
        ? []
        : wrapText(file.reason, Math.max(1, width - 5)).map((text) =>
            span(`     ${text}`, { dim: true }),
          )),
    ];
  }
  const stage =
    file.stageWidth === undefined || file.stageHeight === undefined
      ? UNKNOWN
      : `${file.stageWidth}×${file.stageHeight}`;
  const lines: Line[] = [
    [
      { text: " T1  ", dim: true },
      { text: `${file.title ?? UNKNOWN} · ${stage}` },
    ],
    span(
      `     ${plural(file.scenes ?? 0, "scene")} · ${
        file.assets === undefined ? UNKNOWN : plural(file.assets, "asset")
      } · ${fileSize(file.assetBytes)}`,
      { dim: true },
    ),
  ];
  const kinds = file.assetsByKind ?? [];
  if (kinds.length > 0) {
    lines.push(
      span(
        ellipsis(
          `     ${kinds.map((kind) => `${kind.kind} ${groupDigits(kind.count)}`).join(" · ")}`,
          width,
        ),
        { dim: true },
      ),
    );
  }
  return lines;
}

export function projectDetailLines(
  project: ProjectView,
  view: TeamView,
  width: number,
  heading: boolean,
): Line[] {
  const lines: Line[] = [];
  if (heading) {
    lines.push(span(project.name, { bold: true }));
  }
  lines.push(
    span(` owned by ${project.owner} · created ${shortDate(project.createdAt)}`, { dim: true }),
  );
  if (project.description !== "") {
    lines.push(span(ellipsis(` ${project.description}`, width), { dim: true }));
  }
  lines.push(BLANK);
  lines.push(...historyLines(project, view, width));
  lines.push(BLANK);
  lines.push(...fileLines(project, width));
  return lines;
}

/* -------------------------------------------------------------- settings */

/**
 * The settings surface, and where each row ended up.
 *
 * The rows come back with their line numbers because the surface scrolls to
 * the selected one, and a group heading is a line that belongs to no row.
 */
export function settingsLines(
  view: TeamView,
  width: number,
  selection: number,
): { lines: Line[]; rowLines: number[] } {
  const wide = width >= SETTINGS_WIDE_FROM;
  const lines: Line[] = [];
  const rowLines: number[] = [];
  let group = "";
  for (const [index, setting] of view.settings.entries()) {
    if (setting.group !== group) {
      group = setting.group;
      if (lines.length > 0) {
        lines.push(BLANK);
      }
      lines.push(section(group, width));
    }
    // The mark in the first column is the whole of what says a row cannot be
    // changed here; the footer says what the mark means.
    const lock = setting.editable ? " " : "·";
    const note = wide && setting.restartRequired === true ? "   (restart)" : "";
    const label = setting.label.padEnd(wide ? 19 : 17, " ");
    rowLines.push(lines.length);
    lines.push(
      span(ellipsis(` ${lock} ${label} ${setting.value}${note}`, width).padEnd(width, " "), {
        ...(index === selection ? { inverse: true } : {}),
      }),
    );
  }
  return { lines, rowLines };
}

/**
 * Scroll a block so that one line of it is on screen.
 *
 * It scrolls no further than it has to, so that a surface which fits does not
 * move when the selection does.
 */
export function scrollTo(lines: readonly Line[], height: number, focus: number): Line[] {
  if (lines.length <= height) {
    return [...lines];
  }
  const first = Math.min(Math.max(0, focus - height + 2), lines.length - height);
  return lines.slice(first, first + height);
}
