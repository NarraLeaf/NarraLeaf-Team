/**
 * The five surfaces, drawn from one view.
 *
 * Every screen here is a function of the {@link TeamView} it is handed and the
 * draft state of this browser, and of nothing else. It reads no clock — the
 * moment a view was gathered travels inside it, so "2h ago" means two hours
 * before the server looked, not two hours before this tab drew — and it works
 * nothing out that the server did not already say.
 *
 * What is absent is drawn as the word unknown, which is the whole of the
 * degradation rule the view type sets out: a project written by a newer Studio
 * shows the parts Team understands and says unknown for the rest. It is never
 * an error and never a blank cell, because a blank cell means nothing twice.
 *
 * There is no text written in this file. Every word on screen comes from the
 * catalogue the draft's locale names, and is passed down as `m` rather than
 * read from anywhere: a screen is still a function of the view it is handed and
 * this browser's draft, and the language is part of the draft.
 */
import { describeDuration } from "../../duration.js";
import { everyLanguage, messagesFor } from "../../i18n/index.js";
import type { Locale } from "../../i18n/locales.js";
import type { Messages } from "../../i18n/messages.js";
import {
  fileSize,
  groupDigits,
  relativeTime,
  shortDate,
  shortFingerprint,
  withoutScheme,
} from "../../tui/format.js";
import type { Action } from "../../tui/state.js";
import type {
  AuditView,
  ProjectView,
  SettingView,
  TeamView,
  UserView,
} from "../../teamview.js";
import type { Draft, Operator, Screen, Secret } from "./api.js";
import { group, h, icon, type Child } from "./dom.js";

/** Everything a screen can ask the page to do. */
export interface Handlers {
  readonly perform: (action: Action) => void;
  readonly go: (screen: Screen) => void;
  readonly setField: (key: string, value: string) => void;
  readonly toggle: (key: string) => void;
  readonly dismiss: () => void;
  readonly signOut: () => void;
  readonly setLocale: (locale: Locale) => void;
}

/** The rail, in the order it is read. */
function railScreens(m: Messages): ReadonlyArray<{ screen: Screen; label: string }> {
  return [
    { screen: "overview", label: m.page.nav.overview },
    { screen: "projects", label: m.page.nav.projects },
    { screen: "members", label: m.page.nav.members },
    { screen: "decisions", label: m.page.nav.decisions },
    { screen: "settings", label: m.page.nav.settings },
  ];
}

/** How many decisions the overview shows before it stops being an overview. */
const RECENT_DECISIONS = 6;

/**
 * The label the repository lifetime arrives under.
 *
 * The same string src/view.ts sends, which is how a row is found on the way
 * back as well. Written here rather than imported because that module opens a
 * database, and nothing in a browser may.
 */
const REPOSITORY_ROW = "repository token";

/** A label above a value, which is how nearly everything here is written. */
function field(label: string, value: Child, options: { mono?: boolean; title?: string } = {}): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-label" }, label),
    h(
      "div",
      { class: options.mono === true ? "field-value mono" : "field-value", ...(options.title === undefined ? {} : { title: options.title }) },
      value,
    ),
  );
}

/** A titled box. Everything on a screen is in one of these or is a table. */
function card(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "card" }, h("h2", { class: "card-title" }, title), ...children);
}

/** A word with a coloured dot in front of it. The only status vocabulary here. */
function state(kind: "good" | "bad" | "idle", word: string): HTMLElement {
  return h("span", { class: `state is-${kind}` }, h("span", { class: "dot" }), word);
}

function button(
  label: string,
  onClick: () => void,
  options: { variant?: "primary" | "danger"; disabled?: boolean } = {},
): HTMLElement {
  const variant = options.variant === undefined ? "" : ` is-${options.variant}`;
  return h(
    "button",
    {
      class: `button${variant}`,
      type: "button",
      ...(options.disabled === true ? { disabled: true } : {}),
      onClick: () => onClick(),
    },
    label,
  );
}

