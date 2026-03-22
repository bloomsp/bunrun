export function parseHHMM(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

export function formatDurationMinutes(total: number): string {
  const sign = total < 0 ? '-' : '';
  const m = Math.abs(total);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${sign}${r}m`;
  if (r === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${r}m`;
}

// Brisbane is UTC+10 with no DST.
const BRISBANE_OFFSET = '+10:00';

export function dayTypeForDate(dateYYYYMMDD: string): 'weekday' | 'weekend' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYYYYMMDD)) return null;
  const d = new Date(`${dateYYYYMMDD}T00:00:00${BRISBANE_OFFSET}`);
  const dow = d.getUTCDay();
  // 0 Sun, 6 Sat
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}

export function toHHMM(totalMinutes: number): string {
  const hh = Math.floor(totalMinutes / 60) % 24;
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function operatingHoursFor(dateYYYYMMDD: string): { open: number; close: number } | null {
  const dt = dayTypeForDate(dateYYYYMMDD);
  if (!dt) return null;
  // weekend 06:00-18:00, weekday 06:00-21:00
  return dt === 'weekend'
    ? { open: 6 * 60, close: 18 * 60 }
    : { open: 6 * 60, close: 21 * 60 };
}
