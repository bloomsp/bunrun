import { parseHHMM } from './time';

export function breakAllowanceMinutes(shiftMinutes: number): number {
  if (shiftMinutes < 4 * 60) return 0;
  if (shiftMinutes <= 5 * 60) return 15;
  if (shiftMinutes < 7 * 60) return 45;
  if (shiftMinutes < 10 * 60) return 60;
  return 90;
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function minutesRange(startHHMM: string, durationMinutes: number): { start: number; end: number } | null {
  const s = parseHHMM(startHHMM);
  if (s == null) return null;
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration)) return null;
  return { start: s, end: s + duration };
}