function textField(
  draft: Draft,
  handlers: Handlers,
  key: string,
  placeholder: string,
  fallback = "",
): HTMLElement {
  return h("input", {
    class: "input",
    type: "text",
    placeholder,
    focusKey: key,
    value: draft.fields.get(key) ?? fallback,
    autocomplete: "off",
    onInput: (value) => handlers.setField(key, value),
  });
}

/**
 * A field for a password, which differs from the one above in two ways.
 *
 * What is typed is not shown, and the browser is told this is a password being
 * chosen rather than one it has saved, so it does not offer to fill in the
 * operator's own. It is held in the draft exactly like every other field —
 * a redraw would otherwise empty it under somebody halfway through typing —
 * and main.ts drops it the moment the account exists.
 */
function secretField(
  draft: Draft,
  handlers: Handlers,
  key: string,
  placeholder: string,
): HTMLElement {
  return h("input", {
    class: "input",
    type: "password",
    placeholder,
    focusKey: key,
    value: draft.fields.get(key) ?? "",
    autocomplete: "new-password",
    onInput: (value) => handlers.setField(key, value),
  });
}

/**
 * A box to tick, whose state is this browser's like every other draft value.
 *
 * It sits in the same set as the disclosures because it is the same kind of
 * thing — a boolean this page holds and the server is never told about — and a
 * second store for one checkbox would be a second thing to clear.
 */
function checkbox(
  draft: Draft,
  handlers: Handlers,
  key: string,
  label: string,
): HTMLElement {
  return h(
    "label",
    { class: "check" },
    h("input", {
      type: "checkbox",
      focusKey: key,
      checked: draft.expanded.has(key),
      onToggle: () => handlers.toggle(key),
    }),
    label,
  );
}

function chooser(
  draft: Draft,
  handlers: Handlers,
  key: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  fallback: string,
): HTMLElement {
  const chosen = draft.fields.get(key) ?? fallback;
  return h(
    "select",
    {
      class: "select",
      focusKey: key,
      onChange: (value) => handlers.setField(key, value),
    },
    ...options.map((option) =>
      h("option", { value: option.value, selected: option.value === chosen }, option.label),
    ),
  );
}

/** The value of a field, as it stands. */
function fieldValue(draft: Draft, key: string, fallback = ""): string {
  return (draft.fields.get(key) ?? fallback).trim();
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function statistic(value: string, label: string): HTMLElement {
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "stat-value" }, value),
    h("div", { class: "stat-label" }, label),
  );
}

