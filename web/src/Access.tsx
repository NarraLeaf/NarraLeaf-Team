/**
 * Permission templates and asking for access.
 *
 * A template is a named grant (writer, artist, translator …) the server knows
 * by id, so the console picks one rather than ticking boxes. Asking is a
 * request the project's owners and the operators answer: approve as asked,
 * approve as something else, or say no with a note. Every list here listens
 * on the projects topic, where the server announces each request as it moves.
 */
import { useCallback, useEffect, useState } from "react";
import {
  TEAM_PERMISSION_TEMPLATES,
  TOPIC_PROJECTS,
  teamTemplateOf,
  type TeamAccessRequest,
  type TeamDiscoverableProject,
  type TeamPermissionTemplateId,
  type TeamProjectArea,
  type TeamProjectRole,
} from "@narraleaf/team-protocol";
import { t, type Phrase } from "./i18n";
import { Flash, FormDialog, SelectPanel } from "./ui";
import type { TeamConnection } from "./socket";

export const TEMPLATE_PHRASE: Readonly<Record<TeamPermissionTemplateId, Phrase>> = {
  owner: "tplOwner",
  editor: "tplEditor",
  writer: "tplWriter",
  artist: "tplArtist",
  translator: "tplTranslator",
  engineer: "tplEngineer",
  reviewer: "tplReviewer",
  viewer: "tplViewer",
};

const TEMPLATE_HINT: Readonly<Record<TeamPermissionTemplateId, Phrase>> = {
  owner: "tplOwnerHint",
  editor: "tplEditorHint",
  writer: "tplWriterHint",
  artist: "tplArtistHint",
  translator: "tplTranslatorHint",
  engineer: "tplEngineerHint",
  reviewer: "tplReviewerHint",
  viewer: "tplViewerHint",
};

const STATUS_PHRASE: Readonly<Record<TeamAccessRequest["status"], Phrase>> = {
  pending: "reqPending",
  approved: "reqApproved",
  denied: "reqDenied",
  withdrawn: "reqWithdrawn",
};

const ROLE_PHRASE: Readonly<Record<TeamProjectRole, Phrase>> = {
  owner: "roleOwner",
  editor: "roleEditor",
  reviewer: "roleReviewer",
  viewer: "roleViewer",
};

const AREA_PHRASE: Readonly<Record<TeamProjectArea, Phrase>> = {
  story: "areaStory",
  characters: "areaCharacters",
  assets: "areaAssets",
  ui: "areaUi",
  localization: "areaLocalization",
  config: "areaConfig",
};

const ALL_TEMPLATES: readonly TeamPermissionTemplateId[] = TEAM_PERMISSION_TEMPLATES.map((template) => template.id);
/** What a newcomer may ask for: everything but owning the project. */
const ASKABLE: readonly TeamPermissionTemplateId[] = ALL_TEMPLATES.filter((id) => id !== "owner");

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A grant in words: its template's name when it is one, otherwise the role and its areas. */
export function grantWords(role: TeamProjectRole | undefined, areas: readonly TeamProjectArea[] | undefined): string {
  if (role === undefined) return "—";
  const template = teamTemplateOf(role, areas);
  if (template !== undefined) return t(TEMPLATE_PHRASE[template.id]);
  const named = t(ROLE_PHRASE[role]);
  return areas === undefined || areas.length === 0 ? named : `${named}（${areas.map((area) => t(AREA_PHRASE[area])).join("、")}）`;
}

/** A select of templates, with "custom" shown when the current grant matches none. */
export function TemplateSelect({
  value,
  change,
  choices = ALL_TEMPLATES,
  custom = false,
  size = "small",
}: {
  value: TeamPermissionTemplateId | undefined;
  change: (id: TeamPermissionTemplateId) => void;
  choices?: readonly TeamPermissionTemplateId[];
  custom?: boolean;
  size?: "small" | "medium";
}) {
  return (
    <SelectPanel
      label={t("tplLabel")}
      size={size}
      value={custom ? undefined : value}
      placeholder={t("tplCustom")}
      onChange={change}
      options={choices.map((id) => ({ value: id, label: t(TEMPLATE_PHRASE[id]), description: t(TEMPLATE_HINT[id]) }))}
    />
  );
}

