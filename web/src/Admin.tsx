/**
 * The administration console: accounts, projects and their members, the
 * team's brand and settings, signing keys and the decision log, and the
 * server's health. Every action is an existing `admin.*` or `projects.*`
 * method on the socket; the server refuses all of them to anybody who is not
 * an operator (or, for a project's members, its owner), so this page is a
 * view onto rules it does not itself enforce.
 */
import { DocumentsPanel } from "./Versions";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  TeamAdminDecision,
  TeamAdminKey,
  TeamAdminSetting,
  TeamAdminStatus,
  TeamAdminUser,
  TeamProjectMember,
  TeamProjectRole,
} from "@narraleaf/team-protocol";

import { t, type Phrase } from "./i18n";
import { Webhooks } from "./Production";
import type { ConnectionState, TeamConnection } from "./socket";

type Section = "accounts" | "projects" | "documents" | "brand" | "security" | "webhooks" | "server";
const SECTIONS: readonly Section[] = ["accounts", "projects", "documents", "brand", "security", "webhooks", "server"];
const SECTION_PHRASE: Record<Section, Phrase> = {
  accounts: "adminAccounts",
  projects: "adminProjects",
  brand: "adminBrand",
  security: "adminSecurity",
  webhooks: "adminWebhooks",
  documents: "docsTitle",
  server: "adminServer",
};
const ROLES: readonly TeamProjectRole[] = ["owner", "editor", "reviewer", "viewer"];

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Run one action and say what came of it. */
function useAction() {
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | undefined>(undefined);
  const run = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      setNote(done === undefined ? undefined : { text: done, tone: "ok" });
      return true;
    } catch (caught) {
      setNote({ text: errorText(caught), tone: "error" });
      return false;
    }
  }, []);
  const view = note === undefined ? null : <p className={note.tone === "error" ? "error" : "muted small"}>{note.text}</p>;
  return { run, view };
}

