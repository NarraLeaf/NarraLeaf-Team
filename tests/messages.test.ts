import { describe, expect, it } from "vitest";

import {
  decodeCheckUserPermissionRequest,
  decodeCheckUserPermissionResponse,
  decodeCreateResourceRequest,
  decodeDeleteResourceRequest,
  decodeExchangeExternalTokenForUserTokenRequest,
  decodeExchangeExternalTokenForUserTokenResponse,
  decodeLookupUserPermissionsRequest,
  decodeLookupUserPermissionsResponse,
  decodeRepositoryCreateRequest,
  decodeRepositoryGetRequest,
  decodeRepositoryResponse,
  encodeCheckUserPermissionRequest,
  encodeCheckUserPermissionResponse,
  encodeCreateResourceRequest,
  encodeDeleteResourceRequest,
  encodeExchangeExternalTokenForUserTokenRequest,
  encodeExchangeExternalTokenForUserTokenResponse,
  encodeLookupUserPermissionsRequest,
  encodeLookupUserPermissionsResponse,
  encodeRepositoryCreateRequest,
  encodeRepositoryGetRequest,
  encodeRepositoryResponse,
  type Repository,
} from "../src/grpc/messages.js";
import { MessageWriter } from "../src/grpc/protobuf.js";

const REPOSITORY: Repository = {
  id: "0123456789abcdef0123456789abcdef",
  name: "moonlit-harbour",
  description: "a game about a port at night",
  defaultBranchId: "fedcba9876543210fedcba9876543210",
  defaultBranchName: "main",
  creator: "9a1c0e2e-3b7d-4d2a-8f0e-5b6d7c8e9f00",
  created: 1_786_438_800_123,
  metadata: "aabbcc",
};

describe("CheckUserPermission", () => {
  it("round-trips a request naming several resources", () => {
    const request = { resourceIds: ["urc-aa", "urc-bb", "urc-cc"], targetUser: undefined };

    expect(decodeCheckUserPermissionRequest(encodeCheckUserPermissionRequest(request))).toEqual(
      request,
    );
  });

  it("round-trips a request that names somebody other than the bearer", () => {
    const request = { resourceIds: ["urc-aa"], targetUser: { userToken: "a.b.c" } };

    expect(decodeCheckUserPermissionRequest(encodeCheckUserPermissionRequest(request))).toEqual(
      request,
    );
  });

  it("refuses a request naming more resources than this service will answer about", () => {
    // The enclosing message is capped at four mebibytes and an entry costs two
    // bytes, so one request can name millions of them. Each id that is decoded
    // becomes a database lookup and a written row further on, which is why the
    // list is bounded here rather than by the size of the message around it.
    const many = encodeCheckUserPermissionRequest({
      resourceIds: Array.from({ length: 5000 }, (_, index) => `urc-${index}`),
      targetUser: undefined,
    });

    expect(() => decodeCheckUserPermissionRequest(many)).toThrow(/at most \d+ resources/);
  });

  it("round-trips a response holding both lists", () => {
    const response = {
      allowed: [{ resourceId: "urc-aa", permission: ["read", "write"] }],
      denied: [{ resourceId: "urc-bb", permission: [] }],
    };

    expect(decodeCheckUserPermissionResponse(encodeCheckUserPermissionResponse(response))).toEqual(
      response,
    );
  });

  it("encodes a refusal as an empty message, which is what an empty allow list is", () => {
    const encoded = encodeCheckUserPermissionResponse({ allowed: [], denied: [] });

    expect(encoded).toHaveLength(0);
    expect(decodeCheckUserPermissionResponse(encoded)).toEqual({ allowed: [], denied: [] });
  });

  it("reads a request that named no resources at all", () => {
    expect(decodeCheckUserPermissionRequest(Buffer.alloc(0))).toEqual({
      resourceIds: [],
      targetUser: undefined,
    });
  });
});

describe("LookupUserPermissions", () => {
  it("round-trips a request with every optional field set", () => {
    const request = {
      resourceFilter: "urc-aa",
      contextFilter: "context",
      pageSize: 25,
      pageToken: "page-2",
    };

    expect(
      decodeLookupUserPermissionsRequest(encodeLookupUserPermissionsRequest(request)),
    ).toEqual(request);
  });

  it("tells an absent optional field from one holding its default", () => {
    // proto3's `optional` is the one case where the wire says which it was, and
    // a decoder that started an int32 at 0 rather than at undefined would make
    // "no page size" and "a page size of zero" the same request.
    const absent = decodeLookupUserPermissionsRequest(
      encodeLookupUserPermissionsRequest({ resourceFilter: "" }),
    );
    const present = decodeLookupUserPermissionsRequest(
      encodeLookupUserPermissionsRequest({ resourceFilter: "", pageSize: 0, contextFilter: "" }),
    );

    expect(absent).toEqual({
      resourceFilter: "",
      contextFilter: undefined,
      pageSize: undefined,
      pageToken: undefined,
    });
    expect(present.pageSize).toBe(0);
    expect(present.contextFilter).toBe("");
  });

  it("carries a negative page size back as a negative number", () => {
    const request = { resourceFilter: "", pageSize: -1 };

    expect(decodeLookupUserPermissionsRequest(encodeLookupUserPermissionsRequest(request)).pageSize)
      .toBe(-1);
  });

  it("round-trips a response, with and without another page to come", () => {
    const permissions = [
      { resourceId: "urc-aa", permission: ["read"] },
      { resourceId: "urc-bb", permission: ["read", "write", "owner"] },
    ];

    expect(
      decodeLookupUserPermissionsResponse(
        encodeLookupUserPermissionsResponse({ permissions, nextPageToken: "more" }),
      ),
    ).toEqual({ permissions, nextPageToken: "more" });
    expect(
      decodeLookupUserPermissionsResponse(encodeLookupUserPermissionsResponse({ permissions })),
    ).toEqual({ permissions, nextPageToken: undefined });
  });
});

