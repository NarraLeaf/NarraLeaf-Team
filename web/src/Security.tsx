/**
 * Sign-in security and the server's safety net, as the console shows them:
 * two-step sign-in and API tokens in a person's own settings, the page a reset
 * link opens, and an operator's storage, backups and filtered audit log.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { TeamAdminDecision } from "@narraleaf/team-protocol";

import { t } from "./i18n";
import { Checkbox, confirmAction, CopyText, Flash, RelativeTime, SelectPanel, Skeleton, Subhead, toast, toastError } from "./ui";
import { formatBytes } from "./Builds";
import type { TeamConnection } from "./socket";

/* ---------------------------------------------------------- two-step */

interface TotpStatus {
  readonly enabled: boolean;
  readonly pending?: boolean;
  readonly recoveryLeft?: number;
  readonly required: boolean;
}

function RecoveryCodes({ codes, done }: { codes: readonly string[]; done: () => void }) {
  const text = codes.join("\n");
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    link.download = `${location.hostname}-recovery-codes.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="stack">
      <Flash tone="warning">{t("tfaRecoveryLead")}</Flash>
      <pre className="recovery-codes">{text}</pre>
      <div className="form-actions">
        <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => toast(t("copied")))}>
          {t("copy")}
        </button>
        <button className="btn" type="button" onClick={download}>
          {t("tfaDownloadCodes")}
        </button>
        <button className="btn btn-primary" type="button" onClick={done}>
          {t("tfaSavedCodes")}
        </button>
      </div>
    </div>
  );
}

/** Two-step sign-in for the signed-in account: turn it on, see codes once, turn it off. */
export function TwoFactorPanel({ connection, onEnabled }: { connection: TeamConnection; onEnabled?: () => void }) {
  const [status, setStatus] = useState<TotpStatus | undefined>(undefined);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | undefined>(undefined);
  const [codes, setCodes] = useState<readonly string[] | undefined>(undefined);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<unknown>(undefined);
  const load = useCallback(() => {
    void connection.call<TotpStatus>("account.totp.status").then(setStatus).catch(setFailure);
  }, [connection]);
  useEffect(() => load(), [load]);

  const begin = async () => {
    setFailure(undefined);
    try {
      setSetup(await connection.call<{ secret: string; uri: string }>("account.totp.begin"));
      setCode("");
    } catch (caught) {
      setFailure(caught);
    }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    try {
      const answer = await connection.call<{ recoveryCodes: string[] }>("account.totp.confirm", { code: code.trim() });
      setSetup(undefined);
      setCode("");
      setCodes(answer.recoveryCodes);
      load();
    } catch (caught) {
      setFailure(caught);
    }
  };
  /** Turning it off and new codes both ask for a code now, so an open tab is not enough. */
  const [asking, setAsking] = useState<"account.totp.recovery" | "account.totp.disable" | undefined>(undefined);
  const withCode = async (event: FormEvent) => {
    event.preventDefault();
    if (asking === undefined || code.trim() === "") return;
    setFailure(undefined);
    try {
      const answer = await connection.call<{ recoveryCodes?: string[] }>(asking, { code: code.trim() });
      if (answer.recoveryCodes !== undefined) setCodes(answer.recoveryCodes);
      else toast(t("tfaTurnedOff"));
      setAsking(undefined);
      setCode("");
      load();
    } catch (caught) {
      setFailure(caught);
    }
  };

  if (status === undefined) return failure === undefined ? <Skeleton rows={2} /> : <Flash error={failure} />;
  return (
    <div className="card settings-block">
      <h2>
        {t("tfaTitle")} {status.enabled ? <span className="tag tag-success">{t("tfaOn")}</span> : <span className="tag">{t("tfaOff")}</span>}
      </h2>
      <p className="muted">{status.required && !status.enabled ? t("tfaRequiredLead") : t("tfaLead")}</p>
      {failure === undefined ? null : <Flash error={failure} />}
      {codes !== undefined ? (
        <RecoveryCodes
          codes={codes}
          done={() => {
            setCodes(undefined);
            onEnabled?.();
          }}
        />
      ) : setup !== undefined ? (
        <form className="stack" onSubmit={(event) => void confirm(event)}>
          <p>{t("tfaScanLead")}</p>
          <div className="form-field">
            <span className="form-label">{t("tfaSecret")}</span>
            <CopyText value={setup.secret} />
          </div>
          <div className="form-field">
            <span className="form-label">{t("tfaLink")}</span>
            <a className="small mono break" href={setup.uri}>
              {setup.uri}
            </a>
          </div>
          <label className="form-field">
            <span className="form-label">{t("tfaCode")}</span>
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={8}
              required
              autoFocus
            />
          </label>
          <div className="form-actions">
            <button className="btn" type="button" onClick={() => setSetup(undefined)}>
              {t("cancel")}
            </button>
            <button className="btn btn-primary" type="submit">
              {t("tfaConfirm")}
            </button>
          </div>
        </form>
      ) : asking !== undefined ? (
        <form className="stack" onSubmit={(event) => void withCode(event)}>
          <label className="form-field">
            <span className="form-label">{t("tfaAskCode")}</span>
            <input className="code-input" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={32} required autoFocus />
          </label>
          <div className="form-actions">
            <button className="btn" type="button" onClick={() => setAsking(undefined)}>
              {t("cancel")}
            </button>
            <button className={asking === "account.totp.disable" ? "btn btn-danger" : "btn btn-primary"} type="submit">
              {asking === "account.totp.disable" ? t("tfaTurnOff") : t("tfaNewCodes")}
            </button>
          </div>
        </form>
      ) : status.enabled ? (
        <div className="box">
          <div className="box-row">
            <div className="box-row-text">
              <strong>{t("tfaRecoveryTitle")}</strong>
              <span>{t("tfaRecoveryLeft", { count: String(status.recoveryLeft ?? 0) })}</span>
            </div>
            <button className="btn" onClick={() => { setCode(""); setAsking("account.totp.recovery"); }}>
              {t("tfaNewCodes")}
            </button>
          </div>
          <div className="box-row">
            <div className="box-row-text">
              <strong>{t("tfaTurnOff")}</strong>
              <span>{status.required ? t("tfaRequiredNoOff") : t("tfaTurnOffLead")}</span>
            </div>
            <button className="btn btn-danger" disabled={status.required} onClick={() => { setCode(""); setAsking("account.totp.disable"); }}>
              {t("tfaTurnOff")}
            </button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          <button className="btn btn-primary" onClick={() => void begin()}>
            {t("tfaTurnOn")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The whole console, when this server asks for two-step sign-in and this account has not set it up. */
export function EnrollGate({ connection, done, signOut }: { connection: TeamConnection; done: () => void; signOut: () => void }) {
  return (
    <main className="enroll-gate">
      <div className="enroll-card">
        <h1>{t("tfaEnrollTitle")}</h1>
        <p className="muted">{t("tfaEnrollLead")}</p>
        <TwoFactorPanel connection={connection} onEnabled={done} />
        <button className="btn btn-invisible" onClick={signOut}>
          {t("signOut")}
        </button>
      </div>
    </main>
  );
}

/* --------------------------------------------------------------- tokens */

interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly projects?: readonly string[];
  readonly write: boolean;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly lastUsedAt?: number;
}

/** Personal API tokens: made here, shown once, kept only as a hash. */
export function ApiTokens({ connection }: { connection: TeamConnection }) {
  const [tokens, setTokens] = useState<readonly ApiToken[] | undefined>(undefined);
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<readonly string[]>([]);
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("90");
  const [made, setMade] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const load = useCallback(() => {
    void connection.call<{ tokens: ApiToken[] }>("account.tokens.list").then((answer) => setTokens(answer.tokens)).catch(setFailure);
  }, [connection]);
  useEffect(() => {
    load();
    void connection.call<{ projects: { id: string; name: string }[] }>("projects.list").then((answer) => setProjects(answer.projects)).catch(() => undefined);
  }, [connection, load]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    try {
      const answer = await connection.call<{ token: string }>("account.tokens.create", {
        name: name.trim(),
        write,
        expiresInDays: Number(days),
        ...(scope.length === 0 ? {} : { projects: scope }),
      });
      setMade(answer.token);
      setName("");
      setScope([]);
      setWrite(false);
      load();
    } catch (caught) {
      setFailure(caught);
    }
  };
  const revoke = (token: ApiToken) =>
    void confirmAction({ title: t("tokenRevokeTitle", { name: token.name }), body: t("tokenRevokeBody"), confirmLabel: t("tokenRevoke"), danger: true }).then(
      (yes) =>
        yes &&
        void connection
          .call("account.tokens.revoke", { token: token.id })
          .then(() => {
            // The token just shown may be the one revoked; it is worthless now either way.
            setMade(undefined);
            load();
          })
          .catch(toastError),
    );
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id.slice(0, 8);
  return (
    <div className="card settings-block">
      <h2>{t("tokensTitle")}</h2>
      <p className="muted">{t("tokensLead")}</p>
      {failure === undefined ? null : <Flash error={failure} />}
      {made === undefined ? null : (
        <Flash tone="success" action={<button className="btn btn-sm" onClick={() => setMade(undefined)}>{t("tfaSavedCodes")}</button>}>
          {t("tokenShownOnce")}
          <CopyText value={made} />
        </Flash>
      )}
      {tokens === undefined ? (
        <Skeleton rows={2} />
      ) : tokens.length === 0 ? (
        <p className="muted small">{t("tokensNone")}</p>
      ) : (
        <ul className="member-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <span>
                <strong>{token.name}</strong>{" "}
                <span className="muted small">
                  · {token.write ? t("tokenWrite") : t("tokenRead")} ·{" "}
                  {token.projects === undefined ? t("tokenAllProjects") : token.projects.map(projectName).join(", ")} ·{" "}
                  {token.expiresAt === undefined ? t("tokenNoExpiry") : t("tokenExpires", { when: new Date(token.expiresAt).toLocaleDateString() })}
                  {token.lastUsedAt === undefined ? null : (
                    <>
                      {" "}
                      · {t("tokenUsed")} <RelativeTime at={token.lastUsedAt} />
                    </>
                  )}
                </span>
              </span>
              <button className="btn btn-sm btn-danger" onClick={() => revoke(token)}>
                {t("tokenRevoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="stack token-form" onSubmit={(event) => void create(event)}>
        <h3 className="form-section-title">{t("tokenNew")}</h3>
        <label className="form-field">
          <span className="form-label">{t("tokenName")}</span>
          <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} placeholder={t("tokenNamePlaceholder")} required />
        </label>
        <div className="settings-row">
          <span className="form-label">{t("tokenProjects")}</span>
          <SelectPanel<string>
            label={t("tokenProjects")}
            multiple
            value={scope}
            placeholder={t("tokenAllProjects")}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            onChange={setScope}
            align="end"
          />
        </div>
        <div className="settings-row">
          <span className="form-label">{t("tokenLifetime")}</span>
          <SelectPanel<string>
            label={t("tokenLifetime")}
            value={days}
            options={["7", "30", "90", "365", "0"].map((value) => ({ value, label: value === "0" ? t("tokenNoExpiry") : t("tokenDays", { count: value }) }))}
            onChange={setDays}
            align="end"
          />
        </div>
        <Checkbox checked={write} onChange={setWrite} label={t("tokenWriteLabel")} description={t("tokenWriteHint")} />
        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={name.trim() === ""}>
            {t("tokenCreate")}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------- reset link */

/** The page a reset link opens: no session, just the token in the address. */
export function ResetPage({ token }: { token: string }) {
  const [target, setTarget] = useState<{ username: string; displayName: string } | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  useEffect(() => {
    void fetch(`/api/console/v1/reset?token=${encodeURIComponent(token)}`, { credentials: "same-origin" })
      .then(async (response) => setTarget(response.ok ? ((await response.json()) as { username: string; displayName: string }) : null))
      .catch(() => setTarget(null));
  }, [token]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (password !== again) {
      setError(t("setupPasswordMismatch"));
      return;
    }
    const response = await fetch("/api/console/v1/reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    if (response.ok) {
      setDone(true);
      return;
    }
    setError(response.status === 400 ? t("resetWeak") : response.status === 410 ? t("resetGone") : response.statusText);
  };
  return (
    <main className="gate gate-plain">
      <div className="gate-side">
        <div className="gate-card">
          {target === undefined ? (
            <Skeleton rows={2} />
          ) : target === null ? (
            <div className="gate-form">
              <h1>{t("resetTitle")}</h1>
              <p className="muted">{t("resetGone")}</p>
              <a className="btn" href="/console/">
                {t("signIn")}
              </a>
            </div>
          ) : done ? (
            <div className="gate-form">
              <h1>{t("resetDoneTitle")}</h1>
              <p className="muted">{t("resetDoneLead")}</p>
              <a className="btn btn-primary big" href="/console/">
                {t("signIn")}
              </a>
            </div>
          ) : (
            <form className="gate-form" onSubmit={(event) => void submit(event)}>
              <div className="gate-title">
                <h1>{t("resetTitle")}</h1>
                <p className="muted">{t("resetLead", { name: target.displayName || target.username })}</p>
              </div>
              <input type="text" autoComplete="username" value={target.username} readOnly hidden />
              <label className="field">
                <span>{t("newPassword")}</span>
                <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
              <label className="field">
                <span>{t("setupPasswordAgain")}</span>
                <input type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} required />
              </label>
              {error === undefined ? null : (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary big" type="submit">
                {t("resetSave")}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

/* --------------------------------------------------------------- admin */

export interface StorageRow {
  readonly project: string;
  readonly name: string;
  readonly title?: string;
  readonly archivedAt?: number;
  readonly usedBytes: number;
  readonly buildBytes: number;
  readonly attachmentBytes: number;
  readonly quotaBytes?: number;
  readonly nearlyFull: boolean;
  readonly full: boolean;
}

/** A bar for how much of a quota is used; without a quota, just the number. */
export function StorageMeter({ row }: { row: Pick<StorageRow, "usedBytes" | "quotaBytes" | "nearlyFull" | "full"> }) {
  if (row.quotaBytes === undefined) return <span className="small">{formatBytes(row.usedBytes)}</span>;
  const fraction = Math.min(1, row.usedBytes / Math.max(1, row.quotaBytes));
  return (
    <span className={row.full ? "meter meter-full" : row.nearlyFull ? "meter meter-near" : "meter"} title={`${Math.round(fraction * 100)}%`}>
      <span className="meter-bar">
        <span style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="small">
        {formatBytes(row.usedBytes)} / {formatBytes(row.quotaBytes)}
      </span>
    </span>
  );
}

export function StoragePanel({ connection }: { connection: TeamConnection }) {
  const [rows, setRows] = useState<readonly StorageRow[] | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  useEffect(() => {
    void connection
      .call<{ projects: StorageRow[] }>("admin.storage.list")
      .then((answer) => setRows([...answer.projects].sort((a, b) => b.usedBytes - a.usedBytes)))
      .catch(setFailure);
  }, [connection]);
  if (failure !== undefined) return <Flash error={failure} />;
  if (rows === undefined) return <Skeleton />;
  const total = rows.reduce((sum, row) => sum + row.usedBytes, 0);
  return (
    <div className="admin-section">
      <p className="muted">{t("storageTotal", { size: formatBytes(total) })}</p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t("projectName")}</th>
            <th>{t("storageBuilds")}</th>
            <th>{t("storageAttachments")}</th>
            <th>{t("storageUsed")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.project} className={row.archivedAt === undefined ? "" : "disabled"}>
              <td>
                {row.title ?? row.name}
                {row.archivedAt === undefined ? null : <span className="tag">{t("archived")}</span>}
              </td>
              <td className="small">{formatBytes(row.buildBytes)}</td>
              <td className="small">{formatBytes(row.attachmentBytes)}</td>
              <td>
                <StorageMeter row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("storageQuotaHint")}</p>
    </div>
  );
}

interface BackupInfo {
  readonly name: string;
  readonly size: number;
  readonly createdAt: number;
}

export function BackupsPanel({ connection }: { connection: TeamConnection }) {
  const [state, setState] = useState<{ backups: BackupInfo[]; everyHours: number; keep: number } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const load = useCallback(() => {
    void connection.call<{ backups: BackupInfo[]; everyHours: number; keep: number }>("admin.backups.list").then(setState).catch(setFailure);
  }, [connection]);
  useEffect(() => load(), [load]);
  const take = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await connection.call("admin.backups.create");
      toast(t("backupTaken"));
      load();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-section">
      <div className="box">
        <div className="box-row">
          <div className="box-row-text">
            <strong>{t("backupNow")}</strong>
            <span>
              {state === undefined
                ? ""
                : state.everyHours > 0
                  ? t("backupScheduled", { hours: String(state.everyHours), keep: String(state.keep) })
                  : t("backupNotScheduled")}
            </span>
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void take()}>
            {busy ? t("backupTaking") : t("backupNow")}
          </button>
        </div>
      </div>
      {failure === undefined ? null : <Flash error={failure} />}
      {state === undefined ? (
        <Skeleton />
      ) : state.backups.length === 0 ? (
        <p className="muted">{t("backupsNone")}</p>
      ) : (
        <table className="admin-table">
          <tbody>
            {state.backups.map((backup) => (
              <tr key={backup.name}>
                <td className="mono small">{backup.name}</td>
                <td className="small">{formatBytes(backup.size)}</td>
                <td className="small muted">
                  <RelativeTime at={backup.createdAt} />
                </td>
                <td className="admin-actions">
                  <a className="btn btn-sm" href={`/api/console/v1/backups/${encodeURIComponent(backup.name)}`} download>
                    {t("download")}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Subhead title={t("restoreTitle")} />
      <p className="muted small">{t("restoreLead")}</p>
      <pre className="setup-hint">nlteam restore --root &lt;dir&gt; &lt;backup.tar.gz&gt;</pre>
    </div>
  );
}

type Outcome = "any" | "allowed" | "refused";

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The decision log with filters, and the filtered rows as a CSV file. */
export function AuditPanel({ connection }: { connection: TeamConnection }) {
  const [rows, setRows] = useState<readonly TeamAdminDecision[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("any");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [failure, setFailure] = useState<unknown>(undefined);
  const filters = useCallback(
    () => ({
      ...(username.trim() === "" ? {} : { username: username.trim() }),
      ...(action.trim() === "" ? {} : { action: action.trim() }),
      ...(outcome === "any" ? {} : { outcome }),
      ...(since === "" ? {} : { since: new Date(`${since}T00:00:00`).getTime() }),
      ...(until === "" ? {} : { until: new Date(`${until}T00:00:00`).getTime() + 86_400_000 }),
    }),
    [username, action, outcome, since, until],
  );
  const page = useCallback(
    (after?: string) =>
      connection.call<{ decisions: TeamAdminDecision[]; cursor?: string }>("admin.audit.list", { limit: 100, ...filters(), ...(after === undefined ? {} : { cursor: after }) }),
    [connection, filters],
  );
  const load = useCallback(() => {
    setFailure(undefined);
    void page()
      .then((answer) => {
        setRows(answer.decisions);
        setCursor(answer.cursor);
      })
      .catch(setFailure);
  }, [page]);
  useEffect(() => load(), [load]);
  const more = () =>
    void page(cursor)
      .then((answer) => {
        setRows((current) => [...current, ...answer.decisions]);
        setCursor(answer.cursor);
      })
      .catch(setFailure);
  /** Every matching row, page by page, up to a sane bound. */
  const exportCsv = async () => {
    try {
      const all: TeamAdminDecision[] = [];
      let after: string | undefined;
      do {
        const answer = await page(after);
        all.push(...answer.decisions);
        after = answer.cursor;
      } while (after !== undefined && all.length < 50_000);
      const lines = ["time,username,resource,allowed,detail", ...all.map((row) => [new Date(row.at).toISOString(), row.username, row.resource, String(row.allowed), row.detail].map(csvCell).join(","))];
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv" }));
      link.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (caught) {
      toastError(caught);
    }
  };
  return (
    <div className="card">
      <div className="bell-head">
        <strong>{t("auditLog")}</strong>
        <button className="btn btn-sm" onClick={() => void exportCsv()}>
          {t("auditExport")}
        </button>
      </div>
      <form
        className="audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          load();
        }}
      >
        <input placeholder={t("username")} value={username} onChange={(event) => setUsername(event.target.value)} />
        <input placeholder={t("auditAction")} value={action} onChange={(event) => setAction(event.target.value)} />
        <SelectPanel<Outcome>
          label={t("auditOutcome")}
          value={outcome}
          size="small"
          options={[
            { value: "any", label: t("auditAny") },
            { value: "allowed", label: t("auditAllowed") },
            { value: "refused", label: t("auditRefused") },
          ]}
          onChange={setOutcome}
        />
        <input type="date" aria-label={t("auditSince")} value={since} onChange={(event) => setSince(event.target.value)} />
        <input type="date" aria-label={t("auditUntil")} value={until} onChange={(event) => setUntil(event.target.value)} />
        <button className="btn btn-sm" type="submit">
          {t("auditFilter")}
        </button>
      </form>
      {failure === undefined ? null : <Flash error={failure} />}
      {rows.length === 0 ? (
        <p className="muted small">{t("auditNone")}</p>
      ) : (
        <table className="admin-table">
          <tbody>
            {rows.map((decision) => (
              <tr key={decision.id} className={decision.allowed ? "" : "refused-row"}>
                <td className="muted small">{new Date(decision.at).toLocaleString()}</td>
                <td>{decision.username}</td>
                <td>{decision.resource}</td>
                <td className="small">{decision.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor === undefined ? null : (
        <button className="btn btn-sm" onClick={more}>
          {t("loadMore")}
        </button>
      )}
    </div>
  );
}

/** An admin's reset link for one account: made, shown once, copied. */
export async function makeResetLink(connection: TeamConnection, username: string): Promise<void> {
  const answer = await connection.call<{ path: string; url?: string; expiresAt: number }>("admin.users.resetLink", { username });
  const url = answer.url ?? `${location.origin}${answer.path}`;
  await confirmAction({
    title: t("resetLinkTitle", { name: username }),
    body: (
      <div className="stack">
        <p>{t("resetLinkBody", { when: new Date(answer.expiresAt).toLocaleString() })}</p>
        <CopyText value={url} />
      </div>
    ),
    confirmLabel: t("done"),
  });
}
