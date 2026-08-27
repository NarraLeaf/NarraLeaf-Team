/**
 * The addresses a live session's bytes travel over.
 *
 * The socket carries what people say to each other and is capped at sixteen kilobytes a message,
 * which is right for a line of prose and hopeless for a file. So a file goes over its own request,
 * on the same listener and behind the same certificate as everything else here - one address, one
 * fingerprint an operator compared once, and no second decision to trust. See src/web/router.ts.
 *
 * Five verbs on one address, and each of them is a sentence about the same object:
 *
 *   POST    reserve it, saying how long it is and what it will hash to
 *   PATCH   append to it, from the byte the sender believes it has reached
 *   GET     read it, from the byte the receiver has reached, going on as it is written
 *   HEAD    say how much of it is here, which is what a resumption asks first
 *   DELETE  drop it, which is what cancelling an import reaches
 *
 * ⚠ **Nothing here buffers a body.** The request is handed to the store as a stream and the
 * response is written from one, so a two-hundred-megabyte file costs this process a socket buffer
 * rather than two hundred megabytes. That is the entire reason these are not routes in
 * src/web/studio.ts, whose `readJson` reads a whole body into memory and refuses past four
 * kilobytes - correctly, for what it serves.
 *
 * ## Who may
 *
 * A bearer token, and a header naming the client instance making the request. The instance must be
 * one this server currently knows to have that project open, on that account: a window of that
 * person's Studio, connected right now, looking at this project. That is what a room's membership
 * is made of, so it is the same authorisation the old byte channel had - and because it is about
 * the instance rather than about a room, it goes on being answerable after a room has ended, which
 * is what lets a transfer resume across a session boundary.
 *
 * And, before either of those, a deployment that is a collaboration server at all. A file for a
 * live session is a collaboration service, so `server.collaboration` shuts these addresses along
 * with the rest - checked here on the setting rather than left to the capability disappearing,
 * because the instance this route admits may have announced itself before the switch. See
 * src/team/collaboration.ts.
 */
import { bearerToken, describeRefusal, identifyToken } from "../identity/bearer.js";
import { findProject } from "../projects/registry.js";
import { isBlobName, type TeamBlobStore } from "../team/blobs.js";
import { judgeBlobRoute } from "../team/collaboration.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamPresence } from "../team/presence.js";
import type { TeamService } from "../team/service.js";

/** Where these live. Versioned with the rest of the Team protocol, not with the Studio REST API. */
const PREFIX = "/api/team/v1/blobs";

/** The header a sender says where it has got to in. */
const OFFSET_HEADER = "nl-blob-offset";

/** The header a caller names its client instance in. */
const INSTANCE_HEADER = "nl-instance";

/** What a HEAD answers with, and what a GET repeats so a reader need not ask twice. */
const LENGTH_HEADER = "nl-blob-length";
const RECEIVED_HEADER = "nl-blob-received";
const COMPLETE_HEADER = "nl-blob-complete";
const DIGEST_HEADER = "nl-blob-digest";

/** What the router hands in when this build serves blobs at all. */
export interface BlobRoutesOptions {
  readonly store: TeamBlobStore;
  readonly presence: TeamPresence;
  readonly service: TeamService;
}

/**
 * Answer one request, or say it was not ours.
 *
 * False only for a path outside the prefix. Everything inside it is answered here, refusals
 * included - the same contract src/web/studio.ts's router has, for the same reason: two arms that
 * both half-claim an address produce a 404 that depends on the order they were tried in.
 */
