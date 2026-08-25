/**
 * The messages Team and loreserver exchange, and nothing else from lore's
 * protocol.
 *
 * Three protocol files are involved, all of them public and MIT-licensed in
 * EpicGames/lore under `lore-proto/proto/`:
 *
 *     auth_api.proto                       package epic_urc
 *     rebac_api.proto                      package ucs.auth
 *     lore/repository/v1/repository.proto  package lore.repository.v1
 *
 * The first two are the service loreserver expects to find at the `auth_url` it
 * was configured with, which is Team. The third is what Team calls on loreserver.
 * Field numbers below are copied from those files; a number is the whole of a
 * field's identity on the wire, so a wrong one is not a compile error anywhere,
 * it is a value that silently lands in a different field or in none.
 *
 * Only the messages that travel are here. The rest of `UrcAuthApi` — sessions,
 * API keys, user metadata — is not implemented, and its methods are answered
 * with `UNIMPLEMENTED` rather than with an empty message that would read as a
 * successful answer.
 */
import {
  MessageReader,
  MessageWriter,
  readFields,
  WIRE_DELIMITED,
  WIRE_VARINT,
} from "./protobuf.js";
import { GRPC_RESOURCE_EXHAUSTED, GrpcStatusError } from "./status.js";

/**
 * The most resource ids one request may name.
 *
 * loreserver 0.8.6 asks about exactly one — the note at the top of
 * src/projects/service.ts sets out what it does with the answer — so nothing
 * this service exists to answer comes near this. The limit is for the requests
 * it does not exist to answer: the message around the list is capped at four
 * mebibytes, an entry costs two bytes, and each id that is decoded becomes a
 * lookup, a written row and a claim signed with RSA further on. Sixty-four
 * leaves room for a caller that asks about several repositories at once and
 * ends the arithmetic that turns one request into two million decisions.
 */
export const MAXIMUM_RESOURCE_IDS = 64;

/**
 * Refuse a list that is longer than this will read.
 *
 * RESOURCE_EXHAUSTED rather than INVALID_ARGUMENT, and the same status
 * src/grpc/framing.ts answers an oversized message with: the request is well
 * formed and says exactly what it means, and the answer is that it asks for
 * more than this service will spend on one call. A typed failure is how the
 * server already learns which status to send; nothing else has to know this
 * limit exists.
 */
function tooManyResourceIds(): GrpcStatusError {
  return new GrpcStatusError(
    GRPC_RESOURCE_EXHAUSTED,
    `a request may name at most ${MAXIMUM_RESOURCE_IDS} resources`,
  );
}

/** The full gRPC method paths, as they appear on an HTTP/2 `:path`. */
export const METHOD_CHECK_USER_PERMISSION = "/epic_urc.UrcAuthApi/CheckUserPermission";
export const METHOD_LOOKUP_USER_PERMISSIONS = "/epic_urc.UrcAuthApi/LookupUserPermissions";
export const METHOD_EXCHANGE_EXTERNAL_TOKEN =
  "/epic_urc.UrcAuthApi/ExchangeExternalTokenForUserToken";
export const METHOD_EXCHANGE_MULTIRESOURCE_TOKEN =
  "/epic_urc.UrcAuthApi/ExchangeUserTokenForMultiresourceToken";
export const METHOD_HEALTH_CHECK = "/epic_urc.UrcAuthApi/HealthCheck";
export const METHOD_CREATE_RESOURCE = "/ucs.auth.RebacApi/CreateResource";
export const METHOD_DELETE_RESOURCE = "/ucs.auth.RebacApi/DeleteResource";
export const METHOD_REPOSITORY_CREATE = "/lore.repository.v1.RepositoryService/RepositoryCreate";
export const METHOD_REPOSITORY_GET = "/lore.repository.v1.RepositoryService/RepositoryGet";

/**
 * The encoding of a message with no fields.
 *
 * `CreateResourceResponse` and `DeleteResourceResponse` are both empty, and an
 * empty message is zero bytes — not an absent body. A gRPC reply still carries
 * one length-prefixed frame holding those zero bytes.
 */
