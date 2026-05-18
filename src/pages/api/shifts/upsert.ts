import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { parseHHMM } from '../../../lib/time';
import { ensureScheduleId } from '../../../lib/schedule';
import { findOverlappingShift } from '../../../lib/shifts';
import { assertMemberCanWorkArea } from '../../../lib/area-permissions';
import { clearMemberBreakPlanForSchedule, recomputeWorkBlocksForSchedule } from '../../../lib/work-blocks';
import { loadAreaBreakCoverageWindow, syncBreakAssignmentsForSchedule } from '../../../lib/breaks-role';
import { getPositiveInt, getString, isISODate } from '../../../lib/http';
import { isBreaksRole, normalizeShiftRole } from '../../../lib/shift-role';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const memberId = getPositiveInt(form, 'memberId');
  const homeAreaKey = getString(form, 'homeAreaKey');
  const statusKey = getString(form, 'statusKey');
  const shiftRole = normalizeShiftRole((form.get('shiftRole') || 'normal').toString());

  const startTimeRaw = (form.get('startTime') || '').toString();
  const endTimeRaw = (form.get('endTime') || '').toString();

  const startHH = (form.get('startHH') || '').toString();
  const startMM = (form.get('startMM') || '').toString();
  const endHH = (form.get('endHH') || '').toString();
  const endMM = (form.get('endMM') || '').toString();

  const startTime = startTimeRaw || `${startHH}:${startMM}`;
  const endTime = endTimeRaw || `${endHH}:${endMM}`;

  if (!isISODate(date)) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid date' });
  if (memberId == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid member' });

  const DB = await getDB();
  const permissionError = await assertMemberCanWorkArea(DB, memberId, homeAreaKey);
  if (permissionError) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: permissionError });
  }

  const scheduleId = await ensureScheduleId(DB, date);

  let resolvedStartTime = startTime;
  let resolvedEndTime = endTime;
  let shiftMinutes = 0;
  let startMin = parseHHMM(resolvedStartTime);
  let endMin = parseHHMM(resolvedEndTime);

  if (isBreaksRole(shiftRole)) {
    const coverageWindow = await loadAreaBreakCoverageWindow(DB, scheduleId, homeAreaKey);
    if (!coverageWindow) {
      return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
        error: 'No scheduled breaks were found in that area. Add the breaks first, then assign a Breaks role.'
      });
    }
    resolvedStartTime = coverageWindow.startTime;
    resolvedEndTime = coverageWindow.endTime;
    shiftMinutes = coverageWindow.shiftMinutes;
    startMin = parseHHMM(resolvedStartTime);
    endMin = parseHHMM(resolvedEndTime);
  } else {
    startMin = parseHHMM(startTime);
    endMin = parseHHMM(endTime);
    if (startMin == null || endMin == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid time' });
    if (endMin <= startMin) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'End time must be after start time (same day).' });
    shiftMinutes = endMin - startMin;
    if (shiftMinutes > 10 * 60) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift exceeds 10 hours max.' });
  }

  if (startMin == null || endMin == null || endMin <= startMin) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid break coverage window for that area.' });
  }

  const existingShifts = (
    await DB.prepare(
      'SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?'
    )
      .bind(scheduleId, memberId)
      .all()
  ).results as Array<{
    id: number;
    member_id: number;
    home_area_key: string;
    status_key: string;
    start_time: string;
    end_time: string | null;
  }>;

  const overlap = findOverlappingShift(existingShifts, { start: startMin, end: endMin });
  if (overlap) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
      error: `Shift overlaps an existing shift for this member (${overlap.start_time}-${overlap.end_time ?? '—'}).`
    });
  }

  await DB.prepare(
    `INSERT INTO shifts (schedule_id, member_id, home_area_key, status_key, shift_role, start_time, end_time, shift_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(scheduleId, memberId, homeAreaKey, statusKey, shiftRole, resolvedStartTime, resolvedEndTime, shiftMinutes)
    .run();

  await recomputeWorkBlocksForSchedule(DB, scheduleId);
  await clearMemberBreakPlanForSchedule(DB, scheduleId, memberId);
  await syncBreakAssignmentsForSchedule(DB, scheduleId, isBreaksRole(shiftRole) ? { prioritizeAreaKey: homeAreaKey } : undefined);

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
    notice: isBreaksRole(shiftRole)
      ? 'Breaks role added and area break cover refreshed.'
      : 'Shift added. Break plan cleared for that member.'
  });
};
