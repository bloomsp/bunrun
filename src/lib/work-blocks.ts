import { parseHHMM } from './time';

export type WorkBlock = {
  id: number;
  schedule_id: number;
  member_id: number;
  start_time: string;
  end_time: string;
  total_minutes: number;
};

export type WorkBlockShift = {
  id: number;
  schedule_id: number;
  member_id: number;
  status_key: string;
  home_area_key: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
  work_block_id?: number | null;
};

type PendingWorkBlock = {
  member_id: number;
  start_time: string;
  end_time: string;
  total_minutes: number;
  shiftIds: number[];
};

export function shiftContainsTime(shift: Pick<WorkBlockShift, 'start_time' | 'end_time'>, timeHHMM: string) {
  const start = parseHHMM(shift.start_time);
  const end = shift.end_time ? parseHHMM(shift.end_time) : null;
  const time = parseHHMM(timeHHMM);
  if (start == null || end == null || time == null) return false;
  return start <= time && time < end;
}

export function activeShiftAtTime(shifts: WorkBlockShift[], memberId: number, timeHHMM: string) {
  return shifts.find((shift) => shift.member_id === memberId && shift.status_key === 'working' && shiftContainsTime(shift, timeHHMM)) ?? null;
}

export function buildPendingWorkBlocks(shifts: WorkBlockShift[]): PendingWorkBlock[] {
  const working = shifts
    .filter((shift) => shift.status_key === 'working')
    .slice()
    .sort((a, b) =>
      a.member_id - b.member_id ||
      a.start_time.localeCompare(b.start_time) ||
      (a.end_time ?? '').localeCompare(b.end_time ?? '') ||
      a.id - b.id
    );

  const blocks: PendingWorkBlock[] = [];
  let current: PendingWorkBlock | null = null;

  for (const shift of working) {
    if (!shift.end_time) continue;
    if (
      !current ||
      current.member_id !== shift.member_id ||
      current.end_time !== shift.start_time
    ) {
      current = {
        member_id: shift.member_id,
        start_time: shift.start_time,
        end_time: shift.end_time,
        total_minutes: Number(shift.shift_minutes ?? 0),
        shiftIds: [shift.id]
      };
      blocks.push(current);
      continue;
    }

    current.end_time = shift.end_time;
    current.total_minutes += Number(shift.shift_minutes ?? 0);
    current.shiftIds.push(shift.id);
  }

  return blocks;
}

export async function recomputeWorkBlocksForSchedule(DB: D1Database, scheduleId: number) {
  const shifts = (
    await DB.prepare(
      `SELECT id, schedule_id, member_id, status_key, home_area_key, start_time, end_time, shift_minutes, work_block_id
       FROM shifts
       WHERE schedule_id=?
       ORDER BY member_id ASC, start_time ASC, id ASC`
    )
      .bind(scheduleId)
      .all()
  ).results as WorkBlockShift[];

  const breaks = (
    await DB.prepare(
      `SELECT b.id, b.shift_id, b.start_time
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
    )
      .bind(scheduleId)
      .all()
  ).results as Array<{ id: number; shift_id: number; start_time: string }>;

  await DB.prepare('UPDATE shifts SET work_block_id=NULL WHERE schedule_id=?').bind(scheduleId).run();
  await DB.prepare(
    `UPDATE breaks
     SET work_block_id=NULL
     WHERE id IN (
       SELECT b.id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?
     )`
  ).bind(scheduleId).run();
  await DB.prepare('DELETE FROM work_blocks WHERE schedule_id=?').bind(scheduleId).run();

  const pendingBlocks = buildPendingWorkBlocks(shifts);
  const shiftsById = new Map<number, WorkBlockShift>(shifts.map((shift) => [shift.id, shift]));

  for (const pending of pendingBlocks) {
    const insert = await DB.prepare(
      `INSERT INTO work_blocks (schedule_id, member_id, start_time, end_time, total_minutes)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(scheduleId, pending.member_id, pending.start_time, pending.end_time, pending.total_minutes)
      .run();
    const workBlockId = Number((insert as any)?.meta?.last_row_id ?? 0);
    if (!workBlockId) continue;

    for (const shiftId of pending.shiftIds) {
      await DB.prepare('UPDATE shifts SET work_block_id=? WHERE id=?').bind(workBlockId, shiftId).run();
      const shift = shiftsById.get(shiftId);
      if (shift) shift.work_block_id = workBlockId;
    }
  }

  for (const row of breaks) {
    const oldShift = shiftsById.get(row.shift_id);
    if (!oldShift) continue;
    const activeShift = activeShiftAtTime(shifts, oldShift.member_id, row.start_time) ?? oldShift;
    await DB.prepare('UPDATE breaks SET shift_id=?, work_block_id=? WHERE id=?')
      .bind(activeShift.id, activeShift.work_block_id ?? null, row.id)
      .run();
  }
}

export async function clearMemberBreakPlanForSchedule(DB: D1Database, scheduleId: number, memberId: number) {
  await DB.prepare(
    `DELETE FROM breaks
     WHERE id IN (
       SELECT b.id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND s.member_id=?
     )`
  ).bind(scheduleId, memberId).run();

  await DB.prepare(
    `UPDATE breaks
     SET cover_member_id=NULL
     WHERE id IN (
       SELECT b.id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND b.cover_member_id=?
     )`
  ).bind(scheduleId, memberId).run();
}
