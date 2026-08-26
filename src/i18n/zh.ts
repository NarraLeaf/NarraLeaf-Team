/**
 * 简体中文。
 *
 * Written to say what the English says, not to say it the same way. Two habits
 * of this catalogue are worth knowing before changing it:
 *
 *   - What Team recorded stays as Team recorded it. A username, a project's
 *     name, a group, a `kid`, the detail of a decision — none of them are
 *     translated, because the sentence would then say something the database
 *     does not hold. Only the sentence around them is Chinese.
 *   - The clauses that say how far something reaches are the point of these
 *     sentences, not decoration. "从下一次请求开始生效" has to survive any
 *     rewording, because that is the part an operator otherwise gets wrong.
 */
import type { Messages } from "./messages.js";

export const zh: Messages = {
  locale: "zh",
  name: "简体中文",

  format: {
    duration: (amount, unit) =>
      `${amount} ${{ day: "天", hour: "小时", minute: "分钟", second: "秒" }[unit]}`,
    durationWords: [
      ["小时", "h"],
      ["分钟", "m"],
      ["天", "d"],
      ["秒", "s"],
    ],
  },

  action: {
    keyRotated: ({ kid, published }) =>
      `现在用 ${kid} 签名；已发布的 ${published} 把密钥签出的令牌仍然可以验证`,
    userDisabled: ({ username }) =>
      `已停用 ${username}；从现在起不再签发任何令牌，已经签发的也会被拒绝`,
    userEnabled: ({ username }) => `已启用 ${username}`,
    tokensRevoked: ({ username, lifetime }) =>
      `已吊销 ${username} 的令牌；已经建立的连接可能还会持续到它的仓库令牌过期，最多 ${lifetime}`,
    settingReadOnly: "这一行是只读的",
    settingChanged: ({ label, value }) =>
      `${label}现在是 ${value}；已经签发的令牌仍然保留它们当初拿到的有效期`,
    accountCreated: ({ username, group }) =>
      `已创建 ${username}，属于 ${group}；还需要给他们签发一个登录令牌`,
    tokenIssued: ({ username, lifetime }) =>
      `给 ${username} 的登录令牌，有效期 ${lifetime}`,
    projectCreated: ({ project, owner }) => `已创建 ${project}，拥有者是 ${owner}`,
  },

  error: {
    notADuration: ({ value }) => `“${value}”不是一段时长。可以写成 30 分钟、48 小时或 7 天。`,
    durationTooSmall: "有效期必须大于零",
  },
};
