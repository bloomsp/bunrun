import { buildPlannerContext, isAreaCoveredWithoutAssignedCover, type PlannerBreak } from './break-planner';
import { addDays, ensureScheduleId, startOfWeek, weekDatesFor } from './schedule';
import { parseHHMM } from './time';

export const REPORTS = [
  { key: 'runsheet', label: 'Runsheet' },
  { key: 'shifts-by-area', label: 'Shifts by Area' },
  { key: 'shifts-by-member', label: 'Shifts by Member' },
  { key: 'breaks-by-area', label: 'Breaks by Area' },
  { key: 'breaks-chronological', label: 'Breaks by Time' },
  { key: 'breaks-by-member', label: 'Breaks by Member' },
  { key: 'breaks-taken', label: 'Breaks Taken' }
] as const;

export type ReportKey = typeof REPORTS[number]['key'];
export type Area = { key: string; label: string; min_staff?: number };
export type ShiftRow = {
  id: number;
  member_id: number;
  name: string;
  home_area_key: string;
  status_key: string;
  shift_role: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
};
export type BreakRow = {
  id: number;
  work_block_id: number | null;
  shift_id: number;
  start_time: string;
  actual_start_time: string | null;
  duration_minutes: number;
  cover_member_id: number | null;
  off_member_name: string;
  off_area_key: string;
  cover_member_name: string | null;
  area_covered?: boolean;
};

export type BreakTakenRow = BreakRow & {
  variance_minutes: number | null;
  timing_label: string;
};

export type BreakTakenSummary = {
  totalBreaks: number;
  recordedBreaks: number;
  missingBreaks: number;
  onTimeBreaks: number;
  earlyBreaks: number;
  lateBreaks: number;
  averageVarianceAbsMinutes: number | null;
};

