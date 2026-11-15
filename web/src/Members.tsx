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

export function roleKey(role: TeamProjectRole): Phrase {
  return ({ owner: "roleOwner", editor: "roleEditor", reviewer: "roleReviewer", viewer: "roleViewer" } as const)[role];
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function ProjectMembers({ connection, projectId }: { connection: TeamConnection; projectId: string }) {
  const [members, setMembers] = useState<readonly TeamProjectMember[]>([]);
  const [accounts, setAccounts] = useState<readonly { username: string; displayName: string }[]>([]);
  const [adding, setAdding] = useState({ username: "", template: "editor" as TeamPermissionTemplateId });
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | undefined>(undefined);

  const load = useCallback(() => {
    void connection
      .call<{ members: TeamProjectMember[] }>("projects.members.list", { project: projectId, limit: 500 })
      .then((answer) => setMembers(answer.members))
      .catch((caught: unknown) => setNote({ text: errorText(caught), tone: "error" }));
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
        setNote({ text: t("done"), tone: "ok" });
        load();
      })
      .catch((caught: unknown) => setNote({ text: errorText(caught), tone: "error" }));
  };
  const setRole = (username: string, role: TeamProjectRole) =>
    run(() => connection.call("projects.members.set", { project: projectId, username, role }));
  const setTemplate = (username: string, template: TeamPermissionTemplateId) =>
    run(() => connection.call("projects.members.set", { project: projectId, username, template }));
  const setAreas = (member: TeamProjectMember, areas: readonly TeamProjectArea[]) =>
    run(() =>
      connection.call("projects.members.set", { project: projectId, username: member.username, role: member.role, areas }),
    );
  const remove = (username: string) => run(() => connection.call("projects.members.remove", { project: projectId, username }));
  const outside = accounts.filter((account) => !members.some((member) => member.username === account.username));

  return (
    <div className="project-members">
      {note === undefined ? null : <p className={note.tone === "error" ? "error" : "muted small"}>{note.text}</p>}
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
                {member.displayName || member.username} <span className="muted small">@{member.username}</span>
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
                <select value={member.role} onChange={(event) => setRole(member.username, event.target.value as TeamProjectRole)}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(roleKey(role))}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <AreaCell member={member} change={(areas) => setAreas(member, areas)} />
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
      <p className="muted small">{t("areasHint")}</p>
      {outside.length > 0 ? (
        <form
          className="admin-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding.username !== "") setTemplate(adding.username, adding.template);
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
          <TemplateSelect value={adding.template} change={(template) => setAdding({ ...adding, template })} />
          <button className="primary" type="submit">
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
    <div className="area-ticks">
      {TEAM_PROJECT_AREAS.map((area) => (
        <label key={area} className="area-tick">
          <input
            type="checkbox"
            checked={current.includes(area)}
            onChange={(event) =>
              change(event.target.checked ? TEAM_PROJECT_AREAS.filter((a) => a === area || current.includes(a)) : current.filter((a) => a !== area))
            }
          />
          {t(AREA_PHRASE[area])}
        </label>
      ))}
    </div>
  );
}
