/** "3 hours ago", in the browser's language; a date once it is a month old. */
export function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  const format = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  if (seconds < 60) return format.format(-Math.max(0, seconds), "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
  if (seconds < 86400 * 30) return format.format(-Math.round(seconds / 86400), "day");
  return new Date(at).toLocaleDateString();
}