function useAccessRequests(connection: TeamConnection, params: { project?: string; all?: boolean }) {
  const [lists, setLists] = useState<{ mine: readonly TeamAccessRequest[]; toDecide: readonly TeamAccessRequest[] } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const { project, all } = params;
  const load = useCallback(() => {
    void connection
      .call<{ mine: TeamAccessRequest[]; toDecide: TeamAccessRequest[] }>("access.requests.list", {
        ...(project === undefined ? {} : { project }),
        ...(all === true ? { all: true } : {}),
      })
      .then((answer) => {
        setLists(answer);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [connection, project, all]);
  useEffect(() => {
    load();
    return connection.subscribe(TOPIC_PROJECTS, (payload) => {
      const kind = (payload as { kind?: string } | null)?.kind;
      if (kind === "access-request" || kind === "member-set" || kind === "member-removed") load();
    });
  }, [connection, load]);
  return { lists, error, load };
}

function RequestSummary({ request, showProject }: { request: TeamAccessRequest; showProject: boolean }) {
  const asked = request.kind === "creator" ? t("reqCreator") : grantWords(request.role, request.areas);
  return (
    <div className="request-summary">
      <div>
        <strong>{request.requesterName || request.requester}</strong>
        <span className="muted small"> @{request.requester}</span>
        {showProject && request.projectName !== undefined ? <span className="muted small"> · {request.projectName}</span> : null}
      </div>
      <div className="small">
        {t("reqAsks", { what: asked })}
        {request.currentRole !== undefined ? <span className="muted"> · {t("reqNow", { role: t(ROLE_PHRASE[request.currentRole]) })}</span> : null}
      </div>
      {request.message !== undefined ? <p className="request-message small">“{request.message}”</p> : null}
      <div className="muted small">{new Date(request.at).toLocaleString()}</div>
    </div>
  );
}

/** One pending request with what its decider may do: approve (as asked or as another template) or deny. */
function DecideRow({ connection, request, showProject, decided }: { connection: TeamConnection; request: TeamAccessRequest; showProject: boolean; decided: (error?: string) => void }) {
  const asked = request.kind === "project" && request.role !== undefined ? teamTemplateOf(request.role, request.areas)?.id : undefined;
  const [grant, setGrant] = useState<TeamPermissionTemplateId | undefined>(asked);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => {
    setBusy(true);
    const override = approve && request.kind === "project" && grant !== undefined && grant !== asked ? { template: grant } : {};
    void connection
      .call("access.requests.decide", { id: request.id, approve, ...(note.trim() === "" ? {} : { note: note.trim() }), ...override })
      .then(() => decided())
      .catch((caught: unknown) => decided(errorText(caught)))
      .finally(() => setBusy(false));
  };
  return (
    <li className="request-row">
      <RequestSummary request={request} showProject={showProject} />
      <div className="request-actions">
        {request.kind === "project" ? (
          <label className="small muted">
            {t("reqGrantAs")} <TemplateSelect value={grant} change={setGrant} custom={asked === undefined} />
          </label>
        ) : null}
        <input className="request-note" placeholder={t("reqNote")} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
        <button className="primary small" disabled={busy} onClick={() => decide(true)}>
          {t("approve")}
        </button>
        <button className="ghost small" disabled={busy} onClick={() => decide(false)}>
          {t("deny")}
        </button>
      </div>
    </li>
  );
}

/**
 * Requests waiting on the caller: a project's, in its settings, or every one
 * the caller decides, in the back office.
 */
export function AccessRequestsToDecide({ connection, project, all = false }: { connection: TeamConnection; project?: string; all?: boolean }) {
  const { lists, error, load } = useAccessRequests(connection, { ...(project === undefined ? {} : { project }), all });
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | undefined>(undefined);
  const pending = lists?.toDecide.filter((request) => request.status === "pending") ?? [];
  const settled = all ? (lists?.toDecide.filter((request) => request.status !== "pending") ?? []) : [];
  return (
    <div className="access-requests">
      {error !== undefined ? <Flash error={error} /> : null}
      {note === undefined ? null : <p className={note.tone === "error" ? "error" : "muted small"}>{note.text}</p>}
      {lists === undefined ? (
        <p className="muted small">{t("loading")}</p>
      ) : pending.length === 0 ? (
        <p className="muted small">{t("reqNoneWaiting")}</p>
      ) : (
        <ul className="request-list">
          {pending.map((request) => (
            <DecideRow
              key={request.id}
              connection={connection}
              request={request}
              showProject={project === undefined}
              decided={(failure) => {
                setNote(failure === undefined ? { text: t("done"), tone: "ok" } : { text: failure, tone: "error" });
                load();
              }}
            />
          ))}
        </ul>
      )}
      {settled.length > 0 ? (
        <>
          <h3 className="small muted">{t("reqHistory")}</h3>
          <ul className="request-list">
            {settled.map((request) => (
              <li key={request.id} className="request-row settled">
                <RequestSummary request={request} showProject={project === undefined} />
                <SettledWords request={request} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function SettledWords({ request }: { request: TeamAccessRequest }) {
  return (
    <div className="small">
      <span className={`req-status req-${request.status}`}>{t(STATUS_PHRASE[request.status])}</span>
      {request.status === "approved" && request.grantedRole !== undefined ? (
        <span className="muted"> · {t("reqGranted", { what: grantWords(request.grantedRole, request.grantedAreas) })}</span>
      ) : null}
      {request.decidedBy !== undefined ? <span className="muted"> · {request.decidedBy}</span> : null}
      {request.note !== undefined ? <span className="muted"> · “{request.note}”</span> : null}
    </div>
  );
}

/** The caller's own requests, newest first, with withdraw on those still waiting. */
export function MyAccessRequests({ connection, project }: { connection: TeamConnection; project?: string }) {
  const { lists, load } = useAccessRequests(connection, project === undefined ? {} : { project });
  const mine = lists?.mine ?? [];
  if (mine.length === 0) return null;
  return (
    <div className="my-requests">
      <h3 className="section-title">{t("reqMine")}</h3>
      <ul className="request-list">
        {mine.map((request) => (
          <li key={request.id} className="request-row">
            <div className="request-summary">
              <div>
                <strong>{request.kind === "creator" ? t("reqCreator") : (request.projectName ?? request.project)}</strong>
                {request.kind === "project" ? <span className="muted small"> · {grantWords(request.role, request.areas)}</span> : null}
              </div>
              <div className="muted small">{new Date(request.at).toLocaleString()}</div>
            </div>
            <div className="request-actions">
              <SettledWords request={request} />
              {request.status === "pending" ? (
                <button className="ghost small" onClick={() => void connection.call("access.requests.withdraw", { id: request.id }).then(load)}>
                  {t("reqWithdraw")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A template and a few words, sent as one request, in a dialog. */
function AskForm({
  connection,
  project,
  title,
  choices,
  initial,
  sent,
  cancel,
}: {
  connection: TeamConnection;
  project: string;
  title: string;
  choices: readonly TeamPermissionTemplateId[];
  initial: TeamPermissionTemplateId;
  sent: () => void;
  cancel: () => void;
}) {
  const [template, setTemplate] = useState<TeamPermissionTemplateId>(initial);
  const [message, setMessage] = useState("");
  return (
    <FormDialog
      title={title}
      submitLabel={t("reqSend")}
      onSubmit={async () => {
        await connection.call("access.requests.create", { project, template, ...(message.trim() === "" ? {} : { message: message.trim() }) });
        sent();
        return false;
      }}
      onClose={cancel}
    >
      <div className="form-field">
        <span className="form-label">{t("reqAskFor")}</span>
        <TemplateSelect size="medium" value={template} change={setTemplate} choices={choices} />
        <span className="form-hint">{t(TEMPLATE_HINT[template])}</span>
      </div>
      <label className="form-field">
        <span className="form-label">{t("reqMessageLabel")}</span>
        <textarea placeholder={t("reqMessage")} value={message} maxLength={1000} rows={3} onChange={(event) => setMessage(event.target.value)} autoFocus />
      </label>
    </FormDialog>
  );
}

/** On a project page, for anybody short of owning it: ask for more. */
export function AskForMore({ connection, project, role }: { connection: TeamConnection; project: string; role: TeamProjectRole | undefined }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  if (role === "owner") return null;
  const rank = { viewer: 0, reviewer: 1, editor: 2, owner: 3 } as const;
  // Offer what goes beyond the role held now; an editor may still ask for more areas or ownership.
  const choices = ALL_TEMPLATES.filter((id) => {
    const template = TEAM_PERMISSION_TEMPLATES.find((candidate) => candidate.id === id);
    return template !== undefined && (role === undefined || rank[template.role] >= rank[role]) && !(role !== "editor" && template.role === role);
  });
  if (sent) return <span className="muted small">{t("reqSent")}</span>;
  return (
    <>
      <button className="button-outline" onClick={() => setOpen(true)}>
        {t("reqAskMore")}
      </button>
      {open ? (
        <AskForm
          connection={connection}
          project={project}
          title={t("reqAskMore")}
          choices={choices}
          initial={choices.includes("editor") ? "editor" : (choices[0] ?? "owner")}
          sent={() => {
            setSent(true);
            setOpen(false);
          }}
          cancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Projects the caller has no place in, each with a way to ask in; and asking the operators for leave to make projects. */
export function JoinProjects({ connection, operator, mayCreate }: { connection: TeamConnection; operator: boolean; mayCreate: boolean }) {
  const [projects, setProjects] = useState<readonly TeamDiscoverableProject[] | undefined>(undefined);
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | undefined>(undefined);
  const load = useCallback(() => {
    void connection
      .call<{ projects: TeamDiscoverableProject[] }>("projects.discover")
      .then((answer) => setProjects(answer.projects))
      .catch(() => setProjects([]));
  }, [connection]);
  useEffect(() => {
    load();
    return connection.subscribe(TOPIC_PROJECTS, () => load());
  }, [connection, load]);
  if (operator) return null;
  const askCreator = () =>
    void connection
      .call("access.requests.create", { kind: "creator" })
      .then(() => setNote({ text: t("reqSent"), tone: "ok" }))
      .catch((caught: unknown) => setNote({ text: errorText(caught), tone: "error" }));
  return (
    <section className="join-projects">
      <header className="section-head">
        <h2 className="section-title">{t("reqJoinTitle")}</h2>
        {mayCreate ? null : (
          <button className="ghost small" onClick={askCreator}>
            {t("reqAskCreator")}
          </button>
        )}
      </header>
      {note === undefined ? null : <p className={note.tone === "error" ? "error small" : "muted small"}>{note.text}</p>}
      {projects === undefined ? null : projects.length === 0 ? (
        <p className="muted small">{t("reqNothingToJoin")}</p>
      ) : (
        <ul className="request-list">
          {projects.map((project) => (
            <li key={project.id} className="request-row">
              <div className="request-summary">
                <strong>{project.name}</strong>
                {project.description === undefined ? null : <div className="muted small">{project.description}</div>}
              </div>
              <button className="button-outline small" onClick={() => setAsking(project.id)}>
                {t("reqAskJoin")}
              </button>
              {asking === project.id ? (
                <AskForm
                  connection={connection}
                  project={project.id}
                  title={`${t("reqAskJoin")} · ${project.name}`}
                  choices={ASKABLE}
                  initial="editor"
                  sent={() => {
                    setAsking(undefined);
                    setNote({ text: t("reqSent"), tone: "ok" });
                  }}
                  cancel={() => setAsking(undefined)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <MyAccessRequests connection={connection} />
    </section>
  );
}
