/**
 * The caller's own account: which devices it is signed in on, and signing one out.
 *
 * About the caller and nobody else, so nothing here needs a gate beyond being
 * signed in. An operator ends every device of an account at once with
 * `admin.users.revokeTokens`; this is the finer tool a person uses on their own.
 */
import { listGrants, OAUTH_CLIENTS, revokeGrant } from "../../identity/oauth.js";
import { paramsObject, requiredText, type MethodContext, type TeamMethod } from "../methods.js";
import { TEAM_METHODS, type TeamAccountDevice } from "../protocol.js";

/** The most an id may be: a UUID with room to spare. */
const ID_LIMIT = 64;

export function accountMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.accountDevicesList,
      capability: "session",
      handle: (_params: unknown, context: MethodContext) => ({
        devices: listGrants(context.options.database, context.user.id).map(
          (grant): TeamAccountDevice => ({
            id: grant.id,
            name: grant.deviceName,
            client: OAUTH_CLIENTS[grant.clientId]?.name ?? grant.clientId,
            signedInAt: grant.createdAt,
            lastUsedAt: grant.lastUsedAt,
          }),
        ),
      }),
    },
    {
      name: TEAM_METHODS.accountDevicesRevoke,
      capability: "session",
      handle: (params: unknown, context: MethodContext) => {
        const id = requiredText(paramsObject(params), "device", ID_LIMIT);
        // Scoped to the caller: another account's device is, to them, not there,
        // and signing out one already signed out is the state they asked for.
        revokeGrant(context.options.database, id, context.user.id);
        return {};
      },
    },
  ];
}
