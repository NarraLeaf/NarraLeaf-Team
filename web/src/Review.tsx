/**
 * Sign-off and asset locks in the console.
 *
 * An approval is Team's own note about a scene or an asset - draft, waiting
 * for review, approved, or sent back with a reason. A lock says one person is
 * working on an asset for a while; the server refuses others' edits to it.
 * Neither touches the project's files: the page shows them beside what the
 * files say, and works out a milestone's progress from both.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ASSET_LOCK_DEFAULT_MINUTES,
  projectApprovalsTopic,
  projectLocksTopic,
  type TeamApproval,
  type TeamApprovalStatus,
  type TeamApprovalsEvent,
  type TeamAssetLock,
  type TeamLocksEvent,
  type TeamMilestone,
  type TeamProjectRole,
} from "@narraleaf/team-protocol";

import { Icon, type IconName } from "./Icon";
import { t, type Phrase } from "./i18n";
import { ActionMenu, Dialog, RelativeTime, Switch, toast, toastError, type MenuAction } from "./ui";
import type { TeamConnection } from "./socket";

/* ------------------------------------------------------------ approvals */

const STATUS_PHRASE: Record<TeamApprovalStatus, Phrase> = {
  draft: "approvalDraft",
  pending: "approvalPending",
  approved: "approvalApproved",
  changes: "approvalChanges",
};

const STATUS_ICON: Record<TeamApprovalStatus, IconName> = {
  draft: "file",
  pending: "review",
  approved: "tick",
  changes: "alert",
};

export function sceneTarget(sceneId: string): string {
  return `scene:${sceneId}`;
}

export function assetTarget(assetId: string): string {
  return `asset:${assetId}`;
}

/** Every approval of a project, kept current, by target. */
export function useApprovals(connection: TeamConnection, open: boolean, projectId: string): ReadonlyMap<string, TeamApproval> {
  const [approvals, setApprovals] = useState<ReadonlyMap<string, TeamApproval>>(new Map());
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    connection
      .call<{ approvals: TeamApproval[] }>("approvals.list", { project: projectId })
      .then((answer) => {
        if (live) setApprovals(new Map(answer.approvals.map((approval) => [approval.target, approval])));
      })
      .catch(() => undefined);
    const stop = connection.subscribe(projectApprovalsTopic(projectId), (payload) => {
      const event = payload as TeamApprovalsEvent;
      if (event.kind !== "approval-set") return;
      setApprovals((current) => new Map(current).set(event.approval.target, event.approval));
    });
    return () => {
      live = false;
      stop();
    };
  }, [open, connection, projectId]);
  return approvals;
}

export function ApprovalBadge({ approval }: { approval: TeamApproval | undefined }) {
  const status = approval?.status ?? "draft";
  if (approval === undefined) return null;
  const title = [t(STATUS_PHRASE[status]), approval.by === undefined ? "" : `· ${approval.by}`, approval.note === undefined ? "" : `\n${approval.note}`].join(" ").trim();
  return (
    <span className={`approval approval-${status}`} title={title}>
      <Icon name={STATUS_ICON[status]} size={12} />
      {t(STATUS_PHRASE[status])}
    </span>
  );
}

/**
 * The badge and what this person may do about it: editors put a piece up for
 * review or back to draft; reviewers and owners approve or send it back, the
 * latter with a reason.
 */
