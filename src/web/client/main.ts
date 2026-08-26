/**
 * The page: one state, one draw, one place each of them changes.
 *
 * Everything that happens follows the same three steps. Something changes the
 * state — a click, an answer from the server, a view off the event stream — and
 * then `draw` runs, and the screen is rebuilt from that state. There is no path
 * that reaches into the document to change one thing, which is what stops a
 * screen and the server it describes from drifting apart while nobody is
 * looking.
 */
import { messagesFor } from "../../i18n/index.js";
import type { Locale } from "../../i18n/locales.js";
import type { TeamView } from "../../teamview.js";
import type { Action } from "../../tui/state.js";
import {
  currentSession,
  fetchView,
  newDraft,
  sendAction,
  signIn,
  signOut,
  watchViews,
  type Draft,
  type Operator,
  type Screen,
} from "./api.js";
import { renderInto } from "./dom.js";
import { rememberLocale } from "./language.js";
import {
  LANGUAGE_MENU,
  NEW_ACCOUNT_FIELDS,
  NEW_ACCOUNT_FORM,
  shell,
  signInPage,
  waitingPage,
  type Handlers,
} from "./screens.js";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("the page has no root to draw into");
}
const container = root;

let draft: Draft = newDraft();

// The document says which language it is in from the first frame, for the
// browser's sake as much as a reader's: it is what a screen reader picks a
// voice by and what the text is hyphenated as.
rememberLocale(draft.locale);
let operator: Operator | undefined;
let view: TeamView | undefined;
let stopWatching: (() => void) | undefined;

function draw(): void {
  if (operator === undefined) {
    renderInto(container, signInPage(draft, handlers, attemptSignIn));
    return;
  }
  if (view === undefined) {
    // The gap between being signed in and the first view arriving, which is one
    // gather. The name and nothing else: it is over in well under a second, and
    // a moving thing that appears for that long reads as a fault.
    renderInto(container, waitingPage());
    return;
  }
  renderInto(container, shell(view, draft, operator, handlers));
}

/** Take the interface back to its signed-out state, whatever put it there. */
function signedOut(problem?: string): void {
  stopWatching?.();
  stopWatching = undefined;
  operator = undefined;
  view = undefined;
  // The password is dropped rather than kept for a second attempt: a page that
  // held one after a failure would hold it for as long as the tab stayed open.
  draft.fields.delete("sign-in-password");
  draft.busy = false;
  draft.live = false;
  delete draft.notice;
  // Whatever was on screen for one person to read is not on screen for the next
  // one, and a password typed into a half-finished form goes with it.
  delete draft.secret;
  for (const field of NEW_ACCOUNT_FIELDS) {
    draft.fields.delete(field);
  }
  if (problem === undefined) {
    delete draft.problem;
  } else {
    draft.problem = problem;
  }
  draw();
}

async function attemptSignIn(username: string, password: string): Promise<void> {
  draft.busy = true;
  delete draft.problem;
  draw();

  const answer = await signIn(draft.locale, username, password);
  draft.busy = false;
  if (!answer.ok) {
    draft.problem = answer.problem;
    draft.fields.delete("sign-in-password");
    draw();
    return;
  }

  operator = answer.value.operator;
  // A fresh draft, carrying the one part of the old one that is about the
  // person rather than about what they were doing.
  draft = newDraft(draft.locale);
  draw();
  await load();
}

/** Fetch the first view and start watching for the rest. */
async function load(): Promise<void> {
  const answer = await fetchView(draft.locale);
  if (!answer.ok) {
    if (answer.signedOut) {
      signedOut();
      return;
    }
    draft.problem = answer.problem;
    draw();
    return;
  }
  view = answer.value;
  draw();
  watch();
}

function watch(): void {
  stopWatching?.();
  stopWatching = watchViews(
    (arrived) => {
      view = arrived;
      draft.live = true;
      draw();
    },
    () => {
      // A dropped stream is usually a server being restarted, and EventSource
      // reconnects by itself. What it cannot tell us is whether the session
      // survived, so the page asks — and stops showing itself as live either
      // way, because it no longer knows that what is drawn is current.
      draft.live = false;
      draw();
      void currentSession(draft.locale).then((answer) => {
        if (answer.ok && !answer.value.signedIn) {
          signedOut(messagesFor(draft.locale).refusal.sessionEnded);
        }
      });
    },
  );
}

