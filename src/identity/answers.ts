/**
 * What an account looks like to whoever is administering this server.
 *
 * One builder, so that a field cannot come to exist on one path and not
 * another. It is separate from the module that answers questions because more
 * than one method hands an account back — reading the list is only the first of
 * them, and every change made to an account answers with the account it made —
 * and a second builder is how two of those come to disagree about what a record
 * carries.
 *
 * There is a second, shorter account of a person in this repository, in
 * src/projects/answers.ts, and the difference between them is deliberate rather
 * than accidental duplication. That one is a name beside a piece of work: who
 * wrote this revision, who opened this thread. This one is a record somebody
 * acts on, and it carries what only an operator has any business with — every
 * group the account is in, and when its tokens were last refused.
 */
import type { TeamAdminUser } from "../team/protocol.js";
import { isOperator, type UserRecord } from "./users.js";

export function adminUserBody(user: UserRecord): TeamAdminUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    // The groups themselves, as a list. A joined string would make every reader
    // that wanted to know whether an account is in one take the string apart
    // again, and would break the first time a group name held the separator.
    groups: user.groups,
    // Worked out here rather than stored, and by the one function that answers
    // this question anywhere, so that the label a panel draws and the door this
    // server opens cannot come to disagree.
    operator: isOperator(user.groups),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
    // Absent for an account nothing has ever revoked, and for one whose last
    // revocation was made before this server kept the moment. A nought would
    // read as "at the epoch", which is a time rather than a silence.
    ...(user.tokensInvalidatedAt === undefined
      ? {}
      : { tokensInvalidatedAt: user.tokensInvalidatedAt }),
  };
}