export function ApprovalControl(props: {
  connection: TeamConnection;
  projectId: string;
  target: string;
  approval: TeamApproval | undefined;
  role: TeamProjectRole | undefined;
  label: string;
}) {
  const { connection, projectId, target, approval, role, label } = props;
  const [sendingBack, setSendingBack] = useState(false);
  const [history, setHistory] = useState<readonly TeamApproval[] | undefined>(undefined);
  const status = approval?.status ?? "draft";
  const mayWork = role === "owner" || role === "editor";
  const mayJudge = role === "owner" || role === "reviewer";
  const set = (next: TeamApprovalStatus, note?: string) =>
    connection
      .call("approvals.set", { project: projectId, target, status: next, ...(note === undefined ? {} : { note }) })
      .then(() => toast(t(STATUS_PHRASE[next])))
      .catch(toastError);
  const actions: (MenuAction | false)[] = [
    mayWork && status !== "pending" && { label: t("approvalAsk"), icon: "review", run: () => void set("pending") },
    mayJudge && status !== "approved" && { label: t("approvalApprove"), icon: "tick", run: () => void set("approved") },
    mayJudge && { label: t("approvalSendBack"), icon: "alert", run: () => setSendingBack(true) },
    mayWork && status !== "draft" && { label: t("approvalBackToDraft"), icon: "file", run: () => void set("draft") },
    {
      label: t("approvalHistory"),
      icon: "history",
      run: () =>
        void connection
          .call<{ changes: TeamApproval[] }>("approvals.history", { project: projectId, target })
          .then((answer) => setHistory(answer.changes))
          .catch(toastError),
    },
  ];
  return (
    <span className="approval-control">
      <ActionMenu
        label={t("approvalFor", { what: label })}
        trigger={
          <span className={`approval approval-${status}`}>
            <Icon name={STATUS_ICON[status]} size={12} />
            {approval === undefined ? t("approvalNone") : t(STATUS_PHRASE[status])}
            <Icon name="caret" size={12} />
          </span>
        }
        triggerClassName="btn btn-invisible btn-sm approval-trigger"
        actions={actions}
      />
      {status === "changes" && approval?.note !== undefined ? (
        <span className="approval-note muted small" title={approval.note}>
          {approval.by === undefined ? "" : `${approval.by}: `}
          {approval.note}
        </span>
      ) : null}
      {sendingBack ? (
        <SendBack
          label={label}
          done={(note) => {
            setSendingBack(false);
            if (note !== undefined) void set("changes", note);
          }}
        />
      ) : null}
      {history !== undefined ? (
        <Dialog title={t("approvalHistoryOf", { what: label })} onClose={() => setHistory(undefined)} width={480}>
          {history.length === 0 ? (
            <p className="muted">{t("approvalHistoryEmpty")}</p>
          ) : (
            <ol className="approval-history">
              {history.map((change, index) => (
                <li key={`${change.at}-${index}`}>
                  <ApprovalBadge approval={change} />
                  <span className="small">{change.by ?? "?"}</span>
                  <RelativeTime at={change.at} className="muted small" />
                  {change.note === undefined ? null : <p className="approval-history-note">{change.note}</p>}
                </li>
              ))}
            </ol>
          )}
        </Dialog>
      ) : null}
    </span>
  );
}

function SendBack({ label, done }: { label: string; done: (note: string | undefined) => void }) {
  const [note, setNote] = useState("");
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (note.trim() !== "") done(note.trim());
  };
  return (
    <Dialog
      title={t("approvalSendBackOf", { what: label })}
      onClose={() => done(undefined)}
      footer={
        <>
          <button className="btn" onClick={() => done(undefined)}>
            {t("cancel")}
          </button>
          <button className="btn btn-danger" disabled={note.trim() === ""} onClick={() => submit()}>
            {t("approvalSendBack")}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="field">
          <span>{t("approvalReason")}</span>
          <textarea autoFocus rows={4} maxLength={2000} value={note} placeholder={t("approvalReasonHint")} onChange={(event) => setNote(event.target.value)} />
        </label>
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- locks */

/** The asset locks of a project still in force, kept current, by asset id. */
export function useLocks(connection: TeamConnection, open: boolean, projectId: string): ReadonlyMap<string, TeamAssetLock> {
  const [locks, setLocks] = useState<ReadonlyMap<string, TeamAssetLock>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    connection
      .call<{ locks: TeamAssetLock[] }>("assets.locks", { project: projectId })
      .then((answer) => {
        if (live) setLocks(new Map(answer.locks.map((lock) => [lock.asset, lock])));
      })
      .catch(() => undefined);
    const stop = connection.subscribe(projectLocksTopic(projectId), (payload) => {
      const event = payload as TeamLocksEvent;
      setLocks((current) => {
        const next = new Map(current);
        if (event.kind === "lock-set") next.set(event.lock.asset, event.lock);
        else next.delete(event.asset);
        return next;
      });
    });
    // Locks run out on their own; look again each minute.
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      live = false;
      stop();
      window.clearInterval(timer);
    };
  }, [open, connection, projectId]);
  return useMemo(() => new Map([...locks].filter(([, lock]) => lock.expiresAt > now)), [locks, now]);
}

