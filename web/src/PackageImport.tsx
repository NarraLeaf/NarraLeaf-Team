/**
 * Making a team project from a Studio project package.
 *
 * This is the way a local project becomes a team project: its author exports
 * it from NarraLeaf Studio (File › Export Project, a `.nlspkg`) and uploads the
 * package here. Studio no longer puts a project on a server from the project's
 * own window.
 *
 * Two steps behind one button. The project is made with `projects.create`, so
 * who may make one, what it may be called and who hears about it are the rules
 * every other project is made under; then the package is sent to the new
 * project, which takes it as its first version. A package the server refuses
 * deletes the project made for it, repository and all, so a failed import
 * leaves neither an empty project on the list nor a repository holding its
 * name.
 *
 * A name that is still held by the repository of a project taken off the list
 * is said as that, with the two ways out: bring the old project back, or (for
 * an operator) delete it for good and import under the name after all.
 */
import { useRef, useState } from "react";

import { formatBytes } from "./Builds";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { CallError, type TeamConnection } from "./socket";
import { confirmAction, Flash, FormDialog, toast } from "./ui";

/**
 * The repository a refused create says is holding the name.
 *
 * Read from the server's own sentence for that refusal (`projects.create`,
 * "name-held" in src/team/methods/projects.ts), which names it in parentheses.
 */
function heldRepository(caught: unknown): string | undefined {
  if (!(caught instanceof CallError) || caught.code !== "conflict") return undefined;
  return /\(repository ([0-9a-f]{32})\)/.exec(caught.message)?.[1];
}

/** What a project may be called on a server: the rule `projects.create` holds. */
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** The largest package the server takes (src/web/uploads.ts `PACKAGE_MAX_BYTES`). */
const PACKAGE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** A file name turned into a project name the server takes, or nothing. */
function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.nlspkg$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}

/** Send a package to a project, reporting how much has gone. */
function sendPackage(projectId: string, file: File, progress: (fraction: number) => void): { done: Promise<void>; cancel: () => void } {
  const request = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    request.open("PUT", `/api/team/v1/projects/${encodeURIComponent(projectId)}/package`);
    request.withCredentials = true;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { error?: string };
        reject(new Error(body.error ?? request.statusText));
      } catch {
        reject(new Error(request.statusText || t("packageImportFailed")));
      }
    };
    request.onerror = () => reject(new Error(t("packageImportFailed")));
    request.onabort = () => reject(new Error(t("packageImportCancelled")));
    request.send(file);
  });
  return { done, cancel: () => request.abort() };
}