export function Admin({ connection, state }: { connection: TeamConnection; state: ConnectionState }) {
  const [section, setSection] = useState<Section>("accounts");
  const open = state.kind === "open";
  return (
    <section className="admin">
      <h1>{t("admin")}</h1>
      <nav className="tabs" role="tablist">
        {SECTIONS.map((key) => (
          <button key={key} role="tab" aria-selected={section === key} className={section === key ? "tab active" : "tab"} onClick={() => setSection(key)}>
            {t(SECTION_PHRASE[key])}
          </button>
        ))}
      </nav>
      {!open ? <p className="muted">{t("connecting")}</p> : null}
      {open && section === "accounts" ? <Accounts connection={connection} /> : null}
      {open && section === "projects" ? <Projects connection={connection} /> : null}
      {open && section === "brand" ? <Brand connection={connection} /> : null}
      {open && section === "security" ? <Security connection={connection} /> : null}
      {open && section === "webhooks" ? <Webhooks connection={connection} /> : null}
      {open && section === "documents" ? <DocumentsPanel connection={connection} /> : null}
      {open && section === "server" ? <Server connection={connection} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------- accounts */

function Accounts({ connection }: { connection: TeamConnection }) {
  const [users, setUsers] = useState<readonly TeamAdminUser[]>([]);
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const { run, view } = useAction();
  const load = useCallback(() => {
    void connection.call<{ users: TeamAdminUser[] }>("admin.users.list", { limit: 200 }).then((answer) => setUsers(answer.users));
  }, [connection]);
  useEffect(() => load(), [load]);
  const act = (method: string, username: string) => void run(() => connection.call(method, { username }).then(load), t("done"));
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      () =>
        connection.call("admin.users.create", {
          username: form.username.trim(),
          password: form.password,
          ...(form.displayName.trim() === "" ? {} : { displayName: form.displayName.trim() }),
          clientId: crypto.randomUUID(),
        }),
      t("done"),
    );
    if (ok) {
      setForm({ username: "", displayName: "", password: "" });
      load();
    }
  };
  return (
    <div className="admin-section">
      <form className="admin-form card" onSubmit={(event) => void create(event)}>
        <strong>{t("newAccount")}</strong>
        <div className="admin-form-row">
          <input placeholder={t("username")} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required autoComplete="off" />
          <input placeholder={t("displayName")} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input
            placeholder={t("password")}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            autoComplete="new-password"
          />
          <button className="primary" type="submit">
            {t("add")}
          </button>
        </div>
      </form>
      {view}
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t("username")}</th>
            <th>{t("displayName")}</th>
            <th>{t("status")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className={user.disabled ? "disabled" : ""}>
              <td>
                {user.username}
                {user.operator ? <span className="tag">{t("operator")}</span> : null}
                {user.serviceAccount ? <span className="tag">service</span> : null}
              </td>
              <td>{user.displayName}</td>
              <td className="muted">{user.disabled ? t("disabledLabel") : t("activeLabel")}</td>
              <td className="admin-actions">
                {user.disabled ? (
                  <button className="ghost small" onClick={() => act("admin.users.enable", user.username)}>
                    {t("enable")}
                  </button>
                ) : (
                  <button className="ghost small" onClick={() => act("admin.users.disable", user.username)}>
                    {t("disable")}
                  </button>
                )}
                {user.operator ? (
                  <button className="ghost small" onClick={() => act("admin.users.revokeAdmin", user.username)}>
                    {t("revokeAdmin")}
                  </button>
                ) : (
                  <button className="ghost small" onClick={() => act("admin.users.grantAdmin", user.username)}>
                    {t("grantAdmin")}
                  </button>
                )}
                <button className="ghost small" onClick={() => act("admin.users.revokeTokens", user.username)}>
                  {t("revokeTokens")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- projects */

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

function Projects({ connection }: { connection: TeamConnection }) {
  const [projects, setProjects] = useState<readonly ProjectRow[]>([]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [members, setMembers] = useState<readonly TeamProjectMember[]>([]);
  const [accounts, setAccounts] = useState<readonly { username: string; displayName: string }[]>([]);
  const [adding, setAdding] = useState({ username: "", role: "editor" as TeamProjectRole });
  const { run, view } = useAction();
  const loadProjects = useCallback(() => {
    void connection.call<{ projects: ProjectRow[] }>("projects.list").then((answer) => {
      setProjects(answer.projects);
      setChosen((current) => current ?? answer.projects[0]?.id);
    });
    void connection.call<{ members: { username: string; displayName: string }[] }>("members.list").then((answer) => setAccounts(answer.members));
  }, [connection]);
  const loadMembers = useCallback(() => {
    if (chosen === undefined) return;
    void connection.call<{ members: TeamProjectMember[] }>("projects.members.list", { project: chosen }).then((answer) => setMembers(answer.members));
  }, [connection, chosen]);
  useEffect(() => loadProjects(), [loadProjects]);
  useEffect(() => loadMembers(), [loadMembers]);
  const setRole = (username: string, role: TeamProjectRole) =>
    void run(() => connection.call("projects.members.set", { project: chosen, username, role }).then(loadMembers), t("done"));
  const remove = (username: string) =>
    void run(() => connection.call("projects.members.remove", { project: chosen, username }).then(loadMembers), t("done"));
  const outside = accounts.filter((account) => !members.some((member) => member.username === account.username));
  return (
    <div className="admin-section admin-split">
      <ul className="admin-list">
        {projects.map((project) => (
          <li key={project.id}>
            <button className={project.id === chosen ? "outline-link active" : "outline-link"} onClick={() => setChosen(project.id)}>
              {project.name}
            </button>
          </li>
        ))}
      </ul>
      <div>
        {view}
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("members")}</th>
              <th>{t("role")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.username}>
                <td>
                  {member.displayName || member.username} <span className="muted small">@{member.username}</span>
                </td>
                <td>
                  <select value={member.role} onChange={(event) => setRole(member.username, event.target.value as TeamProjectRole)}>
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(roleKey(role))}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="admin-actions">
                  <button className="ghost small" onClick={() => remove(member.username)}>
                    {t("removeMember")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {outside.length > 0 ? (
          <form
            className="admin-form-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (adding.username !== "") setRole(adding.username, adding.role);
            }}
          >
            <select value={adding.username} onChange={(event) => setAdding({ ...adding, username: event.target.value })}>
              <option value="">{t("addMember")}</option>
              {outside.map((account) => (
                <option key={account.username} value={account.username}>
                  {account.displayName || account.username}
                </option>
              ))}
            </select>
            <select value={adding.role} onChange={(event) => setAdding({ ...adding, role: event.target.value as TeamProjectRole })}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(roleKey(role))}
                </option>
              ))}
            </select>
            <button className="primary" type="submit">
              {t("add")}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function roleKey(role: TeamProjectRole): Phrase {
  return ({ owner: "roleOwner", editor: "roleEditor", reviewer: "roleReviewer", viewer: "roleViewer" } as const)[role];
}

/* ---------------------------------------------------------------- brand */

interface Discovery {
  readonly name: string;
  readonly brand?: { readonly accent?: string; readonly logoUrl?: string };
}

interface BrandState {
  readonly signin: { readonly image?: string; readonly layout: "center" | "left" | "right" };
  readonly watermark: { readonly enabled: boolean; readonly text?: string };
}

interface Look {
  readonly signinImageUrl?: string;
}

function Brand({ connection }: { connection: TeamConnection }) {
  const [discovery, setDiscovery] = useState<Discovery | undefined>(undefined);
  const [look, setLook] = useState<Look>({});
  const [name, setName] = useState("");
  const [accent, setAccent] = useState("#40a8c4");
  const [layout, setLayout] = useState<"center" | "left" | "right">("center");
  const [watermarkOn, setWatermarkOn] = useState(false);
  const [watermarkText, setWatermarkText] = useState("");
  const [settings, setSettings] = useState<readonly TeamAdminSetting[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const picturePicker = useRef<HTMLInputElement>(null);
  const { run, view } = useAction();
  const load = useCallback(() => {
    void fetch("/.well-known/nlteam")
      .then((response) => response.json() as Promise<Discovery>)
      .then((document) => {
        setDiscovery(document);
        setName(document.name);
        setAccent(document.brand?.accent ?? "#40a8c4");
      });
    void fetch("/api/console/v1/look")
      .then((response) => response.json() as Promise<Look>)
      .then(setLook);
    void connection.call<BrandState>("admin.brand.set", {}).then((answer) => {
      setLayout(answer.signin.layout);
      setWatermarkOn(answer.watermark.enabled);
      setWatermarkText(answer.watermark.text ?? "");
    });
    void connection.call<{ settings: TeamAdminSetting[] }>("admin.settings.list").then((answer) => setSettings(answer.settings));
  }, [connection]);
  useEffect(() => load(), [load]);
  const nameLabel = settings.find((row) => row.group === "server" && row.editable)?.label;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      if (nameLabel !== undefined && name.trim() !== discovery?.name) {
        await connection.call("admin.settings.set", { label: nameLabel, value: name.trim() });
      }
      await connection.call("admin.brand.set", {
        accent,
        signinLayout: layout,
        watermark: { enabled: watermarkOn, text: watermarkText },
      });
      document.documentElement.style.setProperty("--nl-primary", hexChannels(accent));
      load();
    }, t("saved"));
  };
  const upload = async (path: string, file: File | undefined) => {
    if (file === undefined) return;
    await run(async () => {
      const response = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "content-type": file.type }, body: file });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? response.statusText);
      load();
    }, t("saved"));
  };
  const removePicture = async () => {
    await run(async () => {
      const response = await fetch("/api/console/v1/brand/signin-image", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error(response.statusText);
      load();
    }, t("saved"));
  };
  return (
    <div className="admin-section">
      <form className="card settings-block" onSubmit={(event) => void save(event)}>
        <strong>{t("brandLook")}</strong>
        <label className="admin-field">
          <span className="muted small">{t("teamName")}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
        </label>
        <label className="admin-field">
          <span className="muted small">{t("accentColour")}</span>
          <span className="admin-form-row">
            <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} />
            <code>{accent}</code>
          </span>
        </label>
        <div className="admin-field">
          <span className="muted small">{t("logo")}</span>
          <span className="admin-form-row">
            {discovery?.brand?.logoUrl !== undefined ? <img className="brand-logo" src={new URL(discovery.brand.logoUrl).pathname} alt="" /> : null}
            <button type="button" className="ghost" onClick={() => picker.current?.click()}>
              {t("changeLogo")}
            </button>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void upload("/api/console/v1/brand/logo", event.target.files?.[0])} />
          </span>
        </div>

        <strong className="admin-subhead">{t("signinPage")}</strong>
        <div className="admin-field">
          <span className="muted small">{t("signinPicture")}</span>
          <span className="admin-form-row">
            {look.signinImageUrl !== undefined ? <img className="signin-thumb" src={look.signinImageUrl} alt="" /> : <span className="muted small">{t("signinNoPicture")}</span>}
            <button type="button" className="ghost" onClick={() => picturePicker.current?.click()}>
              {t("signinChoosePicture")}
            </button>
            {look.signinImageUrl !== undefined ? (
              <button type="button" className="ghost" onClick={() => void removePicture()}>
                {t("remove")}
              </button>
            ) : null}
            <input
              ref={picturePicker}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => void upload("/api/console/v1/brand/signin-image", event.target.files?.[0])}
            />
          </span>
        </div>
        <fieldset className="admin-field layout-choice" disabled={look.signinImageUrl === undefined}>
          <legend className="muted small">{t("signinLayout")}</legend>
          {(["center", "left", "right"] as const).map((value) => (
            <label key={value} className={layout === value ? "layout-option active" : "layout-option"}>
              <input type="radio" name="signin-layout" value={value} checked={layout === value} onChange={() => setLayout(value)} />
              <span className={`layout-sketch layout-sketch-${value}`} aria-hidden="true">
                <span className="sketch-picture" />
                <span className="sketch-form" />
              </span>
              <span>{t(value === "center" ? "signinLayoutCenter" : value === "left" ? "signinLayoutLeft" : "signinLayoutRight")}</span>
            </label>
          ))}
          {look.signinImageUrl === undefined ? <span className="muted small">{t("signinLayoutNeedsPicture")}</span> : null}
        </fieldset>

        <strong className="admin-subhead">{t("watermark")}</strong>
        <label className="admin-check">
          <input type="checkbox" checked={watermarkOn} onChange={(event) => setWatermarkOn(event.target.checked)} />
          <span>{t("watermarkOn")}</span>
        </label>
        <label className="admin-field">
          <span className="muted small">{t("watermarkText")}</span>
          <input value={watermarkText} onChange={(event) => setWatermarkText(event.target.value)} maxLength={64} placeholder={t("watermarkTextHint")} />
        </label>
        <span className="muted small">{t("watermarkLead")}</span>
        {view}
        <div className="actions">
          <button className="primary" type="submit">
            {t("save")}
          </button>
        </div>
      </form>
      <SettingsTable connection={connection} settings={settings} reload={load} />
    </div>
  );
}