export const EMPTY_MESSAGE: Buffer = Buffer.alloc(0);

/** What one resource a caller may reach is called, and what they may do to it. */
export interface ResourcePermission {
  readonly resourceId: string;
  /**
   * The verbs granted.
   *
   * loreserver 0.8.6 does not read this list: it matches the `resource_id` of
   * the first entry against the one it asked about and takes that as the
   * answer. It is filled in anyway, because it is what the audit trail and any
   * later reader of the protocol would expect to find there.
   */
  readonly permission: readonly string[];
}

function writeResourcePermission(value: ResourcePermission): MessageWriter {
  const writer = new MessageWriter();
  if (value.resourceId !== "") {
    writer.string(1, value.resourceId);
  }
  for (const permission of value.permission) {
    writer.string(2, permission);
  }
  return writer;
}

function readResourcePermission(reader: MessageReader): ResourcePermission {
  let resourceId = "";
  const permission: string[] = [];
  readFields(reader, (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      resourceId = message.readString();
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      permission.push(message.readString());
      return true;
    }
    return false;
  });
  return { resourceId, permission };
}

/**
 * Whom a permission question is about, when it is not about the bearer of the
 * token the call carries.
 *
 * loreserver 0.8.6 leaves this out and forwards the caller's own
 * `authorization` header instead, so in practice Team answers about the bearer.
 * It is read regardless: a request that names somebody else and is answered
 * about the bearer would be an answer to a different question.
 */
export interface TargetUser {
  readonly userToken: string;
}

/** `epic_urc.CheckUserPermissionRequest`. */
export interface CheckUserPermissionRequest {
  readonly resourceIds: readonly string[];
  readonly targetUser?: TargetUser | undefined;
}

export function encodeCheckUserPermissionRequest(value: CheckUserPermissionRequest): Buffer {
  const writer = new MessageWriter();
  for (const resourceId of value.resourceIds) {
    writer.string(1, resourceId);
  }
  if (value.targetUser !== undefined) {
    writer.message(2, new MessageWriter().string(1, value.targetUser.userToken));
  }
  return writer.finish();
}

export function decodeCheckUserPermissionRequest(bytes: Uint8Array): CheckUserPermissionRequest {
  const resourceIds: string[] = [];
  let targetUser: TargetUser | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      if (resourceIds.length === MAXIMUM_RESOURCE_IDS) {
        throw tooManyResourceIds();
      }
      resourceIds.push(message.readString());
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      let userToken = "";
      readFields(message.readMessage(), (inner, target) => {
        if (inner.field === 1 && inner.wireType === WIRE_DELIMITED) {
          userToken = target.readString();
          return true;
        }
        return false;
      });
      targetUser = { userToken };
      return true;
    }
    return false;
  });
  return { resourceIds, targetUser };
}

/** `epic_urc.CheckUserPermissionResponse`. */
export interface CheckUserPermissionResponse {
  readonly allowed: readonly ResourcePermission[];
  readonly denied: readonly ResourcePermission[];
}

export function encodeCheckUserPermissionResponse(value: CheckUserPermissionResponse): Buffer {
  const writer = new MessageWriter();
  for (const allowed of value.allowed) {
    writer.message(1, writeResourcePermission(allowed));
  }
  for (const denied of value.denied) {
    writer.message(2, writeResourcePermission(denied));
  }
  return writer.finish();
}

export function decodeCheckUserPermissionResponse(bytes: Uint8Array): CheckUserPermissionResponse {
  const allowed: ResourcePermission[] = [];
  const denied: ResourcePermission[] = [];
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      allowed.push(readResourcePermission(message.readMessage()));
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      denied.push(readResourcePermission(message.readMessage()));
      return true;
    }
    return false;
  });
  return { allowed, denied };
}

/** `epic_urc.LookupUserPermissionsRequest`. */
export interface LookupUserPermissionsRequest {
  readonly resourceFilter: string;
  readonly contextFilter?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly pageToken?: string | undefined;
}

