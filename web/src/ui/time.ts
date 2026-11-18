/** "3 hours ago", in the browser's language; a date once it is a month old. */
export function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  const format = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  // A time still to come (a link that runs out, a due date): how far off, never "now".
  if (seconds < -60) {
    const ahead = -seconds;
    if (ahead < 3600) return format.format(Math.round(ahead / 60), "minute");
    if (ahead < 86_400) return format.format(Math.round(ahead / 3600), "hour");
    if (ahead < 60 * 86_400) return format.format(Math.round(ahead / 86_400), "day");
    return new Date(at).toLocaleDateString();
  }
  if (seconds < 60) return format.format(-Math.max(0, seconds), "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  // Days count calendar days, so a time "yesterday" is never "2 days ago" under a "Yesterday" heading.
  const midnight = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days === 0) return format.format(-Math.max(1, Math.round(seconds / 3600)), "hour");
  if (days < 30) return format.format(-days, "day");
  return new Date(at).toLocaleDateString();
}
