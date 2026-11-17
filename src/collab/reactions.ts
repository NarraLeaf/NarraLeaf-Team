/**
 * Reactions: a 👍 on a comment or a chat message, instead of a reply that says only "ok".
 *
 * Eight emoji and no others ({@link TEAM_REACTIONS}). One person gives each emoji to a target at
 * most once; giving it again takes it back. A target is a comment (`comment`, the comment's id)
 * or a chat message (`chat`, the message's id), always inside one project.
 */
import type { DatabaseSync } from "node:sqlite";

import { textColumn, type Row } from "../identity/database.js";
import { findUserById } from "../identity/users.js";
import { TEAM_REACTIONS, type TeamReaction, type TeamReactionEmoji } from "../team/protocol.js";

export type ReactionTarget = "comment" | "chat";

/** Targets one list asks for at most. */
export const REACTION_TARGETS_LIMIT = 200;

export function isReaction(emoji: string): emoji is TeamReactionEmoji {
  return (TEAM_REACTIONS as readonly string[]).includes(emoji);
}

/** Whether the target is in the project: a comment of its threads, a message of its chat. */
export function targetInProject(database: DatabaseSync, projectId: string, kind: ReactionTarget, target: string): boolean {
  const row =
    kind === "comment"
      ? database
          .prepare("SELECT 1 FROM comments c JOIN threads t ON t.id = c.thread_id WHERE c.id = ? AND t.project_id = ? AND c.deleted_at IS NULL")
          .get(target, projectId)
      : /^\d{1,15}$/.test(target)
        ? database.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND project_id = ? AND deleted_at IS NULL").get(Number(target), projectId)
        : undefined;
  return row !== undefined;
}

/** One target's reactions, emoji by emoji in the fixed order, with who gave each. */
export function reactionsOn(database: DatabaseSync, kind: ReactionTarget, target: string): TeamReaction[] {
  const rows = database
    .prepare("SELECT emoji, account_id FROM reactions WHERE target_kind = ? AND target_id = ? ORDER BY at")
    .all(kind, target) as Row[];
  const by = new Map<string, string[]>();
  for (const row of rows) {
    const user = findUserById(database, textColumn(row, "account_id"));
    if (user === undefined) continue;
    const emoji = textColumn(row, "emoji");
    by.set(emoji, [...(by.get(emoji) ?? []), user.username]);
  }
  return TEAM_REACTIONS.flatMap((emoji) => {
    const names = by.get(emoji);
    return names === undefined ? [] : [{ target, emoji, by: names }];
  });
}

/** Several targets' reactions, flat. */
export function reactionsOnMany(database: DatabaseSync, kind: ReactionTarget, targets: readonly string[]): TeamReaction[] {
  return [...new Set(targets)].flatMap((target) => reactionsOn(database, kind, target));
}

/** Give or take back one emoji. Answers the target's reaction for that emoji now (`by` empty when nobody). */
export function toggleReaction(
  database: DatabaseSync,
  projectId: string,
  kind: ReactionTarget,
  target: string,
  accountId: string,
  emoji: TeamReactionEmoji,
  now = Date.now(),
): TeamReaction {
  const removed = Number(
    database
      .prepare("DELETE FROM reactions WHERE target_kind = ? AND target_id = ? AND account_id = ? AND emoji = ?")
      .run(kind, target, accountId, emoji).changes,
  );
  if (removed === 0) {
    database
      .prepare("INSERT INTO reactions (project_id, target_kind, target_id, account_id, emoji, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, kind, target, accountId, emoji, now);
  }
  return reactionsOn(database, kind, target).find((reaction) => reaction.emoji === emoji) ?? { target, emoji, by: [] };
}
