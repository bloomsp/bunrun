import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { isCoverAssignmentValid, listEligibleCoverOptions } from '../../../lib/break-planner';
import { getOptionalPositiveInt, getPositiveInt, getReturnTo, getString, isISODate } from '../../../lib/http';
import { loadPlannerScheduleData } from '../../../lib/planner-data';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const breakId = getPositiveInt(form, 'breakId');
  const coverMemberId = getOptionalPositiveInt(form, 'coverMemberId');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);

  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (breakId == null) return redirectWithMessage(returnTo, { error: 'Invalid break' });
  if (coverMemberId === undefined) {
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
    const { planner, breaks } = await loadPlannerScheduleData(DB, target.schedule_id, {
      preferredCoverersFor: { shiftId: target.off_shift_id }
    });

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
