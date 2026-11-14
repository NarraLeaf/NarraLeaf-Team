/**
 * Review requests: somebody asks a member of the project to look at a range of
 * its revisions, and the member answers "approved" or "changes".
 *
 * Lighter than a pull request on purpose — there is nothing to merge. The
 * revisions are strings this server stores and never reads, like an anchor's.
 * The line-by-line part is ordinary comment threads; this is the request and
 * the verdict around them.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { integerColumn, optionalTextColumn, textColumn, type Row } from "../identity/database.js";
import { findUserById, type UserRecord } from "../identity/users.js";
import { maySeeProject, projectRole } from "../projects/members.js";
import type { TeamReview, TeamReviewStatus } from "../team/protocol.js";

export const REVIEW_STATUSES: readonly TeamReviewStatus[] = ["open", "approved", "changes", "withdrawn"];

export interface ReviewRecord {
  readonly id: string;
  readonly projectId: string;
  readonly requesterId: string | undefined;
  readonly reviewerId: string;
  readonly fromRevision: string | undefined;
  readonly toRevision: string;
  readonly title: string;
  readonly note: string | undefined;
  readonly status: TeamReviewStatus;
  readonly verdictNote: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class ReviewRefusal extends Error {
  constructor(
    readonly code: "bad-params" | "refused" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

function toRecord(row: Row): ReviewRecord {
  const status = textColumn(row, "status");
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    requesterId: optionalTextColumn(row, "requester_id"),
    reviewerId: textColumn(row, "reviewer_id"),
    fromRevision: optionalTextColumn(row, "from_revision"),
    toRevision: textColumn(row, "to_revision"),
    title: textColumn(row, "title"),
    note: optionalTextColumn(row, "note"),
    status: (REVIEW_STATUSES as readonly string[]).includes(status) ? (status as TeamReviewStatus) : "open",
    verdictNote: optionalTextColumn(row, "verdict_note"),
    createdAt: integerColumn(row, "created_at"),
    updatedAt: integerColumn(row, "updated_at"),
  };
}

export function findReview(database: DatabaseSync, id: string): ReviewRecord | undefined {
  const row = database.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function reviewView(database: DatabaseSync, review: ReviewRecord): TeamReview {
  return {
    id: review.id,
    project: review.projectId,
    requester: (review.requesterId === undefined ? undefined : findUserById(database, review.requesterId)?.username) ?? "?",
    reviewer: findUserById(database, review.reviewerId)?.username ?? "?",
    ...(review.fromRevision === undefined ? {} : { fromRevision: review.fromRevision }),
    toRevision: review.toRevision,
    title: review.title,
    ...(review.note === undefined ? {} : { note: review.note }),
    status: review.status,
    ...(review.verdictNote === undefined ? {} : { verdictNote: review.verdictNote }),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

/** Ask a member to review. Anybody who can comment on the project may ask; the reviewer must be a member too. */
export function createReview(
  database: DatabaseSync,
  actor: UserRecord,
  input: { projectId: string; reviewerId: string; fromRevision?: string; toRevision: string; title: string; note?: string },
  now = Date.now(),
): ReviewRecord {
  const role = projectRole(database, input.projectId, actor);
  if (role === undefined) throw new ReviewRefusal("not-found", "there is no project of that id on this server");
  if (role === "viewer") throw new ReviewRefusal("refused", "a viewer reads this project and does not ask for reviews in it");
  const reviewer = findUserById(database, input.reviewerId);
  if (reviewer === undefined || !maySeeProject(database, input.projectId, reviewer)) {
    throw new ReviewRefusal("bad-params", "that account is not a member of the project");
  }
  if (reviewer.id === actor.id) throw new ReviewRefusal("bad-params", "ask somebody else to review your work");
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO reviews (id, project_id, requester_id, reviewer_id, from_revision, to_revision, title, note, status,
                            verdict_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
    )
    .run(id, input.projectId, actor.id, reviewer.id, input.fromRevision ?? null, input.toRevision, input.title, input.note ?? null, now, now);
  return findReview(database, id) as ReviewRecord;
}

/**
 * The reviewer gives (or changes) a verdict; the requester withdraws or
 * re-opens. Nobody else moves it.
 */
export function updateReview(
  database: DatabaseSync,
  actor: UserRecord,
  id: string,
  input: { status: TeamReviewStatus; verdictNote?: string },
  now = Date.now(),
): ReviewRecord {
  const current = findReview(database, id);
  if (current === undefined || !maySeeProject(database, current.projectId, actor)) {
    throw new ReviewRefusal("not-found", "there is no review of that id");
  }
  const isReviewer = current.reviewerId === actor.id;
  const isRequester = current.requesterId === actor.id;
  const verdict = input.status === "approved" || input.status === "changes";
  if (verdict && !isReviewer) throw new ReviewRefusal("refused", "only the reviewer gives the verdict");
  if (!verdict && !isRequester) throw new ReviewRefusal("refused", "only who asked may withdraw or re-open the request");
  database
    .prepare("UPDATE reviews SET status = ?, verdict_note = ?, updated_at = ? WHERE id = ?")
    .run(input.status, verdict ? (input.verdictNote ?? null) : (current.verdictNote ?? null), now, id);
  return findReview(database, id) as ReviewRecord;
}

/** One project's reviews, or those the viewer asked for or is asked, newest first. */
export function listReviews(
  database: DatabaseSync,
  viewer: UserRecord,
  query: { projectId?: string; includeClosed: boolean },
): ReviewRecord[] {
  const open = query.includeClosed ? "" : " AND status IN ('open', 'changes')";
  const rows =
    query.projectId !== undefined
      ? (database.prepare(`SELECT * FROM reviews WHERE project_id = ?${open} ORDER BY updated_at DESC LIMIT 200`).all(query.projectId) as Row[])
      : (database
          .prepare(`SELECT * FROM reviews WHERE (reviewer_id = ? OR requester_id = ?)${open} ORDER BY updated_at DESC LIMIT 200`)
          .all(viewer.id, viewer.id) as Row[]);
  return rows.map(toRecord).filter((review) => maySeeProject(database, review.projectId, viewer));
}
