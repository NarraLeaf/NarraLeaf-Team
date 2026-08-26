/**
 * Talking to the server, and the state the page keeps that the server does not.
 *
 * Two kinds of state live in this interface and they are kept apart on purpose.
 * The **view** is everything true about the server, it arrives whole, and this
 * page never edits it: what is drawn is always the last one that arrived. The
 * **draft** state is everything that is only true in this browser — which
 * screen is open, what is half-typed into a field, which project is expanded —
 * and the server is never told about it.
 *
 * Keeping them separate is what lets a view arrive at any moment, from the
 * event stream, without disturbing anybody. A field being typed into holds its
 * text because that text was never in the view to begin with.
 */
import { messagesFor } from "../../i18n/index.js";
import { LANGUAGE_HEADER, type Locale } from "../../i18n/locales.js";
import type { TeamView } from "../../teamview.js";
import type { Action } from "../../tui/state.js";
import { openingLocale } from "./language.js";

/** Who is signed in, as the server describes them. */
export interface Operator {
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly expiresAt: number;
}

/** The five surfaces, in the order the rail lists them. */
export type Screen = "overview" | "projects" | "members" | "decisions" | "settings";

/**
 * A credential the server answered with once, and who it is for.
 *
 * Draft state, and the only draft state that is worth saying something about:
 * it is in this tab's memory and nowhere else. The server keeps no copy, it is
 * not in the view, so it never arrives down the event stream, and it is dropped
 * the moment the screen changes or anything else is asked for.
 */
export interface Secret {
  readonly username: string;
  readonly token: string;
}

/** What this browser knows that the server does not. */
export interface Draft {
  screen: Screen;
  /**
   * The language this page is being read in.
   *
   * Draft state like everything else here: it belongs to this browser, the
   * server is not told about it beyond the header on each request, and it is
   * what every screen is drawn from. Keeping it here rather than in a module of
   * its own is what lets a screen stay a function of the view and the draft.
   */
  locale: Locale;
  /** What the last action answered with, shown until the next one. */
  notice?: string;
  /** Why the last thing asked for did not happen. */
  problem?: string;
  /** A token the last action produced, shown on the screen that asked for it. */
  secret?: Secret;
  /** True while a request is out, so a button cannot be pressed twice. */
  busy: boolean;
  /** Whether the connection to the event stream is up. */
  live: boolean;
  /** Half-typed values, by the key of the field they are in. */
  fields: Map<string, string>;
  /** Which rows are open, by their key. */
  expanded: Set<string>;
}

/**
 * A draft with nothing in it, which is what a page starts on.
 *
 * The language is the one thing carried over when this is called again — after
 * signing in, for instance — because it is the only part of a draft that is
 * about the person rather than about what they were doing.
 */
export function newDraft(locale: Locale = openingLocale()): Draft {
  return {
    screen: "overview",
    locale,
    busy: false,
    live: false,
    fields: new Map(),
    expanded: new Set(),
  };
}

/** What one request answered with. */
type Answer<T> = { ok: true; value: T } | { ok: false; problem: string; signedOut: boolean };

async function request<T>(
  path: string,
  locale: Locale,
  init?: RequestInit,
): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      // The cookie is same-origin and marked strict, so nothing is sent
      // anywhere else; naming it here is what makes the browser send it at all.
      credentials: "same-origin",
      ...init,
      // After the spread, not before: the language this page is being read in
      // is not something a caller may leave off, and a sentence coming back in
      // another language than the screen around it is the one failure a person
      // cannot work around.
      headers: { ...(init?.headers as Record<string, string> | undefined), [LANGUAGE_HEADER]: locale },
    });
  } catch {
    // The one failure the page can be sure about: the server is not answering.
    // Said as a fact rather than as an error, because it is usually a laptop
    // that went to sleep rather than anything wrong with the server. Said here
    // rather than by the server, for the obvious reason.
    return { ok: false, problem: messagesFor(locale).refusal.serverSilent, signedOut: false };
  }

  const signedOut = response.status === 401;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const problem =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? // Already in this page's language: the server was told which one on
          // the way in.
          (body as { error: string }).error
        : messagesFor(locale).refusal.serverAnswered({ status: response.status });
    return { ok: false, problem, signedOut };
  }
  return { ok: true, value: body as T };
}

const JSON_POST: RequestInit = {
  method: "POST",
  // Both halves matter. The type is what makes this a request a page on another
  // origin cannot forge without a preflight, and the server refuses anything
  // else on a route that writes.
  headers: { "content-type": "application/json" },
};

/** Whether this browser already has a session, asked once as the page opens. */
export function currentSession(
  locale: Locale,
): Promise<Answer<{ signedIn: boolean; operator?: Operator }>> {
  return request("/api/session", locale);
}

/** Sign in. */
export function signIn(
  locale: Locale,
  username: string,
  password: string,
): Promise<Answer<{ operator: Operator }>> {
  return request("/api/sign-in", locale, {
    ...JSON_POST,
    body: JSON.stringify({ username, password }),
  });
}

/** Sign out, whatever the server makes of it. */
export function signOut(locale: Locale): Promise<Answer<unknown>> {
  return request("/api/sign-out", locale, JSON_POST);
}

/** Ask for everything, once. */
export function fetchView(locale: Locale): Promise<Answer<TeamView>> {
  return request("/api/view", locale);
}

/** Ask for one thing to be done, and get back what it did and the view after it. */
export function sendAction(
  locale: Locale,
  action: Action,
): Promise<Answer<{ message: string; secret?: string; view: TeamView }>> {
  return request("/api/action", locale, { ...JSON_POST, body: JSON.stringify(action) });
}

/**
 * Watch for new views until the page goes away.
 *
 * `EventSource` reconnects on its own after a dropped connection, which is what
 * this wants: a server restarted under an open tab comes back and the tab picks
 * up again without anybody reloading. What it cannot do is tell a restart from
 * a session that expired while the laptop was shut, so `onLost` is called on
 * every failure and the page checks whether it is still signed in.
 */
export function watchViews(
  onView: (view: TeamView) => void,
  onLost: () => void,
): () => void {
  const source = new EventSource("/api/events", { withCredentials: true });
  source.addEventListener("message", (event) => {
    try {
      onView(JSON.parse((event as MessageEvent<string>).data) as TeamView);
    } catch {
      // A partial frame, which the next one replaces. Nothing to say about it.
    }
  });
  source.addEventListener("error", () => onLost());
  return () => source.close();
}