describe("the token exchange messages", () => {
  it("round-trips the request", () => {
    const request = { externalToken: "header.claims.signature", tokenType: "jwt" };

    expect(
      decodeExchangeExternalTokenForUserTokenRequest(
        encodeExchangeExternalTokenForUserTokenRequest(request),
      ),
    ).toEqual(request);
  });

  it("round-trips a response holding a token, and one holding none", () => {
    const userToken = {
      userToken: "header.claims.signature",
      expiresAt: 1_786_438_800,
      userId: "9a1c0e2e-3b7d-4d2a-8f0e-5b6d7c8e9f00",
      userName: "Ada Lovelace",
    };

    expect(
      decodeExchangeExternalTokenForUserTokenResponse(
        encodeExchangeExternalTokenForUserTokenResponse({ userToken }),
      ),
    ).toEqual({ userToken });
    expect(
      decodeExchangeExternalTokenForUserTokenResponse(
        encodeExchangeExternalTokenForUserTokenResponse({}),
      ),
    ).toEqual({ userToken: undefined });
  });
});

describe("the resource messages", () => {
  it("round-trips CreateResourceRequest and DeleteResourceRequest", () => {
    const create = { resourceId: "urc-0123", resourceName: "moonlit-harbour" };

    expect(decodeCreateResourceRequest(encodeCreateResourceRequest(create))).toEqual(create);
    expect(decodeDeleteResourceRequest(encodeDeleteResourceRequest({ resourceId: "urc-0123" })))
      .toEqual({ resourceId: "urc-0123" });
  });
});

describe("the repository messages", () => {
  it("round-trips a create request, ids and all", () => {
    const request = {
      id: REPOSITORY.id,
      name: REPOSITORY.name,
      description: REPOSITORY.description,
      defaultBranchId: REPOSITORY.defaultBranchId,
      defaultBranchName: REPOSITORY.defaultBranchName,
      creator: undefined,
    };

    expect(decodeRepositoryCreateRequest(encodeRepositoryCreateRequest(request))).toEqual(request);
  });

  it("writes the sixteen bytes of an id, not the thirty-two characters of its hex", () => {
    const encoded = encodeRepositoryCreateRequest({
      id: REPOSITORY.id,
      name: "",
      description: "",
      defaultBranchId: "",
      defaultBranchName: "",
    });

    // Tag, length 16, then the bytes themselves.
    expect(encoded.toString("hex")).toBe(`0a10${REPOSITORY.id}`);
  });

  it("round-trips a repository record, including the timestamp", () => {
    expect(decodeRepositoryResponse(encodeRepositoryResponse(REPOSITORY))).toEqual(REPOSITORY);
  });

  it("says when a reply carried no repository at all", () => {
    expect(decodeRepositoryResponse(Buffer.alloc(0))).toBeUndefined();
  });

  it("round-trips a lookup by id and a lookup by name", () => {
    expect(decodeRepositoryGetRequest(encodeRepositoryGetRequest({ kind: "id", id: REPOSITORY.id })))
      .toEqual({ kind: "id", id: REPOSITORY.id });
    expect(
      decodeRepositoryGetRequest(encodeRepositoryGetRequest({ kind: "name", name: "moonlit" })),
    ).toEqual({ kind: "name", name: "moonlit" });
  });

  it("keeps the last member of a oneof, as a receiver of two must", () => {
    const both = Buffer.concat([
      encodeRepositoryGetRequest({ kind: "id", id: REPOSITORY.id }),
      encodeRepositoryGetRequest({ kind: "name", name: "moonlit" }),
    ]);

    expect(decodeRepositoryGetRequest(both)).toEqual({ kind: "name", name: "moonlit" });
  });
});

describe("fields nothing here knows about", () => {
  it("reads the fields it knows out of a message carrying extra ones", () => {
    // A later loreserver adding a field must not stop Team reading the rest.
    const encoded = Buffer.concat([
      encodeCheckUserPermissionRequest({ resourceIds: ["urc-aa"] }),
      new MessageWriter().varint(9, 1).string(10, "added later").finish(),
    ]);

    expect(decodeCheckUserPermissionRequest(encoded).resourceIds).toEqual(["urc-aa"]);
  });

  it("skips a known field number that arrived with the wrong wire type", () => {
    const encoded = new MessageWriter().varint(1, 7).string(1, "urc-aa").finish();

    expect(decodeCheckUserPermissionRequest(encoded).resourceIds).toEqual(["urc-aa"]);
  });
});
