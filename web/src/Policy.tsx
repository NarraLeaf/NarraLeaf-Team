/**
 * Account policies, as the console shows them.
 *
 *  - {@link PolicyTemplates}: an operator's templates, made from a preset and changed for everybody who follows them.
 *  - {@link AccountPolicyDialog}: one account's policy: none, a template, or settings of its own.
 *  - {@link useAccountPolicy}: a person's own settings page, with what an administrator fixed shown as fixed.
 *  - {@link StudioConfigCard}: Studio's preferences kept on this server, to carry to another computer.
 *
 * The server holds the rules; this page only draws them. A field shown as fixed here is refused there too.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  STUDIO_CONFIG_MAX_BYTES,
  STUDIO_CONFIG_PATH,
  TEAM_DIGEST_FREQUENCIES,
  TEAM_NOTIFICATION_CATEGORIES,
  TEAM_NOTIFICATION_CHANNELS,
  type TeamAccountPolicy,
  type TeamAccountPolicyView,
  type TeamDigestFrequency,
  type TeamPolicyAccess,
  type TeamPolicyTemplate,
  type TeamStudioConfigStatus,
} from "@narraleaf/team-protocol";

import { formatBytes } from "./Builds";
import { Icon } from "./Icon";
import { LockedNote } from "./Locked";
import { t, type Phrase } from "./i18n";
import { CATEGORY_PHRASE, CHANNEL_PHRASE, DIGEST_PHRASE, timeZones } from "./Notify";
import type { TeamConnection } from "./socket";
import { Blankslate, Checkbox, confirmAction, Dialog, Flash, RelativeTime, SelectPanel, Skeleton, toast, toastError } from "./ui";

/* ------------------------------------------------------------ own page */

/** The policy this account is under, or undefined until it is known (and on a server too old to say). */
export function useAccountPolicy(connection: TeamConnection, open: boolean): TeamAccountPolicyView | undefined {
  const [view, setView] = useState<TeamAccountPolicyView | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    connection
      .call<TeamAccountPolicyView>("account.policy")
      .then(setView)
      .catch(() => undefined);
  }, [connection, open]);
  return view;
}


/* ------------------------------------------------------------- editor */

type LockMode = "free" | "freeze" | "value";
const LOCK_PHRASE: Record<LockMode, Phrase> = { free: "policyFree", freeze: "policyFreeze", value: "policyFixValue" };
const ACCESS_PHRASE: Record<TeamPolicyAccess, Phrase> = { on: "policyAccessOn", read: "policyAccessRead", off: "policyAccessOff" };
const ACCESS_ORDER: readonly TeamPolicyAccess[] = ["on", "read", "off"];

function modeOf(lock: { value?: unknown } | undefined): LockMode {
  return lock === undefined ? "free" : lock.value === undefined ? "freeze" : "value";
}

type LockKey = "displayName" | "bio" | "timezone" | "digest" | "hook" | "notificationSwitches";

/** One line of the editor: what it is, what it means, and the control. */
function PolicyRow({ label, hint, children }: { label: Phrase; hint?: Phrase; children: ReactNode }) {
  return (
    <div className="policy-row">
      <span className="policy-row-text">
        <span>{t(label)}</span>
        {hint === undefined ? null : <span className="muted small">{t(hint)}</span>}
      </span>
      <span className="policy-row-control">{children}</span>
    </div>
  );
}

const allSwitches = (enabled: boolean) =>
  TEAM_NOTIFICATION_CATEGORIES.flatMap((category) => TEAM_NOTIFICATION_CHANNELS.map((channel) => ({ category, channel, enabled })));

