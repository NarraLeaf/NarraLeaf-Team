/**
 * What every administrative command shares once it is speaking to a server.
 *
 * The commands themselves are beside their local halves — `user list` over the
 * protocol is in src/user.ts next to `user list` off a disk, because the two
 * have to print the same thing and a renderer they both call is the only way to
 * keep that true. What is here is the part none of them owns on its own: how
 * the whole of a paged list is read, and where one fact a command prints comes
 * from when the command did not have to read a database to get it.
 *
 * ## Why nothing here sends a client id
 *
 * Every write in the `admin` family takes an optional `clientId`, keyed
 * `(account, method, clientId)`, so that a write which is retried is not
 * performed twice — see src/identity/writes.ts. Nothing this program sends
 * carries one, and that is a decision rather than an omission.
 *
 * A client id protects a **retry**: the same request, sent again by something
 * that never saw the first answer. This command line has no retry. It makes one
 * call and exits, and a call that failed is a non-zero exit and a sentence, in
 * front of a person who decides what to do next. So an id minted per run would
 * be a fresh id every time and would suppress nothing — the second run is a
 * second process with a second id, and the server would rightly do the work
 * again. An id that was stable across runs would be worse: `key rotate` an hour
 * later is a rotation somebody means, and one that quietly answered with the
 * keys as they stood would be a command that stopped working the second time it
 * was used.
 *
 * `admin.tokens.mint` is where that reasoning is easiest to check. A repeated
 * mint answers with the account and the expiry and **no token**, because the
 * server kept nothing of the one it made. A command line that reused an id
 * would eventually print an expiry and no credential, which is the one output
 * this command must never produce.
 *
 * Studio is the caller that needs the other answer: a panel that lost a socket
 * mid-write does retry, and it has somewhere to keep the id it retried under.
 * The protocol carries the field for that caller, and this one leaves it out.
 */
import { TEAM_METHODS } from "@narraleaf/team-protocol";

import { describeDuration } from "../duration.js";
import { REPOSITORY_SETTING } from "../view.js";
import { readSettings, readUserPage, type ListedUser } from "./answers.js";
import type { TeamSessionClient } from "./session.js";

/**
 * Every account, read a page at a time.
 *
 * The method pages and the command does not, and both are right. A page is a
 * bounded amount of work for a server answering however many clients — each
 * account on it costs a second query for the groups it is in — while
 * `user list` has always printed the whole list, and a person piping it into
 * `grep` has nowhere to hold a cursor between one invocation and the next. So
 * the paging is here, where it costs a few round trips on a large team and
 * nothing on a small one.
 *
 * No limit is asked for. The server's own default decides how big a page is,
 * which keeps this from naming a number that would have to be kept in step with
 * one on the far side.
 */
export async function allUsers(session: TeamSessionClient): Promise<readonly ListedUser[]> {
  const users: ListedUser[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = readUserPage(
      await session.call(TEAM_METHODS.adminUsersList, cursor === undefined ? {} : { cursor }),
    );
    users.push(...page.users);
    cursor = page.cursor;
    if (cursor !== undefined && seen.has(cursor)) {
      // A cursor is opaque and this program never looks inside one, so the only
      // check it can make is that the list is going somewhere. A server that
      // handed back a cursor it had already given would spin this loop for
      // ever, and a command that never comes back is worse than one that says
      // what it could not do.
      throw new Error(
        `that server answered ${TEAM_METHODS.adminUsersList} with a cursor it had already ` +
          "given, so the list does not end",
      );
    }
    if (cursor !== undefined) {
      seen.add(cursor);
    }
  } while (cursor !== undefined);

  return users;
}

/**
 * How long a repository token lasts on this server, in the words a person set it in.
 *
 * `user disable` and `user revoke-tokens` both say how far the refusal reaches,
 * and the sentence carries this number: a connection already open is checked by
 * loreserver rather than by Team and may last until the token it was opened
 * with expires. The local path reads it out of the database beside the server.
 * This one asks the server, because the sentence is part of what the command
 * says it did and a sentence that lost its number on one path would be the two
 * paths saying different things about the same server.
 *
 * Asked **before** the write rather than after it, so that a caller who may not
 * administer this server is refused before anything is changed.
 */
export async function repositoryTokenLifetime(session: TeamSessionClient): Promise<string> {
  const settings = readSettings(await session.call(TEAM_METHODS.adminSettingsList));
  const row = settings.find((setting) => setting.label === REPOSITORY_SETTING);
  if (row === undefined) {
    throw new Error(
      `that server answered ${TEAM_METHODS.adminSettingsList} without the ` +
        `${REPOSITORY_SETTING} lifetime, which is what says how far this reaches`,
    );
  }
  // Written from the number the row carries beside its words rather than from
  // the words, and by the same function the other path writes them with. The
  // words are a server's; the number is a fact. A build answering in another
  // language would otherwise put its own words in the middle of an English
  // sentence, and one that shortened them would put a different string on each
  // of the two paths for the same setting.
  return row.seconds === undefined ? row.value : describeDuration(row.seconds);
}
