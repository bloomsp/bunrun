import type { AreaLookup } from './lookups';

export type AreaKeyRow = { key: string };

export type WorkBlockMemberRow = {
  id: number;
  schedule_id?: number;
  member_id: number;
  start_time?: string;
  end_time?: string;
  total_minutes?: number;
  break_preference?: string;
};

export type ShiftWorkBlockRow = {
  id: number;
  schedule_id: number;
  member_id: number;
  status_key: string;
  home_area_key: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
  work_block_id?: number | null;
  shift_role?: string;
};

export async function loadAreaKeys(DB: D1Database): Promise<Set<string>> {
  const rows = (await DB.prepare('SELECT key FROM areas').all()).results as AreaKeyRow[];
  return new Set(rows.map((row) => row.key));
}

export async function loadWorkBlockById(DB: D1Database, workBlockId: number): Promise<WorkBlockMemberRow | null> {
  return (await DB.prepare(
    `SELECT wb.id, wb.schedule_id, wb.member_id, wb.start_time, wb.end_time, wb.total_minutes, m.break_preference
     FROM work_blocks wb
     JOIN members m ON m.id = wb.member_id
     WHERE wb.id=?`
  ).bind(workBlockId).first()) as WorkBlockMemberRow | null;
}

export async function loadShiftsForWorkBlock(DB: D1Database, workBlockId: number): Promise<ShiftWorkBlockRow[]> {
  return (
    await DB.prepare(
      `SELECT id, schedule_id, member_id, status_key, home_area_key, start_time, end_time, shift_minutes, work_block_id, shift_role
       FROM shifts
       WHERE work_block_id=?
       ORDER BY start_time ASC, id ASC`
    ).bind(workBlockId).all()
  ).results as ShiftWorkBlockRow[];
}

export async function loadScheduleIdByDate(DB: D1Database, date: string): Promise<number | null> {
  const row = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as { id: number } | null;
  return row?.id ?? null;
}

export async function loadAreasByKey(DB: D1Database): Promise<Map<string, AreaLookup>> {
  const rows = (await DB.prepare('SELECT key, label, min_staff FROM areas ORDER BY label COLLATE NOCASE ASC').all()).results as AreaLookup[];
  return new Map(rows.map((row) => [row.key, row]));
}
