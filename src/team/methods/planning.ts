/**
 * A project's glossary, where its voiced lines stand, and project templates - over a session.
 *
 *  - `glossary.list` / `.set` / `.delete`: terms and the agreed word for each language.
 *  - `voice.list` / `.set`: recorded, needing a retake, or not recorded, per language and line.
 *  - `templates.list` / `.save` / `.delete` / `.apply`: members, milestones and to-dos to start a
 *    project with. `projects.create` takes a `template` too, and applies it to what it made.
 *
 * What is stored and who may change it is decided in src/collab/; this file reads parameters,
 * asks, and announces what applying a template made.
 */
import { deleteGlossaryEntry, checkTranslations, GlossaryRefusal, glossaryView, listGlossary, setGlossaryEntry } from "../../collab/glossary.js";
import { milestoneView } from "../../collab/milestones.js";
import {
  applyTemplate,
  bodyFromProject,
  checkBody,
  deleteTemplate,
  listTemplates,
  saveTemplate,
  TEMPLATE_DESCRIPTION_LIMIT,
  TEMPLATE_NAME_LIMIT,
  TemplateRefusal,
  templateView,
} from "../../collab/templates.js";
import { todoView } from "../../collab/todos.js";
import { isLocaleTag, listVoice, setVoice, VOICE_SET_LIMIT, VoiceRefusal } from "../../collab/voice.js";
import { findUser } from "../../identity/users.js";
import { projectMemberBody } from "../../projects/answers.js";
import { findProjectMember } from "../../projects/members.js";
import { findProject } from "../../projects/registry.js";
import { MethodError, oneOf, optionalText, paramsObject, projectVisible, requiredText, type MethodContext, type TeamMethod } from "../methods.js";
import {
  ANCHOR_FIELD_LIMIT,
  projectMilestonesTopic,
  TEAM_METHODS,
  TEAM_VOICE_STATUSES,
  type TeamMilestonesEvent,
  type TeamVoiceStatus,
} from "../protocol.js";
import { announceTodo } from "./collab.js";
import { announceMembers, mayCreateProjects } from "./projects.js";

const ID_LIMIT = 128;
const NOTE_LIMIT = 2000;

function projectRef(context: MethodContext, reference: string): string {
  const project = findProject(context.options.database, reference);
  if (project === undefined || !projectVisible(context, project.id)) {
    throw new MethodError("not-found", "there is no project of that id on this server");
  }
  return project.id;
}

function refused(error: unknown): never {
  if (error instanceof GlossaryRefusal || error instanceof VoiceRefusal || error instanceof TemplateRefusal) {
    throw new MethodError(error.code, error.message);
  }
  throw error;
}

/** Put a template into a project and tell everybody what it made. Shared with `projects.create`. */
export function applyAndAnnounce(context: MethodContext, templateId: string, projectId: string) {
  const database = context.options.database;
  const applied = (() => {
    try {
      return applyTemplate(database, context.user, templateId, projectId);
    } catch (error) {
      refused(error);
    }
  })();
  const project = findProject(database, projectId);
  for (const username of applied.members) {
    const user = findUser(database, username);
    const member = user === undefined ? undefined : findProjectMember(database, projectId, user.id);
    const body = member === undefined ? undefined : projectMemberBody(context.options, member);
    if (user === undefined || body === undefined || project === undefined) continue;
    context.recheck?.(user.id);
    announceMembers(context, project, { kind: "member-set", member: body }, user);
  }
  for (const milestone of applied.milestones) {
    context.publish(projectMilestonesTopic(projectId), {
      kind: "milestone-set",
      milestone: milestoneView(database, milestone),
    } satisfies TeamMilestonesEvent);
  }
  for (const todo of applied.todos) announceTodo(context, todo, { kind: "todo-set", todo: todoView(database, todo) });
  return {
    members: applied.members,
    milestones: applied.milestones.length,
    todos: applied.todos.length,
    skipped: applied.skipped,
  };
}