export function encodeLookupUserPermissionsRequest(value: LookupUserPermissionsRequest): Buffer {
  const writer = new MessageWriter();
  if (value.resourceFilter !== "") {
    writer.string(1, value.resourceFilter);
  }
  if (value.contextFilter !== undefined) {
    writer.string(2, value.contextFilter);
  }
  if (value.pageSize !== undefined) {
    writer.varint(3, value.pageSize);
  }
  if (value.pageToken !== undefined) {
    writer.string(4, value.pageToken);
  }
  return writer.finish();
}

export function decodeLookupUserPermissionsRequest(
  bytes: Uint8Array,
): LookupUserPermissionsRequest {
  let resourceFilter = "";
  let contextFilter: string | undefined;
  let pageSize: number | undefined;
  let pageToken: string | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      resourceFilter = message.readString();
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      contextFilter = message.readString();
      return true;
    }
    if (tag.field === 3 && tag.wireType === WIRE_VARINT) {
      // An `int32` is sign-extended to 64 bits on the wire, so a negative page
      // size arrives as a very large unsigned number and is turned back here.
      pageSize = Number(BigInt.asIntN(32, message.readVarint()));
      return true;
    }
    if (tag.field === 4 && tag.wireType === WIRE_DELIMITED) {
      pageToken = message.readString();
      return true;
    }
    return false;
  });
  return { resourceFilter, contextFilter, pageSize, pageToken };
}

/** `epic_urc.LookupUserPermissionsResponse`. */
export interface LookupUserPermissionsResponse {
  readonly permissions: readonly ResourcePermission[];
  readonly nextPageToken?: string | undefined;
}

export function encodeLookupUserPermissionsResponse(value: LookupUserPermissionsResponse): Buffer {
  const writer = new MessageWriter();
  for (const permission of value.permissions) {
    writer.message(1, writeResourcePermission(permission));
  }
  if (value.nextPageToken !== undefined) {
    writer.string(2, value.nextPageToken);
  }
  return writer.finish();
}

export function decodeLookupUserPermissionsResponse(
  bytes: Uint8Array,
): LookupUserPermissionsResponse {
  const permissions: ResourcePermission[] = [];
  let nextPageToken: string | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      permissions.push(readResourcePermission(message.readMessage()));
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      nextPageToken = message.readString();
      return true;
    }
    return false;
  });
  return { permissions, nextPageToken };
}

/**
 * `epic_urc.UserToken`: what an exchange hands back.
 *
 * Two things about this message are worth knowing before changing it, because
 * both were found by watching a real client fail rather than by reading the
 * protocol file:
 *
 *   - `user_token` in the response is this message, not a string. A bare string
 *     there makes the client fail decoding with "invalid wire type value: 7",
 *     which reads like a corrupt reply rather than a mistake in the reply's
 *     shape.
 *   - `expires_at` is an `int64` of seconds since the epoch, and a varint on the
 *     wire. Written as a string it breaks decoding in the same way.
 */
export interface UserToken {
  readonly userToken: string;
  /** Seconds since the epoch, as the field's `int64` says. */
  readonly expiresAt: number;
  readonly userId: string;
  readonly userName: string;
}

function writeUserToken(value: UserToken): MessageWriter {
  const writer = new MessageWriter();
  if (value.userToken !== "") {
    writer.string(1, value.userToken);
  }
  if (value.expiresAt !== 0) {
    writer.varint(2, value.expiresAt);
  }
  if (value.userId !== "") {
    writer.string(3, value.userId);
  }
  if (value.userName !== "") {
    writer.string(4, value.userName);
  }
  return writer;
}

function readUserToken(reader: MessageReader): UserToken {
  let userToken = "";
  let expiresAt = 0;
  let userId = "";
  let userName = "";
  readFields(reader, (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      userToken = message.readString();
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_VARINT) {
      expiresAt = Number(BigInt.asIntN(64, message.readVarint()));
      return true;
    }
    if (tag.field === 3 && tag.wireType === WIRE_DELIMITED) {
      userId = message.readString();
      return true;
    }
    if (tag.field === 4 && tag.wireType === WIRE_DELIMITED) {
      userName = message.readString();
      return true;
    }
    return false;
  });
  return { userToken, expiresAt, userId, userName };
}

