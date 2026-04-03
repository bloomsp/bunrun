import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import {
  assignBestCovers,
  buildPlannerContext,
  isCoverAssignmentValid,
  type PlannerBreak,
  type PlannerShift
} from '../../../lib/break-planner';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });

  const DB = await getDB();
  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  if (!sched) return redirectWithMessage(returnTo, { error: 'Schedule not found' });
  const scheduleId = sched.id as number;

  const shifts = (await DB.prepare(
    'SELECT id, work_block_id, member_id, home_area_key, status_key, shift_role, start_time, end_time FROM shifts WHERE schedule_id=?'
  )
    .bind(scheduleId)
    .all()).results as PlannerShift[];

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
    shifts,
    members,
    perms,
    minByArea,
    preferredRankByShiftId
  });

  const breaks = (await DB.prepare(
    `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
            s.member_id AS off_member_id, s.home_area_key AS off_area_key
     FROM breaks b
     JOIN shifts s ON s.id=b.shift_id
     WHERE s.schedule_id=?`
  )
    .bind(scheduleId)
    .all()).results as PlannerBreak[];

  let fixed = 0;
  const lockedBreaks: PlannerBreak[] = [];
  const pendingBreaks: PlannerBreak[] = [];

  for (const row of breaks) {
    const offShift = shifts.find((shift) => shift.id === row.shift_id);
    if (!offShift || offShift.status_key !== 'working') continue;
    if (isCoverAssignmentValid(planner, breaks, row, row.cover_member_id)) {
      lockedBreaks.push(row);
    } else {
      pendingBreaks.push({ ...row, cover_member_id: null });
    }
  }

  const assignments = assignBestCovers(planner, lockedBreaks, pendingBreaks);
  let stillMissing = 0;

  for (const row of pendingBreaks) {
    const nextCoverId = assignments.get(row.id) ?? null;
    if (!isCoverAssignmentValid(planner, [...lockedBreaks, ...pendingBreaks], row, nextCoverId)) {
      stillMissing += 1;
    } else if (row.cover_member_id !== nextCoverId) {
      fixed += 1;
    }

    await DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?').bind(nextCoverId, row.id).run();
  }

  const msg = stillMissing > 0
    ? `Auto-fix complete: ${fixed} cover(s) assigned, ${stillMissing} still missing.`
    : `Auto-fix complete: ${fixed} cover(s) assigned.`;

  return redirectWithMessage(returnTo, { notice: msg });
};
