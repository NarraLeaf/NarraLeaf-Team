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
  type TeamWebhookDelivery,
  type TeamWebhookEvent,
  type TeamWebhookFormat,
} from "@narraleaf/team-protocol";

import { t, type Phrase } from "./i18n";
import { Face } from "./Collab";
import { ago, Blankslate, Checkbox, confirmAction, Flash, FormDialog, RelativeTime, SelectPanel, Subhead, toast, toastError, type SelectOption } from "./ui";
import { Icon } from "./Icon";
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

  const [asking, setAsking] = useState(false);
  const ask = async () => {
    await connection.call("reviews.create", {
      project: projectId,
      reviewer: draft.reviewer,
      toRevision: draft.toRevision,
      ...(draft.fromRevision === "" ? {} : { fromRevision: draft.fromRevision }),
      title: draft.title.trim(),
      ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
    });
    setDraft({ reviewer: "", toRevision: "", fromRevision: "", title: "", note: "" });
    toast(t("reviewSent"));
  };

  const move = (review: TeamReview, status: TeamReviewStatus) =>
    connection
      .call("reviews.update", { review: review.id, status, ...(verdicts[review.id] ? { verdictNote: verdicts[review.id] } : {}) })
      .catch((caught: unknown) => setError(errorText(caught)));

  const option = (revision: Revision): SelectOption<string> => ({
    value: revision.id,
    label: (revisionTitle(revision) || (isAutoVersion(revision) ? t("versionAuto") : revision.id.slice(0, 7))).slice(0, 60),
    description: [revision.id.slice(0, 7), revision.by, revision.at === undefined ? undefined : ago(revision.at)].filter(Boolean).join(" · "),
    icon: isAutoVersion(revision) ? "history" : "flag",
  });
  // Automatic snapshots come every few minutes; the versions somebody named are what a review is about.
  const picked = new Set([draft.toRevision, draft.fromRevision]);
  const choices = revisions.filter((revision) => showAuto || !isAutoVersion(revision) || picked.has(revision.id));
  const canAsk = role !== undefined && role !== "viewer";
  const ready = draft.reviewer !== "" && draft.toRevision !== "" && draft.title.trim() !== "";

  return (
    <div className="reviews">
      <Subhead
        title={t("tabReviews")}
        action={
          canAsk ? (
            <button className="btn btn-primary btn-sm" onClick={() => setAsking(true)}>
              <Icon name="plus" size={14} /> {t("reviewAsk")}
            </button>
          ) : undefined
        }
      >
        {t("reviewsLead")}
      </Subhead>
      {error !== undefined ? <Flash error={error} /> : null}
      {canAsk && asking ? (
        <FormDialog title={t("reviewAsk")} submitLabel={t("reviewSend")} width={600} ready={ready} onSubmit={ask} onClose={() => setAsking(false)}>
          <label className="form-field">
            <span className="form-label">{t("reviewTitleLabel")}</span>
            <input value={draft.title} placeholder={t("reviewTitle")} maxLength={300} onChange={(event) => setDraft({ ...draft, title: event.target.value })} autoFocus />
          </label>
          <div className="review-fields">
            <div className="form-field">
              <span className="form-label">{t("reviewer")}</span>
              <SelectPanel
                label={t("reviewer")}
                placeholder={t("reviewPickReviewer")}
                filterFrom={6}
                value={draft.reviewer === "" ? undefined : draft.reviewer}
                onChange={(reviewer) => setDraft({ ...draft, reviewer })}
                options={members
                  .filter((member) => member.username !== me)
                  .map((member) => ({
                    value: member.username,
                    label: member.displayName || member.username,
                    ...(member.displayName ? { description: `@${member.username}` } : {}),
                    leading: <Face name={member.displayName || member.username} user={member.username} size={18} />,
                  }))}
              />
            </div>
            <div className="form-field">
              <span className="form-label">{t("reviewFrom")}</span>
              <SelectPanel
                label={t("reviewFrom")}
                filterFrom={10}
                value={draft.fromRevision}
                onChange={(fromRevision) => setDraft({ ...draft, fromRevision })}
                options={[{ value: "", label: t("reviewFromStart"), icon: "history" }, ...choices.map(option)]}
                footer={<Checkbox checked={showAuto} onChange={setShowAuto} label={<span className="small">{t("showAuto")}</span>} />}
              />
            </div>
            <div className="form-field">
              <span className="form-label">{t("reviewTo")}</span>
              <SelectPanel
                label={t("reviewTo")}
                placeholder={t("reviewPickVersion")}
                filterFrom={10}
                value={draft.toRevision === "" ? undefined : draft.toRevision}
                onChange={(toRevision) => setDraft({ ...draft, toRevision })}
                options={choices.map(option)}
                footer={<Checkbox checked={showAuto} onChange={setShowAuto} label={<span className="small">{t("showAuto")}</span>} />}
              />
            </div>
          </div>
          <label className="form-field">
            <span className="form-label">{t("reviewNoteLabel")}</span>
            <textarea value={draft.note} placeholder={t("reviewNote")} rows={3} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
          </label>
          {ready ? null : (
            <p className="muted small">
              {draft.title.trim() === "" ? t("reviewNeedTitle") : draft.reviewer === "" ? t("reviewNeedReviewer") : t("reviewNeedVersion")}
            </p>
          )}
        </FormDialog>
      ) : null}
      {reviews === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : reviews.length === 0 ? (
        <Blankslate icon="review" title={t("noReviews")} compact>
          {t("noReviewsHint")}
        </Blankslate>
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
          <button className="btn btn-primary" type="submit" disabled={name.trim() === ""}>
            {t("add")}
          </button>
          <button className="btn btn-invisible" type="button" onClick={() => setNaming(false)}>
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
  build: "whBuild",
};

/**
 * The webhooks list and form. Without `projectId`, every webhook on the server, for an operator;
 * with one, that project's, for its owners (`projects.webhooks.*`).
 */
export function Webhooks({ connection, projectId }: { connection: TeamConnection; projectId?: string }) {
  const scoped = projectId !== undefined;
  const method = (name: "list" | "create" | "delete" | "test" | "deliveries" | "redeliver") => (scoped ? `projects.webhooks.${name}` : `admin.webhooks.${name}`);
  const scope = scoped ? { project: projectId } : {};
  const [hooks, setHooks] = useState<readonly TeamWebhook[] | undefined>(undefined);
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<TeamWebhookFormat>("json");
  const [project, setProject] = useState("");
  const [events, setEvents] = useState<readonly TeamWebhookEvent[]>(["version", "review-requested", "todo-assigned"]);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<Record<string, { status: number; error?: string }>>({});
  const [error, setError] = useState<unknown>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [logTick, setLogTick] = useState(0);

  const load = useCallback(() => {
    connection
      .call<{ webhooks: TeamWebhook[] }>(method("list"), scope)
      .then((answer) => setHooks(answer.webhooks))
      .catch((caught: unknown) => setError(caught));
  }, [connection, projectId]);
  useEffect(() => {
    load();
    if (scoped) return;
    connection
      .call<{ projects: { id: string; name: string }[] }>("projects.list")
      .then((answer) => setProjects(answer.projects))
      .catch(() => undefined);
  }, [load, connection, scoped]);

  const [adding, setAdding] = useState(false);
  const add = async () => {
    const answer = await connection.call<{ secret: string }>(method("create"), {
      url: url.trim(),
      format,
      events,
      ...(scoped ? scope : project === "" ? {} : { project }),
    });
    setSecret(answer.secret);
    load();
  };

  const projectName = (id: string | undefined) => (id === undefined ? t("whAllProjects") : (projects.find((p) => p.id === id)?.name ?? id));

  return (
    <div className="admin-section">
      <div className="list-tools">
        <p className="muted">{scoped ? t("projectWebhooksLead") : t("whLead")}</p>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setUrl("");
            setAdding(true);
          }}
        >
          <Icon name="plus" size={14} /> {t("whNew")}
        </button>
      </div>
      {error !== undefined ? <Flash error={error} /> : null}
      {secret !== undefined ? (
        <p className="notice">
          {t("whSecret")} <code>{secret}</code>
        </p>
      ) : null}
      {adding ? (
      <FormDialog title={t("whNew")} submitLabel={t("add")} width={560} ready={url.trim() !== "" && events.length > 0} onSubmit={add} onClose={() => setAdding(false)}>
        <label className="form-field">
          <span className="form-label">{t("whUrl")}</span>
          <input type="url" value={url} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} required autoFocus />
        </label>
        <div className="review-fields">
          <div className="form-field">
            <span className="form-label">{t("whFormat")}</span>
            <SelectPanel
              label={t("whFormat")}
              value={format}
              onChange={setFormat}
              options={TEAM_WEBHOOK_FORMATS.map((name) => ({ value: name, label: name }))}
            />
          </div>
          {scoped ? null : (
            <div className="form-field">
              <span className="form-label">{t("projects")}</span>
              <SelectPanel
                label={t("projects")}
                value={project}
                onChange={setProject}
                options={[{ value: "", label: t("whAllProjects") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
          )}
          <div className="form-field">
            <span className="form-label">{t("whEvents")}</span>
            <SelectPanel<TeamWebhookEvent>
              multiple
              label={t("whEvents")}
              placeholder={t("whPickEvents")}
              allLabel={t("whEveryEvent")}
              value={events}
              onChange={setEvents}
              options={TEAM_WEBHOOK_EVENTS.map((name) => ({ value: name, label: t(EVENT_PHRASE[name]) }))}
            />
          </div>
        </div>
      </FormDialog>
      ) : null}
      {hooks === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : hooks.length === 0 ? (
        <Blankslate icon="link" title={t("whNone")} compact>
          {t("whNoneHint")}
        </Blankslate>
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
                {result[hook.id] !== undefined
                  ? ` · ${t("whTested", { status: String(result[hook.id]!.status) })}${result[hook.id]!.error === undefined ? "" : ` (${deliveryError(result[hook.id]!.error!)})`}`
                  : ""}
              </div>
              <div className="review-actions">
                <button
                  className="ghost small"
                  onClick={() =>
                    void connection
                      .call<{ status: number; error?: string }>(method("test"), { webhook: hook.id })
                      .then((answer) => {
                        setResult({ ...result, [hook.id]: answer });
                        setLogTick((n) => n + 1);
                        load();
                      })
                      .catch((caught: unknown) => setError(caught))
                  }
                >
                  {t("whTest")}
                </button>
                <button className="ghost small" aria-expanded={open === hook.id} onClick={() => setOpen(open === hook.id ? undefined : hook.id)}>
                  {t("whDeliveries")}
                </button>
                <button
                  className="ghost small"
                  onClick={() =>
                    void confirmAction({ title: t("whRemoveTitle"), body: hook.url, confirmLabel: t("remove"), danger: true }).then((yes) => {
                      if (!yes) return;
                      void connection
                        .call(method("delete"), { webhook: hook.id })
                        .then(() => {
                          toast(t("whRemoved"));
                          load();
                        })
                        .catch((caught: unknown) => setError(caught));
                    })
                  }
                >
                  {t("remove")}
                </button>
              </div>
              {open === hook.id ? (
                <DeliveryLog
                  key={logTick}
                  load={() => connection.call<{ deliveries: TeamWebhookDelivery[] }>(method("deliveries"), { webhook: hook.id }).then((answer) => answer.deliveries)}
                  resend={(delivery) => connection.call(method("redeliver"), { delivery })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** When something later is, as "in 30 seconds". */
function soon(at: number): string {
  const seconds = Math.max(1, Math.round((at - Date.now()) / 1000));
  const format = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  return seconds < 60 ? format.format(seconds, "second") : seconds < 3600 ? format.format(Math.round(seconds / 60), "minute") : format.format(Math.round(seconds / 3600), "hour");
}

/** The server's reason a delivery failed, in the reader's language where it is one we know. */
function deliveryError(error: string): string {
  if (error.includes("own network")) return t("whErrPrivate");
  if (error.startsWith("no address")) return t("whErrNoAddress");
  if (error === "no answer in time") return t("whErrTimeout");
  if (error === "could not connect") return t("whErrConnect");
  const answered = /^answered (\d+)$/.exec(error);
  if (answered !== null) return t("whErrAnswered", { status: answered[1]! });
  return error;
}

/** A delivery's answer as a word and a tone: delivered, failed, waiting to try again. */
function deliveryState(delivery: TeamWebhookDelivery): { label: string; tone: "ok" | "bad" | "wait" } {
  if (delivery.status >= 200 && delivery.status < 300) return { label: String(delivery.status), tone: "ok" };
  if (delivery.nextAt !== undefined) return { label: t("whRetrying"), tone: "wait" };
  return { label: delivery.status === 0 ? t("whNoAnswer") : String(delivery.status), tone: "bad" };
}

/** The latest deliveries of one webhook, newest first, each with "send again". */
function DeliveryLog({ load, resend }: { load: () => Promise<TeamWebhookDelivery[]>; resend: (id: number) => Promise<unknown> }) {
  const [deliveries, setDeliveries] = useState<readonly TeamWebhookDelivery[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const refresh = useCallback(() => {
    load()
      .then(setDeliveries)
      .catch((caught: unknown) => setError(caught));
  }, [load]);
  useEffect(() => {
    refresh();
    // A retry may land while the log is open; look again now and then.
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error !== undefined) return <Flash error={error} />;
  if (deliveries === undefined) return <p className="muted small">{t("loading")}</p>;
  if (deliveries.length === 0) return <p className="muted small">{t("whNoDeliveries")}</p>;
  return (
    <ul className="delivery-log">
      {deliveries.map((delivery) => {
        const state = deliveryState(delivery);
        return (
          <li key={delivery.id}>
            <span className={`delivery-status delivery-${state.tone}`}>{state.label}</span>
            <span className="delivery-summary">
              <span>{t(EVENT_PHRASE[delivery.event])}</span>
              <span className="muted small">
                {delivery.summary}
                {delivery.error === undefined ? "" : ` · ${deliveryError(delivery.error)}`}
                {delivery.attempts > 1 ? ` · ${t("whAttempts", { count: String(delivery.attempts) })}` : ""}
                {delivery.nextAt === undefined ? "" : ` · ${t("whNextTry", { when: soon(delivery.nextAt) })}`}
              </span>
            </span>
            <RelativeTime at={delivery.at} />
            <button
              className="ghost small"
              onClick={() =>
                void resend(delivery.id)
                  .then(() => {
                    toast(t("whResent"));
                    window.setTimeout(refresh, 800);
                  })
                  .catch(toastError)
              }
            >
              {t("whResend")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