/** `epic_urc.ExchangeExternalTokenForUserTokenRequest`. */
export interface ExchangeExternalTokenForUserTokenRequest {
  readonly externalToken: string;
  readonly tokenType: string;
}

export function encodeExchangeExternalTokenForUserTokenRequest(
  value: ExchangeExternalTokenForUserTokenRequest,
): Buffer {
  const writer = new MessageWriter();
  if (value.externalToken !== "") {
    writer.string(1, value.externalToken);
  }
  if (value.tokenType !== "") {
    writer.string(2, value.tokenType);
  }
  return writer.finish();
}

export function decodeExchangeExternalTokenForUserTokenRequest(
  bytes: Uint8Array,
): ExchangeExternalTokenForUserTokenRequest {
  let externalToken = "";
  let tokenType = "";
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      externalToken = message.readString();
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      tokenType = message.readString();
      return true;
    }
    return false;
  });
  return { externalToken, tokenType };
}

/** `epic_urc.ExchangeExternalTokenForUserTokenResponse`. */
export interface ExchangeExternalTokenForUserTokenResponse {
  readonly userToken?: UserToken | undefined;
}

export function encodeExchangeExternalTokenForUserTokenResponse(
  value: ExchangeExternalTokenForUserTokenResponse,
): Buffer {
  const writer = new MessageWriter();
  if (value.userToken !== undefined) {
    writer.message(1, writeUserToken(value.userToken));
  }
  return writer.finish();
}

export function decodeExchangeExternalTokenForUserTokenResponse(
  bytes: Uint8Array,
): ExchangeExternalTokenForUserTokenResponse {
  let userToken: UserToken | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      userToken = readUserToken(message.readMessage());
      return true;
    }
    return false;
  });
  return { userToken };
}

/**
 * `epic_urc.ExchangeUserTokenForMultiresourceTokenRequest`.
 *
 * What a client asks for before it touches a repository's data. The user token
 * it already holds is in the `authorization` header, as it is on every other
 * call; this message carries only the resources the token is wanted for.
 *
 * The field is repeated, which one resource encodes indistinguishably from a
 * singular field — the name of the method is what says which it is. A request
 * observed from lore 0.8.5 asking to open one repository was, exactly:
 *
 *     0a 24 "urc-57d679274c65429db58d797cf10aa741"
 */
export interface ExchangeUserTokenForMultiresourceTokenRequest {
  readonly resourceIds: readonly string[];
}

export function encodeExchangeUserTokenForMultiresourceTokenRequest(
  value: ExchangeUserTokenForMultiresourceTokenRequest,
): Buffer {
  const writer = new MessageWriter();
  for (const resourceId of value.resourceIds) {
    writer.string(1, resourceId);
  }
  return writer.finish();
}

export function decodeExchangeUserTokenForMultiresourceTokenRequest(
  bytes: Uint8Array,
): ExchangeUserTokenForMultiresourceTokenRequest {
  const resourceIds: string[] = [];
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      if (resourceIds.length === MAXIMUM_RESOURCE_IDS) {
        throw tooManyResourceIds();
      }
      resourceIds.push(message.readString());
      return true;
    }
    return false;
  });
  return { resourceIds };
}

/**
 * `epic_urc.ExchangeUserTokenForMultiresourceTokenResponse`.
 *
 * One field, named `token` rather than `user_token` — the client library's own
 * descriptor strings say so — and carrying the same `UserToken` message the
 * other exchange returns. A client that finds it empty reports "empty user
 * token in exchange response".
 */
export interface ExchangeUserTokenForMultiresourceTokenResponse {
  readonly token?: UserToken | undefined;
}

export function encodeExchangeUserTokenForMultiresourceTokenResponse(
  value: ExchangeUserTokenForMultiresourceTokenResponse,
): Buffer {
  const writer = new MessageWriter();
  if (value.token !== undefined) {
    writer.message(1, writeUserToken(value.token));
  }
  return writer.finish();
}

