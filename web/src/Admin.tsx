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
} from "@narraleaf/team-protocol";

import { t, type Phrase } from "./i18n";
import { ActionMenu, Checkbox, confirmAction, Flash, toast, type MenuAction } from "./ui";
import { Face } from "./Collab";
import { Webhooks } from "./Production";
import { ProjectMembers } from "./Members";
import { AccessRequestsToDecide } from "./Access";
import type { ConnectionState, TeamConnection } from "./socket";

type Section = "accounts" | "projects" | "requests" | "documents" | "brand" | "security" | "webhooks" | "server";
const SECTIONS: readonly Section[] = ["accounts", "projects", "requests", "documents", "brand", "security", "webhooks", "server"];
const SECTION_PHRASE: Record<Section, Phrase> = {
  accounts: "adminAccounts",
  projects: "adminProjects",
  requests: "reqTitle",
  brand: "adminBrand",
  security: "adminSecurity",
  webhooks: "adminWebhooks",
  documents: "docsTitle",
  server: "adminServer",
};

/** Run one action: a toast when it worked, a notice in the page saying why when it did not. */
function useAction() {
  const [failure, setFailure] = useState<unknown>(undefined);
  const run = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      setFailure(undefined);
      if (done !== undefined) toast(done);
      return true;
    } catch (caught) {
      setFailure(caught);
      return false;
    }
  }, []);
  const view = failure === undefined ? null : <Flash error={failure} />;
  return { run, view };
}

export function Admin({ connection, state, me }: { connection: TeamConnection; state: ConnectionState; me: string }) {
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
      {open && section === "accounts" ? <Accounts connection={connection} me={me} /> : null}
      {open && section === "projects" ? <Projects connection={connection} /> : null}
      {open && section === "requests" ? (
        <div className="admin-section">
          <AccessRequestsToDecide connection={connection} all />
        </div>
      ) : null}
      {open && section === "brand" ? <Brand connection={connection} /> : null}
      {open && section === "security" ? <Security connection={connection} /> : null}
      {open && section === "webhooks" ? <Webhooks connection={connection} /> : null}
      {open && section === "documents" ? <DocumentsPanel connection={connection} /> : null}
      {open && section === "server" ? <Server connection={connection} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------- accounts */

function Accounts({ connection, me }: { connection: TeamConnection; me: string }) {
  const [users, setUsers] = useState<readonly TeamAdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const { run, view } = useAction();
  const load = useCallback(() => {
    void connection.call<{ users: TeamAdminUser[] }>("admin.users.list", { limit: 200 }).then((answer) => setUsers(answer.users));
  }, [connection]);
  useEffect(() => load(), [load]);
  const act = (method: string, username: string) => void run(() => connection.call(method, { username }).then(load), t("done"));
  /** Ask first, then act: the dangerous ones on the "⋯" menu. */
  const askThen = (options: Parameters<typeof confirmAction>[0], method: string, username: string) =>
    void confirmAction({ danger: true, ...options }).then((yes) => yes && act(method, username));
  const actions = (user: TeamAdminUser): MenuAction[] => {
    const name = user.displayName || user.username;
    const self = user.username === me;
    const creator = user.groups.includes("project-creator");
    const list: MenuAction[] = [];
    if (!user.operator) {
      list.push({
        label: creator ? t("disallowCreate") : t("allowCreate"),
        icon: "plus",
        run: () =>
          void run(() => connection.call("admin.users.setCreator", { username: user.username, creator: !creator }).then(load), t("done")),
      });
    }
    list.push(
      user.operator
        ? {
            label: t("revokeAdmin"),
            icon: "key",
            danger: true,
            disabledReason: self ? t("notOnYourself") : undefined,
            run: () => askThen({ title: t("revokeAdminTitle", { name }), body: t("revokeAdminBody"), confirmLabel: t("revokeAdmin") }, "admin.users.revokeAdmin", user.username),
          }
        : {
            label: t("grantAdmin"),
            icon: "key",
            run: () =>
              void confirmAction({ title: t("grantAdminTitle", { name }), body: t("grantAdminBody"), confirmLabel: t("grantAdmin") }).then(
                (yes) => yes && act("admin.users.grantAdmin", user.username),
              ),
          },
      {
        label: t("revokeTokens"),
        icon: "lock",
        danger: true,
        description: t("revokeTokensHint"),
        run: () =>
          askThen({ title: t("revokeTokensTitle", { name }), body: t("revokeTokensBody"), confirmLabel: t("revokeTokens") }, "admin.users.revokeTokens", user.username),
      },
      user.disabled
        ? { label: t("enable"), icon: "tick", run: () => act("admin.users.enable", user.username) }
        : {
            label: t("disable"),
            icon: "close",
            danger: true,
            disabledReason: self ? t("notOnYourself") : undefined,
            run: () =>
              askThen(
                { title: t("disableTitle", { name }), body: t("disableBody"), confirmLabel: t("disable"), typeToConfirm: user.username },
                "admin.users.disable",
                user.username,
              ),
          },
    );
    return list;
  };
  const shown = users.filter((user) => {
    const q = query.trim().toLowerCase();
    return q === "" || user.username.toLowerCase().includes(q) || user.displayName.toLowerCase().includes(q);
  });
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
          <button className="btn btn-primary" type="submit">
            {t("add")}
          </button>
        </div>
      </form>
      {view}
      <div className="table-tools">
        <input type="search" placeholder={t("filterAccounts")} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("filterAccounts")} />
        <span className="muted small">{t("accountCount", { count: String(users.length) })}</span>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t("account")}</th>
            <th>{t("status")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((user) => (
            <tr key={user.id} className={user.disabled ? "disabled" : ""}>
              <td>
                <span className="member-cell">
                  <Face name={user.displayName || user.username} user={user.username} size={28} />
                  <span className="member-cell-text">
                    <strong>
                      {user.displayName || user.username}
                      {user.username === me ? <span className="muted small"> {t("youMark")}</span> : null}
                    </strong>
                    <span className="muted small">@{user.username}</span>
                  </span>
                  {user.operator ? <span className="tag">{t("operator")}</span> : null}
                  {user.serviceAccount ? <span className="tag">service</span> : null}
                  {!user.operator && user.groups.includes("project-creator") ? <span className="tag">{t("mayCreateProjects")}</span> : null}
                </span>
              </td>
              <td>
                <span className={user.disabled ? "status-dot off" : "status-dot on"}>{user.disabled ? t("disabledLabel") : t("activeLabel")}</span>
              </td>
              <td className="admin-actions">
                <ActionMenu actions={actions(user)} />
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
  useEffect(() => {
    void connection.call<{ projects: ProjectRow[] }>("projects.list").then((answer) => {
      setProjects(answer.projects);
      setChosen((current) => current ?? answer.projects[0]?.id);
    });
  }, [connection]);
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
      <div>{chosen === undefined ? null : <ProjectMembers key={chosen} connection={connection} projectId={chosen} />}</div>
    </div>
  );
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
        <Checkbox className="admin-check" checked={watermarkOn} onChange={setWatermarkOn} label={t("watermarkOn")} />
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
