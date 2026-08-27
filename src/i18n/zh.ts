/**
 * 简体中文。
 *
 * Written to say what the English says, not to say it the same way. One habit of
 * this catalogue is worth knowing before changing it: what Team recorded stays
 * as Team recorded it. A value somebody typed is quoted back exactly as they
 * typed it, because the sentence would otherwise say something they did not
 * write. Only the sentence around it is Chinese.
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

  error: {
    notADuration: ({ value }) => `“${value}”不是一段时长。可以写成 30 分钟、48 小时或 7 天。`,
    durationTooSmall: "有效期必须大于零",
  },
};