function overview(view: TeamView, handlers: Handlers, m: Messages): HTMLElement {
  const { server, reach } = view;
  const words = m.page.overview;
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "stats" },
      statistic(groupDigits(view.projects.length), words.projects),
      statistic(groupDigits(view.users.length), words.members),
      statistic(groupDigits(view.signingKeys), words.signingKeys),
    ),
    h(
      "div",
      { class: "columns" },
      card(
        // The name of a program, which is the same word everywhere.
        "loreserver",
        h(
          "div",
          { class: "fields" },
          field(
            words.state,
            server.healthy
              ? state("good", words.healthy)
              : state("bad", words.notAnswering),
          ),
          field(words.version, server.version, { mono: true }),
          field(words.checked, relativeTime(server.healthCheckedAt, view.now, m)),
          field(words.storage, fileSize(server.storageBytes, m)),
          field(words.storageRoot, server.storageRoot, { mono: true, title: server.storageRoot }),
        ),
      ),
      card(
        words.reach,
        h(
          "div",
          { class: "fields" },
          field(words.signInAt, withoutScheme(reach.signIn), { mono: true, title: reach.signIn }),
          field(words.data, withoutScheme(reach.data), { mono: true, title: reach.data }),
          field(words.authority, shortFingerprint(reach.fingerprint), {
            mono: true,
            title: reach.fingerprint,
          }),
          field(
            words.loopback,
            // `what` names the service on that port — health, jwks, authz — and
            // is left as it is: they are the names in the configuration and in
            // the documentation, not words on a screen.
            reach.loopback.map((port) => `${port.port} ${port.what}`).join(", "),
            { mono: true },
          ),
        ),
      ),
    ),
    card(
      words.recentDecisions,
      view.audit.length === 0
        ? h("p", { class: "empty" }, m.page.decisions.empty)
        : group(
            decisionTable(view.audit.slice(0, RECENT_DECISIONS), view.now, m),
            view.audit.length > RECENT_DECISIONS &&
              h(
                "div",
                { class: "card-foot" },
                h(
                  "button",
                  { class: "link", type: "button", onClick: () => handlers.go("decisions") },
                  words.allDecisions,
                ),
              ),
          ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function projectFile(project: ProjectView, m: Messages): HTMLElement {
  const { file } = project;
  const words = m.page.projects;
  const unknown = m.format.unknown;
  if (!file.readable) {
    // The reason is a sentence the server wrote about a repository it could not
    // read, in English. It is left alone: it names files and errors, and a
    // guessed translation of one would be a worse thing to search for.
    return h("div", { class: "fields" }, field(words.projectFile, file.reason ?? unknown));
  }
  return h(
    "div",
    { class: "fields" },
    field(words.title, file.title ?? unknown),
    field(
      words.stage,
      file.stageWidth === undefined || file.stageHeight === undefined
        ? unknown
        : `${file.stageWidth} × ${file.stageHeight}`,
    ),
    field(words.scenes, file.scenes === undefined ? unknown : groupDigits(file.scenes)),
    field(
      words.assets,
      file.assets === undefined
        ? unknown
        : `${groupDigits(file.assets)}, ${fileSize(file.assetBytes, m)}`,
    ),
    ...(file.assetsByKind ?? []).map((kind) =>
      field(kind.kind, `${groupDigits(kind.count)}, ${fileSize(kind.bytes, m)}`),
    ),
  );
}

function projectCard(
  project: ProjectView,
  view: TeamView,
  draft: Draft,
  handlers: Handlers,
  m: Messages,
): HTMLElement {
  const key = `project:${project.name}`;
  const open = draft.expanded.has(key);
  const { history } = project;
  const words = m.page.projects;

  const head = h(
    "button",
    { class: "disclosure", type: "button", onClick: () => handlers.toggle(key) },
    h("span", { class: `caret${open ? " is-open" : ""}` }),
    h("span", { class: "disclosure-name" }, project.name),
    h("span", { class: "disclosure-note" }, project.owner),
    h(
      "span",
      { class: "disclosure-note" },
      history.revisions === undefined
        ? m.format.unknown
        : words.revisionCount(groupDigits(history.revisions)),
    ),
    h(
      "span",
      { class: "disclosure-note" },
      relativeTime(history.lastAt ?? project.createdAt, view.now, m),
    ),
  );

  if (!open) {
    return h("section", { class: "card is-collapsed" }, head);
  }

  return h(
    "section",
    { class: "card" },
    head,
    h(
      "div",
      { class: "disclosure-body" },
      project.description !== "" && h("p", { class: "prose" }, project.description),
      h(
        "div",
        { class: "columns" },
        h(
          "div",
          { class: "fields" },
          field(words.owner, project.owner, { mono: true }),
          field(words.created, shortDate(project.createdAt, m)),
          field(words.branch, history.branch ?? m.format.unknown, { mono: true }),
          field(
            words.revisions,
            history.revisions === undefined ? m.format.unknown : groupDigits(history.revisions),
          ),
          field(words.repository, fileSize(history.bytes, m)),
          field(
            words.lastRevision,
            history.lastAt === undefined
              ? m.format.unknown
              : `${relativeTime(history.lastAt, view.now, m)}, ${history.lastBy ?? m.format.unknown}`,
          ),
          field(words.message, history.lastMessage ?? m.format.unknown),
        ),
        projectFile(project, m),
      ),
    ),
  );
}

function projects(view: TeamView, draft: Draft, handlers: Handlers, m: Messages): HTMLElement {
  const open = draft.expanded.has("new-project");
  const words = m.page.projects;
  const owners = view.users
    .filter((user) => !user.disabled)
    .map((user) => ({ value: user.username, label: user.username }));

  return h(
    "div",
    { class: "stack" },
    open &&
      h(
        "div",
        { class: "form is-standalone" },
        textField(draft, handlers, "new-project-name", words.name),
        owners.length > 0 && chooser(draft, handlers, "new-project-owner", owners, owners[0]?.value ?? ""),
        button(
          words.create,
          () => {
            const name = fieldValue(draft, "new-project-name");
            const owner = fieldValue(draft, "new-project-owner", owners[0]?.value ?? "");
            if (name === "" || owner === "") {
              return;
            }
            handlers.perform({ kind: "create-project", name, owner });
          },
          { variant: "primary", disabled: draft.busy },
        ),
        button(words.cancel, () => handlers.toggle("new-project")),
      ),
    view.projects.length === 0
      ? h("p", { class: "empty" }, words.empty)
      : group(...view.projects.map((project) => projectCard(project, view, draft, handlers, m))),
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** What is being made on this screen, by the key each field is held under. */
const NEW_ACCOUNT = "new-account";
const ACCOUNT_FIELDS = [
  "new-account-username",
  "new-account-display-name",
  "new-account-email",
  "new-account-password",
] as const;

/** The tick that decides which group a new account joins. */
const ACCOUNT_OPERATOR = "new-account-operator";

/**
 * A token, once, and nothing that survives leaving this screen.
 *
 * It is drawn where it was asked for rather than in the notice bar every other
 * answer uses, because it is not a sentence about what happened: it is the
 * thing itself, and somebody has to be able to select it. The server keeps no
 * copy, which the line under it says, so a person who missed it asks again.
 */
function issuedToken(secret: Secret, handlers: Handlers, m: Messages): HTMLElement {
  const words = m.page.members;
  return card(
    words.tokenFor({ username: secret.username }),
    h("div", { class: "token mono" }, secret.token),
    h("p", { class: "caution" }, words.tokenShownOnce),
    h("div", { class: "card-foot" }, button(words.done, () => handlers.dismiss())),
  );
}

/** The form that makes an account, which is the one `nlteam user create` makes. */
function newAccount(draft: Draft, handlers: Handlers, m: Messages): HTMLElement {
  const words = m.page.members;
  const [username, displayName, email, password] = ACCOUNT_FIELDS;
  return h(
    "div",
    { class: "form is-standalone" },
    textField(draft, handlers, username, words.username),
    textField(draft, handlers, displayName, words.displayName),
    textField(draft, handlers, email, words.email),
    secretField(draft, handlers, password, words.password),
    checkbox(draft, handlers, ACCOUNT_OPERATOR, words.operator),
    button(
      words.create,
      () => {
        const name = fieldValue(draft, username);
        // Not trimmed: spaces at either end are characters of a password, and
        // one shortened here would not be the password anywhere else.
        const secret = draft.fields.get(password) ?? "";
        if (name === "" || secret === "") {
          return;
        }
        const chosen = fieldValue(draft, displayName);
        const address = fieldValue(draft, email);
        handlers.perform({
          kind: "create-account",
          username: name,
          password: secret,
          ...(chosen === "" ? {} : { displayName: chosen }),
          ...(address === "" ? {} : { email: address }),
          operator: draft.expanded.has(ACCOUNT_OPERATOR),
        });
      },
      { variant: "primary", disabled: draft.busy },
    ),
    button(words.cancel, () => handlers.toggle(NEW_ACCOUNT)),
  );
}

function memberRow(
  user: UserView,
  draft: Draft,
  handlers: Handlers,
  m: Messages,
): HTMLElement {
  const words = m.page.members;
  return h(
    "tr",
    {},
    h(
      "td",
      {},
      h("div", { class: "cell-name mono" }, user.username),
      user.displayName !== user.username && h("div", { class: "cell-note" }, user.displayName),
    ),
    // The groups an account is in, as the database holds them. Not translated:
    // `admin` is what the server compares, and it is the whole of what a group
    // decides here — every account reaches every project either way.
    h("td", {}, user.role),
    h("td", {}, shortDate(user.createdAt, m)),
    h(
      "td",
      {},
      user.disabled
        ? state("bad", words.disabled)
        : user.serviceAccount
          ? state("idle", words.serviceAccount)
          : state("good", words.active),
    ),
    h(
      "td",
      { class: "cell-actions" },
      button(user.disabled ? words.enable : words.disable, () =>
        handlers.perform({
          kind: "set-user-disabled",
          username: user.username,
          disabled: !user.disabled,
        }),
        user.disabled ? {} : { variant: "danger" },
      ),
      button(words.revokeTokens, () =>
        handlers.perform({ kind: "revoke-tokens", username: user.username }),
      ),
      // Not offered for an account that has been disabled: nothing new is
      // issued for one, and a button that answered with that refusal every
      // time would be a button that never works.
      button(
        words.issueToken,
        () => handlers.perform({ kind: "issue-token", username: user.username }),
        { disabled: draft.busy || user.disabled },
      ),
    ),
  );
}

function members(view: TeamView, draft: Draft, handlers: Handlers, m: Messages): HTMLElement {
  const words = m.page.members;
  return h(
    "div",
    { class: "stack" },
    draft.secret !== undefined && issuedToken(draft.secret, handlers, m),
    draft.expanded.has(NEW_ACCOUNT) && newAccount(draft, handlers, m),
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, words.account),
          h("th", {}, words.role),
          h("th", {}, words.added),
          h("th", {}, words.state),
          h("th", {}, ""),
        ),
      ),
      h("tbody", {}, ...view.users.map((user) => memberRow(user, draft, handlers, m))),
    ),
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function decisionTable(
  decisions: readonly AuditView[],
  now: number,
  m: Messages,
): HTMLElement {
  const words = m.page.decisions;
  return h(
    "table",
    { class: "table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, words.when),
        h("th", {}, words.account),
        h("th", {}, words.resource),
        h("th", {}, words.answer),
        h("th", {}, words.detail),
      ),
    ),
    h(
      "tbody",
      {},
      ...decisions.map((decision) =>
        h(
          "tr",
          {},
          h("td", { title: shortDate(decision.at, m) }, relativeTime(decision.at, now, m)),
          h("td", { class: "mono" }, decision.username),
          h("td", { class: "mono" }, decision.resource),
          h("td", {}, decision.allowed ? state("good", words.allowed) : state("bad", words.refused)),
          // What the authorization service wrote down when it answered. It is a
          // record rather than a sentence to a person, and it is shown as it was
          // recorded — a translated audit trail would not match the log beside it.
          h("td", { class: "cell-detail" }, decision.detail),
        ),
      ),
    ),
  );
}

function decisions(view: TeamView, m: Messages): HTMLElement {
  if (view.audit.length === 0) {
    return h("p", { class: "empty" }, m.page.decisions.empty);
  }
  return decisionTable(view.audit, view.now, m);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * A row's name and its value, in this language where there is one.
 *
 * A row Team added and nobody has translated is drawn as the server sent it,
 * which is the same rule as everywhere else here: what arrived, rather than a
 * blank or a key.
 */
function settingWords(
  row: SettingView,
  m: Messages,
): { readonly label: string; readonly value: string } {
  return {
    label: m.page.settings.rowNames[row.label] ?? row.label,
    // Only the two lifetimes carry the number they were written from, and they
    // are the only rows whose value is words rather than a name, an address or
    // a number.
    value: row.seconds === undefined ? row.value : describeDuration(row.seconds, m),
  };
}

function settingRow(
  row: SettingView,
  index: number,
  draft: Draft,
  handlers: Handlers,
  m: Messages,
): HTMLElement {
  const key = `setting:${index}`;
  const editing = draft.expanded.has(key);
  const { label, value } = settingWords(row, m);
  const words = m.page.settings;

  if (!row.editable) {
    return h(
      "div",
      { class: "row" },
      h("span", { class: "row-name" }, label),
      h("span", { class: "row-value mono", title: value }, value),
    );
  }

  if (!editing) {
    return h(
      "div",
      { class: "row" },
      h("span", { class: "row-name" }, label),
      h("span", { class: "row-value" }, value),
      h("span", { class: "row-actions" }, button(words.change, () => handlers.toggle(key))),
    );
  }

  return h(
    "div",
    { class: "row is-editing" },
    h("span", { class: "row-name" }, label),
    h(
      "span",
      { class: "row-edit" },
      // The editor opens on the words being read — "30 天" as readily as
      // "30 days" — and the server accepts back whichever of them it sent.
      textField(draft, handlers, key, value, value),
      button(
        words.save,
        () => {
          const written = fieldValue(draft, key, value);
          if (written === "") {
            return;
          }
          handlers.toggle(key);
          handlers.perform({ kind: "set-setting", index, value: written });
        },
        { variant: "primary", disabled: draft.busy },
      ),
      button(words.cancel, () => handlers.toggle(key)),
      // One row carries a caution today and this language has it written out.
      // A row that grows one later shows the English the view carries, until
      // somebody translates that one too.
      row.caution !== undefined &&
        h(
          "span",
          { class: "caution" },
          row.label === REPOSITORY_ROW ? words.repositoryCaution : row.caution,
        ),
    ),
  );
}

function settings(view: TeamView, draft: Draft, handlers: Handlers, m: Messages): HTMLElement {
  const groups: string[] = [];
  for (const row of view.settings) {
    if (!groups.includes(row.group)) {
      groups.push(row.group);
    }
  }

  return h(
    "div",
    { class: "stack" },
    ...groups.map((name) =>
      card(
        m.page.settings.groupNames[name] ?? name,
        h(
          "div",
          { class: "rows" },
          ...view.settings
            .map((row, index) => ({ row, index }))
            .filter((entry) => entry.row.group === name)
            .map((entry) => settingRow(entry.row, entry.index, draft, handlers, m)),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** What the header offers, which is different on every screen. */
function headerActions(
  view: TeamView,
  draft: Draft,
  handlers: Handlers,
  m: Messages,
): Child[] {
  switch (draft.screen) {
    case "projects":
      return [
        button(m.page.projects.newProject, () => handlers.toggle("new-project"), {
          variant: "primary",
          disabled: draft.busy || view.users.length === 0,
        }),
      ];
    case "members":
      return [
        button(m.page.members.newAccount, () => handlers.toggle(NEW_ACCOUNT), {
          variant: "primary",
          disabled: draft.busy,
        }),
      ];
    case "settings":
      return [
        button(m.page.settings.rotateKey, () => handlers.perform({ kind: "rotate-key" }), {
          disabled: draft.busy,
        }),
      ];
    default:
      return [];
  }
}

function title(screen: Screen, m: Messages): string {
  return railScreens(m).find((entry) => entry.screen === screen)?.label ?? m.page.nav.overview;
}

function body(view: TeamView, draft: Draft, handlers: Handlers, m: Messages): HTMLElement {
  switch (draft.screen) {
    case "overview":
      return overview(view, handlers, m);
    case "projects":
      return projects(view, draft, handlers, m);
    case "members":
      return members(view, draft, handlers, m);
    case "decisions":
      return decisions(view, m);
    case "settings":
      return settings(view, draft, handlers, m);
  }
}

/**
 * The languages, behind a button that opens them.
 *
 * One of these, drawn in two places — the top bar and the sign-in page — because
 * they are the same control and a second copy of it would be a second set of
 * rules about what closes it.
 *
 * The button is labelled with the language now in use rather than with the word
 * "Language", so what is on screen is a fact about this page rather than an
 * invitation, and somebody who opened the wrong language can see which one they
 * are in without opening anything. Every entry inside is written in itself: a
 * person looking for their own language is looking for a word they can read.
 *
 * Whether it is open is draft state like any other disclosure here, which is
 * what makes closing it a redraw rather than something reaching into the
 * document. What closes it from outside — a click elsewhere, escape — is in
 * main.ts, because it belongs to the page rather than to this control.
 */
export const LANGUAGE_MENU = "language-menu";

/**
 * Everything the account form holds, for the page to drop once it is made.
 *
 * Exported because clearing it belongs to whoever knows the account was made,
 * which is main.ts, and because one of these fields is a password: a form left
 * holding one after the account exists would hold it for as long as the tab is
 * open.
 */
export const NEW_ACCOUNT_FORM = [NEW_ACCOUNT, ACCOUNT_OPERATOR, ...ACCOUNT_FIELDS] as const;

/** The fields of it, which are the ones with text in them. */
export const NEW_ACCOUNT_FIELDS = ACCOUNT_FIELDS;

/**
 * A globe: the one mark that means "language" without being written in one.
 *
 * Three strokes — the outline, the equator and a meridian — because at fourteen
 * pixels anything more is a grey smudge. It is the only icon in this interface,
 * and it is here because this is the only control whose label is deliberately
 * not in the language of the rest of the page.
 */
function globe(): SVGSVGElement {
  return icon(
    "language-globe",
    "M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
    "M1.5 8h13",
    "M8 1.5c1.8 1.8 2.8 4 2.8 6.5S9.8 12.7 8 14.5C6.2 12.7 5.2 10.5 5.2 8S6.2 3.3 8 1.5Z",
  );
}

/**
 * The chevron beside it, drawn pointing down.
 *
 * A path rather than a rotated square with two borders, which is the usual
 * trick and which nobody can read: what direction a rotated corner ends up
 * pointing in is four lines of arithmetic away from what the stylesheet says,
 * and it was pointing the wrong way. Here it points down, the stylesheet turns
 * it a half-turn when it should point up, and both facts are legible.
 */
function caret(): SVGSVGElement {
  return icon("language-caret", "M4.5 6.5 8 10l3.5-3.5");
}

function languageMenu(
  draft: Draft,
  handlers: Handlers,
  m: Messages,
  placement: "head" | "gate",
): HTMLElement {
  const open = draft.expanded.has(LANGUAGE_MENU);
  return h(
    "div",
    { class: `language is-${placement}${open ? " is-open" : ""}` },
    h(
      "button",
      {
        class: "language-trigger",
        type: "button",
        title: m.page.shell.language,
        expanded: open,
        haspopup: true,
        // Named so the redraw that opens the list gives the button its focus
        // back, which is what lets the whole control be worked from a keyboard.
        focusKey: LANGUAGE_MENU,
        onClick: () => handlers.toggle(LANGUAGE_MENU),
      },
      globe(),
      h("span", { class: "language-name" }, m.name),
      caret(),
    ),
    open &&
      h(
        "div",
        { class: "language-list" },
        ...everyLanguage().map((language) =>
          h(
            "button",
            {
              class: `language-item${language.locale === draft.locale ? " is-current" : ""}`,
              type: "button",
              onClick: () => handlers.setLocale(language.locale),
            },
            language.name,
          ),
        ),
      ),
  );
}

/** The whole interface, once somebody is signed in. */
export function shell(
  view: TeamView,
  draft: Draft,
  operator: Operator,
  handlers: Handlers,
): HTMLElement {
  const m = messagesFor(draft.locale);
  return h(
    "div",
    { class: "shell" },
    h(
      "nav",
      { class: "rail" },
      h(
        "div",
        { class: "rail-head" },
        h("div", { class: "rail-title" }, "NarraLeaf Team"),
        h("div", { class: "rail-note mono" }, view.teamVersion),
      ),
      h(
        "div",
        { class: "rail-items" },
        ...railScreens(m).map((entry) =>
          h(
            "button",
            {
              class: `rail-item${entry.screen === draft.screen ? " is-current" : ""}`,
              type: "button",
              onClick: () => handlers.go(entry.screen),
            },
            entry.label,
          ),
        ),
      ),
      h(
        "div",
        { class: "rail-foot" },
        h(
          "div",
          { class: "rail-user" },
          h("div", { class: "rail-user-name" }, operator.displayName),
          h("div", { class: "rail-note mono" }, operator.username),
        ),
        h(
          "button",
          { class: "link", type: "button", onClick: () => handlers.signOut() },
          m.page.shell.signOut,
        ),
      ),
    ),
    h(
      "main",
      { class: "main" },
      h(
        "header",
        { class: "head" },
        h("h1", { class: "head-title" }, title(draft.screen, m)),
        h(
          "div",
          { class: "head-actions" },
          !draft.live &&
            h("span", { class: "head-state" }, state("idle", m.page.shell.reconnecting)),
          // Before the screen's own actions rather than after them: this one is
          // the same on every surface and is reached rarely, and the button
          // that does the thing this screen is for keeps the corner.
          languageMenu(draft, handlers, m, "head"),
          ...headerActions(view, draft, handlers, m),
        ),
      ),
      (draft.notice !== undefined || draft.problem !== undefined) &&
        h(
          "div",
          { class: draft.problem === undefined ? "notice" : "notice is-problem" },
          // Whatever the server answered with, in the language it was asked in.
          h("span", { class: "notice-text" }, draft.problem ?? draft.notice ?? ""),
          h(
            "button",
            { class: "link", type: "button", onClick: () => handlers.dismiss() },
            m.page.shell.dismiss,
          ),
        ),
      h("div", { class: "content" }, body(view, draft, handlers, m)),
    ),
  );
}

/**
 * What is on screen between signing in and the first view.
 *
 * The name, and nothing that moves. It is one gather long — well under a second
 * on any server small enough to have one operator — and something spinning for
 * that long reads as a fault rather than as progress.
 */
export function waitingPage(): HTMLElement {
  return h("div", { class: "gate" }, h("h1", { class: "gate-title" }, "NarraLeaf Team"));
}

/**
 * The sign-in page.
 *
 * A password field and nothing else. There is no way to make an account from
 * here: accounts are made by an operator, who is already signed in — on the
 * members screen, or with `nlteam user create` at the server — and the first
 * one with `nlteam init`. A link offering it would be a link to a page that
 * does not exist.
 */
export function signInPage(
  draft: Draft,
  handlers: Handlers,
  onSubmit: (username: string, password: string) => void,
): HTMLElement {
  const m = messagesFor(draft.locale);
  const submit = (): void => {
    const username = fieldValue(draft, "sign-in-username");
    const password = draft.fields.get("sign-in-password") ?? "";
    if (username === "" || password === "") {
      return;
    }
    onSubmit(username, password);
  };

  return h(
    "div",
    { class: "gate" },
    h(
      "form",
      { class: "gate-form", onSubmit: () => submit() },
      h("h1", { class: "gate-title" }, "NarraLeaf Team"),
      h("input", {
        class: "input",
        type: "text",
        placeholder: m.page.gate.username,
        focusKey: "sign-in-username",
        autofocus: true,
        autocomplete: "username",
        value: draft.fields.get("sign-in-username") ?? "",
        onInput: (value) => handlers.setField("sign-in-username", value),
      }),
      h("input", {
        class: "input",
        type: "password",
        placeholder: m.page.gate.password,
        focusKey: "sign-in-password",
        autocomplete: "current-password",
        value: draft.fields.get("sign-in-password") ?? "",
        onInput: (value) => handlers.setField("sign-in-password", value),
      }),
      h(
        "button",
        { class: "button is-primary is-wide", type: "submit", ...(draft.busy ? { disabled: true } : {}) },
        m.page.gate.signIn,
      ),
      draft.problem !== undefined && h("p", { class: "gate-problem" }, draft.problem),
    ),
    // The same control as the rail's, on this page too, and it has to be here:
    // somebody who cannot read the form is the one person who most needs to
    // change the language, and the rail they would otherwise change it from is
    // behind the form. Directly under the sign-in button, where somebody who
    // has just found out they cannot read the form is already looking — and
    // outside the form element rather than inside it, so that opening the list
    // is never mistaken for submitting.
    languageMenu(draft, handlers, m, "gate"),
  );
}
