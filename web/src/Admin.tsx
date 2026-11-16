/**
 * The administration console: accounts, projects and their members, the
 * team's brand and settings, signing keys and the decision log, and the
 * server's health. Every action is an existing `admin.*` or `projects.*`
 * method on the socket; the server refuses all of them to anybody who is not
 * an operator (or, for a project's members, its owner), so this page is a
 * view onto rules it does not itself enforce.
 */
import { DocumentsPanel } from "./Versions";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type {
  TeamAdminKey,
  TeamAdminSetting,
  TeamAdminStatus,
  TeamAdminUser,
} from "@narraleaf/team-protocol";

import { t, type Phrase } from "./i18n";
import { ActionMenu, Checkbox, confirmAction, CopyText, Flash, RelativeTime, SettingsLayout, Skeleton, Subhead, toast, type MenuAction } from "./ui";
import { Icon, type IconName } from "./Icon";
import { Face } from "./Collab";
import { Webhooks } from "./Production";
import { ProjectMembers } from "./Members";
import { AccessRequestsToDecide } from "./Access";
import { AuditPanel, BackupsPanel, makeResetLink, StoragePanel } from "./Security";
import type { ConnectionState, TeamConnection } from "./socket";

export type AdminSection = "accounts" | "projects" | "requests" | "documents" | "storage" | "brand" | "security" | "webhooks" | "backups" | "server";
/** The back office's sections, in groups: people, projects, the team itself. */
const GROUPS: readonly (readonly AdminSection[])[] = [
  ["accounts", "requests"],
  ["projects", "documents", "storage", "webhooks"],
  ["brand", "security", "backups", "server"],
];
export const ADMIN_SECTIONS: readonly AdminSection[] = GROUPS.flat();
export const ADMIN_PHRASE: Record<AdminSection, Phrase> = {
  accounts: "adminAccounts",
  projects: "adminProjects",
  requests: "reqTitle",
  brand: "adminBrand",
  security: "adminSecurity",
  webhooks: "adminWebhooks",
  documents: "docsTitle",
  storage: "adminStorage",
  backups: "adminBackups",
  server: "adminServer",
};
const SECTION_ICON: Record<AdminSection, IconName> = {
  accounts: "people",
  requests: "key",
  projects: "folder",
  documents: "file",
  webhooks: "link",
  storage: "server",
  backups: "download",
  brand: "palette",
  security: "lock",
  server: "server",
};
/** What a section is for, said under its title; the ones without explain themselves in their first line. */
const SECTION_LEAD: Partial<Record<AdminSection, Phrase>> = {
  accounts: "adminAccountsLead",
  projects: "adminProjectsLead",
  requests: "adminRequestsLead",
  brand: "adminBrandLead",
  security: "adminSecurityLead",
  server: "adminServerLead",
  storage: "adminStorageLead",
  backups: "adminBackupsLead",
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

export function Admin({
  connection,
  state,
  me,
  section,
  go,
}: {
  connection: TeamConnection;
  state: ConnectionState;
  me: string;
  section: AdminSection;
  go: (section: AdminSection) => void;
}) {
  const open = state.kind === "open";
  const lead = SECTION_LEAD[section];
  return (
    <section className="admin">
      <header className="page-head">
        <h1 className="page-title">{t("admin")}</h1>
      </header>
      <SettingsLayout
        label={t("admin")}
        active={section}
        onSelect={go}
        groups={GROUPS.map((group) => group.map((key) => ({ key, label: t(ADMIN_PHRASE[key]), icon: SECTION_ICON[key] })))}
      >
        <div>
          <Subhead title={t(ADMIN_PHRASE[section])}>{lead === undefined ? undefined : t(lead)}</Subhead>
          {!open ? <Skeleton /> : null}
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
          {open && section === "server" ? <Server connection={connection} live={open} /> : null}
          {open && section === "storage" ? <StoragePanel connection={connection} /> : null}
          {open && section === "backups" ? <BackupsPanel connection={connection} /> : null}
        </div>
      </SettingsLayout>
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
        label: t("resetLink"),
        icon: "link",
        description: t("resetLinkHint"),
        disabledReason: user.disabled ? t("resetLinkDisabled") : undefined,
        run: () => void makeResetLink(connection, user.username).catch((caught: unknown) => void run(() => Promise.reject(caught))),
      },
      {
        label: t("resetTwoFactor"),
        icon: "lock",
        danger: true,
        description: t("resetTwoFactorHint"),
        run: () =>
          askThen({ title: t("resetTwoFactorTitle", { name }), body: t("resetTwoFactorBody"), confirmLabel: t("resetTwoFactor") }, "admin.users.resetTwoFactor", user.username),
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

/** Server settings by the label the server gives them, in the reader's language. Unknown ones show as they come. */
const SETTING_PHRASE: Record<string, Phrase> = {
  name: "setName",
  collaboration: "setCollaboration",
  "repeat publishes": "setRepeatPublishes",
  "who makes projects": "setWhoMakes",
  "who removes projects": "setWhoRemoves",
  "others in a new project": "setOthersInNew",
  "edit log kept (days)": "setEditLogDays",
  "sign-in token": "setSignInToken",
  "repository token": "setRepositoryToken",
  issuer: "setIssuer",
  audience: "setAudience",
  hostnames: "setHostnames",
  "pinned version": "setPinnedVersion",
  "data port": "setDataPort",
  "storage root": "setStorageRoot",
  fingerprint: "setFingerprint",
  "notifications kept (days)": "setKeepNotifications",
  "activity kept (days)": "setKeepActivity",
  "chat kept (days)": "setKeepChat",
  "audit kept (days)": "setKeepAudit",
  "webhook deliveries kept (days)": "setKeepDeliveries",
  "webhooks to private addresses": "setWebhooksPrivate",
  "studio access token (hours)": "setStudioAccessHours",
  "two-factor required": "setRequireTwoFactor",
  "allowed networks": "setAllowedNetworks",
  "project storage quota (MB)": "setStorageQuota",
  "largest play build (MB)": "setBuildLimit",
  "backup every (hours)": "setBackupEvery",
  "backups kept": "setBackupKeep",
  "public address": "setPublicUrl",
  "smtp host": "setSmtpHost",
  "smtp port": "setSmtpPort",
  "smtp implicit tls": "setSmtpTls",
  "smtp user": "setSmtpUser",
  "smtp password": "setSmtpPassword",
  "mail from": "setMailFrom",
  "oidc issuer": "setOidcIssuer",
  "oidc client id": "setOidcClientId",
  "oidc client secret": "setOidcClientSecret",
  "oidc creates accounts": "setOidcCreate",
  "oidc button text": "setOidcButton",
  "ldap url": "setLdapUrl",
  "ldap bind dn": "setLdapBind",
};
const GROUP_PHRASE: Record<string, Phrase> = {
  server: "groupServer",
  tokens: "groupTokens",
  identity: "groupIdentity",
  loreserver: "groupLoreserver",
  authority: "groupAuthority",
  retention: "groupRetention",
  security: "groupSecurity",
  storage: "groupStorage",
  backup: "groupBackup",
  email: "groupEmail",
  sso: "groupSso",
};
const settingName = (label: string) => (SETTING_PHRASE[label] === undefined ? label : t(SETTING_PHRASE[label]!));
const groupName = (group: string) => (GROUP_PHRASE[group] === undefined ? group : t(GROUP_PHRASE[group]!));

function SettingsTable({ connection, settings: given, reload }: { connection: TeamConnection; settings: readonly TeamAdminSetting[]; reload: () => void }) {
  // Grouped, each group where it first appears, rows in the server's order within it.
  const order = [...new Set(given.map((row) => row.group))];
  const settings = [...given].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const [editing, setEditing] = useState<{ label: string; value: string } | undefined>(undefined);
  const [mailTo, setMailTo] = useState("");
  const { run, view } = useAction();
  const hasMail = given.some((row) => row.group === "email");
  return (
    <div className="card">
      <strong>{t("serverSettings")}</strong>
      {view}
      {hasMail ? (
        <form
          className="admin-form-row mail-test"
          onSubmit={(event) => {
            event.preventDefault();
            const to = mailTo.trim();
            void run(
              () => connection.call<{ to: string }>("admin.email.test", to === "" ? {} : { to }).then((answer) => toast(t("emailTestSent", { to: answer.to }))),
              undefined,
            );
          }}
        >
          <span className="muted small">{t("emailTestLead")}</span>
          <input type="email" value={mailTo} placeholder={t("emailTestTo")} onChange={(event) => setMailTo(event.target.value)} maxLength={254} />
          <button className="btn" type="submit">
            <Icon name="send" size={14} /> {t("emailTest")}
          </button>
        </form>
      ) : null}
      <table className="admin-table">
        <tbody>
          {settings.map((row, index) => (
            <tr key={row.label} className={index > 0 && settings[index - 1]!.group !== row.group ? "group-start" : undefined}>
              <td className="muted">{index === 0 || settings[index - 1]!.group !== row.group ? groupName(row.group) : ""}</td>
              <td title={row.label}>{settingName(row.label)}</td>
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
  const { run, view } = useAction();
  const load = useCallback(() => {
    void connection.call<{ keys: TeamAdminKey[] }>("admin.keys.list").then((answer) => setKeys(answer.keys));
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
      <AuditPanel connection={connection} />
    </div>
  );
}

/* --------------------------------------------------------------- server */

/** A byte count as people read it: 1.4 GB, not 1503238553. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function StatusLine({ label, children }: { label: Phrase; children: ReactNode }) {
  return (
    <div className="status-line">
      <dt>{t(label)}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Health({ ok, label }: { ok: boolean; label: Phrase }) {
  return (
    <span className={ok ? "health is-ok" : "health is-down"}>
      <span className="health-dot" aria-hidden="true" />
      {t(label)}
    </span>
  );
}

function Server({ connection, live }: { connection: TeamConnection; live: boolean }) {
  const [status, setStatus] = useState<TeamAdminStatus | undefined>(undefined);
  useEffect(() => {
    void connection.call<TeamAdminStatus>("admin.server.status").then(setStatus);
  }, [connection]);
  if (status === undefined) return <Skeleton rows={4} />;
  const lore = status.loreserver;
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
      <div className="status-grid">
        <section className="card status-card">
          <header className="status-card-head">
            <Icon name="server" size={16} />
            <strong>{t("statusTeam")}</strong>
            <Health ok={live} label={live ? "statusRunning" : "statusOffline"} />
          </header>
          <dl>
            <StatusLine label="statusVersion">
              <span className="mono">{status.version}</span>
            </StatusLine>
            <StatusLine label="statusRoot">
              <CopyText value={status.root} />
            </StatusLine>
            <StatusLine label="statusGathered">
              <RelativeTime at={status.gatheredAt} />
            </StatusLine>
          </dl>
        </section>
        <section className="card status-card">
          <header className="status-card-head">
            <Icon name="book" size={16} />
            <strong>{t("statusLoreserver")}</strong>
            <Health ok={lore.healthy} label={lore.healthy ? "statusHealthy" : "statusUnhealthy"} />
          </header>
          <dl>
            <StatusLine label="statusVersion">
              <span className="mono">{lore.version}</span>
            </StatusLine>
            <StatusLine label="statusStorage">{lore.storageBytes === undefined ? t("statusUnknownSize") : formatBytes(lore.storageBytes)}</StatusLine>
            <StatusLine label="statusRoot">
              <CopyText value={lore.storageRoot} />
            </StatusLine>
          </dl>
        </section>
        <section className="card status-card status-card-wide">
          <header className="status-card-head">
            <Icon name="link" size={16} />
            <strong>{t("statusReach")}</strong>
          </header>
          <dl>
            <StatusLine label="statusSignIn">
              <CopyText value={status.reach.signIn} />
            </StatusLine>
            <StatusLine label="statusData">
              <CopyText value={status.reach.data} />
            </StatusLine>
            <StatusLine label="statusFingerprint">
              <CopyText value={status.reach.fingerprint} />
            </StatusLine>
            {status.reach.loopback.length === 0 ? null : (
              <StatusLine label="statusLoopback">
                <span className="status-ports">
                  {status.reach.loopback.map((one) => (
                    <span key={one.port} className="status-port" title={one.what}>
                      <span className="mono">{one.port}</span> {one.what}
                    </span>
                  ))}
                </span>
              </StatusLine>
            )}
          </dl>
        </section>
      </div>
      <details className="status-raw">
        <summary>{t("statusRaw")}</summary>
        <pre className="status-dump">{JSON.stringify(status, null, 2)}</pre>
      </details>
    </div>
  );
}
