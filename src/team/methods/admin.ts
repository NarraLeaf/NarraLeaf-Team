/**
 * This server's own state, read by whoever administers it.
 *
 * Everything here answers a question about the server rather than about a
 * project: who has an account on it, what it is set to, what it signs with,
 * what it has been asked, and whether the server beside it is answering. Before
 * these existed the only way to ask any of them was to open the database with a
 * command line on the machine the server runs on, which is a thing exactly one
 * person can do and only while sitting somewhere particular.
 *
 * **The gate is on every call, not at sign-in.** Every handler below reads the
 * caller's groups as the call arrives — see {@link administered} — because the
 * whole of this server's claim about revocation is that it takes effect at once
 * rather than at expiry. A session that decided once, when it opened, whether
 * its account could administer would leave an account demoted an hour ago still
 * administering until it happened to reconnect, and that is the one place the
 * claim would be untrue.
 *
 * **The capability is announced to everybody, including the people it refuses.**
 * That is not an oversight, and it is worth saying because it reads like one.
 * `capabilities` is a statement about the build — it says this server can be
 * administered over the socket, so that a client knows the methods exist before
 * it calls one. Whether *this* caller may administer is a different question,
 * and it is already answered in the same `hello` frame by `account.operator`.
 * A client draws a management surface from the two together: the capability
 * says the surface can exist here, the account says whether to draw it. Hiding
 * the capability would fold two facts into one and give a client no way to tell
 * "this server is too old to be administered over the socket" from "you are not
 * an operator" — which are different sentences to show a person, and only one of
 * them is about them.
 *
 * Nothing here writes. Every method is a read, so a topic to announce a change
 * on would be a topic nothing ever publishes to, and this server refuses a
 * subscription to one of those rather than leaving a client waiting on it.
 */