export async function loadViewSchedulePageData(DB: D1Database, date: string) {
  const weekStart = startOfWeek(date);
  const weekDates = weekDatesFor(date);
  const previousWeekDate = addDays(weekStart, -7);
  const nextWeekDate = addDays(weekStart, 7);
  const weekEnd = weekDates[6] ?? date;

  const scheduleId = await ensureScheduleId(DB, date);

  const [weeklyCountsRows, areas, shifts, breaks] = await Promise.all([
    DB.prepare(
      `SELECT sc.date, COUNT(s.id) AS shift_count
       FROM schedules sc
       LEFT JOIN shifts s ON s.schedule_id = sc.id
       WHERE sc.date BETWEEN ? AND ?
       GROUP BY sc.date`
    ).bind(weekStart, weekEnd).all().then((result) => result.results as Array<{ date: string; shift_count: number | string | null }>),
    DB.prepare('SELECT key, label, min_staff FROM areas ORDER BY label COLLATE NOCASE ASC').all().then((result) => result.results as Area[]),
    DB.prepare(
      `SELECT s.id, s.member_id, m.name, s.home_area_key, s.status_key, s.shift_role, s.start_time, s.end_time, s.shift_minutes
       FROM shifts s
       JOIN members m ON m.id=s.member_id
       WHERE s.schedule_id=?
       ORDER BY s.home_area_key ASC, m.name COLLATE NOCASE ASC, s.start_time ASC`
    ).bind(scheduleId).all().then((result) => result.results as ShiftRow[]),
    DB.prepare(
      `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.actual_start_time, b.duration_minutes, b.cover_member_id,
              offm.name AS off_member_name, s.home_area_key AS off_area_key, coverm.name AS cover_member_name
       FROM breaks b
       JOIN shifts s ON s.id=b.shift_id
       JOIN members offm ON offm.id=s.member_id
       LEFT JOIN members coverm ON coverm.id=b.cover_member_id
       WHERE s.schedule_id=?
       ORDER BY b.start_time ASC, offm.name COLLATE NOCASE ASC`
    ).bind(scheduleId).all().then((result) => result.results as BreakRow[])
  ]);

  const weekCountsByDate = new Map(weeklyCountsRows.map((row) => [row.date, Number(row.shift_count ?? 0)]));
  const areaByKey = new Map(areas.map((area) => [area.key, area.label]));

  const groupedShifts = areas
    .map((area) => ({
      area,
      rows: shifts
        .filter((shift) => shift.home_area_key === area.key)
        .sort((a, b) => a.name.localeCompare(b.name) || a.start_time.localeCompare(b.start_time))
    }))
    .filter((group) => group.rows.length > 0);

  const memberSortedShifts = shifts
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.start_time.localeCompare(b.start_time) || a.home_area_key.localeCompare(b.home_area_key));

  const chronologicalBreaks = breaks
    .slice()
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.off_member_name.localeCompare(b.off_member_name));

  const memberSortedBreaks = breaks
    .slice()
    .sort((a, b) => a.off_member_name.localeCompare(b.off_member_name) || a.start_time.localeCompare(b.start_time));

  const breaksTakenRows: BreakTakenRow[] = breaks
    .slice()
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.off_member_name.localeCompare(b.off_member_name))
    .map((row) => {
      const scheduledMinutes = parseHHMM(row.start_time);
      const actualMinutes = row.actual_start_time ? parseHHMM(row.actual_start_time) : null;
      const variance = scheduledMinutes != null && actualMinutes != null ? actualMinutes - scheduledMinutes : null;
      let timingLabel = 'Not recorded';
      if (variance === 0) timingLabel = 'On time';
      else if (variance != null && variance < 0) timingLabel = `${Math.abs(variance)}m early`;
      else if (variance != null && variance > 0) timingLabel = `${variance}m late`;
      return {
        ...row,
        variance_minutes: variance,
        timing_label: timingLabel
      };
    });

  const recordedBreaks = breaksTakenRows.filter((row) => row.actual_start_time != null);
  const breakTakenSummary: BreakTakenSummary = {
    totalBreaks: breaksTakenRows.length,
    recordedBreaks: recordedBreaks.length,
    missingBreaks: breaksTakenRows.length - recordedBreaks.length,
    onTimeBreaks: recordedBreaks.filter((row) => row.variance_minutes === 0).length,
    earlyBreaks: recordedBreaks.filter((row) => (row.variance_minutes ?? 0) < 0).length,
    lateBreaks: recordedBreaks.filter((row) => (row.variance_minutes ?? 0) > 0).length,
    averageVarianceAbsMinutes: recordedBreaks.length > 0
      ? Math.round(recordedBreaks.reduce((sum, row) => sum + Math.abs(row.variance_minutes ?? 0), 0) / recordedBreaks.length)
      : null
  };

  const groupedBreaks = areas
    .map((area) => ({
      area,
      rows: breaks
        .filter((row) => row.off_area_key === area.key)
        .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.off_member_name.localeCompare(b.off_member_name))
    }))
    .filter((group) => group.rows.length > 0);

  const planner = buildPlannerContext({
    shifts: shifts.map((shift) => ({
      id: shift.id,
      member_id: shift.member_id,
      home_area_key: shift.home_area_key,
      status_key: shift.status_key,
      shift_role: shift.shift_role,
      start_time: shift.start_time,
      end_time: shift.end_time
    })),
    members: [],
    perms: [],
    minByArea: new Map(areas.map((area) => [area.key, Number(area.min_staff ?? 0)]))
  });
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const plannerBreaks: PlannerBreak[] = breaks.flatMap((row) => {
    const shift = shiftById.get(row.shift_id);
    if (!shift) return [];
    return [{
      id: row.id,
      work_block_id: row.work_block_id,
      shift_id: row.shift_id,
      start_time: row.start_time,
      duration_minutes: Number(row.duration_minutes),
      cover_member_id: row.cover_member_id,
      off_member_id: shift.member_id,
      off_shift_id: shift.id,
      off_area_key: row.off_area_key
    }];
  });
  const areaCoveredByBreakId = new Map(
    plannerBreaks.map((row) => [row.id, row.cover_member_id == null && isAreaCoveredWithoutAssignedCover(planner, plannerBreaks, row)])
  );

  return {
    weekStart,
    weekDates,
    previousWeekDate,
    nextWeekDate,
    weekCountsByDate,
    areas,
    areaByKey,
    shifts,
    breaks,
    groupedShifts,
    memberSortedShifts,
    chronologicalBreaks,
    memberSortedBreaks,
    breaksTakenRows,
    breakTakenSummary,
    groupedBreaks,
    areaCoveredByBreakId
  };
}
