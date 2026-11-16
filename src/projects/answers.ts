/**
 * What a project and an account look like in an answer.
 *
 * One builder each, so that a field cannot come to exist on one path and not
 * another. Every caller is a method on a session; none of them composes a body of
 * its own.
 *
 * What is absent and what is nought
 * ---------------------------------
 * Everything that comes out of a repository is optional, and a field Team has not
 * read is left out rather than sent as zero. A project cloned for the first time
 * may be minutes away from having a history to report, and a row saying nought
 * revisions is a row saying nobody has ever worked on it. Absent is the only
 * honest answer while the read is still running, and it is the same answer a
 * project written by a newer Studio gets - which is what keeps this server from
 * having to be upgraded in step with the one it serves.
 *
 * Nothing here starts a repository read or waits on one. Whatever the reader has
 * landed so far is what is served.
 */
import { versionRoles } from "../authority/versions.js";
import type { TeamVersionRole } from "../team/protocol.js";
import { audienceHosts, dataRemoteUrl } from "../identity/config.js";
import { findUserById, isOperator, type UserRecord } from "../identity/users.js";
import type { TeamService } from "../team/service.js";
import type { RevisionView } from "../teamview.js";
import type { ProjectRecord } from "./registry.js";
import {
  editableAreas,
  PROJECT_AREAS,
  projectRole,
  type ProjectArea,
  type ProjectMember,
  type ProjectRole,
} from "./members.js";
import { storedProjectDeleters } from "../identity/settings.js";

/** One project, as a Studio installation reads it. */
export interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who made it, by username; absent for an account that has been deleted. */
  readonly createdBy?: string;
  readonly createdAt: number;
  /**
   * The remote to clone, which is the address Studio would otherwise be told.
   *
   * **The project's name is on the end, and it has to be.** A client is given
   * `lore://host:port/<name>` and refuses one without the name — measured: the
   * clone page marks an origin-only address invalid and will not go on. What
   * the client stores afterwards is only the origin, which is why it is easy to
   * think the name is decoration.
   */
  readonly remote: string;
  /**
   * What the repository says about itself, absent until Team has read it.
   *
   * Absent rather than empty, and never zeroed. The first read of a project is
   * a clone and the slowest thing this server does, and a project that has been
   * worked on for months must not read as one nobody has touched while that
   * clone is still running.
   */
  readonly history?: RevisionView;
  /** The least role that may save a version of it, and restore one. */
  readonly saveRole: TeamVersionRole;
  readonly restoreRole: TeamVersionRole;
  /**
   * The role the account asking has in this project, so a client can leave out
   * what that role cannot do. Absent only where nobody in particular asked.
   */
  readonly role?: ProjectRole;
  /**
   * The areas the account asking may change: all of them for an owner, its own
   * for an editor, none for a reviewer or viewer. Absent where nobody asked.
   */
  readonly areas?: readonly ProjectArea[];
  /** Whether the account asking may take the project off the list. Absent where nobody asked. */
  readonly mayRemove?: boolean;
}

/**
 * One account, as a name beside a piece of work rather than as an account.
 *
 * What is here is what somebody needs in order to know whose revision they are
 * looking at. What is not here is an operator's business: when an account's
 * tokens were last refused, what groups it is in beyond the one label below,
 * and anything else the management plane keeps.
 *
 * `operator` is that label, and it is a label. It says this account may
 * administer this server, which makes it the owner of every project; what any
 * other account may do in a project is its role there — see {@link ProjectMember}.
 */
export interface MemberBody {
  readonly username: string;
  readonly displayName: string;
  /**
   * The address, where the account has one.
   *
   * Included on purpose. It is already on every revision this person authored,
   * so within this server it is not a secret, and a member list that could not
   * be matched against a history would not be much of a member list. What is
   * done with it is Studio's decision, which is to show it to nobody by
   * default.
   */
  readonly email?: string;
  readonly operator: boolean;
  /**
   * Whether the account may still sign in.
   *
   * A disabled account is listed rather than dropped. Somebody who wrote half
   * of a project's history and then left is still the person that history
   * names, and a list they had fallen out of would leave those revisions signed
   * by a stranger.
   */
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  readonly createdAt: number;
  /** Where the account's avatar is, absent for one with none. */
  readonly avatarUrl?: string;
}

