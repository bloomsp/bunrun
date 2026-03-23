import { parseHHMM } from './time';

export const RUNSHEET_START = '06:00';
export const RUNSHEET_END = '21:15';
export const RUNSHEET_STEP_MIN = 30;

export function buildTimeSlots(startHHMM = RUNSHEET_START, endHHMM = RUNSHEET_END, stepMin = RUNSHEET_STEP_MIN) {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start == null || end == null) return [] as { t: number; label: string }[];

  const slots: { t: number; label: string }[] = [];
  for (let t = start; t <= end; t += stepMin) {
    const hh = Math.floor(t / 60);
    const mm = t % 60;
    slots.push({ t, label: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` });
  }
  return slots;
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function minutesToLeftPx(mins: number, startMins: number, pxPerSlot: number) {
  // 30 min per slot
  return ((mins - startMins) / RUNSHEET_STEP_MIN) * pxPerSlot;
}
