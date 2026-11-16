/**
 * The caller's own sign-in security: two-step sign-in and personal API tokens.
 *
 * About the caller and nobody else. Turning a second factor off or replacing
 * its recovery codes asks for a current code, so a console left open on
 * somebody's desk cannot be used to take it away.
 */
import {
  API_TOKEN_NAME_LIMIT,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenRecord,
} from "../../identity/apitokens.js";
import { recordDecision } from "../../identity/audit.js";
import { storedServerName } from "../../identity/settings.js";
import {
  beginTotp,
  confirmTotp,
  otpauthUri,
  removeTotp,
  replaceRecoveryCodes,
  totpState,
  twoFactorRequired,
  verifySecondFactor,
} from "../../identity/totp.js";
import { findProject } from "../../projects/registry.js";
import {
  flag,
  MethodError,
  paramsObject,
  projectVisible,
  requiredText,
  type MethodContext,
  type TeamMethod,
} from "../methods.js";
import { TEAM_METHODS } from "../protocol.js";

const CODE_LIMIT = 32;
const ID_LIMIT = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

function note(context: MethodContext, resource: string, detail: string): void {
  recordDecision(context.options.database, {
    username: context.user.username,
    resource,
    allowed: true,
    detail,
  });
}

function tokenBody(record: ApiTokenRecord): Record<string, unknown> {
  return { ...record };
}

export function securityMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.accountTotpStatus,
      capability: "two-factor",
      handle: (_params: unknown, context: MethodContext) => ({
        ...totpState(context.options.database, context.user.id),
        required: twoFactorRequired(context.options.database),
      }),
    },
    {
      name: TEAM_METHODS.accountTotpBegin,
      capability: "two-factor",
      handle: (_params: unknown, context: MethodContext) => {
        const database = context.options.database;
        let secret: string;
        try {
          secret = beginTotp(database, context.user.id);
        } catch (error) {
          throw new MethodError("conflict", error instanceof Error ? error.message : String(error));
        }
        const issuer = storedServerName(database, "NarraLeaf Team");
        return { secret, uri: otpauthUri(secret, context.user.username, issuer) };
      },
    },
    {
      name: TEAM_METHODS.accountTotpConfirm,
      capability: "two-factor",
      handle: (params: unknown, context: MethodContext) => {
        const code = requiredText(paramsObject(params), "code", CODE_LIMIT);
        const codes = confirmTotp(context.options.database, context.user.id, code);
        if (codes === undefined) {
          throw new MethodError("bad-params", "that code is not right; check the time on your phone and try the next one");
        }
        note(context, `account:${context.user.username}`, "two-step sign-in on");
        return { recoveryCodes: codes };
      },
    },
    {
      name: TEAM_METHODS.accountTotpDisable,
      capability: "two-factor",
      handle: (params: unknown, context: MethodContext) => {
        const database = context.options.database;
        const code = requiredText(paramsObject(params), "code", CODE_LIMIT);
        if (twoFactorRequired(database)) {
          throw new MethodError("refused", "this server asks every account for two-step sign-in, so it cannot be turned off");
        }
        if (!verifySecondFactor(database, context.user.id, code)) {
          throw new MethodError("refused", "that code is not right");
        }
        removeTotp(database, context.user.id);
        note(context, `account:${context.user.username}`, "two-step sign-in off");
        return {};
      },
    },
    {
      name: TEAM_METHODS.accountTotpRecovery,
      capability: "two-factor",
      handle: (params: unknown, context: MethodContext) => {
        const database = context.options.database;
        const code = requiredText(paramsObject(params), "code", CODE_LIMIT);
        if (!totpState(database, context.user.id).enabled) {
          throw new MethodError("conflict", "two-step sign-in is not on for this account");
        }
        if (!verifySecondFactor(database, context.user.id, code)) {
          throw new MethodError("refused", "that code is not right");
        }
        note(context, `account:${context.user.username}`, "new recovery codes");
        return { recoveryCodes: replaceRecoveryCodes(database, context.user.id) };
      },
    },
    {
      name: TEAM_METHODS.accountTokensList,
      capability: "api-tokens",
      handle: (_params: unknown, context: MethodContext) => ({
        tokens: listApiTokens(context.options.database, context.user.id).map(tokenBody),
      }),
    },
    {
      name: TEAM_METHODS.accountTokensCreate,
      capability: "api-tokens",
      handle: (params: unknown, context: MethodContext) => {
        const read = paramsObject(params);
        const database = context.options.database;
        const name = requiredText(read, "name", API_TOKEN_NAME_LIMIT).trim();
        if (name === "") {
          throw new MethodError("bad-params", "a token needs a name, so you can tell it apart later");
        }
        let projects: string[] | undefined;
        const raw = read["projects"];
        if (raw !== undefined && raw !== null) {
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100 || raw.some((item) => typeof item !== "string")) {
            throw new MethodError("bad-params", "projects is a list of project ids, or left out for all of yours");
          }
          projects = [];
          for (const reference of raw as string[]) {
            const project = findProject(database, reference);
            if (project === undefined || !projectVisible(context, project.id)) {
              throw new MethodError("not-found", `there is no project ${reference} you may reach`);
            }
            if (!projects.includes(project.id)) projects.push(project.id);
          }
        }
        const days = read["expiresInDays"];
        if (days !== undefined && (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 3650)) {
          throw new MethodError("bad-params", "expiresInDays is a whole number from 0 (never) to 3650");
        }
        const lifetime = days === undefined ? 90 : days;
        let made;
        try {
          made = createApiToken(database, context.user.id, {
            name,
            ...(projects === undefined ? {} : { projects }),
            write: flag(read, "write", false),
            ...(lifetime === 0 ? {} : { expiresAt: Date.now() + lifetime * DAY_MS }),
          });
        } catch (error) {
          throw new MethodError("conflict", error instanceof Error ? error.message : String(error));
        }
        note(context, `account:${context.user.username}`, `API token made: ${name}`);
        return { token: made.token, record: tokenBody(made.record) };
      },
    },
    {
      name: TEAM_METHODS.accountTokensRevoke,
      capability: "api-tokens",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "token", ID_LIMIT);
        if (revokeApiToken(context.options.database, context.user.id, id)) {
          note(context, `account:${context.user.username}`, "API token revoked");
        }
        return {};
      },
    },
  ];
}
