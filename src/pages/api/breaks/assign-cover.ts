import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import {
  buildPlannerContext,
  isCoverAssignmentValid,
  listEligibleCoverOptions,
  type PlannerBreak,
  type PlannerShift
} from '../../../lib/break-planner';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const breakId = Number(form.get('breakId'));
  const coverMemberIdRaw = (form.get('coverMemberId') || '').toString();
  const coverMemberId = coverMemberIdRaw === '' ? null : Number(coverMemberIdRaw);
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (!Number.isFinite(breakId) || breakId <= 0) return redirectWithMessage(returnTo, { error: 'Invalid break' });
  if (coverMemberId !== null && (!Number.isFinite(coverMemberId) || coverMemberId <= 0)) {
    return redirectWithMessage(returnTo, { error: 'Invalid cover selection' });
  }

  const DB = await getDB();

  const target = (await DB.prepare(
    `SELECT b.id as break_id, b.start_time, b.duration_minutes,
            s.id AS off_shift_id, s.schedule_id, s.home_area_key, s.member_id AS off_member_id
     FROM breaks b
     JOIN shifts s ON s.id = b.shift_id
     WHERE b.id=?`
  )
    .bind(breakId)
    .first()) as any;

  if (!target) return redirectWithMessage(returnTo, { error: 'Break not found' });

  if (coverMemberId !== null) {
    const shifts = (await DB.prepare(
      'SELECT id, member_id, home_area_key, status_key, shift_role, start_time, end_time FROM shifts WHERE schedule_id=?'
    )
      .bind(target.schedule_id)
      .all()).results as PlannerShift[];
    const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as Array<{ id: number; all_areas: number }>;
    const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as Array<{ member_id: number; area_key: string }>;
    const areas = (await DB.prepare('SELECT key, min_staff FROM areas').all()).results as Array<{ key: string; min_staff: number }>;
    const preferredCovererRows = (
      await DB.prepare('SELECT shift_id, member_id, priority FROM shift_cover_priorities WHERE shift_id=? ORDER BY priority ASC')
        .bind(target.off_shift_id)
        .all()
    ).results as Array<{ shift_id: number; member_id: number; priority: number }>;
    const preferredRankByShiftId = new Map<number, Map<number, number>>();
    preferredRankByShiftId.set(target.off_shift_id, new Map(preferredCovererRows.map((row, index) => [row.member_id, index])));

    const planner = buildPlannerContext({
      shifts,
      members,
      perms,
      minByArea: new Map(areas.map((row) => [row.key, Number(row.min_staff ?? 0)])),
      preferredRankByShiftId
    });
    const breaks = (await DB.prepare(
      `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id AS off_member_id, s.home_area_key AS off_area_key
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
    )
      .bind(target.schedule_id)
      .all()).results as PlannerBreak[];

    const currentBreak = breaks.find((row) => row.id === breakId);
    if (!currentBreak) return redirectWithMessage(returnTo, { error: 'Break not found' });

    const validCandidateIds = new Set(
      listEligibleCoverOptions(planner, breaks, currentBreak)
        .map((row) => row.memberId)
        .filter((value): value is number => value != null)
    );

    if (!validCandidateIds.has(coverMemberId) || !isCoverAssignmentValid(planner, breaks, currentBreak, coverMemberId)) {
      return redirectWithMessage(returnTo, { error: 'Selected cover member is not available for that break' });
    }
  }

  await DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?')
    .bind(coverMemberId, breakId)
    .run();

  return redirectWithMessage(returnTo, { notice: 'Cover updated' });
};