export function decodeExchangeUserTokenForMultiresourceTokenResponse(
  bytes: Uint8Array,
): ExchangeUserTokenForMultiresourceTokenResponse {
  let token: UserToken | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      token = readUserToken(message.readMessage());
      return true;
    }
    return false;
  });
  return { token };
}

/** `epic_urc.HealthCheckResponse`. */
export function encodeHealthCheckResponse(status: string): Buffer {
  const writer = new MessageWriter();
  if (status !== "") {
    writer.string(1, status);
  }
  return writer.finish();
}

/** `ucs.auth.CreateResourceRequest`. */
export interface CreateResourceRequest {
  readonly resourceId: string;
  readonly resourceName: string;
}

export function encodeCreateResourceRequest(value: CreateResourceRequest): Buffer {
  const writer = new MessageWriter();
  if (value.resourceId !== "") {
    writer.string(1, value.resourceId);
  }
  if (value.resourceName !== "") {
    writer.string(2, value.resourceName);
  }
  return writer.finish();
}

export function decodeCreateResourceRequest(bytes: Uint8Array): CreateResourceRequest {
  let resourceId = "";
  let resourceName = "";
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      resourceId = message.readString();
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      resourceName = message.readString();
      return true;
    }
    return false;
  });
  return { resourceId, resourceName };
}

/** `ucs.auth.DeleteResourceRequest`. */
export interface DeleteResourceRequest {
  readonly resourceId: string;
}

export function encodeDeleteResourceRequest(value: DeleteResourceRequest): Buffer {
  const writer = new MessageWriter();
  if (value.resourceId !== "") {
    writer.string(1, value.resourceId);
  }
  return writer.finish();
}

export function decodeDeleteResourceRequest(bytes: Uint8Array): DeleteResourceRequest {
  let resourceId = "";
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      resourceId = message.readString();
      return true;
    }
    return false;
  });
  return { resourceId };
}

/**
 * `lore.model.v1.Repository`: what loreserver holds about one repository.
 *
 * The two identifiers are 16 raw bytes on the wire. They are carried here as
 * lower-case hex, because that is the form they are stored, logged and turned
 * into a resource id in — see src/projects/registry.ts.
 */
export interface Repository {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultBranchId: string;
  readonly defaultBranchName: string;
  readonly creator: string;
  /** Milliseconds since the epoch, assigned by loreserver. */
  readonly created: number;
  /** The current metadata pointer, as hex; empty for a repository with none. */
  readonly metadata: string;
}

function readRepository(reader: MessageReader): Repository {
  let id = "";
  let name = "";
  let description = "";
  let defaultBranchId = "";
  let defaultBranchName = "";
  let creator = "";
  let created = 0;
  let metadata = "";
  readFields(reader, (tag, message) => {
    if (tag.wireType === WIRE_DELIMITED) {
      switch (tag.field) {
        case 1:
          id = message.readDelimited().toString("hex");
          return true;
        case 2:
          name = message.readString();
          return true;
        case 3:
          description = message.readString();
          return true;
        case 4:
          defaultBranchId = message.readDelimited().toString("hex");
          return true;
        case 5:
          defaultBranchName = message.readString();
          return true;
        case 6:
          creator = message.readString();
          return true;
        case 8:
          metadata = message.readDelimited().toString("hex");
          return true;
        default:
          return false;
      }
    }
    if (tag.field === 7 && tag.wireType === WIRE_VARINT) {
      created = message.readNumber();
      return true;
    }
    return false;
  });
  return {
    id,
    name,
    description,
    defaultBranchId,
    defaultBranchName,
    creator,
    created,
    metadata,
  };
}

function writeRepository(value: Repository): MessageWriter {
  const writer = new MessageWriter();
  if (value.id !== "") {
    writer.bytes(1, Buffer.from(value.id, "hex"));
  }
  if (value.name !== "") {
    writer.string(2, value.name);
  }
  if (value.description !== "") {
    writer.string(3, value.description);
  }
  if (value.defaultBranchId !== "") {
    writer.bytes(4, Buffer.from(value.defaultBranchId, "hex"));
  }
  if (value.defaultBranchName !== "") {
    writer.string(5, value.defaultBranchName);
  }
  if (value.creator !== "") {
    writer.string(6, value.creator);
  }
  if (value.created !== 0) {
    writer.varint(7, value.created);
  }
  if (value.metadata !== "") {
    writer.bytes(8, Buffer.from(value.metadata, "hex"));
  }
  return writer;
}

