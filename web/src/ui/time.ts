/** "3 hours ago", in the browser's language; a date once it is a month old. */
export function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  const format = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  if (seconds < 60) return format.format(-Math.max(0, seconds), "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  // Days count calendar days, so a time "yesterday" is never "2 days ago" under a "Yesterday" heading.
  const midnight = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days === 0) return format.format(-Math.max(1, Math.round(seconds / 3600)), "hour");
  if (days < 30) return format.format(-days, "day");
  return new Date(at).toLocaleDateString();
}