export function PackageImportDialog({
  connection,
  operator,
  onClose,
  onImported,
}: {
  connection: TeamConnection;
  operator: boolean;
  onClose: () => void;
  onImported: (projectId: string) => void;
}) {
  const [file, setFile] = useState<File | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState<{ fraction: number; cancel: () => void } | undefined>(undefined);
  /** The name the server said is held by a leftover repository, and that repository. */
  const [held, setHeld] = useState<{ name: string; repositoryId: string } | undefined>(undefined);
  const [heldBusy, setHeldBusy] = useState(false);
  const [heldFailure, setHeldFailure] = useState<unknown>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const nameProblem = trimmed !== "" && !PROJECT_NAME_PATTERN.test(trimmed);

  const pick = (picked: File | undefined) => {
    setFile(picked);
    if (picked !== undefined && trimmed === "") setName(nameFromFile(picked.name));
  };

  const submit = async () => {
    if (file === undefined || trimmed === "" || nameProblem) return false;
    if (!file.name.toLowerCase().endsWith(".nlspkg")) throw new Error(t("packageNotPackage"));
    if (file.size > PACKAGE_MAX_BYTES) throw new Error(t("packageTooLarge", { size: formatBytes(PACKAGE_MAX_BYTES) }));
    setHeld(undefined);
    let made: { project: { id: string } };
    try {
      made = await connection.call<{ project: { id: string } }>("projects.create", {
        name: trimmed,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      });
    } catch (caught) {
      const repositoryId = heldRepository(caught);
      if (repositoryId === undefined) throw caught;
      setHeldFailure(undefined);
      setHeld({ name: trimmed, repositoryId });
      return false;
    }
    const projectId = made.project.id;
    const sent = sendPackage(projectId, file, (fraction) => setSending((current) => (current === undefined ? current : { ...current, fraction })));
    setSending({ fraction: 0, cancel: sent.cancel });
    try {
      await sent.done;
    } catch (error) {
      // The project was made for this package only. Deleted for good, so its
      // repository does not go on holding the name; taken off the list where
      // the caller may not delete it.
      await connection
        .call("projects.delete", { name: trimmed, repositoryId: projectId })
        .catch(() => connection.call("projects.forget", { project: projectId }))
        .catch(() => undefined);
      throw error;
    } finally {
      setSending(undefined);
    }
    toast(t("packageImported"));
    onImported(projectId);
  };

  /** Bring back the project whose repository holds the name: recorded again under its own id. */
  const restoreOld = async () => {
    if (held === undefined) return;
    setHeldBusy(true);
    setHeldFailure(undefined);
    try {
      const made = await connection.call<{ project: { id: string } }>("projects.create", { name: held.name, repositoryId: held.repositoryId });
      toast(t("restoredProject", { name: held.name }));
      onImported(made.project.id);
    } catch (caught) {
      setHeldFailure(caught);
    } finally {
      setHeldBusy(false);
    }
  };

  /** Delete the repository holding the name, after the operator types the name; the import can then go ahead. */
  const deleteOld = async () => {
    if (held === undefined) return;
    const yes = await confirmAction({
      title: t("deleteForeverTitle"),
      body: t("deleteForeverConfirm", { name: held.name }),
      confirmLabel: t("deleteForever"),
      danger: true,
      typeToConfirm: held.name,
    });
    if (!yes) return;
    setHeldBusy(true);
    setHeldFailure(undefined);
    try {
      await connection.call("projects.delete", { name: held.name, repositoryId: held.repositoryId });
      toast(t("deletedForever", { name: held.name }));
      setHeld(undefined);
    } catch (caught) {
      setHeldFailure(caught);
    } finally {
      setHeldBusy(false);
    }
  };

  /** Closing while it sends stops the upload too, and the failed send takes the new project away. */
  const close = () => {
    sending?.cancel();
    onClose();
  };

  return (
    <FormDialog
      title={t("packageImportTitle")}
      lead={t("packageImportLead")}
      submitLabel={t("packageImport")}
      width={560}
      ready={file !== undefined && trimmed !== "" && !nameProblem && sending === undefined}
      onSubmit={submit}
      onClose={close}
    >
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
          {file === undefined ? t("packagePick") : `${file.name} · ${formatBytes(file.size)}`}
          <span className="muted small"> {t("packagePickHint", { size: formatBytes(PACKAGE_MAX_BYTES) })}</span>
        </span>
        <input ref={input} type="file" accept=".nlspkg" hidden onChange={(event) => pick(event.target.files?.[0])} />
      </label>
      <label className="form-field">
        <span className="form-label">{t("packageProjectName")}</span>
        <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} placeholder="my-game" aria-invalid={nameProblem} />
        <span className={nameProblem ? "error small" : "muted small"}>{t(nameProblem ? "packageNameInvalid" : "packageNameHint")}</span>
      </label>
      <label className="form-field">
        <span className="form-label">{t("packageProjectDescription")}</span>
        <textarea value={description} rows={2} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {held === undefined || held.name !== trimmed ? null : (
        <Flash
          tone="warning"
          action={
            <span className="flash-actions">
              <button className="btn btn-sm" type="button" disabled={heldBusy} onClick={() => void restoreOld()}>
                {t("packageRestoreOld")}
              </button>
              {operator ? (
                <button className="btn btn-sm btn-danger" type="button" disabled={heldBusy} onClick={() => void deleteOld()}>
                  {t("deleteForever")}
                </button>
              ) : null}
            </span>
          }
        >
          {t(operator ? "packageNameHeld" : "packageNameHeldAsk", { name: held.name })}
        </Flash>
      )}
      {heldFailure === undefined ? null : <Flash error={heldFailure} />}
      {sending === undefined ? null : (
        <div className="build-progress">
          <progress value={sending.fraction} max={1} />
          <span className="muted small">{Math.round(sending.fraction * 100)}%</span>
        </div>
      )}
    </FormDialog>
  );
}
