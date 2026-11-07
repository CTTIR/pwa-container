/** Display helpers for organiser-entered event dates (calendar days, no time zone involved). */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * German date or date range, e.g. "07.11.2026", "07.–08.11.2026", "30.10.–02.11.2026",
 * "30.12.2026–02.01.2027". Unparseable values are returned unchanged.
 */
export function formatEventDate(start: string, end?: string | null): string {
  const a = ISO_DATE.exec(start);
  if (!a) return start;
  const [, y1, m1, d1] = a;
  const b = end && end !== start ? ISO_DATE.exec(end) : null;
  if (!b) return `${d1}.${m1}.${y1}`;
  const [, y2, m2, d2] = b;
  if (y1 !== y2) return `${d1}.${m1}.${y1}–${d2}.${m2}.${y2}`;
  if (m1 !== m2) return `${d1}.${m1}.–${d2}.${m2}.${y2}`;
  return `${d1}.–${d2}.${m2}.${y2}`;
}

/** "Event name · 07.–08.11.2026" */
export function eventLine(course: { label: string; eventDate?: string | null; eventDateEnd?: string | null }): string {
  return course.eventDate ? `${course.label} · ${formatEventDate(course.eventDate, course.eventDateEnd)}` : course.label;
}
