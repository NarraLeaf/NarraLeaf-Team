/**
 * The projects and the people, over a session.
 *
 * Everything a Studio installation asks a server about its projects is here, and
 * it is here rather than behind a request of its own because a session is how
 * Studio finds out that a list changed. Reading over the socket means the read
 * and the event that invalidates it come down one connection in order, so there
 * is no window in which a client has asked, been told the answer, and missed the
 * event that arrived in between.
 *
 * What a project and an account look like in an answer is not composed here:
 * `projectBody` and `memberBody` are imported, because two functions building the
 * same JSON is how a field comes to exist on one path and not another.
 */
import {
  countProjects,
  eachProject,
  findProject,
  forgetProject,
} from "../../projects/registry.js";
import { countUsers, eachUser } from "../../identity/users.js";
import { NOT_READ_YET } from "../../teamview.js";
import { memberBody, projectBody } from "../../projects/answers.js";
import { makeOrAdoptProject } from "../../projects/create.js";
import {
  boundedCount,
  MethodError,
  optionalText,
  paramsObject,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import {
  PAGE_BYTES_LIMIT,
  projectTopic,
  TEAM_METHODS,
  TOPIC_PROJECTS,
  type TeamProjectsEvent,
} from "../protocol.js";

/** The most an id may be, which is more than any id this server issues. */
const ID_LIMIT = 128;

/** The most a project name may be. The name pattern caps it tighter; this is the gross bound. */
const NAME_LIMIT = 128;

/** The most a project description may be: a line about the project, not a document. */
const DESCRIPTION_LIMIT = 4 * 1024;

/** The most a client id may be. Long enough for a UUID and a word, short of a payload. */
const CLIENT_ID_LIMIT = 128;

/** How many revisions a page of history holds when it is not asked for a number. */
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * The most revisions one page may hold.
 *
 * Each one costs a read of its metadata, so a page is a bounded amount of work
 * rather than however much a client asked for. Somebody wanting the whole of a
 * long history pages through it, which is what the cursor is for.
 *
 * **It bounds how much work, never how large the answer.** A revision carries
 * the message it was pushed with, which is a string out of a repository and not
 * a column this server bounds, so the count multiplied out has no figure at all.
 * That is what the byte ceiling beside it is for, and the reader stops at
 * whichever of the two is reached first.
 */
const MAXIMUM_HISTORY_LIMIT = 100;

/**
 * The most rows either of the two whole-answer lists here carries.
 *
 * `projects.list` and `members.list` answer with what is on this server rather
 * than with a page of it, and both grow with a deployment rather than with a
 * request. The rows are small, which is why nobody has minded, but "small rows"
 * is not a bound: a project carries a description of up to four kilobytes and
 * the last commit message this server read out of its repository, and neither
 * this server nor the count of projects on it says how many.
 *
 * **They are bounded and not paged, and that is the decision worth stating.**
 * Paging is the consistent answer and it is the wrong one here. A cursor is only
 * a bound if every client honours it, and a client that reads these lists whole
 * today — Studio does — would go on drawing the first page and quietly call it
 * the whole server. A ceiling with a count beside it costs that client nothing
 * and tells it the truth: `total` is what this server holds, and a list shorter
 * than `total` was cut. Neither list has a "next page" gesture behind it either;
 * one draws a picker and the other puts a name beside a piece of work, and both
 * are read in one go.
 *
 * A thousand of either, because a deployment past that is far past what one
 * Team server is for, and because it bounds the fields around the rows that
 * PAGE_BYTES_LIMIT does not weigh. The byte ceiling is what actually binds for a
 * list of long descriptions; this catches a deployment with a great many short
 * ones.
 */
const MAXIMUM_ROWS = 1000;

/**
 * As much of a list as one answer holds, and how many there are in all.
 *
 * Composed a row at a time and stopped at the ceiling, rather than composed
 * whole and cut down: the rows past the budget are never built, and for a
 * project that means the reading behind it is never looked up and for an account
 * it means the query for its groups is never made. Weighed on what was composed
 * rather than on the database row, because part of a project's answer — the head
 * revision and the message on it — comes out of a repository rather than out of
 * the table.
 */
function within<Row, Body>(rows: Iterable<Row>, compose: (row: Row) => Body): Body[] {
  const answer: Body[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (answer.length === MAXIMUM_ROWS) {
      break;
    }
    const body = compose(row);
    // The first row goes on whatever it weighs, for the reason every page on
    // this server admits its first: an answer that could come back empty would
    // leave a reader with nothing and no way past it.
    const weight = Buffer.byteLength(JSON.stringify(body), "utf-8");
    if (answer.length > 0 && bytes + weight > PAGE_BYTES_LIMIT) {
      break;
    }
    bytes += weight;
    answer.push(body);
  }
  return answer;
}

/**
 * Say a project appeared or went.
 *
 * The list moves for whoever holds the `projects` topic; a project going is said
 * on its own topic too, because anybody watching it is watching something that is
 * not there any more, and telling them beats a screen that just goes quiet.
 *
 * Announced from the method rather than from the registry, because the registry
 * is also written by the CLI and by loreserver adopting a repository — and an
 * announcement is about a decision somebody made, not about a row.
 */
function announceProjects(context: MethodContext, event: TeamProjectsEvent): void {
  context.publish(TOPIC_PROJECTS, event);
  if (event.kind === "project-forgotten") {
    context.publish(projectTopic(event.project), event);
  }
}

export function projectMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.projectsList,
      // Announced under `session` rather than a capability of its own: a server
      // with the socket and no projects list would be a server with a socket
      // and nothing to say.
      capability: "session",
      handle: (_params: unknown, context: MethodContext) => ({
        projects: within(eachProject(context.options.database), (project) =>
          projectBody(context.options, project),
        ),
        // What this server holds, whatever the ceiling above left out. A list
        // shorter than this was cut, and saying so is the whole of what a client
        // is owed in place of a cursor it would have had to learn.
        total: countProjects(context.options.database),
      }),
    },
    {
      name: TEAM_METHODS.projectsGet,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        // By id or by name: a client has both in front of it - the id every row
        // carries, and the name the remote address ends with - and neither is more
        // correct than the other.
        const reference = requiredText(paramsObject(params), "project", ID_LIMIT);
        const project = findProject(context.options.database, reference);
        if (project === undefined) {
          throw new MethodError("not-found", "there is no project of that id on this server");
        }
        // The project file, read out of the repository and therefore the part that
        // may be absent. A file this server could not make sense of degrades to
        // `readable: false` with a sentence, never a refusal - and so does one
        // whose first clone has not landed.
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
        const readings = context.options.readings;
        if (readings?.revisions === undefined) {
          // A build that reads no repositories has no history to page. An empty
          // page rather than a refusal a client can do nothing about; such a build
          // leaves `project-history` out of its capabilities, so a client that read
          // them does not ask.
          return { revisions: [] };
        }
        const limit = boundedCount(read, "limit", DEFAULT_HISTORY_LIMIT, MAXIMUM_HISTORY_LIMIT);
        // Opaque to the client: the cursor is a revision id this server handed
        // back, passed straight through to the reader.
        const cursor = optionalText(read, "cursor", ID_LIMIT);
        // Called on the reader rather than through a reference lifted off it. The
        // reader is a class whose `revisions` keeps a set of the projects a read is
        // inside of, and a copy of the method called on its own has no `this` to
        // find that set on - which every object-literal stand-in in a test does
        // have, so a detached call answers in the suite and throws on every real
        // server.
        const page = await readings.revisions(project.id, {
          limit,
          // The byte ceiling every other list here is held to, and the one this
          // answer needs most: a revision carries the message somebody wrote
          // when they pushed it, which comes out of a repository and is bounded
          // by nothing this server writes. The reader stops at whichever of the
          // two comes first and never reads the revisions past it.
          limitBytes: PAGE_BYTES_LIMIT,
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
      name: TEAM_METHODS.projectsCreate,
      capability: "session",
      handle: async (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const name = requiredText(read, "name", NAME_LIMIT);
        const description = optionalText(read, "description", DESCRIPTION_LIMIT);
        const repositoryId = optionalText(read, "repositoryId", ID_LIMIT);
        const clientId = optionalText(read, "clientId", CLIENT_ID_LIMIT);

        // The one call that makes or adopts a project: it writes the row before it
        // asks loreserver and rolls the row back if loreserver refuses, adopts
        // rather than creates when a repository id is given, and hands back the row
        // a repeat already made rather than a second one.
        const result = await makeOrAdoptProject(context.options, context.user, {
          name,
          ...(description === undefined ? {} : { description }),
          ...(repositoryId === undefined ? {} : { repositoryId }),
          ...(clientId === undefined ? {} : { clientId }),
        });

        switch (result.kind) {
          case "invalid-repository-id":
            throw new MethodError(
              "bad-params",
              "a repository id is thirty-two hexadecimal characters",
            );
          case "invalid-name":
            throw new MethodError("bad-params", result.message);
          case "repository-taken":
            throw new MethodError(
              "conflict",
              `the repository ${result.repositoryId} is already a project on this server`,
            );
          case "name-taken":
            throw new MethodError("conflict", result.message);
          case "repository-refused":
            // loreserver would not make the repository, and the row was rolled
            // back. The other server is what refused, so its sentence is carried
            // through for the operator's log rather than swallowed as a fault of
            // this one.
            throw new MethodError("unavailable", result.message);
          case "repeat":
            // The create already happened; this is the project it made. Nothing
            // changed, so - like every idempotent write here - nothing is
            // announced.
            return { project: projectBody(context.options, result.project) };
          case "made":
            announceProjects(context, { kind: "project-created", project: result.project.id });
            return { project: projectBody(context.options, result.project) };
        }
      },
    },
    {
      name: TEAM_METHODS.projectsForget,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        // By id or by name: a client holding a stray row has both, and neither is
        // more correct than the other.
        const reference = requiredText(paramsObject(params), "project", ID_LIMIT);
        const project = findProject(context.options.database, reference);
        if (project === undefined) {
          // Idempotent, and this is the whole of it: a project that is already
          // gone is the state the caller asked for, so a second forget - or one
          // after somebody else's - is an empty object rather than a refusal.
          // Any account may forget any project, which is why nothing here is a
          // role check: the standing rule is that every account reaches every
          // project on this server.
          return {};
        }
        // The row goes; the repository does not. loreserver keeps the store and
        // every revision in it, exactly as they were - forgetting is this
        // server's list forgetting a project, not a way of destroying one.
        forgetProject(context.options.database, project.id);
        // The reading is dropped too, so a re-registration of that repository id
        // does not inherit a history read while the stray row sat on the list.
        context.options.readings?.forget?.(project.id);
        // The known gap this closes: the gRPC delete path does not publish this,
        // so a project forgotten another way left connected clients on a stale
        // list. Said on the list's topic and the project's own, the second
        // because anybody holding it is watching something that is not there.
        announceProjects(context, { kind: "project-forgotten", project: project.id });
        // An object rather than null: a method with nothing to report says {}.
        return {};
      },
    },
    {
      name: TEAM_METHODS.membersList,
      capability: "session",
      handle: (_params: unknown, context: MethodContext) => ({
        // Disabled accounts included: somebody who wrote half a history and then
        // left is still the person that history names.
        members: within(eachUser(context.options.database), (user) => memberBody(user)),
        /** Every account this server has, whatever the ceiling above left out. */
        total: countUsers(context.options.database),
      }),
    },
  ];
}
