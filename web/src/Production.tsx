/**
 * Review requests, milestones and webhooks in the console.
 *
 * Reviews are a project tab; milestones hang beside the revisions in the
 * history; webhooks are an admin section. All three only call the methods the
 * server already guards — the page hides what a role cannot do, the server
 * refuses it.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  projectMilestonesTopic,
  projectReviewsTopic,
  TEAM_WEBHOOK_EVENTS,
  TEAM_WEBHOOK_FORMATS,
  type TeamDocVersion,
  type TeamMilestone,
  type TeamProjectRole,
  type TeamReview,
  type TeamReviewStatus,
  type TeamWebhook,
  type TeamWebhookEvent,
  type TeamWebhookFormat,
} from "@narraleaf/team-protocol";

import { t, type Phrase } from "./i18n";
import type { TeamConnection } from "./socket";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function when(at: number): string {
  return new Date(at).toLocaleString();
}

const REVIEW_PHRASE: Record<TeamReviewStatus, Phrase> = {
  open: "reviewOpen",
  approved: "reviewApproved",
  changes: "reviewChanges",
  withdrawn: "reviewWithdrawn",
};

interface Member {
  readonly username: string;
  readonly displayName: string;
}

export interface Revision {
  readonly id: string;
  readonly message?: string;
  readonly by?: string;
  readonly at?: number;
  /** What the server knows about a revision it wrote as a history version. */
  readonly version?: TeamDocVersion;
}

/** The line every server-written version ends with; a version saved by hand has its name above it. */
const SNAPSHOT_TRAILER = /(?:^|\n\n)Team snapshot at seq \d+\s*$/;

/** What to call a revision: a version's name, or the first line of a commit's message. */
export function revisionTitle(revision: Revision): string {
  if (revision.version?.label !== undefined) return revision.version.label;
  return (revision.message ?? "").replace(SNAPSHOT_TRAILER, "").trim().split("\n")[0] ?? "";
}

/** Whether the server saved this version on its own: in a list of versions, folded away by default. */
export function isAutoVersion(revision: Revision): boolean {
  if (revision.version !== undefined) return revision.version.auto;
  return SNAPSHOT_TRAILER.test(revision.message ?? "") && revisionTitle(revision) === "";
}

/* --------------------------------------------------------------- reviews */