const LOCK_SPANS: readonly { minutes: number; phrase: Phrase }[] = [
  { minutes: 60, phrase: "lockFor1h" },
  { minutes: ASSET_LOCK_DEFAULT_MINUTES, phrase: "lockFor4h" },
  { minutes: 24 * 60, phrase: "lockFor1d" },
  { minutes: 3 * 24 * 60, phrase: "lockFor3d" },
];

export function LockControl(props: {
  connection: TeamConnection;
  projectId: string;
  assetId: string;
  assetName: string;
  lock: TeamAssetLock | undefined;
  me: string;
  role: TeamProjectRole | undefined;
  isOperator: boolean;
}) {
  const { connection, projectId, assetId, assetName, lock, me, role, isOperator } = props;
  const mine = lock?.holder === me;
  const mayLock = role === "owner" || role === "editor";
  const mayForce = role === "owner" || isOperator;
  const lockFor = (minutes: number) =>
    void connection
      .call("assets.lock", { project: projectId, asset: assetId, minutes })
      .then(() => toast(t("lockTaken", { what: assetName })))
      .catch(toastError);
  const unlock = () =>
    void connection
      .call("assets.unlock", { project: projectId, asset: assetId })
      .then(() => toast(t("lockReleased", { what: assetName })))
      .catch(toastError);
  if (lock === undefined && !mayLock) return null;
  const until = lock === undefined ? "" : new Date(lock.expiresAt).toLocaleString();
  return (
    <ActionMenu
      label={t("lockFor", { what: assetName })}
      trigger={
        lock === undefined ? (
          <span className="lock-trigger">
            <Icon name="lock" size={12} />
            {t("lockTake")}
          </span>
        ) : (
          <span className={mine ? "lock-badge is-mine" : "lock-badge"} title={t("lockHeldUntil", { who: lock.holder, until })}>
            <Icon name="lock" size={12} />
            {mine ? t("lockMine") : lock.holder}
          </span>
        )
      }
      triggerClassName={lock === undefined ? "btn btn-invisible btn-sm lock-button" : "btn btn-invisible btn-sm lock-button is-held"}
      actions={
        lock === undefined || mine
          ? [
              ...LOCK_SPANS.map((span) => ({
                label: t(span.phrase),
                icon: "lock" as const,
                ...(mine ? { description: t("lockExtend") } : {}),
                run: () => lockFor(span.minutes),
              })),
              mine && { label: t("lockRelease"), icon: "close" as const, run: unlock },
            ]
          : [
              {
                label: t("lockHeldUntil", { who: lock.holder, until }),
                icon: "info" as const,
                disabledReason: lock.note ?? t("lockHeldHint"),
                run: () => undefined,
              },
              mayForce && { label: t("lockForceRelease"), icon: "close" as const, danger: true, run: unlock },
            ]
      }
    />
  );
}

/* ----------------------------------------------------------- milestones */

/**
 * The milestones with dates and gates, on the project overview. A gate's
 * progress is the share of scenes approved, worked out here from the scenes
 * the page read and the approvals the server keeps.
 */
