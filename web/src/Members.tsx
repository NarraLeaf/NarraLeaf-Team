/**
 * Who is in a project and what each of them may change. Shared by a project's
 * own settings, for its owners, and the back office, for operators: the same
 * table, the same refusals, because the server decides both the same way.
 *
 * An editor carries a set of areas (story, characters, assets, UI,
 * localization, game config). All of them is the same as no list; the server
 * drops a list that covers everything.
 */
import { useCallback, useEffect, useState } from "react";
import {
  TEAM_PROJECT_AREAS,
  teamTemplateOf,
  type TeamPermissionTemplateId,
  type TeamProjectArea,
  type TeamProjectMember,
  type TeamProjectRole,
} from "@narraleaf/team-protocol";
import { TemplateSelect } from "./Access";
import { t, type Phrase } from "./i18n";
import { Face } from "./Collab";
import { ActionMenu, confirmAction, SelectPanel, toast, toastError } from "./ui";
import type { TeamConnection } from "./socket";

const ROLES: readonly TeamProjectRole[] = ["owner", "editor", "reviewer", "viewer"];

const AREA_PHRASE: Readonly<Record<TeamProjectArea, Phrase>> = {
  story: "areaStory",
  characters: "areaCharacters",
  assets: "areaAssets",
  ui: "areaUi",
  localization: "areaLocalization",
  config: "areaConfig",
};

const ROLE_HINT: Readonly<Record<TeamProjectRole, Phrase>> = {
  owner: "roleOwnerHint",
  editor: "roleEditorHint",
  reviewer: "roleReviewerHint",
  viewer: "roleViewerHint",
};

export function roleKey(role: TeamProjectRole): Phrase {
  return ({ owner: "roleOwner", editor: "roleEditor", reviewer: "roleReviewer", viewer: "roleViewer" } as const)[role];
}

export function ProjectMembers({ connection, projectId }: { connection: TeamConnection; projectId: string }) {
  const [members, setMembers] = useState<readonly TeamProjectMember[]>([]);
  const [accounts, setAccounts] = useState<readonly { username: string; displayName: string }[]>([]);
  const [adding, setAdding] = useState({ username: "", template: "editor" as TeamPermissionTemplateId });

  const load = useCallback(() => {
    void connection
      .call<{ members: TeamProjectMember[] }>("projects.members.list", { project: projectId, limit: 500 })
      .then((answer) => setMembers(answer.members))
      .catch(toastError);
  }, [connection, projectId]);
  useEffect(() => {
    load();
    void connection
      .call<{ members: { username: string; displayName: string }[] }>("members.list")
      .then((answer) => setAccounts(answer.members))
      .catch(() => setAccounts([]));
  }, [connection, load]);

  const run = (work: () => Promise<unknown>) => {
    void work()
      .then(() => {
        toast(t("done"));
        load();
      })
      .catch(toastError);
  };
  const setRole = (username: string, role: TeamProjectRole) =>
    run(() => connection.call("projects.members.set", { project: projectId, username, role }));
  const setTemplate = (username: string, template: TeamPermissionTemplateId) =>
    run(() => connection.call("projects.members.set", { project: projectId, username, template }));
  const setAreas = (member: TeamProjectMember, areas: readonly TeamProjectArea[]) =>
    run(() =>
      connection.call("projects.members.set", { project: projectId, username: member.username, role: member.role, areas }),
    );
  const remove = (member: TeamProjectMember) =>
    void confirmAction({
      title: t("removeMemberTitle", { name: member.displayName || member.username }),
      body: t("removeMemberBody"),
      confirmLabel: t("removeMember"),
      danger: true,
    }).then((yes) => {
      if (yes) run(() => connection.call("projects.members.remove", { project: projectId, username: member.username }));
    });
  const outside = accounts.filter((account) => !members.some((member) => member.username === account.username));

  return (
    <div className="project-members">
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t("members")}</th>
            <th>{t("tplLabel")}</th>
            <th>{t("role")}</th>
            <th>{t("areasLabel")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.username}>
              <td>
                <span className="member-cell">
                  <Face name={member.displayName || member.username} user={member.username} size={24} />
                  <span className="member-cell-text">
                    <strong>{member.displayName || member.username}</strong>
                    <span className="muted small">@{member.username}</span>
                  </span>
                </span>
              </td>
              <td>
                <TemplateSelect
                  value={teamTemplateOf(member.role, member.areas)?.id}
                  change={(template) => {
                    // The "custom" entry carries no template; picking it changes nothing.
                    if ((template as string) !== "") setTemplate(member.username, template);
                  }}
                />
              </td>
              <td>
                <SelectPanel
                  label={t("role")}
                  size="small"
                  value={member.role}
                  onChange={(role) => setRole(member.username, role)}
                  options={ROLES.map((role) => ({ value: role, label: t(roleKey(role)), description: t(ROLE_HINT[role]) }))}
                />
              </td>
              <td>
                <AreaCell member={member} change={(areas) => setAreas(member, areas)} />
              </td>
              <td className="admin-actions">
                <ActionMenu actions={[{ label: t("removeMember"), icon: "trash", danger: true, run: () => remove(member) }]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("areasHint")}</p>
      {outside.length > 0 ? (
        <form
          className="admin-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding.username !== "") setTemplate(adding.username, adding.template);
          }}
        >
          <SelectPanel
            label={t("addMember")}
            placeholder={t("addMember")}
            filterFrom={0}
            value={adding.username === "" ? undefined : adding.username}
            onChange={(username) => setAdding({ ...adding, username })}
            options={outside.map((account) => ({
              value: account.username,
              label: account.displayName || account.username,
              ...(account.displayName ? { description: `@${account.username}` } : {}),
              leading: <Face name={account.displayName || account.username} user={account.username} size={18} />,
            }))}
          />
          <TemplateSelect size="medium" value={adding.template} change={(template) => setAdding({ ...adding, template })} />
          <button className="btn btn-primary" type="submit" disabled={adding.username === ""}>
            {t("add")}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** Ticks for an editor; a word for everybody else, whose role already says it. */
function AreaCell({ member, change }: { member: TeamProjectMember; change: (areas: readonly TeamProjectArea[]) => void }) {
  if (member.role === "owner") {
    return <span className="muted small">{t("areasAll")}</span>;
  }
  if (member.role !== "editor") {
    return <span className="muted small">—</span>;
  }
  const current: readonly TeamProjectArea[] = member.areas ?? TEAM_PROJECT_AREAS;
  return (
    <SelectPanel
      multiple
      label={t("areasLabel")}
      size="small"
      allLabel={t("areasAll")}
      value={current}
      // Kept in the protocol's order, whatever order they were ticked in.
      onChange={(areas) => {
        if (areas.length > 0) change(TEAM_PROJECT_AREAS.filter((area) => areas.includes(area)));
      }}
      options={TEAM_PROJECT_AREAS.map((area) => ({ value: area, label: t(AREA_PHRASE[area]) }))}
    />
  );
}
