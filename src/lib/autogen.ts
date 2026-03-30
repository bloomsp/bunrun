import { breakAllowanceMinutes, overlap } from './breaks';
import { parseHHMM, toHHMM } from './time';
import type { BreakPreference } from './member-config';

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

export function generateBreakTemplate(shiftMinutes: number, preference: BreakPreference = '15+30'): number[] {
  let template: number[];
  if (shiftMinutes < 4 * 60) {
    template = [];
  } else if (shiftMinutes <= 5 * 60) {
    template = [15];
  } else if (shiftMinutes < 7 * 60) {
    template = [15, 30];
  } else if (shiftMinutes < 10 * 60) {
    template = [15, 30, 15];
  } else {
    template = [15, 30, 15, 30];
  }

  if (preference === '15+30') return template;

  const thirties = template.filter((minutes) => minutes === 30);
  const fifteens = template.filter((minutes) => minutes === 15);
  if (thirties.length === 0) return template;
  if (thirties.length === 1) return [30, ...fifteens];
  return [30, 15, 30, ...fifteens.slice(1)];
}

export function proposeBreakTimes(
  shift: ShiftLike,
  durations: number[],
  opts?: {
    offsetMinutes?: number;
    existingBreaks?: Array<{ start_time: string; duration_minutes: number }>;
  }
): { start_time: string; duration_minutes: number }[] {
  const startMin = parseHHMM(shift.start_time);
  const endMin = shift.end_time ? parseHHMM(shift.end_time) : null;
  if (startMin == null || endMin == null) return [];

  const out: { start_time: string; duration_minutes: number }[] = [];
  if (durations.length === 0) return out;

  let previousStart: number | null = null;
  const offset = opts?.offsetMinutes ?? 0;
  const existingBreaks = opts?.existingBreaks ?? [];
  const planned: { start_time: string; duration_minutes: number }[] = [];

  for (let index = 0; index < durations.length; index += 1) {
    const dur = durations[index];
    const earliestStart = (previousStart ?? startMin) + 120 + (index === 0 ? offset : 0);
    const preferredStart = (previousStart ?? startMin) + 150 + (index === 0 ? offset : 0);
    const latestByCadence = (previousStart ?? startMin) + 180 + (index === 0 ? offset : 0);
    const latestByShift = endMin - dur - 60;
    const latestStart = Math.min(latestByCadence, latestByShift);
    if (latestStart < earliestStart) break;

    let bestStart: number | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let candidate = earliestStart; candidate <= latestStart; candidate += 15) {
      const candidateBreak = { start_time: toHHMM(candidate), duration_minutes: dur };
      const overlapCount = [...existingBreaks, ...planned].reduce((count, row) => {
        return count + (breaksOverlap(candidateBreak, row) ? 1 : 0);
      }, 0);
      const score = overlapCount * 1000 + Math.abs(candidate - preferredStart);
      if (score < bestScore) {
        bestScore = score;
        bestStart = candidate;
      }
    }

    if (bestStart == null) break;
    const nextBreak = { start_time: toHHMM(bestStart), duration_minutes: dur };
    out.push(nextBreak);
    planned.push(nextBreak);
    previousStart = bestStart;
  }

  return out;
}

export function rangeFor(b: { start_time: string; duration_minutes: number }): { start: number; end: number } | null {
  const s = parseHHMM(b.start_time);
  if (s == null) return null;
  const duration = Number(b.duration_minutes);
  if (!Number.isFinite(duration)) return null;
  return { start: s, end: s + duration };
}

export function breaksOverlap(a: { start_time: string; duration_minutes: number }, b: { start_time: string; duration_minutes: number }) {
  const ar = rangeFor(a);
  const br = rangeFor(b);
  if (!ar || !br) return false;
  return overlap(ar.start, ar.end, br.start, br.end);
}