export function MilestonePlan(props: {
  connection: TeamConnection;
  open: boolean;
  projectId: string;
  milestones: readonly TeamMilestone[];
  sceneIds: readonly string[] | undefined;
  approvals: ReadonlyMap<string, TeamApproval>;
  role: TeamProjectRole | undefined;
  me: string;
}) {
  const { connection, milestones, sceneIds, approvals, role, me } = props;
  const [editing, setEditing] = useState<TeamMilestone | undefined>(undefined);
  const approved = sceneIds === undefined ? undefined : sceneIds.filter((id) => approvals.get(sceneTarget(id))?.status === "approved").length;
  const ordered = [...milestones].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  const now = Date.now();
  if (ordered.length === 0) return null;
  return (
    <section className="milestone-plan">
      <h2>{t("milestonePlan")}</h2>
      <ul>
        {ordered.map((milestone) => {
          const late = milestone.dueAt !== undefined && milestone.dueAt < now;
          const share = milestone.gate === true && approved !== undefined && sceneIds !== undefined && sceneIds.length > 0 ? approved / sceneIds.length : undefined;
          const mayEdit = milestone.createdBy === me || role === "owner";
          return (
            <li key={milestone.id} className="milestone-row">
              <div className="milestone-row-head">
                <span className="milestone-row-name">
                  <Icon name="flag" size={14} />
                  {milestone.name}
                  {milestone.gate === true ? <span className="badge">{t("milestoneGate")}</span> : null}
                </span>
                {mayEdit ? (
                  <button className="btn btn-invisible btn-sm" onClick={() => setEditing(milestone)}>
                    {t("edit")}
                  </button>
                ) : null}
              </div>
              <div className="muted small">
                {milestone.dueAt === undefined ? t("milestoneNoDate") : <span className={late && share !== 1 ? "tone-danger" : undefined}>{t("milestoneDue", { when: new Date(milestone.dueAt).toLocaleDateString() })}</span>}
                {milestone.note === undefined ? "" : ` · ${milestone.note}`}
              </div>
              {share === undefined ? null : (
                <div className="gate-progress" title={t("milestoneGateHint")}>
                  <span className="gate-bar">
                    <span style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="small">{t("milestoneGateCount", { done: String(approved), total: String(sceneIds?.length ?? 0) })}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing === undefined ? null : <MilestoneEditor connection={connection} milestone={editing} close={() => setEditing(undefined)} />}
    </section>
  );
}

function dateInput(at: number | undefined): string {
  if (at === undefined) return "";
  const day = new Date(at);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function MilestoneEditor({ connection, milestone, close }: { connection: TeamConnection; milestone: TeamMilestone; close: () => void }) {
  const [name, setName] = useState(milestone.name);
  const [note, setNote] = useState(milestone.note ?? "");
  const [due, setDue] = useState(dateInput(milestone.dueAt));
  const [gate, setGate] = useState(milestone.gate === true);
  const save = useCallback(() => {
    // The end of the chosen day, where the person is.
    const dueAt = due === "" ? null : new Date(`${due}T23:59:59`).getTime();
    void connection
      .call("milestones.update", { milestone: milestone.id, name: name.trim(), note: note.trim() === "" ? null : note.trim(), dueAt, gate })
      .then(() => {
        toast(t("saved"));
        close();
      })
      .catch(toastError);
  }, [connection, milestone.id, name, note, due, gate, close]);
  return (
    <Dialog
      title={t("milestoneEdit")}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" disabled={name.trim() === ""} onClick={save}>
            {t("save")}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>{t("milestoneName")}</span>
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("milestoneDueLabel")}</span>
          <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("milestoneNote")}</span>
          <textarea rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="field-row">
          <span>
            <strong>{t("milestoneGate")}</strong>
            <span className="muted small"> — {t("milestoneGateHint")}</span>
          </span>
          <Switch checked={gate} onChange={setGate} label={t("milestoneGate")} />
        </div>
      </div>
    </Dialog>
  );
}