/** `#40a8c4` as the `64 168 196` the design tokens write colours in. */
export function hexChannels(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function SettingsTable({ connection, settings, reload }: { connection: TeamConnection; settings: readonly TeamAdminSetting[]; reload: () => void }) {
  const [editing, setEditing] = useState<{ label: string; value: string } | undefined>(undefined);
  const { run, view } = useAction();
  return (
    <div className="card">
      <strong>{t("serverSettings")}</strong>
      {view}
      <table className="admin-table">
        <tbody>
          {settings.map((row) => (
            <tr key={row.label}>
              <td className="muted">{row.group}</td>
              <td>{row.label}</td>
              <td>
                {editing?.label === row.label ? (
                  <form
                    className="admin-form-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(() => connection.call("admin.settings.set", { label: row.label, value: editing.value }).then(reload), t("saved")).then(
                        (ok) => ok && setEditing(undefined),
                      );
                    }}
                  >
                    <input value={editing.value} onChange={(event) => setEditing({ label: row.label, value: event.target.value })} autoFocus />
                    <button className="primary small" type="submit">
                      {t("save")}
                    </button>
                  </form>
                ) : (
                  <code>{row.value}</code>
                )}
              </td>
              <td className="admin-actions">
                {row.editable && editing?.label !== row.label ? (
                  <button className="ghost small" onClick={() => setEditing({ label: row.label, value: row.value })}>
                    {t("edit")}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- security */

function Security({ connection }: { connection: TeamConnection }) {
  const [keys, setKeys] = useState<readonly TeamAdminKey[]>([]);
  const [decisions, setDecisions] = useState<readonly TeamAdminDecision[]>([]);
  const { run, view } = useAction();
  const load = useCallback(() => {
    void connection.call<{ keys: TeamAdminKey[] }>("admin.keys.list").then((answer) => setKeys(answer.keys));
    void connection.call<{ decisions: TeamAdminDecision[] }>("admin.audit.list", { limit: 100 }).then((answer) => setDecisions(answer.decisions));
  }, [connection]);
  useEffect(() => load(), [load]);
  return (
    <div className="admin-section">
      <div className="card">
        <div className="bell-head">
          <strong>{t("signingKeys")}</strong>
          <button className="ghost small" onClick={() => void run(() => connection.call("admin.keys.rotate", { clientId: crypto.randomUUID() }).then(load), t("done"))}>
            {t("rotateKey")}
          </button>
        </div>
        {view}
        <table className="admin-table">
          <tbody>
            {keys.map((key) => (
              <tr key={key.kid} className={key.retired ? "disabled" : ""}>
                <td>
                  <code>{key.kid.slice(0, 16)}…</code>
                </td>
                <td className="muted">#{key.serial}</td>
                <td>{key.signing ? <span className="tag">{t("signing")}</span> : key.retired ? t("retiredLabel") : ""}</td>
                <td className="admin-actions">
                  {!key.signing && !key.retired ? (
                    <button className="ghost small" onClick={() => void run(() => connection.call("admin.keys.retire", { kid: key.kid }).then(load), t("done"))}>
                      {t("retireKey")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <strong>{t("auditLog")}</strong>
        <table className="admin-table">
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.id} className={decision.allowed ? "" : "refused-row"}>
                <td className="muted small">{new Date(decision.at).toLocaleString()}</td>
                <td>{decision.username}</td>
                <td>{decision.resource}</td>
                <td className="small">{decision.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- server */

function Server({ connection }: { connection: TeamConnection }) {
  const [status, setStatus] = useState<TeamAdminStatus | undefined>(undefined);
  useEffect(() => {
    void connection.call<TeamAdminStatus>("admin.server.status").then(setStatus);
  }, [connection]);
  if (status === undefined) return <p className="muted">{t("loading")}</p>;
  return (
    <div className="admin-section">
      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{status.accounts}</span>
          <span className="muted">{t("adminAccounts")}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.projects}</span>
          <span className="muted">{t("adminProjects")}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.signingKeys}</span>
          <span className="muted">{t("signingKeys")}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.decisions}</span>
          <span className="muted">{t("auditLog")}</span>
        </div>
      </div>
      <pre className="card status-dump">{JSON.stringify({ version: status.version, root: status.root, loreserver: status.loreserver, reach: status.reach }, null, 2)}</pre>
    </div>
  );
}
