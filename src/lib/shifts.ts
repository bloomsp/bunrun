import { parseHHMM } from './time';

export type ShiftTimeLike = {
  id?: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  start_time: string;
  end_time: string | null;
};

export type MinuteRange = {
  start: number;
  end: number;
};

export function shiftRange(shift: Pick<ShiftTimeLike, 'start_time' | 'end_time'>): MinuteRange | null {
  const start = parseHHMM(shift.start_time);
  const end = shift.end_time ? parseHHMM(shift.end_time) : null;
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

export function rangesOverlap(a: MinuteRange, b: MinuteRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function findOverlappingShift(
  shifts: Array<ShiftTimeLike>,
  target: MinuteRange,
  opts?: { excludeShiftId?: number }
): ShiftTimeLike | null {
  const excludeShiftId = opts?.excludeShiftId ?? null;
  for (const shift of shifts) {
    if (excludeShiftId != null && shift.id === excludeShiftId) continue;
    const range = shiftRange(shift);
    if (!range) continue;
    if (rangesOverlap(range, target)) return shift;
  }
  return null;
}

export function shiftsActiveInRange(shifts: Array<ShiftTimeLike>, target: MinuteRange, opts?: { workingOnly?: boolean }) {
  return shifts.filter((shift) => {
    if (opts?.workingOnly && shift.status_key !== 'working') return false;
    const range = shiftRange(shift);
    return Boolean(range && rangesOverlap(range, target));
  });
}

export function firstActiveShiftInRange(
  shifts: Array<ShiftTimeLike>,
  target: MinuteRange,
  opts?: { workingOnly?: boolean }
) {
  return shiftsActiveInRange(shifts, target, opts)[0] ?? null;
}

export function countWorkingShiftsByAreaInRange(shifts: Array<ShiftTimeLike>, target: MinuteRange) {
  const counts = new Map<string, number>();
  for (const shift of shifts) {
    if (shift.status_key !== 'working') continue;
    const range = shiftRange(shift);
    if (!range || !rangesOverlap(range, target)) continue;
    counts.set(shift.home_area_key, (counts.get(shift.home_area_key) ?? 0) + 1);
  }
  return counts;
}