export function planningMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.glossaryList,
      capability: "glossary",
      handle: (params: unknown, context: MethodContext) => {
        const projectId = projectRef(context, requiredText(paramsObject(params), "project", ID_LIMIT));
        try {
          return { entries: listGlossary(context.options.database, context.user, projectId).map((entry) => glossaryView(context.options.database, entry)) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.glossarySet,
      capability: "glossary",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const id = optionalText(read, "id", ID_LIMIT);
        const note = read["note"] === null ? null : optionalText(read, "note", NOTE_LIMIT);
        try {
          const entry = setGlossaryEntry(context.options.database, context.user, {
            projectId,
            ...(id === undefined ? {} : { id }),
            term: requiredText(read, "term", 200),
            translations: checkTranslations(read["translations"] ?? {}),
            ...(note === undefined ? {} : { note }),
          });
          return { entry: glossaryView(context.options.database, entry) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.glossaryDelete,
      capability: "glossary",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        try {
          deleteGlossaryEntry(context.options.database, context.user, projectId, requiredText(read, "id", ID_LIMIT));
        } catch (error) {
          refused(error);
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.voiceList,
      capability: "voice",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const locale = optionalText(read, "locale", 35);
        if (locale !== undefined && !isLocaleTag(locale)) throw new MethodError("bad-params", "locale is a locale tag");
        try {
          return { lines: listVoice(context.options.database, context.user, projectId, locale) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.voiceSet,
      capability: "voice",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        const locale = requiredText(read, "locale", 35);
        const status = oneOf<TeamVoiceStatus | "none">(read, "status", [...TEAM_VOICE_STATUSES, "none"]);
        const raw = read["lines"];
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > VOICE_SET_LIMIT || raw.some((line) => typeof line !== "string" || line === "" || line.length > ANCHOR_FIELD_LIMIT)) {
          throw new MethodError("bad-params", `lines is a list of 1 to ${VOICE_SET_LIMIT} line ids`);
        }
        const takeRaw = read["take"];
        if (takeRaw !== undefined && takeRaw !== null && (typeof takeRaw !== "number" || !Number.isInteger(takeRaw) || takeRaw < 1 || takeRaw > 999)) {
          throw new MethodError("bad-params", "take is a whole number from 1");
        }
        const note = read["note"] === null ? null : optionalText(read, "note", NOTE_LIMIT);
        try {
          const lines = setVoice(context.options.database, context.user, {
            projectId,
            locale,
            lines: [...new Set(raw as string[])],
            status,
            ...(takeRaw === undefined ? {} : { take: takeRaw as number | null }),
            ...(note === undefined ? {} : { note }),
          });
          return { lines };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.templatesList,
      capability: "templates",
      handle: (_params: unknown, context: MethodContext) => ({
        templates: listTemplates(context.options.database).map((template) => templateView(context.options.database, template)),
      }),
    },
    {
      name: TEAM_METHODS.templatesSave,
      capability: "templates",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        if (!mayCreateProjects(context)) throw new MethodError("refused", "templates are kept by the accounts that may make projects");
        const id = optionalText(read, "id", ID_LIMIT);
        const from = optionalText(read, "fromProject", ID_LIMIT);
        const description = read["description"] === null ? null : optionalText(read, "description", TEMPLATE_DESCRIPTION_LIMIT);
        try {
          const body = from === undefined ? checkBody(read["body"] ?? {}) : bodyFromProject(context.options.database, context.user, projectRef(context, from));
          const template = saveTemplate(context.options.database, context.user, {
            ...(id === undefined ? {} : { id }),
            name: requiredText(read, "name", TEMPLATE_NAME_LIMIT),
            ...(description === undefined ? {} : { description }),
            body,
          });
          return { template: templateView(context.options.database, template) };
        } catch (error) {
          refused(error);
        }
      },
    },
    {
      name: TEAM_METHODS.templatesDelete,
      capability: "templates",
      handle: (params: unknown, context: MethodContext) => {
        try {
          deleteTemplate(context.options.database, context.user, requiredText(paramsObject(params), "template", ID_LIMIT));
        } catch (error) {
          refused(error);
        }
        return {};
      },
    },
    {
      name: TEAM_METHODS.templatesApply,
      capability: "templates",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const projectId = projectRef(context, requiredText(read, "project", ID_LIMIT));
        return applyAndAnnounce(context, requiredText(read, "template", ID_LIMIT), projectId);
      },
    },
  ];
}
