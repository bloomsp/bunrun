import { recomputeWorkBlocksForSchedule } from './work-blocks';
const BRISBANE_OFFSET = '+10:00';

type ShiftCopyRow = {
  id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  shift_role: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
};

type BreakCopyRow = {
  source_shift_id: number;
  start_time: string;
  duration_minutes: number;
  cover_member_id: number | null;
};

export function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateParts(dateYYYYMMDD: string) {
  const [year, month, date] = dateYYYYMMDD.split('-').map(Number);
  return { year, month, date };
}

export function addDays(dateYYYYMMDD: string, offset: number): string {
  if (!isISODate(dateYYYYMMDD)) throw new Error(`Invalid date: ${dateYYYYMMDD}`);
  const { year, month, date } = parseDateParts(dateYYYYMMDD);
  const dt = new Date(Date.UTC(year, month - 1, date + offset));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function startOfWeek(dateYYYYMMDD: string): string {
  if (!isISODate(dateYYYYMMDD)) throw new Error(`Invalid date: ${dateYYYYMMDD}`);
  const dt = new Date(`${dateYYYYMMDD}T12:00:00${BRISBANE_OFFSET}`);
  const day = dt.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(dateYYYYMMDD, offset);
}

export function weekDatesFor(dateYYYYMMDD: string): string[] {
  const weekStart = startOfWeek(dateYYYYMMDD);
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function formatShortDateLabel(dateYYYYMMDD: string): string {
  if (!isISODate(dateYYYYMMDD)) return dateYYYYMMDD;
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Brisbane'
  }).format(new Date(`${dateYYYYMMDD}T12:00:00${BRISBANE_OFFSET}`));
}

export function formatLongDateLabel(dateYYYYMMDD: string): string {
  if (!isISODate(dateYYYYMMDD)) return dateYYYYMMDD;
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Brisbane'
  }).format(new Date(`${dateYYYYMMDD}T12:00:00${BRISBANE_OFFSET}`));
}

async function ensureScheduleId(DB: D1Database, date: string): Promise<number> {
  await DB.prepare('INSERT OR IGNORE INTO schedules (date) VALUES (?)').bind(date).run();
  const row = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as { id: number } | null;
  if (!row?.id) throw new Error(`Unable to load schedule for ${date}`);
  return row.id;
}

export async function copyScheduleDay(DB: D1Database, sourceDate: string, targetDate: string): Promise<{ shiftCount: number; breakCount: number; }> {
  if (!isISODate(sourceDate) || !isISODate(targetDate)) throw new Error('Invalid date');
  if (sourceDate === targetDate) throw new Error('Source and target day must be different');

  const sourceScheduleId = await ensureScheduleId(DB, sourceDate);
  const targetScheduleId = await ensureScheduleId(DB, targetDate);

  const sourceShifts = (
    await DB.prepare(
      `SELECT id, member_id, home_area_key, status_key, start_time, end_time, shift_minutes
             , shift_role
       FROM shifts
       WHERE schedule_id=?
       ORDER BY id ASC`
    )
      .bind(sourceScheduleId)
      .all()
  ).results as ShiftCopyRow[];

  const sourceBreaks = (
    await DB.prepare(
      `SELECT b.shift_id AS source_shift_id, b.start_time, b.duration_minutes, b.cover_member_id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?
       ORDER BY b.id ASC`
    )
      .bind(sourceScheduleId)
      .all()
  ).results as BreakCopyRow[];

  await DB.prepare('DELETE FROM shifts WHERE schedule_id=?').bind(targetScheduleId).run();

  const targetShiftIdBySourceShiftId = new Map<number, number>();
  for (const shift of sourceShifts) {
    const insertResult = await DB.prepare(
      `INSERT INTO shifts (schedule_id, member_id, home_area_key, status_key, shift_role, start_time, end_time, shift_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        targetScheduleId,
        shift.member_id,
        shift.home_area_key,
        shift.status_key,
        shift.shift_role ?? 'normal',
        shift.start_time,
        shift.end_time,
        shift.shift_minutes
      )
      .run();
    const insertedId = Number((insertResult as any)?.meta?.last_row_id ?? 0);
    if (insertedId > 0) {
      targetShiftIdBySourceShiftId.set(shift.id, insertedId);
      continue;
    }

    const inserted = (await DB.prepare(
      `SELECT id
       FROM shifts
       WHERE schedule_id=? AND member_id=? AND home_area_key=? AND status_key=? AND shift_role=? AND start_time=?
         AND ((end_time IS NULL AND ? IS NULL) OR end_time=?)
       ORDER BY id DESC
       LIMIT 1`
    )
      .bind(
        targetScheduleId,
        shift.member_id,
        shift.home_area_key,
        shift.status_key,
        shift.shift_role ?? 'normal',
        shift.start_time,
        shift.end_time,
        shift.end_time
      )
      .first()) as { id: number } | null;
    if (inserted?.id) targetShiftIdBySourceShiftId.set(shift.id, inserted.id);
  }

  let copiedBreaks = 0;
  for (const item of sourceBreaks) {
    const targetShiftId = targetShiftIdBySourceShiftId.get(item.source_shift_id);
    if (!targetShiftId) continue;
    await DB.prepare(
      'INSERT INTO breaks (shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?)'
    )
      .bind(targetShiftId, item.start_time, item.duration_minutes, item.cover_member_id)
      .run();
    copiedBreaks += 1;
  }

  await recomputeWorkBlocksForSchedule(DB, targetScheduleId);

  return { shiftCount: sourceShifts.length, breakCount: copiedBreaks };
}

export async function copyScheduleWeek(
  DB: D1Database,
  sourceWeekDate: string,
  targetWeekDate: string
): Promise<{ dayCount: number; shiftCount: number; breakCount: number; sourceWeekStart: string; targetWeekStart: string; }> {
  if (!isISODate(sourceWeekDate) || !isISODate(targetWeekDate)) throw new Error('Invalid date');

  const sourceWeekStart = startOfWeek(sourceWeekDate);
  const targetWeekStart = startOfWeek(targetWeekDate);
  if (sourceWeekStart === targetWeekStart) throw new Error('Source and target week must be different');

  let shiftCount = 0;
  let breakCount = 0;
  for (let index = 0; index < 7; index += 1) {
    const dayResult = await copyScheduleDay(DB, addDays(sourceWeekStart, index), addDays(targetWeekStart, index));
    shiftCount += dayResult.shiftCount;
    breakCount += dayResult.breakCount;
  }

  return {
    dayCount: 7,
    shiftCount,
    breakCount,
    sourceWeekStart,
    targetWeekStart
  };
}
