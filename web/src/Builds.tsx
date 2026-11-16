/**
 * What a project hands to people who play it or read it without editing it:
 *
 *   - builds: playable exports Studio (or anybody with the editor role) uploads,
 *     one marked as the one to play, each kept with its checksum;
 *   - share links: a read-only look at a story or the whole project for somebody
 *     with no account, made here by an owner and opened at /console/s/<token>;
 *   - the page such a link opens, where a guest may also leave a note.
 *
 * The console never changes a project's content (docs/architecture.md, D1), and
 * the server never reads it (D2), so the paths a story's link shows are worked
 * out here, from the revision's own story index.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BUILD_MAX_BYTES,
  projectBuildsTopic,
  SHARE_LINK_MAX_DAYS,
  type TeamBuild,
  type TeamBuildsEvent,
  type TeamProjectRole,
  type TeamShareLink,
  type TeamShareView,
} from "@narraleaf/team-protocol";
import {
  ASSET_REGISTER_PATTERN,
  CHARACTER_STORE_PATH,
  readStoryLibrary,
  STORY_INDEX_PATH,
  VARIABLE_STORE_PATH,
  type StoryEntry,
  type StoryRow,
} from "@narraleaf/project-view";

import { fetchJson, fetchTree } from "./files";
import { Icon } from "./Icon";
import { t, type Phrase } from "./i18n";
import { LeafLogo } from "./LeafLogo";
import { loadProjectData, type ProjectData } from "./projectData";
import { StorageMeter, type StorageRow } from "./Security";
import type { TeamConnection } from "./socket";
import {
  ActionMenu,
  Blankslate,
  confirmAction,
  CopyText,
  Dialog,
  Flash,
  RelativeTime,
  SelectPanel,
  Subhead,
  Switch,
  toast,
  toastError,
  type MenuAction,
} from "./ui";

/** A byte count as people read it: 1.4 GB, not 1503238553. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const PLATFORMS = ["windows", "mac", "linux", "web", "android", "ios", "other"] as const;
type Platform = (typeof PLATFORMS)[number];
const PLATFORM_PHRASE: Record<Platform, Phrase> = {
  windows: "platWindows",
  mac: "platMac",
  linux: "platLinux",
  web: "platWeb",
  android: "platAndroid",
  ios: "platIos",
  other: "platOther",
};

function platformText(platform: string | undefined): string | undefined {
  if (platform === undefined) return undefined;
  const known = PLATFORMS.find((name) => name === platform);
  return known === undefined ? platform : t(PLATFORM_PHRASE[known]);
}

function buildsBase(projectId: string): string {
  return `/api/team/v1/projects/${encodeURIComponent(projectId)}/builds`;
}

/** A project's builds, newest first, kept current by its builds topic. */
export function useBuilds(connection: TeamConnection, open: boolean, projectId: string): readonly TeamBuild[] | undefined {
  const [builds, setBuilds] = useState<readonly TeamBuild[] | undefined>(undefined);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    connection
      .call<{ builds: TeamBuild[] }>("builds.list", { project: projectId })
      .then((answer) => {
        if (live) setBuilds(answer.builds);
      })
      .catch(() => {
        if (live) setBuilds([]);
      });
    const stop = connection.subscribe(projectBuildsTopic(projectId), (payload) => {
      const event = payload as TeamBuildsEvent;
      setBuilds((current) => {
        const list = current ?? [];
        if (event.kind === "build-removed") return list.filter((build) => build.id !== event.build);
        const without = list.filter((build) => build.id !== event.build.id);
        return [event.build, ...without].sort((a, b) => b.createdAt - a.createdAt);
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [open, connection, projectId]);
  return builds;
}

/** Send one file as a build, reporting how much has gone. */
function sendBuild(
  projectId: string,
  file: File,
  fields: { name: string; note: string; platform: string; latest: boolean },
  progress: (fraction: number) => void,
): { done: Promise<TeamBuild>; cancel: () => void } {
  const query = new URLSearchParams({ name: fields.name, file: file.name });
  if (fields.note.trim() !== "") query.set("note", fields.note.trim());
  if (fields.platform !== "") query.set("platform", fields.platform);
  if (fields.latest) query.set("latest", "1");
  const request = new XMLHttpRequest();
  const done = new Promise<TeamBuild>((resolve, reject) => {
    request.open("PUT", `${buildsBase(projectId)}?${query.toString()}`);
    request.withCredentials = true;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    };
    request.onload = () => {
      try {
        const body = JSON.parse(request.responseText) as { build?: TeamBuild; error?: string };
        if (request.status >= 200 && request.status < 300 && body.build !== undefined) resolve(body.build);
        else reject(new Error(body.error ?? request.statusText));
      } catch {
        reject(new Error(request.statusText || t("buildUploadFailed")));
      }
    };
    request.onerror = () => reject(new Error(t("buildUploadFailed")));
    request.onabort = () => reject(new Error(t("buildUploadCancelled")));
    request.send(file);
  });
  return { done, cancel: () => request.abort() };
}

interface ProjectStorage {
  readonly storage: Pick<StorageRow, "usedBytes" | "buildBytes" | "attachmentBytes" | "quotaBytes" | "nearlyFull" | "full">;
  readonly buildLimitBytes: number;
}

/** How much room this project has left, and the largest build it takes. Refreshed when its builds change. */
function useProjectStorage(connection: TeamConnection, projectId: string, builds: readonly TeamBuild[] | undefined): ProjectStorage | undefined {
  const [answer, setAnswer] = useState<ProjectStorage | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void connection
      .call<ProjectStorage>("projects.storage", { project: projectId })
      .then((next) => {
        if (live) setAnswer(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection, projectId, builds]);
  return answer;
}

function BuildUpload({ projectId, first, storage }: { projectId: string; first: boolean; storage: ProjectStorage | undefined }) {
  const limit = storage?.buildLimitBytes ?? BUILD_MAX_BYTES;
  const [file, setFile] = useState<File | undefined>(undefined);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [platform, setPlatform] = useState<string>("windows");
  const [latest, setLatest] = useState(true);
  const [sending, setSending] = useState<{ fraction: number; cancel: () => void } | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  const pick = (picked: File | undefined) => {
    setFile(picked);
    if (picked !== undefined && name.trim() === "") setName(picked.name.replace(/\.[^.]+$/, ""));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (file === undefined) return;
    if (file.size > limit) {
      toastError(new Error(t("buildTooLarge", { size: formatBytes(limit) })));
      return;
    }
    const sent = sendBuild(projectId, file, { name: name.trim() || file.name, note, platform, latest }, (fraction) =>
      setSending((current) => (current === undefined ? current : { ...current, fraction })),
    );
    setSending({ fraction: 0, cancel: sent.cancel });
    try {
      await sent.done;
      toast(t("buildUploaded"));
      setFile(undefined);
      setName("");
      setNote("");
      if (input.current !== null) input.current.value = "";
    } catch (caught) {
      toastError(caught);
    } finally {
      setSending(undefined);
    }
  };

  return (
    <form className="card build-upload" onSubmit={(event) => void submit(event)}>
      {storage?.storage.quotaBytes === undefined ? null : (
        <div className="build-storage">
          <span className="muted small">{t("storageUsed")}</span>
          <StorageMeter row={storage.storage} />
        </div>
      )}
      {storage?.storage.full === true ? (
        <Flash tone="danger">{t("storageFull")}</Flash>
      ) : storage?.storage.nearlyFull === true ? (
        <Flash tone="warning">{t("storageNearlyFull")}</Flash>
      ) : null}
      <label
        className={file === undefined ? "build-drop" : "build-drop picked"}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          pick(event.dataTransfer.files[0]);
        }}
      >
        <Icon name="upload" size={20} />
        <span>
          {file === undefined ? t("buildPick") : `${file.name} · ${formatBytes(file.size)}`}
          <span className="muted small"> {t("buildPickHint", { size: formatBytes(limit) })}</span>
        </span>
        <input ref={input} type="file" hidden onChange={(event) => pick(event.target.files?.[0])} />
      </label>
      <div className="review-fields">
        <label className="form-field">
          <span className="form-label">{t("buildName")}</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={t("buildNamePlaceholder")} />
        </label>
        <div className="form-field">
          <span className="form-label">{t("buildPlatform")}</span>
          <SelectPanel label={t("buildPlatform")} value={platform} onChange={setPlatform} options={PLATFORMS.map((value) => ({ value, label: t(PLATFORM_PHRASE[value]) }))} />
        </div>
      </div>
      <label className="form-field">
        <span className="form-label">{t("buildNote")}</span>
        <textarea value={note} rows={2} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder={t("buildNotePlaceholder")} />
      </label>
      {first ? null : (
        <div className="field-row">
          <span>{t("buildMakeLatest")}</span>
          <Switch checked={latest} onChange={setLatest} label={t("buildMakeLatest")} />
        </div>
      )}
      {sending === undefined ? (
        <button className="btn btn-primary" type="submit" disabled={file === undefined}>
          <Icon name="upload" size={14} /> {t("buildUpload")}
        </button>
      ) : (
        <div className="build-progress">
          <progress value={sending.fraction} max={1} />
          <span className="muted small">{Math.round(sending.fraction * 100)}%</span>
          <button type="button" className="btn btn-sm" onClick={sending.cancel}>
            {t("cancel")}
          </button>
        </div>
      )}
    </form>
  );
}

function EditBuild({ connection, build, onClose }: { connection: TeamConnection; build: TeamBuild; onClose: () => void }) {
  const [name, setName] = useState(build.name);
  const [note, setNote] = useState(build.note ?? "");
  const [platform, setPlatform] = useState(build.platform ?? "other");
  const save = () =>
    void connection
      .call("builds.update", { build: build.id, name: name.trim(), note: note.trim() === "" ? null : note.trim(), platform })
      .then(() => {
        toast(t("saved"));
        onClose();
      })
      .catch(toastError);
  return (
    <Dialog
      title={t("buildEdit")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" disabled={name.trim() === ""} onClick={save}>
            {t("save")}
          </button>
        </>
      }
    >
      <label className="form-field">
        <span className="form-label">{t("buildName")}</span>
        <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="form-field">
        <span className="form-label">{t("buildPlatform")}</span>
        <SelectPanel label={t("buildPlatform")} value={platform} onChange={setPlatform} options={PLATFORMS.map((value) => ({ value, label: t(PLATFORM_PHRASE[value]) }))} />
      </div>
      <label className="form-field">
        <span className="form-label">{t("buildNote")}</span>
        <textarea value={note} rows={3} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
      </label>
    </Dialog>
  );
}

/** The project's builds: the one to play on top, the rest below, newest first. */
export function BuildsPage(props: { connection: TeamConnection; open: boolean; projectId: string; role: TeamProjectRole | undefined; me: string; operator: boolean }) {
  const { connection, open, projectId, role, me, operator } = props;
  const builds = useBuilds(connection, open, projectId);
  const storage = useProjectStorage(connection, projectId, builds);
  const [editing, setEditing] = useState<TeamBuild | undefined>(undefined);
  const mayUpload = role === "owner" || role === "editor";
  const ordered = useMemo(() => (builds === undefined ? undefined : [...builds].sort((a, b) => Number(b.latest) - Number(a.latest) || b.createdAt - a.createdAt)), [builds]);

  const actions = (build: TeamBuild): MenuAction[] => {
    const list: MenuAction[] = [];
    if (mayUpload && !build.latest) {
      list.push({
        label: t("buildMakeLatest"),
        icon: "flag",
        run: () => void connection.call("builds.update", { build: build.id, latest: true }).then(() => toast(t("buildIsLatestNow"))).catch(toastError),
      });
    }
    if (mayUpload) list.push({ label: t("edit"), icon: "gear", run: () => setEditing(build) });
    list.push({
      label: t("buildCopyChecksum"),
      icon: "copy",
      run: () => void navigator.clipboard?.writeText(build.sha256).then(() => toast(t("copied")), () => undefined),
    });
    const mayRemove = role === "owner" || operator || build.uploadedBy === me;
    list.push({
      label: t("remove"),
      icon: "trash",
      danger: true,
      ...(mayRemove ? {} : { disabledReason: t("buildRemoveWho") }),
      run: () =>
        void confirmAction({ title: t("buildRemoveTitle"), body: t("buildRemoveBody", { name: build.name }), confirmLabel: t("remove"), danger: true }).then((yes) => {
          if (yes) void connection.call("builds.delete", { build: build.id }).then(() => toast(t("buildRemoved"))).catch(toastError);
        }),
    });
    return list;
  };

  return (
    <div className="builds-page">
      <Subhead title={t("tabBuilds")}>{t("buildsLead")}</Subhead>
      {mayUpload ? <BuildUpload projectId={projectId} first={builds !== undefined && builds.length === 0} storage={storage} /> : null}
      {ordered === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : ordered.length === 0 ? (
        <Blankslate icon="gamepad" title={t("buildsNone")}>
          {mayUpload ? t("buildsNoneHint") : t("buildsNoneReader")}
        </Blankslate>
      ) : (
        <ul className="build-list">
          {ordered.map((build) => (
            <li key={build.id} className={build.latest ? "card build latest" : "card build"}>
              <span className="build-icon">
                <Icon name="gamepad" size={20} />
              </span>
              <div className="build-main">
                <div className="build-title">
                  <strong>{build.name}</strong>
                  {build.latest ? <span className="badge accent">{t("buildLatest")}</span> : null}
                  {build.platform === undefined ? null : <span className="badge">{platformText(build.platform)}</span>}
                </div>
                <div className="muted small">
                  {build.file} · {formatBytes(build.size)} · {build.uploadedBy ?? t("someoneGone")} · <RelativeTime at={build.createdAt} />
                  {build.revision === undefined ? null : (
                    <>
                      {" · "}
                      <span className="mono">{build.revision.slice(0, 7)}</span>
                    </>
                  )}
                </div>
                {build.note === undefined ? null : <p className="build-note">{build.note}</p>}
              </div>
              <div className="build-actions">
                <a className={build.latest ? "btn btn-primary btn-sm" : "btn btn-sm"} href={`${buildsBase(projectId)}/${encodeURIComponent(build.id)}`} download={build.file}>
                  <Icon name="download" size={14} /> {t("buildDownload")}
                </a>
                <ActionMenu label={t("moreActions")} actions={actions(build)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing === undefined ? null : <EditBuild connection={connection} build={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

/* ------------------------------------------------------------ share links */

/** Everything one story needs to be read: its document, the index naming it, the characters, variables and assets. */
async function storyPaths(projectId: string, entry: StoryEntry): Promise<string[]> {
  const tree = await fetchTree(projectId, "head");
  const registers = tree.files.map((file) => file.path).filter((path) => ASSET_REGISTER_PATTERN.test(path));
  return [STORY_INDEX_PATH, entry.documentPath, CHARACTER_STORE_PATH, VARIABLE_STORE_PATH, ...registers, "assets/content/"];
}

async function readStories(projectId: string): Promise<{ stories: readonly StoryEntry[]; revision: string | undefined }> {
  const tree = await fetchTree(projectId, "head");
  if (!tree.files.some((file) => file.path === STORY_INDEX_PATH)) return { stories: [], revision: tree.revision };
  const library = readStoryLibrary(await fetchJson(projectId, "head", STORY_INDEX_PATH));
  return { stories: library.supported ? library.stories : [], revision: tree.revision };
}

const SPANS: readonly { days: number | undefined; phrase: Phrase }[] = [
  { days: 7, phrase: "shareFor7d" },
  { days: 30, phrase: "shareFor30d" },
  { days: 90, phrase: "shareFor90d" },
  { days: SHARE_LINK_MAX_DAYS, phrase: "shareFor1y" },
  { days: undefined, phrase: "shareForever" },
];

function shareUrl(token: string): string {
  return `${window.location.origin}/console/s/${encodeURIComponent(token)}`;
}

function ShareCreate({ connection, projectId, created }: { connection: TeamConnection; projectId: string; created: (token: string) => void }) {
  const [stories, setStories] = useState<{ stories: readonly StoryEntry[]; revision: string | undefined } | undefined>(undefined);
  const [scope, setScope] = useState("project");
  const [label, setLabel] = useState("");
  const [span, setSpan] = useState("30");
  const [comments, setComments] = useState(true);
  const [freeze, setFreeze] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    readStories(projectId)
      .then(setStories)
      .catch(() => setStories({ stories: [], revision: undefined }));
  }, [projectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const story = stories?.stories.find((entry) => `story:${entry.id}` === scope);
      const paths = story === undefined ? undefined : await storyPaths(projectId, story);
      const days = SPANS.find((entry) => String(entry.days ?? "") === span)?.days;
      const revision = freeze && stories?.revision !== undefined && stories.revision !== "head" ? stories.revision : "head";
      const answer = await connection.call<{ share: TeamShareLink; token: string }>("shares.create", {
        project: projectId,
        label: label.trim() || (story === undefined ? t("shareWholeProject") : story.name),
        scope,
        revision,
        ...(paths === undefined ? {} : { paths }),
        allowComments: comments,
        ...(days === undefined ? {} : { days }),
      });
      setLabel("");
      created(answer.token);
    } catch (caught) {
      toastError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card share-new" onSubmit={(event) => void submit(event)}>
      <div className="review-fields">
        <div className="form-field">
          <span className="form-label">{t("shareWhat")}</span>
          <SelectPanel
            label={t("shareWhat")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "project", label: t("shareWholeProject"), icon: "folder" },
              ...(stories?.stories ?? []).map((entry) => ({ value: `story:${entry.id}`, label: entry.name, icon: "book" as const })),
            ]}
          />
        </div>
        <div className="form-field">
          <span className="form-label">{t("shareExpires")}</span>
          <SelectPanel label={t("shareExpires")} value={span} onChange={setSpan} options={SPANS.map((entry) => ({ value: String(entry.days ?? ""), label: t(entry.phrase) }))} />
        </div>
      </div>
      <label className="form-field">
        <span className="form-label">{t("shareLabel")}</span>
        <input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder={t("shareLabelPlaceholder")} />
      </label>
      <div className="field-row">
        <span>{t("shareAllowComments")}</span>
        <Switch checked={comments} onChange={setComments} label={t("shareAllowComments")} />
      </div>
      <div className="field-row">
        <span>{t("shareFreeze")}</span>
        <Switch checked={freeze} onChange={setFreeze} label={t("shareFreeze")} />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy || stories === undefined}>
        <Icon name="link" size={14} /> {t("shareCreate")}
      </button>
    </form>
  );
}

/** A project's share links, for its owners. */
export function ShareLinks({ connection, projectId }: { connection: TeamConnection; projectId: string }) {
  const [shares, setShares] = useState<readonly TeamShareLink[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [token, setToken] = useState<string | undefined>(undefined);
  const load = useCallback(() => {
    connection
      .call<{ shares: TeamShareLink[] }>("shares.list", { project: projectId })
      .then((answer) => setShares(answer.shares))
      .catch((caught: unknown) => setError(caught));
  }, [connection, projectId]);
  useEffect(() => load(), [load]);
  const now = Date.now();
  const state = (share: TeamShareLink): { phrase: Phrase; tone: string } =>
    share.revokedAt !== undefined
      ? { phrase: "shareRevoked", tone: "badge danger" }
      : share.expiresAt !== undefined && share.expiresAt <= now
        ? { phrase: "shareExpired", tone: "badge" }
        : { phrase: "shareActive", tone: "badge success" };

  return (
    <div className="admin-section">
      {error === undefined ? null : <Flash error={error} />}
      {token === undefined ? null : (
        <Flash tone="success" action={<button className="btn btn-sm" onClick={() => setToken(undefined)}>{t("done")}</button>}>
          <div>{t("shareCreatedOnce")}</div>
          <CopyText value={shareUrl(token)} />
        </Flash>
      )}
      <ShareCreate
        connection={connection}
        projectId={projectId}
        created={(next) => {
          setToken(next);
          load();
        }}
      />
      {shares === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : shares.length === 0 ? (
        <Blankslate icon="link" title={t("shareNone")} compact>
          {t("shareNoneHint")}
        </Blankslate>
      ) : (
        <ul className="webhook-list">
          {shares.map((share) => {
            const shown = state(share);
            const live = share.revokedAt === undefined && (share.expiresAt === undefined || share.expiresAt > now);
            return (
              <li key={share.id} className="card share-row">
                <div className="build-title">
                  <Icon name={share.scope.startsWith("story:") ? "book" : "folder"} size={14} />
                  <strong>{share.label}</strong>
                  <span className={shown.tone}>{t(shown.phrase)}</span>
                  {share.allowComments ? <span className="badge">{t("shareTakesNotes")}</span> : null}
                </div>
                <div className="muted small">
                  {share.revision === "head" ? t("shareFollowsLatest") : t("shareFrozenAt", { rev: share.revision.slice(0, 7) })}
                  {" · "}
                  {share.expiresAt === undefined ? t("shareNoExpiry") : <>{t("shareExpiresAt")} <RelativeTime at={share.expiresAt} /></>}
                  {" · "}
                  {t("shareUses", { count: String(share.uses) })}
                  {share.lastUsedAt === undefined ? null : (
                    <>
                      {" · "}
                      {t("shareLastUsed")} <RelativeTime at={share.lastUsedAt} />
                    </>
                  )}
                  {share.createdBy === undefined ? null : ` · ${share.createdBy}`}
                </div>
                {live ? (
                  <div className="review-actions">
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        void confirmAction({ title: t("shareRevokeTitle"), body: t("shareRevokeBody", { name: share.label }), confirmLabel: t("shareRevoke"), danger: true }).then((yes) => {
                          if (!yes) return;
                          void connection
                            .call("shares.revoke", { share: share.id })
                            .then(() => {
                              toast(t("shareRevokedToast"));
                              load();
                            })
                            .catch(toastError);
                        })
                      }
                    >
                      {t("shareRevoke")}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the page a link opens */

const READ_KINDS = new Set<StoryRow["kind"]>(["narration", "dialogue", "choice", "option"]);

function speakerName(row: StoryRow, data: ProjectData): string | undefined {
  if (row.kind !== "dialogue" || row.speaker === undefined) return undefined;
  return "characterId" in row.speaker ? (data.characters.get(row.speaker.characterId)?.name ?? "?") : row.speaker.name;
}

function GuestNote(props: { token: string; view: TeamShareView; document?: string; element?: string; label: string; onClose: () => void }) {
  const { token, view, document, element, label, onClose } = props;
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("nlteam.guestName") ?? "";
    } catch {
      return "";
    }
  });
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/team/v1/share/${encodeURIComponent(token)}/comments`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), body: body.trim(), ...(document === undefined ? {} : { document }), ...(element === undefined ? {} : { element }) }),
      });
      if (!response.ok) {
        const answer = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(answer.error ?? response.statusText);
      }
      try {
        localStorage.setItem("nlteam.guestName", name.trim());
      } catch {
        /* nothing to remember with */
      }
      toast(t("guestNoteSent"));
      onClose();
    } catch (caught) {
      toastError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("guestNoteTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || name.trim() === "" || body.trim() === ""} onClick={() => void send()}>
            {t("guestNoteSend")}
          </button>
        </>
      }
    >
      <p className="muted small">{t("guestNoteLead", { project: view.projectName })}</p>
      <blockquote className="guest-quote">{label}</blockquote>
      <label className="form-field">
        <span className="form-label">{t("guestName")}</span>
        <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} autoFocus />
      </label>
      <label className="form-field">
        <span className="form-label">{t("guestNoteBody")}</span>
        <textarea value={body} rows={4} maxLength={16000} onChange={(event) => setBody(event.target.value)} />
      </label>
    </Dialog>
  );
}

/** What /console/s/<token> shows: the stories the link opens, read-only, with a place to leave a note. */
export function ShareView({ token }: { token: string }) {
  const [view, setView] = useState<TeamShareView | Error | undefined>(undefined);
  const [data, setData] = useState<ProjectData | Error | undefined>(undefined);
  const [storyId, setStoryId] = useState<string | undefined>(undefined);
  const [sceneId, setSceneId] = useState<string | undefined>(undefined);
  const [noting, setNoting] = useState<{ element?: string; label: string } | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/team/v1/share/${encodeURIComponent(token)}`, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("shareGone"));
        return (await response.json()) as TeamShareView;
      })
      .then(async (found) => {
        if (!live) return;
        setView(found);
        document.title = `${found.label} · ${found.projectName}`;
        const project = `share:${token}`;
        const tree = await fetchTree(project, found.revision);
        const loaded = await loadProjectData(project, tree);
        if (live) setData(loaded);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const error = caught instanceof Error ? caught : new Error(String(caught));
        setView((current) => (current === undefined ? error : current));
        setData(error);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const stories = data === undefined || data instanceof Error ? [] : data.stories;
  const story = stories.find((entry) => entry.entry.id === storyId) ?? stories[0];
  const scene = story === undefined ? undefined : (story.document.scenes[sceneId ?? ""] ?? story.document.scenes[story.document.order[0] ?? ""]);

  if (view === undefined) return <div className="splash" aria-busy="true" />;
  if (view instanceof Error) {
    return (
      <main className="share-page">
        <Blankslate icon="link" title={t("shareGone")}>
          {t("shareGoneHint")}
        </Blankslate>
      </main>
    );
  }
  const anchorOf = story === undefined ? undefined : `story:${story.entry.id}`;
  return (
    <main className="share-page">
      <header className="share-head">
        <LeafLogo size={22} className="share-leaf" />
        <div>
          <h1>{view.label}</h1>
          <p className="muted small">
            {view.projectName} · {view.revision === "head" ? t("shareFollowsLatest") : t("shareFrozenAt", { rev: view.revision.slice(0, 7) })}
            {view.expiresAt === undefined ? null : (
              <>
                {" · "}
                {t("shareExpiresAt")} <RelativeTime at={view.expiresAt} />
              </>
            )}
          </p>
        </div>
        <span className="badge">{t("readOnlyBadge")}</span>
      </header>
      {data === undefined ? (
        <p className="muted">{t("loading")}</p>
      ) : data instanceof Error ? (
        <Flash error={data} />
      ) : story === undefined ? (
        <Blankslate icon="book" title={t("shareNoStory")} />
      ) : (
        <div className="share-body">
          <nav className="share-outline" aria-label={t("tabStory")}>
            {stories.length > 1 ? (
              <SelectPanel
                label={t("storyPick")}
                size="small"
                value={story.entry.id}
                onChange={(next) => {
                  setStoryId(next);
                  setSceneId(undefined);
                }}
                options={stories.map((entry) => ({ value: entry.entry.id, label: entry.entry.name, icon: "book" }))}
              />
            ) : (
              <strong className="share-story">{story.entry.name}</strong>
            )}
            {story.document.order.map((id) => {
              const item = story.document.scenes[id];
              if (item === undefined) return null;
              return (
                <button key={id} className={item.id === scene?.id ? "share-scene active" : "share-scene"} onClick={() => setSceneId(id)}>
                  {item.name}
                </button>
              );
            })}
          </nav>
          <article className="share-script">
            {scene === undefined ? null : (
              <>
                <h2>{scene.name}</h2>
                {scene.description ? <p className="muted">{scene.description}</p> : null}
                <ol className="share-lines">
                  {scene.rows
                    .filter((row) => READ_KINDS.has(row.kind) && !row.disabled)
                    .map((row) => {
                      const text = "text" in row ? row.text : "";
                      const who = speakerName(row, data);
                      return (
                        <li key={row.id} className={`share-line ${row.kind}`} style={{ paddingLeft: `${row.depth * 16}px` }}>
                          {who === undefined ? null : <span className="share-who">{who}</span>}
                          <span className="share-text">{row.kind === "option" ? `› ${text}` : text}</span>
                          {view.allowComments ? (
                            <button
                              className="btn btn-invisible btn-icon btn-sm share-note"
                              title={t("guestNoteTitle")}
                              aria-label={t("guestNoteTitle")}
                              onClick={() => setNoting({ element: `${scene.id}/${row.id}`, label: who === undefined ? text : `${who}：${text}` })}
                            >
                              <Icon name="chat" size={14} />
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                </ol>
              </>
            )}
          </article>
        </div>
      )}
      {view.allowComments && data !== undefined && !(data instanceof Error) ? (
        <div className="share-foot">
          <button className="btn" onClick={() => setNoting({ label: view.label })}>
            <Icon name="chat" size={14} /> {t("guestNoteGeneral")}
          </button>
        </div>
      ) : null}
      {noting === undefined ? null : (
        <GuestNote
          token={token}
          view={view}
          {...(anchorOf === undefined ? {} : { document: anchorOf })}
          {...(noting.element === undefined ? {} : { element: noting.element })}
          label={noting.label}
          onClose={() => setNoting(undefined)}
        />
      )}
      <footer className="share-powered muted small">Powered by NarraLeaf Team</footer>
    </main>
  );
}
