import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { assignBestCovers, isCoverAssignmentValid, type PlannerBreak } from '../../../lib/break-planner';
import { getReturnTo, getString, isISODate } from '../../../lib/http';
import { loadPlannerScheduleData } from '../../../lib/planner-data';
import { ensureScheduleId } from '../../../lib/schedule';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);
  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });

  const DB = await getDB();
  const scheduleId = await ensureScheduleId(DB, date);

  const { planner, shifts, breaks } = await loadPlannerScheduleData(DB, scheduleId);

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

  const updates = [];
  for (const row of pendingBreaks) {
    const nextCoverId = assignments.get(row.id) ?? null;
    if (!isCoverAssignmentValid(planner, [...lockedBreaks, ...pendingBreaks], row, nextCoverId)) {
      stillMissing += 1;
    } else if (row.cover_member_id !== nextCoverId) {
      fixed += 1;
    }

    updates.push(DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?').bind(nextCoverId, row.id));
  }

  if (updates.length > 0) {
    await DB.batch(updates);
  }

  const msg = stillMissing > 0
    ? `Auto-fix complete: ${fixed} cover(s) assigned, ${stillMissing} still missing.`
    : `Auto-fix complete: ${fixed} cover(s) assigned.`;

  return redirectWithMessage(returnTo, { notice: msg });
};
