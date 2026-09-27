/** Entry files are named YYYY-MM-DD.md; dates are handled as local-time strings. */
export const ENTRY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

export function monthKey(key: string): string {
  return key.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function dayKey(month: string, day: number): string {
  return `${month}-${pad(day)}`;
}

export function formatLong(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatMonth(month: string): string {
  return parseDateKey(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatWeekday(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: 'short' });
}