/** Every setting a policy can fix, edited in place. */
export function PolicyEditor({ value, onChange }: { value: TeamAccountPolicy; onChange: (next: TeamAccountPolicy) => void }) {
  const set = (patch: Partial<Record<keyof TeamAccountPolicy, unknown>>) => {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next as TeamAccountPolicy);
  };
  /** The "how fixed" choice for a lockable field, and what each choice starts from. */
  const lockChoice = (key: LockKey, initial: unknown) => (
    <SelectPanel<LockMode>
      label={t("policyHowFixed")}
      size="small"
      align="end"
      value={modeOf(value[key])}
      options={(["free", "freeze", "value"] as const).map((mode) => ({ value: mode, label: t(LOCK_PHRASE[mode]) }))}
      onChange={(mode) => set({ [key]: mode === "free" ? undefined : mode === "freeze" ? {} : { value: (value[key] as { value?: unknown } | undefined)?.value ?? initial } })}
    />
  );
  const switches = value.notificationSwitches?.value;
  const switchOn = (category: string, channel: string) => switches?.find((entry) => entry.category === category && entry.channel === channel)?.enabled ?? true;
  return (
    <div className="policy-editor">
      <h3 className="form-section-title">{t("profile")}</h3>
      <PolicyRow label="displayName">
        {lockChoice("displayName", "")}
        {value.displayName?.value === undefined ? null : (
          <input value={value.displayName.value} maxLength={128} onChange={(event) => set({ displayName: { value: event.target.value } })} placeholder={t("displayName")} />
        )}
      </PolicyRow>
      <PolicyRow label="bio">
        {lockChoice("bio", "")}
        {value.bio?.value === undefined ? null : <input value={value.bio.value} maxLength={400} onChange={(event) => set({ bio: { value: event.target.value } })} placeholder={t("bio")} />}
      </PolicyRow>
      <PolicyRow label="timezone">
        {lockChoice("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)}
        {value.timezone?.value === undefined ? null : (
          <SelectPanel<string>
            label={t("timezone")}
            size="small"
            align="end"
            filterFrom={0}
            value={value.timezone.value === "" ? "-" : value.timezone.value}
            options={[{ value: "-", label: t("timezoneUnset") }, ...timeZones().map((zone) => ({ value: zone, label: zone }))]}
            onChange={(zone) => set({ timezone: { value: zone === "-" ? "" : zone } })}
          />
        )}
      </PolicyRow>
      <PolicyRow label="policyLockAvatar" hint="policyLockAvatarHint">
        <Checkbox checked={value.lockAvatar === true} onChange={(on) => set({ lockAvatar: on ? true : undefined })} description={t("policyLockAvatar")} />
      </PolicyRow>

      <h3 className="form-section-title">{t("notificationSettings")}</h3>
      <PolicyRow label="policySwitches" hint="policySwitchesHint">
        {lockChoice("notificationSwitches", allSwitches(true))}
      </PolicyRow>
      {switches === undefined ? null : (
        <table className="notify-matrix policy-matrix">
          <thead>
            <tr>
              <th />
              {TEAM_NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} scope="col">
                  {t(CHANNEL_PHRASE[channel])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TEAM_NOTIFICATION_CATEGORIES.map((category) => (
              <tr key={category}>
                <th scope="row">{t(CATEGORY_PHRASE[category])}</th>
                {TEAM_NOTIFICATION_CHANNELS.map((channel) => (
                  <td key={channel}>
                    <Checkbox
                      checked={switchOn(category, channel)}
                      onChange={(enabled) =>
                        set({
                          notificationSwitches: {
                            value: allSwitches(true).map((entry) =>
                              entry.category === category && entry.channel === channel ? { ...entry, enabled } : { ...entry, enabled: switchOn(entry.category, entry.channel) },
                            ),
                          },
                        })
                      }
                      label={<span className="visually-hidden">{`${t(CATEGORY_PHRASE[category])} · ${t(CHANNEL_PHRASE[channel])}`}</span>}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <PolicyRow label="digest">
        {lockChoice("digest", "daily")}
        {value.digest?.value === undefined ? null : (
          <SelectPanel<TeamDigestFrequency>
            label={t("digest")}
            size="small"
            align="end"
            value={value.digest.value}
            options={TEAM_DIGEST_FREQUENCIES.map((frequency) => ({ value: frequency, label: t(DIGEST_PHRASE[frequency]) }))}
            onChange={(digest) => set({ digest: { value: digest } })}
          />
        )}
      </PolicyRow>
      <PolicyRow label="personalHook">
        {lockChoice("hook", "")}
        {value.hook?.value === undefined ? null : (
          <input type="url" value={value.hook.value} maxLength={2048} placeholder={t("policyHookNone")} onChange={(event) => set({ hook: { value: event.target.value } })} />
        )}
      </PolicyRow>

      <h3 className="form-section-title">{t("policySecurity")}</h3>
      <PolicyRow label="policyRequireTwoFactor" hint="policyRequireTwoFactorHint">
        <Checkbox checked={value.requireTwoFactor === true} onChange={(on) => set({ requireTwoFactor: on ? true : undefined })} description={t("policyRequireTwoFactor")} />
      </PolicyRow>
      <PolicyRow label="tokensTitle" hint="policyTokensHint">
        <SelectPanel<TeamPolicyAccess>
          label={t("tokensTitle")}
          size="small"
          align="end"
          value={value.apiTokens ?? "on"}
          options={ACCESS_ORDER.map((access) => ({ value: access, label: t(access === "read" ? "policyTokensRead" : ACCESS_PHRASE[access]) }))}
          onChange={(access) => set({ apiTokens: access === "on" ? undefined : access })}
        />
      </PolicyRow>
      <PolicyRow label="policyTokenDays" hint="policyTokenDaysHint">
        <input
          className="policy-days"
          type="number"
          min={1}
          max={3650}
          value={value.apiTokenMaxDays ?? ""}
          placeholder={t("policyNoLimit")}
          disabled={value.apiTokens === "off"}
          onChange={(event) => set({ apiTokenMaxDays: event.target.value === "" ? undefined : Math.max(1, Math.min(3650, Math.round(Number(event.target.value)))) })}
        />
      </PolicyRow>

      <h3 className="form-section-title">Studio</h3>
      <PolicyRow label="studioConfigTitle" hint="policyStudioHint">
        <SelectPanel<TeamPolicyAccess>
          label={t("studioConfigTitle")}
          size="small"
          align="end"
          value={value.studioConfig ?? "on"}
          options={ACCESS_ORDER.map((access) => ({ value: access, label: t(access === "read" ? "policyStudioRead" : ACCESS_PHRASE[access]) }))}
          onChange={(access) => set({ studioConfig: access === "on" ? undefined : access })}
        />
      </PolicyRow>
    </div>
  );
}

/** A few lines saying what a policy fixes, for a list. */
export function policySummary(policy: TeamAccountPolicy): string {
  const parts: string[] = [];
  const locked = (["displayName", "bio", "timezone"] as const).filter((key) => policy[key] !== undefined).map((key) => t(key === "displayName" ? "displayName" : key));
  if (policy.lockAvatar === true) locked.push(t("policyAvatar"));
  if (locked.length > 0) parts.push(t("policySumProfile", { list: locked.join(t("listJoin")) }));
  if (policy.notificationSwitches !== undefined || policy.digest !== undefined || policy.hook !== undefined) parts.push(t("policySumNotify"));
  if (policy.requireTwoFactor === true) parts.push(t("policySumTwoFactor"));
  if (policy.apiTokens === "off") parts.push(t("policySumNoTokens"));
  else if (policy.apiTokens === "read") parts.push(t("policySumReadTokens"));
  if (policy.apiTokenMaxDays !== undefined && policy.apiTokens !== "off") parts.push(t("policySumTokenDays", { count: String(policy.apiTokenMaxDays) }));
  if (policy.studioConfig !== undefined) parts.push(t(policy.studioConfig === "off" ? "policySumStudioOff" : "policySumStudioRead"));
  return parts.length === 0 ? t("policySumNothing") : parts.join(" · ");
}

/* ------------------------------------------------------------ presets */

interface Preset {
  readonly id: string;
  readonly name: Phrase;
  readonly lead: Phrase;
  readonly policy: TeamAccountPolicy;
}

const PRESETS: readonly Preset[] = [
  { id: "blank", name: "presetBlank", lead: "presetBlankLead", policy: {} },
  { id: "strict", name: "presetStrict", lead: "presetStrictLead", policy: { requireTwoFactor: true, apiTokens: "read", apiTokenMaxDays: 30 } },
  {
    id: "contractor",
    name: "presetContractor",
    lead: "presetContractorLead",
    policy: { requireTwoFactor: true, apiTokens: "off", studioConfig: "read", displayName: {}, lockAvatar: true },
  },
  {
    id: "managed",
    name: "presetManaged",
    lead: "presetManagedLead",
    policy: { displayName: {}, bio: {}, timezone: {}, lockAvatar: true, notificationSwitches: { value: allSwitches(true) }, digest: { value: "daily" }, hook: {} },
  },
];

/* ---------------------------------------------------------- templates */

interface Draft {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly policy: TeamAccountPolicy;
}

/** An operator's templates, each a policy several accounts can follow at once. */
export function PolicyTemplates({ connection }: { connection: TeamConnection }) {
  const [templates, setTemplates] = useState<readonly TeamPolicyTemplate[] | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const load = useCallback(() => {
    void connection
      .call<{ templates: TeamPolicyTemplate[] }>("admin.policies.list")
      .then((answer) => setTemplates(answer.templates))
      .catch(setFailure);
  }, [connection]);
  useEffect(() => load(), [load]);
  const save = async () => {
    if (draft === undefined) return;
    setFailure(undefined);
    try {
      await connection.call("admin.policies.save", {
        ...(draft.id === undefined ? {} : { id: draft.id }),
        name: draft.name.trim(),
        ...(draft.description.trim() === "" ? {} : { description: draft.description.trim() }),
        policy: draft.policy,
      });
      setDraft(undefined);
      toast(t("saved"));
      load();
    } catch (caught) {
      setFailure(caught);
    }
  };
  const remove = (template: TeamPolicyTemplate) =>
    void confirmAction({
      title: t("policyDeleteTitle", { name: template.name }),
      body: template.accounts === 0 ? t("policyDeleteBodyNone") : t("policyDeleteBody", { count: String(template.accounts) }),
      confirmLabel: t("remove"),
      danger: true,
    }).then((yes) => yes && void connection.call("admin.policies.delete", { id: template.id }).then(load).catch(toastError));
  return (
    <div className="admin-section">
      <div className="table-tools">
        <span className="muted small">{t("policyTemplatesLead")}</span>
        <button className="btn btn-primary" onClick={() => setChoosing(true)}>
          <Icon name="plus" size={14} /> {t("policyNew")}
        </button>
      </div>
      {draft === undefined && failure !== undefined ? <Flash error={failure} /> : null}
      {templates === undefined ? (
        <Skeleton rows={3} />
      ) : templates.length === 0 ? (
        <Blankslate icon="shield" title={t("policyNone")}>
          {t("policyNoneLead")}
        </Blankslate>
      ) : (
        <ul className="policy-list">
          {templates.map((template) => (
            <li key={template.id} className="card policy-card">
              <div className="policy-card-text">
                <strong>{template.name}</strong>
                {template.description === undefined ? null : <span className="muted small">{template.description}</span>}
                <span className="small">{policySummary(template.policy)}</span>
                <span className="muted small">
                  {t("policyFollowers", { count: String(template.accounts) })} · <RelativeTime at={template.updatedAt} />
                </span>
              </div>
              <span className="policy-card-actions">
                <button className="btn btn-sm" onClick={() => setDraft({ id: template.id, name: template.name, description: template.description ?? "", policy: template.policy })}>
                  {t("edit")}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(template)}>
                  {t("remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {choosing ? (
        <Dialog title={t("policyChoosePreset")} onClose={() => setChoosing(false)} width={560}>
          <div className="preset-grid">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="preset-option"
                onClick={() => {
                  setChoosing(false);
                  setFailure(undefined);
                  setDraft({ name: preset.id === "blank" ? "" : t(preset.name), description: preset.id === "blank" ? "" : t(preset.lead), policy: preset.policy });
                }}
              >
                <strong>{t(preset.name)}</strong>
                <span className="muted small">{t(preset.lead)}</span>
              </button>
            ))}
          </div>
        </Dialog>
      ) : null}
      {draft === undefined ? null : (
        <Dialog
          title={draft.id === undefined ? t("policyNew") : t("policyEdit", { name: draft.name })}
          onClose={() => setDraft(undefined)}
          width={640}
          footer={
            <>
              <button className="btn" onClick={() => setDraft(undefined)}>
                {t("cancel")}
              </button>
              <button className="btn btn-primary" disabled={draft.name.trim() === ""} onClick={() => void save()}>
                {t("save")}
              </button>
            </>
          }
        >
          <div className="stack">
            {failure === undefined ? null : <Flash error={failure} />}
            {draft.id !== undefined && (templates?.find((one) => one.id === draft.id)?.accounts ?? 0) > 0 ? (
              <Flash tone="info">{t("policyEditApplies", { count: String(templates?.find((one) => one.id === draft.id)?.accounts ?? 0) })}</Flash>
            ) : null}
            <label className="form-field">
              <span className="form-label">{t("policyName")}</span>
              <input value={draft.name} maxLength={64} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required autoFocus />
            </label>
            <label className="form-field">
              <span className="form-label">{t("policyDescription")}</span>
              <input value={draft.description} maxLength={400} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <PolicyEditor value={draft.policy} onChange={(policy) => setDraft({ ...draft, policy })} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------- one account */

type Assignment = "none" | "template" | "custom";

/** One account's policy: none, a template, or settings of its own. */
export function AccountPolicyDialog({
  connection,
  usernames,
  title,
  onClose,
  onSaved,
}: {
  connection: TeamConnection;
  usernames: readonly string[];
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [templates, setTemplates] = useState<readonly TeamPolicyTemplate[]>([]);
  const [mode, setMode] = useState<Assignment>("none");
  const [template, setTemplate] = useState<string | undefined>(undefined);
  const [policy, setPolicy] = useState<TeamAccountPolicy>({});
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const single = usernames.length === 1 ? usernames[0] : undefined;
  useEffect(() => {
    void Promise.all([
      connection.call<{ templates: TeamPolicyTemplate[] }>("admin.policies.list"),
      single === undefined ? Promise.resolve(undefined) : connection.call<TeamAccountPolicyView>("admin.users.policy", { username: single }),
    ])
      .then(([list, view]) => {
        setTemplates(list.templates);
        if (view?.template !== undefined) {
          setMode("template");
          setTemplate(view.template.id);
        } else if (view?.custom === true) {
          setMode("custom");
          setPolicy(view.policy);
        }
        setTemplate((current) => current ?? list.templates[0]?.id);
        setReady(true);
      })
      .catch(setFailure);
  }, [connection, single]);
  const save = async () => {
    setFailure(undefined);
    try {
      await connection.call("admin.users.policySet", {
        usernames,
        ...(mode === "none" ? { clear: true } : mode === "template" ? { template } : { policy }),
      });
      toast(t("saved"));
      onSaved();
      onClose();
    } catch (caught) {
      setFailure(caught);
    }
  };
  const chosen = templates.find((one) => one.id === template);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" disabled={!ready || (mode === "template" && template === undefined)} onClick={() => void save()}>
            {t("save")}
          </button>
        </>
      }
    >
      <div className="stack">
        {failure === undefined ? null : <Flash error={failure} />}
        {!ready ? (
          <Skeleton rows={3} />
        ) : (
          <>
            <fieldset className="policy-modes">
              {(["none", "template", "custom"] as const).map((value) => (
                <label key={value} className={mode === value ? "policy-mode active" : "policy-mode"}>
                  <input type="radio" name="policy-mode" checked={mode === value} disabled={value === "template" && templates.length === 0} onChange={() => setMode(value)} />
                  <span>
                    <strong>{t(value === "none" ? "policyModeNone" : value === "template" ? "policyModeTemplate" : "policyModeCustom")}</strong>
                    <span className="muted small">
                      {t(value === "none" ? "policyModeNoneLead" : value === "template" ? (templates.length === 0 ? "policyModeTemplateEmpty" : "policyModeTemplateLead") : "policyModeCustomLead")}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === "template" && templates.length > 0 ? (
              <div className="settings-row">
                <span className="small">{chosen === undefined ? null : policySummary(chosen.policy)}</span>
                <SelectPanel<string>
                  label={t("policyModeTemplate")}
                  align="end"
                  value={template ?? ""}
                  options={templates.map((one) => ({ value: one.id, label: one.name }))}
                  onChange={setTemplate}
                />
              </div>
            ) : null}
            {mode === "custom" ? <PolicyEditor value={policy} onChange={setPolicy} /> : null}
            {mode !== "none" ? <p className="muted small">{t("policyApplyNote")}</p> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------- Studio sync */

/** Studio's preferences kept on this server: what is there, and getting it out or putting a file in. */
export function StudioConfigCard({ connection, open }: { connection: TeamConnection; open: boolean }) {
  const [status, setStatus] = useState<TeamStudioConfigStatus | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    connection
      .call<TeamStudioConfigStatus>("account.studioConfig")
      .then(setStatus)
      .catch(() => undefined);
  }, [connection]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  if (status === undefined) return null;
  const upload = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      if (file.size > STUDIO_CONFIG_MAX_BYTES) throw new Error(t("studioConfigTooBig", { size: formatBytes(STUDIO_CONFIG_MAX_BYTES) }));
      const response = await fetch(STUDIO_CONFIG_PATH, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: file });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? response.statusText);
      setStatus((await response.json()) as TeamStudioConfigStatus);
      toast(t("saved"));
    } catch (caught) {
      toastError(caught);
    }
  };
  const remove = () =>
    void confirmAction({ title: t("studioConfigDeleteTitle"), body: t("studioConfigDeleteBody"), confirmLabel: t("remove"), danger: true }).then(
      (yes) =>
        yes &&
        void connection
          .call<TeamStudioConfigStatus>("account.studioConfig.delete")
          .then(setStatus)
          .catch(toastError),
    );
  const stored = status.stored;
  return (
    <div className="card settings-block">
      <h2>{t("studioConfigTitle")}</h2>
      <p className="muted">{t("studioConfigLead")}</p>
      {status.access === "off" ? (
        <p className="small">
          <LockedNote>{t("studioConfigOff")}</LockedNote>
        </p>
      ) : (
        <>
          {status.access === "read" ? (
            <p className="small">
              <LockedNote>{t("studioConfigReadOnly")}</LockedNote>
            </p>
          ) : null}
          <div className="settings-row">
            <span className="small">
              {stored === undefined ? (
                <span className="muted">{t("studioConfigNone")}</span>
              ) : (
                <>
                  {t("studioConfigStored", { size: formatBytes(stored.size) })}
                  {stored.studioVersion === undefined ? null : ` · Studio ${stored.studioVersion}`} · <RelativeTime at={stored.updatedAt} />
                </>
              )}
            </span>
            <span className="settings-row-actions">
              {stored === undefined ? null : (
                <a className="btn btn-sm" href={STUDIO_CONFIG_PATH} download="narraleaf-studio-settings.json">
                  <Icon name="download" size={14} /> {t("exportDownload")}
                </a>
              )}
              {status.access === "on" ? (
                <>
                  <button className="btn btn-sm" onClick={() => picker.current?.click()}>
                    <Icon name="upload" size={14} /> {t("studioConfigUpload")}
                  </button>
                  {stored === undefined ? null : (
                    <button className="btn btn-sm btn-danger" onClick={remove}>
                      {t("remove")}
                    </button>
                  )}
                  <input
                    ref={picker}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      void upload(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </>
              ) : null}
            </span>
          </div>
          {status.access === "on" ? <p className="muted small">{t("studioConfigHint")}</p> : null}
        </>
      )}
    </div>
  );
}
