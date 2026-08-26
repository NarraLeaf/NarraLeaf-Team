/**
 * 日本語。
 *
 * The same two habits as the Chinese catalogue. What Team recorded — a
 * username, a project's name, a group, a `kid`, the detail of a decision — is
 * left exactly as it is; only the sentence around it is Japanese. And the
 * clauses that say how far a thing reaches ("次のリクエストから") are the
 * reason these sentences exist, so they survive any rewording.
 */
import type { Messages } from "./messages.js";

export const ja: Messages = {
  locale: "ja",
  name: "日本語",

  format: {
    duration: (amount, unit) =>
      `${amount}${{ day: "日", hour: "時間", minute: "分", second: "秒" }[unit]}`,
    durationWords: [
      ["時間", "h"],
      ["日", "d"],
      ["分", "m"],
      ["秒", "s"],
    ],
  },

  action: {
    keyRotated: ({ kid, published }) =>
      `これからは ${kid} で署名します。公開中の ${published} 個の鍵で署名されたトークンは引き続き検証できます`,
    userDisabled: ({ username }) =>
      `${username} を無効にしました。今後は何も発行されず、発行済みのトークンも拒否されます`,
    userEnabled: ({ username }) => `${username} を有効にしました`,
    tokensRevoked: ({ username, lifetime }) =>
      `${username} のトークンを失効させました。すでに開いている接続は、そのリポジトリトークンが切れるまで、最大 ${lifetime} 続くことがあります`,
    settingReadOnly: "この行は読み取り専用です",
    settingChanged: ({ label, value }) =>
      `${label}は ${value} になりました。発行済みのトークンは受け取った有効期間のままです`,
    accountCreated: ({ username, group }) =>
      `${username} を ${group} に作成しました。サインイン用のトークンを発行して渡してください`,
    tokenIssued: ({ username, lifetime }) =>
      `${username} のサインイントークンです。有効期間は ${lifetime} です`,
    projectCreated: ({ project, owner }) => `${project} を作成しました。オーナーは ${owner} です`,
  },

  error: {
    notADuration: ({ value }) =>
      `「${value}」は期間ではありません。30分、48時間、7日 のように書いてください。`,
    durationTooSmall: "有効期間は 0 より大きくなければなりません",
  },
};
