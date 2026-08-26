/**
 * The projects and the people, over a session.
 *
 * The same answers the REST API gives, from the same builders, so that a client
 * reading a project over the socket and one reading it over HTTP are looking at
 * the same document. Not a second implementation: `projectBody` and `memberBody`
 * are imported from the file that serves the routes, because two functions
 * building the same JSON is how a field comes to exist on one path and not the
 * other.
 *
 * Why they are here at all, when the routes already work: a session is how
 * Studio finds out that a list changed. Reading it over the socket means the
 * read and the event that invalidates it come down one connection in order, so
 * there is no window where Studio has asked over HTTP, been told the answer, and
 * missed the event that came in between.
 */
import { findProject, listProjects } from "../../projects/registry.js";
import { listUsers } from "../../identity/users.js";
import { NOT_READ_YET } from "../../teamview.js";
import {
  DEFAULT_HISTORY_LIMIT,
  MAXIMUM_HISTORY_LIMIT,
  memberBody,
  projectBody,
} from "../../web/studio.js";
import {
  boundedCount,
  MethodError,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import { TEAM_METHODS } from "../protocol.js";

/** The most an id may be, which is more than any id this server issues. */
const ID_LIMIT = 128;

export function projectMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.projectsList,
      // Announced under `session` rather than a capability of its own: a server
      // with the socket and no projects list would be a server with a socket
      // and nothing to say.
      capability: "session",
      handle: (_params: unknown, context: MethodContext) => ({
        projects: listProjects(context.options.database).map((project) =>
          projectBody(context.options, project),
        ),
      }),
    },
    {
      name: TEAM_METHODS.projectsGet,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        // By id or by name, as the REST twin resolves it: a client has both in
        // front of it - the id every row carries, and the name the remote address
        // ends with - and neither is more correct than the other.
        const reference = requiredText(paramsObject(params), "project", ID_LIMIT);
        const project = findProject(context.options.database, reference);
        if (project === undefined) {
          throw new MethodError("not-found", "there is no project of that id on this server");
        }
        // The project file the REST route also answers with, read out of the
        // repository and therefore the part that may be absent. A file this server
        // could not make sense of degrades to `readable: false` with a sentence,
        // never a refusal - the same NOT_READ_YET the route falls back to for a
        // project whose first clone has not landed.
        const read = context.options.readings?.get(project.id) ?? NOT_READ_YET;
        return { project: projectBody(context.options, project), file: read.file };
      },
    },
    {
      name: TEAM_METHODS.projectsHistory,
      capability: "session",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const reference = requiredText(read, "project", ID_LIMIT);
        const project = findProject(context.options.database, reference);
        if (project === undefined) {
          throw new MethodError("not-found", "there is no project of that id on this server");
        }
        const revisions = context.options.readings?.revisions;
        if (revisions === undefined) {
          // A build that reads no repositories has no history to page. The same
          // silence the REST route answers with, shaped as an empty page rather
          // than a refusal a client can do nothing about.
          return { revisions: [] };
        }
        const limit = boundedCount(read, "limit", DEFAULT_HISTORY_LIMIT, MAXIMUM_HISTORY_LIMIT);
        // Opaque to the client: the cursor is a revision id this server handed
        // back, passed straight through to the reader.
        const cursor = optionalText(read, "cursor", ID_LIMIT);
        const page = await revisions(project.id, {
          limit,
          ...(cursor === undefined ? {} : { before: cursor }),
        });
        if (page === undefined) {
          // Team has no checkout of this project to read yet. That is "not read",
          // which a row's absent history already says, rather than "no revisions"
          // - so an empty page and no cursor, never a nought a reader would draw
          // as an emptied project.
          return { revisions: [] };
        }
        const last = page.revisions.at(-1);
        return {
          revisions: page.revisions,
          // Where to carry on from, present only when a page follows this one.
          // The last revision's id rather than the `<updatedAt>:<id>` a thread
          // list pages by: a revision has no updated-at that is always there to
          // pair with, and its id is the stable key the reader already finds
          // positions from.
          ...(page.more && last !== undefined ? { cursor: last.id } : {}),
        };
      },
    },
    {
      name: TEAM_METHODS.membersList,
      capability: "session",
      handle: (_params: unknown, context: MethodContext) => ({
        // Disabled accounts included, for the reason the route gives: somebody
        // who wrote half a history and then left is still the person that
        // history names.
        members: listUsers(context.options.database).map((user) => memberBody(user)),
      }),
    },
  ];
}
