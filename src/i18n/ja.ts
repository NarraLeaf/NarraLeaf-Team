/**
 * 日本語。
 *
 * The same habit as the Chinese catalogue: what Team recorded is left exactly as
 * it is — a value somebody typed is quoted back as they typed it — and only the
 * sentence around it is Japanese.
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

  error: {
    notADuration: ({ value }) =>
      `「${value}」は期間ではありません。30分、48時間、7日 のように書いてください。`,
    durationTooSmall: "有効期間は 0 より大きくなければなりません",
  },
};