export function projectBody(
  options: TeamService,
  project: ProjectRecord,
  viewer?: UserRecord,
): ProjectBody {
  const { database, config } = options;
  const maker = findUserById(database, project.createdBy);
  // Whatever the reader has landed, and nothing is asked of it here. A project
  // it has not reached has no history, which is left out rather than filled in.
  const history = options.readings?.get(project.id)?.history;
  const roles = versionRoles(database, project.id);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    ...(maker === undefined ? {} : { createdBy: maker.username }),
    createdAt: project.createdAt,
    // Built from what this server was started with rather than stored, for the
    // same reason the discovery document is: the address a project is reached
    // at is a fact about the deployment, not about the project.
    remote: `${dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort)}/${project.name}`,
    ...(history === undefined ? {} : { history }),
    saveRole: roles.save,
    restoreRole: roles.restore,
    ...(viewer === undefined ? {} : viewerFields(options, project, viewer)),
  };
}

/** What a project body says about the account asking: its role, its areas, and whether it may remove it. */
function viewerFields(
  options: TeamService,
  project: ProjectRecord,
  viewer: UserRecord,
): { role?: ProjectRole; areas: readonly ProjectArea[]; mayRemove: boolean } {
  const role = projectRole(options.database, project.id, viewer);
  return {
    ...roleField(role),
    areas: [...editableAreas(options.database, project.id, viewer)],
    mayRemove: mayRemoveProject(options, viewer, role),
  };
}

/** Whether an account may take a project off the list, as `project.delete_by` stands. */
export function mayRemoveProject(options: TeamService, user: UserRecord, role: ProjectRole | undefined): boolean {
  return storedProjectDeleters(options.database) === "admins" ? isOperator(user.groups) : role === "owner";
}

function roleField(role: ProjectRole | undefined): { role?: ProjectRole } {
  return role === undefined ? {} : { role };
}

/** One account's place in one project, as the protocol carries it. */
export interface ProjectMemberBody {
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly role: ProjectRole;
  readonly areas?: readonly ProjectArea[];
  readonly addedBy?: string;
  readonly addedAt: number;
}

/**
 * A member row as the protocol carries it, or undefined for a row whose account
 * no longer exists — which the foreign key prevents, and which is left out
 * rather than sent nameless if it ever happens.
 */
export function projectMemberBody(options: TeamService, member: ProjectMember): ProjectMemberBody | undefined {
  const user = findUserById(options.database, member.userId);
  if (user === undefined) {
    return undefined;
  }
  const adder = member.addedBy === undefined ? undefined : findUserById(options.database, member.addedBy);
  const avatar = avatarUrl(user);
  return {
    username: user.username,
    displayName: user.displayName,
    ...(avatar === undefined ? {} : { avatarUrl: avatar }),
    role: member.role,
    ...(member.areas === undefined || member.areas.length === PROJECT_AREAS.length ? {} : { areas: [...member.areas] }),
    ...(adder === undefined ? {} : { addedBy: adder.username }),
    addedAt: member.addedAt,
  };
}

export function memberBody(user: UserRecord): MemberBody {
  const avatar = avatarUrl(user);
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    // The one group question this API asks, asked where the interface asks it,
    // so that the label and the door cannot come to disagree.
    operator: isOperator(user.groups),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
    ...(avatar === undefined ? {} : { avatarUrl: avatar }),
  };
}

/** Where an account's avatar is served: content-addressed, so it can be cached for ever. */
export function avatarUrl(user: UserRecord): string | undefined {
  return user.avatar === undefined ? undefined : `/api/team/v1/avatars/${encodeURIComponent(user.username)}/${user.avatar}`;
}

/** An account's profile: a name, a face and a line. */
export function profileBody(user: UserRecord): { username: string; displayName: string; bio?: string; avatarUrl?: string; timezone?: string } {
  const avatar = avatarUrl(user);
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.bio === undefined ? {} : { bio: user.bio }),
    ...(user.timezone === undefined ? {} : { timezone: user.timezone }),
    ...(avatar === undefined ? {} : { avatarUrl: avatar }),
  };
}
