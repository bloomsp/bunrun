import { breakAllowanceMinutes, overlap } from './breaks';
import { parseHHMM, toHHMM } from './time';

export type ShiftLike = {
  id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
};

export type BreakLike = {
  id?: number;
  shift_id: number;
  start_time: string;
  duration_minutes: number;
  cover_member_id: number | null;
};

export type AreaLike = { key: string; label: string; min_staff: number };

export type MemberLike = { id: number; all_areas: number };

export function computeShiftMinutes(shift: ShiftLike): number {
  const startMin = parseHHMM(shift.start_time) ?? 0;
  const endMin = shift.end_time ? parseHHMM(shift.end_time) : null;
  return endMin != null ? endMin - startMin : shift.shift_minutes;
}

export function generateBreakTemplate(shiftMinutes: number): number[] {
  const allowance = breakAllowanceMinutes(shiftMinutes);
  if (allowance <= 15) return [15];
  if (allowance === 45) return [30, 15];
  // 60m default (A): 30 + 15 + 15
  if (allowance === 60) return [30, 15, 15];
  // fallback
  return [allowance];
}

export function proposeBreakTimes(
  shift: ShiftLike,
  durations: number[],
  opts?: { offsetMinutes?: number }
): { start_time: string; duration_minutes: number }[] {
  const startMin = parseHHMM(shift.start_time);
  const endMin = shift.end_time ? parseHHMM(shift.end_time) : null;
  if (startMin == null || endMin == null) return [];

  // Simple cadence: first break around +2h30, subsequent breaks around +2h30 after previous break start.
  const cadence = 150; // minutes
  const out: { start_time: string; duration_minutes: number }[] = [];
  let cursor = startMin + cadence + (opts?.offsetMinutes ?? 0);

  for (const dur of durations) {
    // Clamp to fit inside shift
    const latestStart = endMin - dur;
    const s = Math.min(cursor, latestStart);
    if (s <= startMin) break;
    out.push({ start_time: toHHMM(s), duration_minutes: dur });
    cursor = s + cadence;
  }

  return out;
}

export function rangeFor(b: { start_time: string; duration_minutes: number }): { start: number; end: number } | null {
  const s = parseHHMM(b.start_time);
  if (s == null) return null;
  return { start: s, end: s + b.duration_minutes };
}

export function breaksOverlap(a: { start_time: string; duration_minutes: number }, b: { start_time: string; duration_minutes: number }) {
  const ar = rangeFor(a);
  const br = rangeFor(b);
  if (!ar || !br) return false;
  return overlap(ar.start, ar.end, br.start, br.end);
}
