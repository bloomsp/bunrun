import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { candidateOffsets, computeShiftMinutes, generateBreakTemplate, proposeBreakTimes } from '../../../lib/autogen';
import { assignBestCovers, buildPlannerContext, type PlannerBreak } from '../../../lib/break-planner';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const shiftId = Number(form.get('shiftId'));
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (!Number.isFinite(shiftId) || shiftId <= 0) return redirectWithMessage(returnTo, { error: 'Invalid shift' });

  const DB = await getDB();

  const shift = (await DB.prepare(
    `SELECT s.id, s.schedule_id, s.member_id, s.home_area_key, s.status_key, s.start_time, s.end_time, s.shift_minutes,
            m.break_preference
     FROM shifts s
     JOIN members m ON m.id = s.member_id
     WHERE s.id=?`
  )
    .bind(shiftId)
    .first()) as any;

  if (!shift) return redirectWithMessage(returnTo, { error: 'Shift not found' });
  if (shift.status_key !== 'working') {
    return redirectWithMessage(returnTo, { error: 'Cannot auto-generate breaks for non-working status' });
  }

  const shifts = (await DB.prepare(
    `SELECT id, member_id, home_area_key, status_key, start_time, end_time
     FROM shifts WHERE schedule_id=?`
  )
    .bind(shift.schedule_id)
    .all()).results as any[];

  const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as any[];
  const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as any[];
  const areas = (await DB.prepare('SELECT key, label, min_staff FROM areas').all()).results as any[];
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));
  const preferredCovererRows = (
    await DB.prepare('SELECT shift_id, member_id, priority FROM shift_cover_priorities WHERE shift_id=? ORDER BY priority ASC')
      .bind(shift.id)
      .all()
  ).results as Array<{ shift_id: number; member_id: number; priority: number }>;
  const preferredRankByShiftId = new Map<number, Map<number, number>>();
  preferredRankByShiftId.set(shift.id, new Map(preferredCovererRows.map((row, index) => [row.member_id, index])));

  const planner = buildPlannerContext({
    shifts,
    members,
    perms,
    minByArea,
    preferredRankByShiftId
  });

  const existingBreaks = (await DB.prepare(
    `SELECT b.id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
            s.member_id AS off_member_id, s.home_area_key AS off_area_key
     FROM breaks b
     JOIN shifts s ON s.id=b.shift_id
     WHERE s.schedule_id=?`
  )
    .bind(shift.schedule_id)
    .all()).results as PlannerBreak[];

  const areaPeers = shifts
    .filter((s: any) => s.status_key === 'working' && s.home_area_key === shift.home_area_key)
    .sort((a: any, b: any) =>
      a.start_time.localeCompare(b.start_time) ||
      (a.end_time ?? '').localeCompare(b.end_time ?? '') ||
      a.member_id - b.member_id
    );
  const shiftIndexInArea = Math.max(0, areaPeers.findIndex((s: any) => s.id === shift.id));
  const staggerOffset = (shiftIndexInArea % 4) * 15;
  const shiftMinutes = computeShiftMinutes(shift);
  const durations = generateBreakTemplate(shiftMinutes, shift.break_preference);
  const areaBreaks = existingBreaks
    .filter((row) => row.off_area_key === shift.home_area_key)
    .map((row) => ({ start_time: row.start_time, duration_minutes: Number(row.duration_minutes) }));

  let bestPendingBreaks: PlannerBreak[] = [];
  let bestAssignments = new Map<number, number | null>();
  let bestMissingCount = Number.POSITIVE_INFINITY;

  for (const offset of candidateOffsets(staggerOffset)) {
    const proposed = proposeBreakTimes(shift, durations, {
      offsetMinutes: offset,
      existingBreaks: areaBreaks
    });

    const pendingBreaks: PlannerBreak[] = proposed.map((row, index) => ({
      id: -1 - index,
      shift_id: shift.id,
      start_time: row.start_time,
      duration_minutes: row.duration_minutes,
      cover_member_id: null,
      off_member_id: shift.member_id,
      off_area_key: shift.home_area_key
    }));

    const assignments = assignBestCovers(planner, existingBreaks, pendingBreaks);
    const missingCount = pendingBreaks.reduce((count, row) => count + (assignments.get(row.id) == null ? 1 : 0), 0);

    if (missingCount < bestMissingCount) {
      bestPendingBreaks = pendingBreaks;
      bestAssignments = assignments;
      bestMissingCount = missingCount;
      if (missingCount === 0) break;
    }
  }

  const statements = [DB.prepare('DELETE FROM breaks WHERE shift_id=?').bind(shiftId)];

  for (const row of bestPendingBreaks) {
    const coverMemberId = bestAssignments.get(row.id) ?? null;
    statements.push(
      DB.prepare('INSERT INTO breaks (shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?)')
        .bind(shiftId, row.start_time, row.duration_minutes, coverMemberId)
    );
  }

  await DB.batch(statements);

  if (bestMissingCount > 0) {
    return redirectWithMessage(returnTo, { notice: 'Breaks generated (some missing cover)' });
  }

  return redirectWithMessage(returnTo, { notice: 'Breaks generated' });
};