export function Reviews(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  me: string;
  role: TeamProjectRole | undefined;
  viewAt: (revision: string) => void;
}) {
  const { connection, open, projectId, me, role, viewAt } = props;
  const [reviews, setReviews] = useState<readonly TeamReview[] | undefined>(undefined);
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState({ reviewer: "", toRevision: "", fromRevision: "", title: "", note: "" });
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [showAuto, setShowAuto] = useState(false);

  const load = useCallback(() => {
    connection
      .call<{ reviews: TeamReview[] }>("reviews.list", { project: projectId, includeClosed: true })
      .then((answer) => setReviews(answer.reviews))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [connection, projectId]);

  useEffect(() => {
    if (!open) return undefined;
    load();
    connection
      .call<{ members: Member[] }>("projects.members.list", { project: projectId })
      .then((answer) => setMembers(answer.members))
      .catch(() => undefined);
    connection
      .call<{ revisions: Revision[] }>("projects.history", { project: projectId, limit: 50 })
      .then((answer) => setRevisions(answer.revisions))
      .catch((caught: unknown) => setError(errorText(caught)));
    return connection.subscribe(projectReviewsTopic(projectId), () => load());
  }, [open, load, connection, projectId]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await connection.call("reviews.create", {
        project: projectId,
        reviewer: draft.reviewer,
        toRevision: draft.toRevision,
        ...(draft.fromRevision === "" ? {} : { fromRevision: draft.fromRevision }),
        title: draft.title.trim(),
        ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
      });
      setDraft({ reviewer: "", toRevision: "", fromRevision: "", title: "", note: "" });
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const move = (review: TeamReview, status: TeamReviewStatus) =>
    connection
      .call("reviews.update", { review: review.id, status, ...(verdicts[review.id] ? { verdictNote: verdicts[review.id] } : {}) })
      .catch((caught: unknown) => setError(errorText(caught)));

  const label = (revision: Revision) =>
    `${revision.id.slice(0, 8)} ${(revisionTitle(revision) || (isAutoVersion(revision) ? t("versionAuto") : "")).slice(0, 50)}`;
  // Automatic snapshots come every few minutes; the versions somebody named are what a review is about.
  const picked = new Set([draft.toRevision, draft.fromRevision]);
  const choices = revisions.filter((revision) => showAuto || !isAutoVersion(revision) || picked.has(revision.id));
  const canAsk = role !== undefined && role !== "viewer";
  const ready = draft.reviewer !== "" && draft.toRevision !== "" && draft.title.trim() !== "";

  return (
    <div className="reviews">
      {error !== undefined ? <p className="error">{error}</p> : null}
      {canAsk ? (
        <form className="card review-new" onSubmit={(event) => void ask(event)}>
          <h3>{t("reviewAsk")}</h3>
          <input value={draft.title} placeholder={t("reviewTitle")} maxLength={300} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <div className="review-fields">
            <label>
              {t("reviewer")}
              <select value={draft.reviewer} onChange={(event) => setDraft({ ...draft, reviewer: event.target.value })}>
                <option value="">—</option>
                {members
                  .filter((member) => member.username !== me)
                  .map((member) => (
                    <option key={member.username} value={member.username}>
                      {member.displayName || member.username}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("reviewFrom")}
              <select value={draft.fromRevision} onChange={(event) => setDraft({ ...draft, fromRevision: event.target.value })}>
                <option value="">{t("reviewFromStart")}</option>
                {choices.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {label(revision)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("reviewTo")}
              <select value={draft.toRevision} onChange={(event) => setDraft({ ...draft, toRevision: event.target.value })}>
                <option value="">—</option>
                {choices.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {label(revision)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="small">
            <input type="checkbox" checked={showAuto} onChange={(event) => setShowAuto(event.target.checked)} /> {t("showAuto")}
          </label>
          <textarea value={draft.note} placeholder={t("reviewNote")} rows={2} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
          <button className="primary" type="submit" disabled={!ready}>
            {t("reviewSend")}
          </button>
        </form>
      ) : null}
      {reviews === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : reviews.length === 0 ? (
        <p className="placeholder-card">{t("noReviews")}</p>
      ) : (
        <ul className="review-list">
          {reviews.map((review) => (
            <li key={review.id} className={`card review status-${review.status}`}>
              <div className="review-head">
                <strong>{review.title}</strong>
                <span className={`badge review-${review.status}`}>{t(REVIEW_PHRASE[review.status])}</span>
              </div>
              <div className="muted small">
                {t("reviewWho", { requester: review.requester, reviewer: review.reviewer })} · {when(review.updatedAt)} ·{" "}
                <button className="link" onClick={() => viewAt(review.toRevision)}>
                  {review.fromRevision === undefined ? "…" : review.fromRevision.slice(0, 8)} → {review.toRevision.slice(0, 8)}
                </button>
              </div>
              {review.note ? <p>{review.note}</p> : null}
              {review.verdictNote ? <p className="verdict">“{review.verdictNote}”</p> : null}
              {review.reviewer === me && review.status !== "withdrawn" ? (
                <div className="review-actions">
                  <input
                    value={verdicts[review.id] ?? ""}
                    placeholder={t("reviewVerdictNote")}
                    onChange={(event) => setVerdicts({ ...verdicts, [review.id]: event.target.value })}
                  />
                  <button className="primary small" onClick={() => void move(review, "approved")}>
                    {t("reviewApprove")}
                  </button>
                  <button className="ghost small" onClick={() => void move(review, "changes")}>
                    {t("reviewRequestChanges")}
                  </button>
                </div>
              ) : null}
              {review.requester === me ? (
                <div className="review-actions">
                  {review.status === "withdrawn" ? (
                    <button className="ghost small" onClick={() => void move(review, "open")}>
                      {t("reviewReopen")}
                    </button>
                  ) : (
                    <button className="ghost small" onClick={() => void move(review, "withdrawn")}>
                      {t("reviewWithdraw")}
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ milestones */

/** A project's milestones, kept current, as revision → names. */
export function useMilestones(connection: TeamConnection, open: boolean, projectId: string) {
  const [milestones, setMilestones] = useState<readonly TeamMilestone[]>([]);
  const load = useCallback(() => {
    connection
      .call<{ milestones: TeamMilestone[] }>("milestones.list", { project: projectId })
      .then((answer) => setMilestones(answer.milestones))
      .catch(() => setMilestones([]));
  }, [connection, projectId]);
  useEffect(() => {
    if (!open) return undefined;
    load();
    return connection.subscribe(projectMilestonesTopic(projectId), () => load());
  }, [open, load, connection, projectId]);
  return milestones;
}

/** The tags on one revision in the history, and (for owners and editors) a way to add one. */
export function MilestoneTags(props: {
  connection: TeamConnection;
  projectId: string;
  revision: string;
  milestones: readonly TeamMilestone[];
  canName: boolean;
  me: string;
  role: TeamProjectRole | undefined;
}) {
  const { connection, projectId, revision, milestones, canName, me, role } = props;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const here = milestones.filter((milestone) => milestone.revision === revision);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await connection.call("milestones.create", { project: projectId, revision, name: name.trim() });
      setName("");
      setNaming(false);
      setError(undefined);
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <span className="milestones">
      {here.map((milestone) => (
        <span key={milestone.id} className="badge milestone" title={milestone.note ?? milestone.createdBy ?? ""}>
          ⚑ {milestone.name}
          {milestone.createdBy === me || role === "owner" ? (
            <button
              className="link small"
              aria-label={t("remove")}
              onClick={() => void connection.call("milestones.delete", { milestone: milestone.id }).catch(() => undefined)}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {canName && !naming ? (
        <button className="link small" onClick={() => setNaming(true)}>
          + {t("milestoneAdd")}
        </button>
      ) : null}
      {naming ? (
        <form className="milestone-new" onSubmit={(event) => void add(event)}>
          <input autoFocus value={name} placeholder={t("milestoneName")} maxLength={80} onChange={(event) => setName(event.target.value)} />
          <button className="primary small" type="submit" disabled={name.trim() === ""}>
            {t("add")}
          </button>
          <button className="ghost small" type="button" onClick={() => setNaming(false)}>
            {t("cancel")}
          </button>
        </form>
      ) : null}
      {error !== undefined ? <span className="error small">{error}</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------- webhooks */

const EVENT_PHRASE: Record<TeamWebhookEvent, Phrase> = {
  commit: "whCommit",
  thread: "whThread",
  "todo-assigned": "whTodoAssigned",
  "todo-done": "whTodoDone",
  "review-requested": "whReviewRequested",
  "review-answered": "whReviewAnswered",
  milestone: "whMilestone",
  version: "whVersion",
};

/**
 * The webhooks list and form. Without `projectId`, every webhook on the server, for an operator;
 * with one, that project's, for its owners (`projects.webhooks.*`).
 */
export function Webhooks({ connection, projectId }: { connection: TeamConnection; projectId?: string }) {
  const scoped = projectId !== undefined;
  const method = (name: "list" | "create" | "delete" | "test") => (scoped ? `projects.webhooks.${name}` : `admin.webhooks.${name}`);
  const scope = scoped ? { project: projectId } : {};
  const [hooks, setHooks] = useState<readonly TeamWebhook[] | undefined>(undefined);
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<TeamWebhookFormat>("json");
  const [project, setProject] = useState("");
  const [events, setEvents] = useState<readonly TeamWebhookEvent[]>(["version", "review-requested", "todo-assigned"]);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    connection
      .call<{ webhooks: TeamWebhook[] }>(method("list"), scope)
      .then((answer) => setHooks(answer.webhooks))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [connection, projectId]);
  useEffect(() => {
    load();
    if (scoped) return;
    connection
      .call<{ projects: { id: string; name: string }[] }>("projects.list")
      .then((answer) => setProjects(answer.projects))
      .catch(() => undefined);
  }, [load, connection, scoped]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const answer = await connection.call<{ secret: string }>(method("create"), {
        url: url.trim(),
        format,
        events,
        ...(scoped ? scope : project === "" ? {} : { project }),
      });
      setSecret(answer.secret);
      setUrl("");
      load();
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const toggle = (name: TeamWebhookEvent) => setEvents(events.includes(name) ? events.filter((e) => e !== name) : [...events, name]);
  const projectName = (id: string | undefined) => (id === undefined ? t("whAllProjects") : (projects.find((p) => p.id === id)?.name ?? id));

  return (
    <div className="admin-section">
      <p className="muted">{scoped ? t("projectWebhooksLead") : t("whLead")}</p>
      {error !== undefined ? <p className="error">{error}</p> : null}
      {secret !== undefined ? (
        <p className="notice">
          {t("whSecret")} <code>{secret}</code>
        </p>
      ) : null}
      <form className="card webhook-new" onSubmit={(event) => void add(event)}>
        <input value={url} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} />
        <div className="review-fields">
          <label>
            {t("whFormat")}
            <select value={format} onChange={(event) => setFormat(event.target.value as TeamWebhookFormat)}>
              {TEAM_WEBHOOK_FORMATS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {scoped ? null : <label>
            {t("projects")}
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value="">{t("whAllProjects")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>}
        </div>
        <div className="webhook-events">
          {TEAM_WEBHOOK_EVENTS.map((name) => (
            <label key={name} className="small">
              <input type="checkbox" checked={events.includes(name)} onChange={() => toggle(name)} /> {t(EVENT_PHRASE[name])}
            </label>
          ))}
        </div>
        <button className="primary" type="submit" disabled={url.trim() === "" || events.length === 0}>
          {t("add")}
        </button>
      </form>
      {hooks === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : hooks.length === 0 ? (
        <p className="placeholder-card">{t("whNone")}</p>
      ) : (
        <ul className="webhook-list">
          {hooks.map((hook) => (
            <li key={hook.id} className="card">
              <div>
                <code>{hook.url}</code> <span className="badge">{hook.format}</span>
              </div>
              <div className="muted small">
                {projectName(hook.project)} · {hook.events.map((name) => t(EVENT_PHRASE[name])).join("、")}
                {hook.lastStatus !== undefined ? ` · ${t("whLast", { status: String(hook.lastStatus) })}` : ""}
                {result[hook.id] !== undefined ? ` · ${t("whTested", { status: String(result[hook.id]) })}` : ""}
              </div>
              <div className="review-actions">
                <button
                  className="ghost small"
                  onClick={() =>
                    void connection
                      .call<{ status: number }>(method("test"), { webhook: hook.id })
                      .then((answer) => {
                        setResult({ ...result, [hook.id]: answer.status });
                        load();
                      })
                      .catch((caught: unknown) => setError(errorText(caught)))
                  }
                >
                  {t("whTest")}
                </button>
                <button
                  className="ghost small"
                  onClick={() => void connection.call(method("delete"), { webhook: hook.id }).then(load).catch((caught: unknown) => setError(errorText(caught)))}
                >
                  {t("remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
