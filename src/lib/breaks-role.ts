import { assignBestCovers, isCoverAssignmentValid, type PlannerBreak } from './break-planner';
import { loadPlannerScheduleData } from './planner-data';
import { parseHHMM } from './time';

export async function loadAreaBreakCoverageWindow(DB: D1Database, scheduleId: number, areaKey: string) {
  const rows = (
    await DB.prepare(
      `SELECT b.start_time, b.duration_minutes
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND s.home_area_key=?
       ORDER BY b.start_time ASC, b.id ASC`
    )
      .bind(scheduleId, areaKey)
      .all()
  ).results as Array<{ start_time: string; duration_minutes: number | string | null }>;

  let startMinutes: number | null = null;
  let endMinutes: number | null = null;

  for (const row of rows) {
    const start = parseHHMM(row.start_time);
    const duration = Number(row.duration_minutes ?? 0);
    if (start == null || duration <= 0) continue;
    const end = start + duration;
    startMinutes = startMinutes == null ? start : Math.min(startMinutes, start);
    endMinutes = endMinutes == null ? end : Math.max(endMinutes, end);
  }

  if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) return null;

  const toHHMM = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  return {
    startTime: toHHMM(startMinutes),
    endTime: toHHMM(endMinutes),
    shiftMinutes: endMinutes - startMinutes,
    breakCount: rows.length
  };
}

export async function syncBreakAssignmentsForSchedule(
  DB: D1Database,
  scheduleId: number,
  opts?: { prioritizeAreaKey?: string }
) {
  const { planner, shifts, breaks } = await loadPlannerScheduleData(DB, scheduleId);

  const lockedBreaks: PlannerBreak[] = [];
  const pendingBreaks: PlannerBreak[] = [];
  const originalCoverByBreakId = new Map<number, number | null>();

  for (const row of breaks) {
    const offShift = shifts.find((shift) => shift.id === row.shift_id);
    if (!offShift || offShift.status_key !== 'working') continue;

    const valid = isCoverAssignmentValid(planner, breaks, row, row.cover_member_id);
    const shouldReplan = opts?.prioritizeAreaKey
      ? row.off_area_key === opts.prioritizeAreaKey || !valid
      : !valid;

    if (shouldReplan) {
      originalCoverByBreakId.set(row.id, row.cover_member_id);
      pendingBreaks.push({ ...row, cover_member_id: null });
    } else {
      lockedBreaks.push(row);
    }
  }

  if (pendingBreaks.length === 0) {
    return { updated: 0, missing: 0 };
  }

  const assignments = assignBestCovers(planner, lockedBreaks, pendingBreaks);
  const appliedPendingBreaks = pendingBreaks.map((row) => ({
    ...row,
    cover_member_id: assignments.get(row.id) ?? null
  }));
  const updates = [];
  let updated = 0;
  let missing = 0;

  for (const row of appliedPendingBreaks) {
    const coverMemberId = row.cover_member_id ?? null;
    if (!isCoverAssignmentValid(planner, [...lockedBreaks, ...appliedPendingBreaks], row, coverMemberId)) {
      missing += 1;
    }
    if ((originalCoverByBreakId.get(row.id) ?? null) !== coverMemberId) {
      updated += 1;
    }
    updates.push(DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?').bind(coverMemberId, row.id));
  }

  if (updates.length > 0) {
    await DB.batch(updates);
  }

  return { updated, missing };
}