/** `lore.repository.v1.RepositoryCreateRequest`. */
export interface RepositoryCreateRequest {
  /** 16 bytes as lower-case hex, generated by the caller. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 16 bytes as lower-case hex, generated by the caller. */
  readonly defaultBranchId: string;
  readonly defaultBranchName: string;
  /**
   * Whom the repository is attributed to. Left out so that loreserver
   * attributes it to the identity in the token the call carries; naming
   * somebody else needs a permission of its own.
   */
  readonly creator?: string | undefined;
}

export function encodeRepositoryCreateRequest(value: RepositoryCreateRequest): Buffer {
  const writer = new MessageWriter();
  if (value.id !== "") {
    writer.bytes(1, Buffer.from(value.id, "hex"));
  }
  if (value.name !== "") {
    writer.string(2, value.name);
  }
  if (value.description !== "") {
    writer.string(3, value.description);
  }
  if (value.defaultBranchId !== "") {
    writer.bytes(4, Buffer.from(value.defaultBranchId, "hex"));
  }
  if (value.defaultBranchName !== "") {
    writer.string(5, value.defaultBranchName);
  }
  if (value.creator !== undefined) {
    writer.string(6, value.creator);
  }
  return writer.finish();
}

export function decodeRepositoryCreateRequest(bytes: Uint8Array): RepositoryCreateRequest {
  let id = "";
  let name = "";
  let description = "";
  let defaultBranchId = "";
  let defaultBranchName = "";
  let creator: string | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.wireType !== WIRE_DELIMITED) {
      return false;
    }
    switch (tag.field) {
      case 1:
        id = message.readDelimited().toString("hex");
        return true;
      case 2:
        name = message.readString();
        return true;
      case 3:
        description = message.readString();
        return true;
      case 4:
        defaultBranchId = message.readDelimited().toString("hex");
        return true;
      case 5:
        defaultBranchName = message.readString();
        return true;
      case 6:
        creator = message.readString();
        return true;
      default:
        return false;
    }
  });
  return { id, name, description, defaultBranchId, defaultBranchName, creator };
}

/**
 * `lore.repository.v1.RepositoryGetRequest`, whose one field is a `oneof`.
 *
 * A `oneof` is not a wire construct: its members are ordinary fields, and what
 * makes them exclusive is that a sender writes one of them. Writing both would
 * encode without complaint and leave the receiver to keep whichever came last.
 */
export type RepositoryQuery =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "name"; readonly name: string };

export function encodeRepositoryGetRequest(query: RepositoryQuery): Buffer {
  const writer = new MessageWriter();
  if (query.kind === "id") {
    writer.bytes(1, Buffer.from(query.id, "hex"));
  } else {
    writer.string(2, query.name);
  }
  return writer.finish();
}

export function decodeRepositoryGetRequest(bytes: Uint8Array): RepositoryQuery | undefined {
  let query: RepositoryQuery | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      query = { kind: "id", id: message.readDelimited().toString("hex") };
      return true;
    }
    if (tag.field === 2 && tag.wireType === WIRE_DELIMITED) {
      query = { kind: "name", name: message.readString() };
      return true;
    }
    return false;
  });
  return query;
}

/**
 * The single `repository` field that both `RepositoryCreateResponse` and
 * `RepositoryGetResponse` carry, at field 1 in each.
 */
export function encodeRepositoryResponse(repository: Repository): Buffer {
  return new MessageWriter().message(1, writeRepository(repository)).finish();
}

export function decodeRepositoryResponse(bytes: Uint8Array): Repository | undefined {
  let repository: Repository | undefined;
  readFields(new MessageReader(bytes), (tag, message) => {
    if (tag.field === 1 && tag.wireType === WIRE_DELIMITED) {
      repository = readRepository(message.readMessage());
      return true;
    }
    return false;
  });
  return repository;
}