/** Ask for one thing to be done, and say what it did. */
async function perform(action: Action): Promise<void> {
  draft.busy = true;
  delete draft.problem;
  // Whatever was shown once has been read by now, and leaving it up would
  // attach it to whatever is being done next.
  delete draft.secret;
  draw();

  const answer = await sendAction(draft.locale, action);
  draft.busy = false;

  if (!answer.ok) {
    if (answer.signedOut) {
      signedOut(messagesFor(draft.locale).refusal.sessionEnded);
      return;
    }
    draft.problem = answer.problem;
    draw();
    return;
  }

  // The sentence the server answered with, shown as it is. It stays on screen
  // until somebody dismisses it or asks for something else, because some of
  // them name a thing that happened once and will not be repeated.
  draft.notice = answer.value.message;
  view = answer.value.view;
  // Shown where it was asked for rather than in the notice bar: it is the thing
  // itself rather than a sentence about it, and it is never written anywhere
  // this page cannot drop it again.
  if (answer.value.secret !== undefined && action.kind === "issue-token") {
    draft.secret = { username: action.username, token: answer.value.secret };
  }
  // Anything half-typed into the thing that just happened is finished with.
  if (action.kind === "create-project") {
    draft.fields.delete("new-project-name");
    draft.expanded.delete("new-project");
  }
  if (action.kind === "create-account") {
    // The password among them, and this is the moment it stops being needed.
    for (const key of NEW_ACCOUNT_FORM) {
      draft.fields.delete(key);
      draft.expanded.delete(key);
    }
  }
  draw();
}

const handlers: Handlers = {
  perform: (action) => {
    void perform(action);
  },
  go: (screen: Screen) => {
    draft.screen = screen;
    delete draft.notice;
    delete draft.problem;
    // It was shown on the screen that asked for it, and this is another screen.
    delete draft.secret;
    draw();
  },
  setField: (key, value) => {
    draft.fields.set(key, value);
    // No redraw. The field already shows what was typed into it, and rebuilding
    // the screen on every keystroke is the one thing that would make typing
    // here feel worse than typing anywhere else.
  },
  toggle: (key) => {
    if (draft.expanded.has(key)) {
      draft.expanded.delete(key);
    } else {
      draft.expanded.add(key);
    }
    draw();
  },
  dismiss: () => {
    delete draft.notice;
    delete draft.problem;
    delete draft.secret;
    draw();
  },
  signOut: () => {
    void signOut(draft.locale).then(() => signedOut());
  },
  setLocale: (locale: Locale) => {
    draft.locale = locale;
    draft.expanded.delete(LANGUAGE_MENU);
    rememberLocale(locale);
    // A redraw and nothing else. Every word on screen is drawn from the view
    // this page already has, so there is nothing to fetch — and what is not
    // redrawn is what the server already said: a sentence answered a minute ago
    // stays in the language it was answered in rather than being guessed at
    // again here, and the next one arrives in the new language.
    draw();
  },
};

/**
 * Close the language list when it is no longer being used.
 *
 * Two listeners on the document, added once, rather than anything added and
 * taken away as the list opens: a redraw replaces the whole page, and a
 * listener attached to something inside it would be attached to an element that
 * no longer exists a moment later.
 *
 * A click inside the control is not an outside click, which is what `closest`
 * settles — including the click on the button that opened it, which would
 * otherwise open and close the list in the same gesture.
 */
function closeLanguageMenu(): void {
  if (!draft.expanded.has(LANGUAGE_MENU)) {
    return;
  }
  draft.expanded.delete(LANGUAGE_MENU);
  draw();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".language") !== null) {
    return;
  }
  closeLanguageMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeLanguageMenu();
  }
});

/** Open on whatever this browser already is. */
async function start(): Promise<void> {
  draw();
  const answer = await currentSession(draft.locale);
  if (answer.ok && answer.value.signedIn && answer.value.operator !== undefined) {
    operator = answer.value.operator;
    draw();
    await load();
  }
}

void start();
