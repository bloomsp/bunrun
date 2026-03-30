import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { computeShiftMinutes, generateBreakTemplate, proposeBreakTimes } from '../../../lib/autogen';
import { assignBestCovers, buildPlannerContext, type PlannerBreak } from '../../../lib/break-planner';

type ShiftRow = {
  id: number;
  schedule_id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
  break_preference?: string;
};

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const mode = (form.get('mode') || 'missing').toString(); // missing|overwrite
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (mode !== 'missing' && mode !== 'overwrite') return redirectWithMessage(returnTo, { error: 'Invalid mode' });

  const DB = await getDB();

  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  if (!sched) return redirectWithMessage(returnTo, { error: 'Schedule not found' });

  const scheduleId = sched.id as number;

  const shifts = (await DB.prepare(
    `SELECT s.id, s.schedule_id, s.member_id, s.home_area_key, s.status_key, s.start_time, s.end_time, s.shift_minutes,
            m.break_preference
     FROM shifts s
     JOIN members m ON m.id = s.member_id
     WHERE schedule_id=? AND status_key <> 'sick'`
  )
    .bind(scheduleId)
    .all()).results as ShiftRow[];

  if (mode === 'overwrite') {
    await DB.prepare(
      `DELETE FROM breaks WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_id=? AND status_key <> 'sick')`
    )
      .bind(scheduleId)
      .run();
  }

  const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as any[];
  const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as any[];
  const areas = (await DB.prepare('SELECT key, min_staff FROM areas').all()).results as any[];
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));
  const preferredCovererRows = (
    await DB.prepare('SELECT shift_id, member_id, priority FROM shift_cover_priorities ORDER BY shift_id ASC, priority ASC').all()
  ).results as Array<{ shift_id: number; member_id: number; priority: number }>;
  const preferredRankByShiftId = new Map<number, Map<number, number>>();
  for (const row of preferredCovererRows) {
    const ranks = preferredRankByShiftId.get(row.shift_id) ?? new Map<number, number>();
    ranks.set(row.member_id, ranks.size);
    preferredRankByShiftId.set(row.shift_id, ranks);
  }

  const planner = buildPlannerContext({
    shifts: shifts.map((shift) => ({
      id: shift.id,
      member_id: shift.member_id,
      home_area_key: shift.home_area_key,
      status_key: shift.status_key,
      start_time: shift.start_time,
      end_time: shift.end_time
    })),
    members,
    perms,
    minByArea,
    preferredRankByShiftId
  });

  let plannedBreaks: PlannerBreak[] = mode === 'overwrite'
    ? []
    : ((await DB.prepare(
      `SELECT b.id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id AS off_member_id, s.home_area_key AS off_area_key
       FROM breaks b
       JOIN shifts s ON s.id=b.shift_id
       WHERE s.schedule_id=?`
    )
      .bind(scheduleId)
      .all()).results as PlannerBreak[]);

  let generated = 0;
  const workingShiftsByArea = new Map<string, ShiftRow[]>();
  for (const shift of shifts) {
    if (shift.status_key !== 'working') continue;
    const rows = workingShiftsByArea.get(shift.home_area_key) ?? [];
    rows.push(shift);
    workingShiftsByArea.set(shift.home_area_key, rows);
  }
  for (const rows of workingShiftsByArea.values()) {
    rows.sort((a, b) =>
      a.start_time.localeCompare(b.start_time) ||
      (a.end_time ?? '').localeCompare(b.end_time ?? '') ||
      a.member_id - b.member_id
    );
  }

  for (const shift of shifts) {
    if (shift.status_key === 'sick') continue;

    if (mode === 'missing') {
      if (plannedBreaks.some((row) => row.shift_id === shift.id)) continue;
    }

    const shiftMinutes = computeShiftMinutes(shift);
    const durations = generateBreakTemplate(shiftMinutes, (shift.break_preference as any) ?? '15+30');
    const areaPeers = workingShiftsByArea.get(shift.home_area_key) ?? [];
    const shiftIndexInArea = Math.max(0, areaPeers.findIndex((row) => row.id === shift.id));
    const staggerOffset = (shiftIndexInArea % 4) * 15;
    const proposed = proposeBreakTimes(shift, durations, {
      offsetMinutes: staggerOffset,
      existingBreaks: plannedBreaks
        .filter((row) => row.off_area_key === shift.home_area_key)
        .map((row) => ({ start_time: row.start_time, duration_minutes: Number(row.duration_minutes) }))
    });

    const pendingBreaks: PlannerBreak[] = proposed.map((row, index) => ({
      id: -(shift.id * 10 + index + 1),
      shift_id: shift.id,
      start_time: row.start_time,
      duration_minutes: row.duration_minutes,
      cover_member_id: null,
      off_member_id: shift.member_id,
      off_area_key: shift.home_area_key
    }));

    const assignments = assignBestCovers(planner, plannedBreaks, pendingBreaks);
    for (const row of pendingBreaks) {
      const coverMemberId = assignments.get(row.id) ?? null;
      await DB.prepare('INSERT INTO breaks (shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?)')
        .bind(shift.id, row.start_time, row.duration_minutes, coverMemberId)
        .run();
      plannedBreaks.push({ ...row, cover_member_id: coverMemberId });
    }

    generated++;
  }

  const missingCount = plannedBreaks.filter((row) => {
    const offShift = planner.shifts.find((shift) => shift.id === row.shift_id);
    return offShift?.status_key === 'working' && row.cover_member_id == null;
  }).length;

  const tail = missingCount > 0 ? ' (some missing cover)' : '';
  const label = mode === 'overwrite' ? 'Breaks generated (overwrite)' : 'Breaks generated (missing only)';

  return redirectWithMessage(returnTo, { notice: `${label}${tail}` });
};