export function serveTeamBlobs(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    return false;
  }

  const named = beneath(path);
  if (named === undefined) {
    refuse(response, 404, "a blob is addressed by a project and a transfer.");
    return true;
  }

  const allowed = permit(options, request, response, named.project);
  if (allowed === undefined) {
    return true;
  }

  const work = answer(options, request, response, named);
  void work.catch((cause: unknown) => {
    options.service.log?.(
      `blob request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    if (response.headersSent) {
      // The status was already sent, so the only remaining way to say something went wrong is to
      // stop short of the length that was promised. A reader that is short asks again from where
      // it got to, which is what it does after any other interruption.
      response.end();
      return;
    }
    refuse(response, 500, "this server could not answer that.");
  });
  return true;
}

async function answer(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  switch (request.method) {
    case "POST":
      return reserve(options, request, response, named);
    case "PATCH":
      return append(options, request, response, named);
    case "GET":
      return read(options, request, response, named);
    case "HEAD":
      return head(options, response, named);
    case "DELETE":
      return drop(options, response, named);
    default:
      response.writeHead(405, {
        allow: "POST, PATCH, GET, HEAD, DELETE",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "that address answers POST, PATCH, GET, HEAD and DELETE." }));
      return;
  }
}

/* ------------------------------------------------------------------------------- the five verbs */

async function reserve(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  const query = new URL(request.url ?? "/", "http://team.invalid").searchParams;
  const length = wholeNumber(query.get("length"));
  const digest = query.get("digest") ?? "";
  if (length === undefined || digest === "" || digest.length > 128) {
    refuse(response, 400, "a reservation names how long the file is and what it hashes to.");
    return;
  }

  const made = await options.store.reserve({ ...named, length, digest });
  if (!made.ok) {
    if (made.refusal.kind === "taken") {
      refuse(response, 409, "a different file is already reserved under that name.");
      return;
    }
    // 507, and not 413: what is full is this server, and the sentence has to be one an author can
    // act on. The client turns it into the name of the file it could not carry.
    response.writeHead(507, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        error: "this project has as many bytes in flight as it may.",
        reserved: made.refusal.reserved,
        limit: made.refusal.limit,
      }),
    );
    return;
  }
  sendJson(response, 201, made.description);
}

async function append(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  const offset = wholeNumber(header(request, OFFSET_HEADER));
  if (offset === undefined) {
    refuse(response, 400, `an append says where it starts, in ${OFFSET_HEADER}.`);
    return;
  }

  const outcome = await options.store.append({ ...named, offset, source: request });
  if (outcome.ok) {
    sendJson(response, 200, options.store.describe(named.project, named.transfer) ?? {});
    return;
  }
  switch (outcome.kind) {
    case "offset":
      // The one refusal a sender recovers from without being told twice: it is told where the file
      // actually ends, and goes on from there.
      response.writeHead(409, {
        "content-type": "application/json; charset=utf-8",
        [RECEIVED_HEADER]: String(outcome.received),
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "that is not where this file ends.", received: outcome.received }));
      return;
    case "over":
      refuse(response, 400, "that is more than was reserved.");
      return;
    case "busy":
      refuse(response, 409, "something is already appending to that file.");
      return;
    case "gone":
      refuse(response, 404, "nothing is reserved under that name.");
      return;
  }
}

async function read(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  const known = options.store.describe(named.project, named.transfer);
  if (known === undefined) {
    refuse(response, 404, "nothing is reserved under that name.");
    return;
  }
  const from = rangeStart(header(request, "range")) ?? 0;
  if (from > known.length) {
    refuse(response, 416, "that is past the end of the file.");
    return;
  }

  // No content-length: what is here now is not what will be here by the time this response ends,
  // because a reader is held at the end of the file while the sender is still writing. The reader
  // measures what it has landed rather than trusting a promise made before the file existed.
  response.writeHead(from === 0 ? 200 : 206, {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
    [LENGTH_HEADER]: String(known.length),
    [DIGEST_HEADER]: known.digest,
  });

  let stopped = false;
  response.on("close", () => {
    stopped = true;
  });
  for await (const chunk of options.store.read(named.project, named.transfer, from)) {
    if (stopped) {
      return;
    }
    if (!response.write(chunk)) {
      // Backpressure, and the only flow control here: the store is not asked for another byte
      // until this socket has taken the last one. ⚠ Both listeners come off again either way -
      // a large file is thousands of these, and one left behind per chunk is a leak that
      // announces itself as a warning about listeners rather than as a leak.
      await new Promise<void>((settle) => {
        const done = (): void => {
          response.off("drain", done);
          response.off("close", done);
          settle();
        };
        response.on("drain", done);
        response.on("close", done);
      });
    }
  }
  response.end();
}

async function head(
  options: BlobRoutesOptions,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  const known = options.store.describe(named.project, named.transfer);
  if (known === undefined) {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    [LENGTH_HEADER]: String(known.length),
    [RECEIVED_HEADER]: String(known.received),
    [COMPLETE_HEADER]: known.complete ? "true" : "false",
    [DIGEST_HEADER]: known.digest,
  });
  response.end();
}

async function drop(
  options: BlobRoutesOptions,
  response: ServerResponse,
  named: { project: string; transfer: string },
): Promise<void> {
  await options.store.drop(named.project, named.transfer);
  // 204 whether or not there was anything there. A cancel reaches this from every machine in the
  // room, and the second one to arrive has not failed at anything.
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

/* ---------------------------------------------------------------------------------- the edges */

/**
 * Who is asking, and whether they may.
 *
 * Undefined once the refusal has been written. Two things are checked and both are load-bearing:
 * the token says which account, and the instance header says which window - and this server only
 * agrees if it currently holds an announcement from that window, for that account, on that project.
 */
function permit(
  options: BlobRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  project: string,
): { instance: string } | undefined {
  const authorization = request.headers["authorization"];
  const token = bearerToken(Array.isArray(authorization) ? authorization[0] : authorization);
  const identified = identifyToken(
    options.service.database,
    options.service.keys,
    options.service.config,
    token,
  );
  if (identified.kind === "refused") {
    refuse(response, 401, describeRefusal(identified.reason));
    return undefined;
  }

  // Before anything about the project, because this is a statement about the
  // deployment rather than about the caller or about what it asked for: a server
  // closed to collaboration does not serve these addresses at all. Read here, on
  // the setting as it stands, rather than left to the capability going quiet -
  // see judgeBlobRoute, which says why the announcement and the methods together
  // are not enough to shut this door.
  const collaboration = judgeBlobRoute(options.service.database);
  if (collaboration.kind === "refused") {
    refuse(response, 403, collaboration.detail);
    return undefined;
  }

  if (findProject(options.service.database, project) === undefined) {
    refuse(response, 404, "this server has no project by that name.");
    return undefined;
  }

  const instance = header(request, INSTANCE_HEADER);
  if (instance === undefined) {
    refuse(response, 403, `a blob request names the installation making it, in ${INSTANCE_HEADER}.`);
    return undefined;
  }
  const announced = options.presence
    .clients(project)
    .some((each) => each.id === instance && each.account === identified.user.username);
  if (!announced) {
    refuse(response, 403, "that installation does not have this project open on this server.");
    return undefined;
  }
  return { instance };
}

/** The project and transfer an address names, or undefined for one that names neither. */
function beneath(path: string): { project: string; transfer: string } | undefined {
  if (!path.startsWith(`${PREFIX}/`)) {
    return undefined;
  }
  const [project, transfer, ...more] = path.slice(PREFIX.length + 1).split("/");
  if (project === undefined || transfer === undefined || more.length > 0) {
    return undefined;
  }
  const named = { project: decodeSegment(project), transfer: decodeSegment(transfer) };
  if (named.project === undefined || named.transfer === undefined) {
    return undefined;
  }
  // ⚠ Checked here as well as in the store. Both of these become directory entries, and they are
  // chosen by another machine.
  if (!isBlobName(named.project) || !isBlobName(named.transfer)) {
    return undefined;
  }
  return { project: named.project, transfer: named.transfer };
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === "" ? undefined : single;
}

/** A count of bytes, written the one way that cannot be `1e9`, `0x10` or ` 4`. */
function wholeNumber(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null || !/^\d{1,16}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** Only the open form, `bytes=N-`: this reads forwards from where a machine got to, and nothing else. */
function rangeStart(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const matched = /^bytes=(\d{1,16})-$/.exec(value.trim());
  return matched === undefined || matched === null ? undefined : Number(matched[1]);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function refuse(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}
