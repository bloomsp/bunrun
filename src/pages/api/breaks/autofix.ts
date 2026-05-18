import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { getReturnTo, getString, isISODate } from '../../../lib/http';
import { ensureScheduleId } from '../../../lib/schedule';
import { syncBreakAssignmentsForSchedule } from '../../../lib/breaks-role';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);
  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });

  const DB = await getDB();
  const scheduleId = await ensureScheduleId(DB, date);

  const { updated: fixed, missing: stillMissing } = await syncBreakAssignmentsForSchedule(DB, scheduleId);

  const msg = stillMissing > 0
    ? `Auto-fix complete: ${fixed} cover(s) assigned, ${stillMissing} still missing.`
    : `Auto-fix complete: ${fixed} cover(s) assigned.`;

  return redirectWithMessage(returnTo, { notice: msg });
};