import { pageDecisions } from "../../identity/audit.js";
import { adminUserBody } from "../../identity/answers.js";
import { isOperator, pageUsers } from "../../identity/users.js";
import { settingRows } from "../../view.js";
import {
  boundedCount,
  MethodError,
  optionalText,
  paramsObject,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import { TEAM_METHODS, type TeamAdminSetting } from "../protocol.js";
import type { TeamService } from "../service.js";
import { serverStatus } from "../status.js";

/**
 * The most a cursor may be.
 *
 * Longer than any this server hands back, which is a number and an id. It is
 * here so that a cursor cannot become somewhere to put a payload, not because a
 * long one would be wrong: an unreadable cursor is answered with the first page.
 */
const CURSOR_LIMIT = 128;

/** How many accounts one page holds when the caller did not say. */
const DEFAULT_USER_PAGE = 50;

/**
 * The most accounts one page may hold.
 *
 * A page is a bounded amount of work rather than however much was asked for,
 * and each account here costs a second query for the groups it is in. Somebody
 * wanting the whole of a large team pages through it, which is what the cursor
 * is for.
 */
const MAXIMUM_USER_PAGE = 200;

/** How many decisions one page holds when the caller did not say. */
const DEFAULT_AUDIT_PAGE = 50;

/**
 * The most decisions one page may hold.
 *
 * The table is bounded at a couple of thousand rows, so this is not about
 * protecting the database; it is about the size of one answer on the wire, and
 * about a caller that asked for everything getting a page it can draw rather
 * than a frame it has to wait for.
 */
const MAXIMUM_AUDIT_PAGE = 200;

/**
 * Refuse anybody who is not an operator.
 *
 * Read off the record the session identified for this call, so an account that
 * was taken out of the admin group a moment ago is refused on its very next
 * call rather than when its token expires. `refused` rather than `not-found`:
 * pretending a method is not there would send whoever is fixing a client in the
 * wrong direction, and there is nothing secret about the existence of a
 * management surface that the capability list does not already say.
 */
function requireOperator(context: MethodContext): void {
  if (!isOperator(context.user.groups)) {
    throw new MethodError("refused", "administering this server is for its operators");
  }
}

/**
 * One method of this family, with the gate in front of it.
 *
 * A wrapper rather than a line at the top of each handler, because the gate is
 * the thing that must not be forgotten and a line one can forget to write is a
 * line somebody eventually will. Written once here, every method below has it.
 */
function administered(
  name: string,
  handle: (params: unknown, context: MethodContext) => Promise<unknown> | unknown,
): TeamMethod {
  return {
    name,
    capability: "admin",
    handle: (params, context) => {
      requireOperator(context);
      return handle(params, context);
    },
  };
}

/** The settings surface, read from what this service was brought up with. */
function settingsOf(options: TeamService): TeamAdminSetting[] {
  return settingRows({
    root: options.root,
    database: options.database,
    config: options.config,
    fingerprint: options.fingerprint,
  });
}

export function adminMethods(): TeamMethod[] {
  return [
    administered(TEAM_METHODS.adminUsersList, (params: unknown, context: MethodContext) => {
      const read = paramsObject(params);
      const cursor = optionalText(read, "cursor", CURSOR_LIMIT);
      const page = pageUsers(context.options.database, {
        limit: boundedCount(read, "limit", DEFAULT_USER_PAGE, MAXIMUM_USER_PAGE),
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      return {
        // Composed by the builder every answer carrying an account uses, so
        // that the record a change hands back and the record a list carries
        // cannot come to differ by a field.
        users: page.users.map((user) => adminUserBody(user)),
        // Opaque to the caller: `<createdAt>:<id>` as this server wrote it,
        // passed straight back. Absent when no page follows this one.
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    }),
    administered(TEAM_METHODS.adminAuditList, (params: unknown, context: MethodContext) => {
      const read = paramsObject(params);
      const cursor = optionalText(read, "cursor", CURSOR_LIMIT);
      const page = pageDecisions(context.options.database, {
        limit: boundedCount(read, "limit", DEFAULT_AUDIT_PAGE, MAXIMUM_AUDIT_PAGE),
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      return {
        // Newest first, because the order somebody looks for a refusal in is
        // backwards from now.
        decisions: page.decisions,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    }),
    administered(TEAM_METHODS.adminSettingsList, (_params: unknown, context: MethodContext) => ({
      // Whole rather than paged, and that is a decision rather than a gap. The
      // rows are a literal in settingRows: ten of them today, and however many
      // that function is written to build tomorrow. There is no query behind
      // this that could return more of them, so a cursor would be a cursor over
      // a list whose length is a line of source, and a caller would page
      // through it once for nothing every time it drew the surface. If that
      // function ever came to build a row per something a server can have many
      // of, this is the sentence that would have to change.
      settings: settingsOf(context.options),
    })),
    administered(TEAM_METHODS.adminKeysList, async (_params: unknown, context: MethodContext) => {
      // Read out of the store this server already holds rather than by opening
      // the keys directory again: the store is what mints and verifies with
      // these keys, and a second reader of the same files could answer with a
      // set this server is not actually using.
      //
      // Re-read first, so that a `nlteam key rotate` run in another terminal is
      // on this list without the server being restarted. The store throttles
      // its own re-reads, so asking on every call is a scan every few seconds
      // at worst.
      await context.options.keys.reload();
      const signing = context.options.keys.published[0];
      return {
        // Whole rather than paged, for the reason the settings are: this is
        // however many times a server has rotated its keys, which is a number
        // that goes up when an operator decides it should.
        keys: context.options.keys.all.map((key) => ({
          kid: key.kid,
          serial: key.serial,
          retired: key.retired,
          signing: key.kid === signing?.kid,
        })),
      };
    }),
    administered(TEAM_METHODS.adminServerStatus, (_params: unknown, context: MethodContext) =>
      // Worked out when somebody asks and kept for a stated moment, never on a
      // timer - see src/team/status.ts for what that costs and why it is worth
      // it. The answer carries when it was worked out, so a panel can say "as
      // of" instead of implying it is live.
      serverStatus(context.options),
    ),
  ];
}
