/**
 * Team projects as the server holds them: who is editing now, how a saved version differs from
 * now, the owners' settings for a project, and an operator's view of every project's log.
 *
 * Nothing here edits a project's content (docs/architecture.md, D1): a version is restored from
 * Studio's history panel, and the web only views and compares them.
 */
import { useEffect, useState, type FormEvent } from "react";

import { readStoryDocument, readStoryLibrary, STORY_INDEX_PATH, type StoryRow } from "@narraleaf/project-view";
import { projectClientsTopic, type TeamClientInstance, type TeamProjectRole, type TeamVersionRole } from "@narraleaf/team-protocol";

import { fetchJson, fetchTree, type Tree } from "./files";
import { t, type Phrase } from "./i18n";
import type { IconName } from "./Icon";
import { confirmAction, Flash, SelectPanel, SettingsLayout, Subhead, toast } from "./ui";
import { Webhooks } from "./Production";
import { ProjectMembers } from "./Members";
import { AccessRequestsToDecide } from "./Access";
import type { TeamConnection } from "./socket";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/* ----------------------------------------------------------- editing now */

/** The people who have the project open in Studio right now, and what each is on. */
export function OnlineNow({ connection, open, projectId }: { connection: TeamConnection; open: boolean; projectId: string }) {
  const [clients, setClients] = useState<readonly TeamClientInstance[] | undefined>(undefined);
  useEffect(() => {
    if (!open) return undefined;
    const load = () =>
      connection
        .call<{ clients: TeamClientInstance[] }>("clients.list", { project: projectId })
        .then((answer) => setClients(answer.clients))
        .catch(() => setClients([]));
    load();
    return connection.subscribe(projectClientsTopic(projectId), () => void load());
  }, [open, connection, projectId]);
  if (clients === undefined) return null;
  // One line per person, however many windows they have open.
  const people = new Map<string, TeamClientInstance>();
  for (const client of clients) {
    const known = people.get(client.account);
    if (known === undefined || (client.editing !== undefined && known.editing === undefined)) people.set(client.account, client);
  }
  return (
    <div className="card online-now">
      <div className="muted">{t("onlineNow")}</div>
      {people.size === 0 ? (
        <div className="muted small">{t("onlineNobody")}</div>
      ) : (
        <ul className="member-list">
          {[...people.values()].map((client) => (
            <li key={client.account}>
              <span className="member-name">
                <span className="online-dot" aria-hidden="true" />
                {client.account}
              </span>
              {client.editing !== undefined ? <span className="muted small">{t("onlineEditing", { doc: client.editing })}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- compare */

interface RowChange {
  readonly kind: "added" | "removed" | "changed";
  readonly scene: string;
  readonly before?: string;
  readonly after?: string;
}

function rowText(row: StoryRow): string {
  if ("text" in row) return row.text;
  if (row.kind === "empty") return "";
  return row.kind;
}

/** Every story document in a tree, by story id: its scenes' rows by block id, with the scene name. */
async function storyRows(projectId: string, tree: Tree): Promise<Map<string, { scene: string; text: string }>> {
  const rows = new Map<string, { scene: string; text: string }>();
  if (!tree.files.some((file) => file.path === STORY_INDEX_PATH)) return rows;
  const library = readStoryLibrary(await fetchJson(projectId, tree.revision, STORY_INDEX_PATH));
  if (!library.supported) return rows;
  for (const story of library.stories) {
    if (!tree.files.some((file) => file.path === story.documentPath)) continue;
    const document = readStoryDocument(await fetchJson(projectId, tree.revision, story.documentPath));
    if (!document.supported) continue;
    for (const sceneId of document.order) {
      const scene = document.scenes[sceneId];
      if (scene === undefined) continue;
      for (const row of scene.rows) rows.set(`${story.id}/${row.id}`, { scene: scene.name, text: rowText(row) });
    }
  }
  return rows;
}

/** How one revision's story differs from what the project holds now, row by row, and how many other files differ. */
export function CompareWithNow({ projectId, revision, close }: { projectId: string; revision: string; close: () => void }) {
  const [changes, setChanges] = useState<{ rows: RowChange[]; files: number } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [then, now] = await Promise.all([fetchTree(projectId, revision), fetchTree(projectId, "current")]);
        const [before, after] = await Promise.all([storyRows(projectId, then), storyRows(projectId, now)]);
        const rows: RowChange[] = [];
        for (const [key, row] of after) {
          const old = before.get(key);
          if (old === undefined) rows.push({ kind: "added", scene: row.scene, after: row.text });
          else if (old.text !== row.text) rows.push({ kind: "changed", scene: row.scene, before: old.text, after: row.text });
        }
        for (const [key, row] of before) {
          if (!after.has(key)) rows.push({ kind: "removed", scene: row.scene, before: row.text });
        }
        const sizes = new Map(then.files.map((file) => [file.path, file.size]));
        const story = (path: string) => path.startsWith("editor/story/");
        let files = 0;
        for (const file of now.files) {
          if (!story(file.path) && sizes.get(file.path) !== file.size) files += 1;
          sizes.delete(file.path);
        }
        files += [...sizes.keys()].filter((path) => !story(path)).length;
        if (alive) setChanges({ rows, files });
      } catch (caught) {
        if (alive) setError(errorText(caught));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, revision]);
  const phrase = { added: "compareAdded", removed: "compareRemoved", changed: "compareChanged" } as const;
  return (
    <div className="card compare">
      <div className="compare-head">
        <strong>{t("compareTitle", { rev: revision.slice(0, 12) })}</strong>
        <button className="ghost small" onClick={close}>
          {t("close")}
        </button>
      </div>
      {error !== undefined ? (
        <p className="error">{error}</p>
      ) : changes === undefined ? (
        <p className="muted">{t("compareLoading")}</p>
      ) : (
        <>
          {changes.rows.length === 0 ? <p className="muted">{t("compareNone")}</p> : null}
          <ul className="compare-rows">
            {changes.rows.slice(0, 300).map((change, index) => (
              <li key={index} className={`compare-${change.kind}`}>
                <span className="badge">{t(phrase[change.kind])}</span> <span className="muted small">{change.scene}</span>
                {change.before !== undefined ? <div className="compare-before">{change.before || "—"}</div> : null}
                {change.after !== undefined ? <div className="compare-after">{change.after || "—"}</div> : null}
              </li>
            ))}
          </ul>
          {changes.files > 0 ? <p className="muted small">{t("compareFiles", { count: String(changes.files) })}</p> : null}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------- owner settings */

interface ProjectSettingsView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly saveRole?: TeamVersionRole;
  readonly restoreRole?: TeamVersionRole;
  readonly role?: TeamProjectRole;
  readonly mayRemove?: boolean;
}

/** A project's settings, for its owners: description, who may save and restore versions, webhooks. */
export type ProjectSettingsSection = "general" | "members" | "requests" | "webhooks";
export const PROJECT_SETTINGS_SECTIONS: readonly ProjectSettingsSection[] = ["general", "members", "requests", "webhooks"];
const SETTINGS_PHRASE: Record<ProjectSettingsSection, Phrase> = {
  general: "settingsGeneral",
  members: "membersTitle",
  requests: "reqTitle",
  webhooks: "projectWebhooks",
};
const SETTINGS_ICON: Record<ProjectSettingsSection, IconName> = { general: "gear", members: "people", requests: "key", webhooks: "link" };

/** A project's settings, each part on a page of its own, the way a repository's are. */
export function ProjectSettings(props: {
  connection: TeamConnection;
  project: ProjectSettingsView;
  section: ProjectSettingsSection;
  go: (section: ProjectSettingsSection) => void;
  changed: (project: ProjectSettingsView) => void;
  removed: () => void;
}) {
  const { connection, project, section, go, changed, removed } = props;
  const item = (key: ProjectSettingsSection) => ({ key, label: t(SETTINGS_PHRASE[key]), icon: SETTINGS_ICON[key] });
  return (
    <SettingsLayout
      label={t("tabSettings")}
      active={section}
      onSelect={go}
      groups={[
        (["general", "members"] as const).map(item),
        (["requests", "webhooks"] as const).map(item),
      ]}
    >
      {section === "general" ? <GeneralSettings connection={connection} project={project} changed={changed} removed={removed} /> : null}
      {section === "members" ? (
        <div>
          <Subhead title={t("membersTitle")}>{t("membersLead")}</Subhead>
          <ProjectMembers connection={connection} projectId={project.id} />
        </div>
      ) : null}
      {section === "requests" ? (
        <div>
          <Subhead title={t("reqTitle")}>{t("projectRequestsLead")}</Subhead>
          <AccessRequestsToDecide connection={connection} project={project.id} />
        </div>
      ) : null}
      {section === "webhooks" ? (
        <div>
          <Subhead title={t("projectWebhooks")} />
          <Webhooks connection={connection} projectId={project.id} />
        </div>
      ) : null}
    </SettingsLayout>
  );
}

function GeneralSettings({
  connection,
  project,
  changed,
  removed,
}: {
  connection: TeamConnection;
  project: ProjectSettingsView;
  changed: (project: ProjectSettingsView) => void;
  removed: () => void;
}) {
  const [description, setDescription] = useState(project.description);
  const [saveRole, setSaveRole] = useState<TeamVersionRole>(project.saveRole ?? "editor");
  const [restoreRole, setRestoreRole] = useState<TeamVersionRole>(project.restoreRole ?? "editor");
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);
  const dirty =
    description.trim() !== project.description.trim() || saveRole !== (project.saveRole ?? "editor") || restoreRole !== (project.restoreRole ?? "editor");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setSaving(true);
    try {
      const answer = await connection.call<{ project: ProjectSettingsView }>("projects.update", {
        project: project.id,
        description: description.trim(),
        saveRole,
        restoreRole,
      });
      changed(answer.project);
      toast(t("saved"));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setSaving(false);
    }
  };
  const roleSelect = (label: string, value: TeamVersionRole, set: (role: TeamVersionRole) => void) => (
    <SelectPanel<TeamVersionRole>
      label={label}
      align="end"
      value={value}
      onChange={set}
      options={[
        { value: "editor", label: t("roleEditorsUp") },
        { value: "owner", label: t("roleOwnersOnly") },
      ]}
    />
  );
  const remove = () =>
    void confirmAction({
      title: t("removeProjectTitle"),
      body: t("removeProjectConfirm", { name: project.name }),
      confirmLabel: t("removeProject"),
      danger: true,
      typeToConfirm: project.name,
    }).then((yes) => {
      if (!yes) return;
      void connection
        .call("projects.forget", { project: project.id })
        .then(() => {
          toast(t("removedProject", { name: project.name }));
          removed();
        })
        .catch((caught: unknown) => setFailure(caught));
    });
  return (
    <>
      <form onSubmit={(event) => void save(event)}>
        <Subhead title={t("settingsGeneral")} />
        <div className="form-field">
          <span className="form-label">{t("projectName")}</span>
          <input value={project.name} readOnly disabled />
          <span className="form-hint">{t("settingsNameFixed")}</span>
        </div>
        <label className="form-field">
          <span className="form-label">{t("settingsDescription")}</span>
          <textarea value={description} rows={3} maxLength={4096} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <h3 className="form-section-title">{t("versionRolesTitle")}</h3>
        <div className="box">
          <div className="box-row">
            <div className="box-row-text">
              <strong>{t("saveRoleLabel")}</strong>
            </div>
            {roleSelect(t("saveRoleLabel"), saveRole, setSaveRole)}
          </div>
          <div className="box-row">
            <div className="box-row-text">
              <strong>{t("restoreRoleLabel")}</strong>
              <span>{t("restoreInStudio")}</span>
            </div>
            {roleSelect(t("restoreRoleLabel"), restoreRole, setRestoreRole)}
          </div>
        </div>
        {failure === undefined ? null : <Flash error={failure} />}
        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={!dirty || saving}>
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </form>
      {project.mayRemove === true ? (
        <div className="danger-zone">
          <Subhead title={t("dangerZone")} danger />
          <div className="box box-danger">
            <div className="box-row">
              <div className="box-row-text">
                <strong>{t("removeProjectTitle")}</strong>
                <span>{t("removeProjectLead")}</span>
              </div>
              <button className="btn btn-danger" onClick={remove}>
                {t("removeProject")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- admin status */

interface DocumentsStatus {
  readonly held: boolean;
  readonly retainDays: number;
  readonly projects: ReadonlyArray<{
    readonly project: string;
    readonly name: string;
    readonly loaded: boolean;
    readonly seq: number;
    readonly savedSeq: number;
    readonly savedAt?: number;
    readonly logRows: number;
    readonly prunedThrough: number;
    readonly versions: number;
    readonly owedFiles?: number;
    readonly unreadable?: number;
  }>;
}

/** Every team project's log and versions, for an operator, with a way to save a version now. */
export function DocumentsPanel({ connection }: { connection: TeamConnection }) {
  const [status, setStatus] = useState<DocumentsStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const load = () =>
    connection
      .call<DocumentsStatus>("admin.documents.status")
      .then(setStatus)
      .catch((caught: unknown) => setError(errorText(caught)));
  useEffect(() => {
    void load();
    // Loaded once on opening; the button below and a reopen read it again.
  }, [connection]);
  if (error !== undefined) return <p className="error">{error}</p>;
  if (status === undefined) return <p className="muted">{t("loading")}</p>;
  if (!status.held) return <p className="placeholder-card">{t("docsNotHeld")}</p>;
  return (
    <div className="admin-section">
      <p className="muted">{t("docsLead")}</p>
      <p className="muted small">{t("docsRetain", { days: String(status.retainDays) })}</p>
      {status.projects.length === 0 ? (
        <p className="placeholder-card">{t("docsNone")}</p>
      ) : (
        <ul className="webhook-list">
          {status.projects.map((row) => (
            <li key={row.project} className="card">
              <div>
                <strong>{row.name}</strong> <span className="badge">{row.loaded ? t("docsLoaded") : t("docsIdle")}</span>
              </div>
              <div className="muted small">
                {[
                  t("docsSeq", { seq: String(row.seq) }),
                  t("docsSaved", { seq: String(row.savedSeq) }),
                  row.savedAt === undefined ? undefined : t("docsSavedAt", { when: new Date(row.savedAt).toLocaleString() }),
                  t("docsVersions", { count: String(row.versions) }),
                  t("docsLog", { count: String(row.logRows) }),
                  row.prunedThrough > 0 ? t("docsPruned", { seq: String(row.prunedThrough) }) : undefined,
                  row.owedFiles ? t("docsOwed", { count: String(row.owedFiles) }) : undefined,
                  row.unreadable ? t("docsUnreadable", { count: String(row.unreadable) }) : undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
              </div>
              {row.seq > row.savedSeq ? (
                <div className="review-actions">
                  <button
                    className="ghost small"
                    onClick={() =>
                      void connection
                        .call("doc.snapshot", { project: row.project })
                        .then(load)
                        .catch((caught: unknown) => setError(errorText(caught)))
                    }
                  >
                    {t("docsSaveNow")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
