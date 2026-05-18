import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { parseHHMM } from '../../../lib/time';
import { findOverlappingShift, shiftRange } from '../../../lib/shifts';
import { assertMemberCanWorkArea } from '../../../lib/area-permissions';
import { clearMemberBreakPlanForSchedule, recomputeWorkBlocksForSchedule } from '../../../lib/work-blocks';
import { loadAreaBreakCoverageWindow, syncBreakAssignmentsForSchedule } from '../../../lib/breaks-role';
import { getPositiveInt, getString, getUniquePositiveInts, isISODate } from '../../../lib/http';
import { isBreaksRole, normalizeShiftRole } from '../../../lib/shift-role';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const shiftId = getPositiveInt(form, 'shiftId');
  const homeAreaKey = getString(form, 'homeAreaKey');
  const statusKey = getString(form, 'statusKey');
  const shiftRole = normalizeShiftRole((form.get('shiftRole') || 'normal').toString());
  const startTime = (form.get('startTime') || '').toString();
  const endTime = (form.get('endTime') || '').toString();
  const preferredCovererIds = getUniquePositiveInts(form, 'preferredCovererIds', 4);

  if (!isISODate(date)) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid date' });
  if (shiftId == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid shift' });

  const DB = await getDB();

  const current = (await DB.prepare('SELECT schedule_id, member_id, start_time, end_time, work_block_id FROM shifts WHERE id=?').bind(shiftId).first()) as any;
  if (!current) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift not found' });
  const permissionError = await assertMemberCanWorkArea(DB, current.member_id, homeAreaKey);
  if (permissionError) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: permissionError });
  }
  if (preferredCovererIds.some((memberId) => memberId === current.member_id)) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'A member cannot be their own preferred coverer' });
  }

  let resolvedStartTime = startTime;
  let resolvedEndTime = endTime;
  let startMin = parseHHMM(resolvedStartTime);
  let endMin = parseHHMM(resolvedEndTime);
  let shiftMinutes = 0;

  if (isBreaksRole(shiftRole)) {
    const coverageWindow = await loadAreaBreakCoverageWindow(DB, current.schedule_id, homeAreaKey);
    if (!coverageWindow) {
      return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
        error: 'No scheduled breaks were found in that area. Add the breaks first, then assign a Breaks role.'
      });
    }
    resolvedStartTime = coverageWindow.startTime;
    resolvedEndTime = coverageWindow.endTime;
    startMin = parseHHMM(resolvedStartTime);
    endMin = parseHHMM(resolvedEndTime);
    shiftMinutes = coverageWindow.shiftMinutes;
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

  const uniquePreferredCovererIds = preferredCovererIds;

  const siblingShifts = (
    await DB.prepare(
      'SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?'
    )
      .bind(current.schedule_id, current.member_id)
      .all()
  ).results as Array<{
    id: number;
    member_id: number;
    home_area_key: string;
    status_key: string;
    start_time: string;
    end_time: string | null;
  }>;

  const overlap = findOverlappingShift(siblingShifts, { start: startMin, end: endMin }, { excludeShiftId: shiftId });
  if (overlap) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
      error: `Shift overlaps another shift for this member (${overlap.start_time}-${overlap.end_time ?? '—'}).`
    });
  }

  await DB.prepare(
    'UPDATE shifts SET home_area_key=?, status_key=?, shift_role=?, start_time=?, end_time=?, shift_minutes=? WHERE id=?'
  )
    .bind(homeAreaKey, statusKey, shiftRole, resolvedStartTime, resolvedEndTime, shiftMinutes, shiftId)
    .run();

  await recomputeWorkBlocksForSchedule(DB, current.schedule_id);
  await clearMemberBreakPlanForSchedule(DB, current.schedule_id, current.member_id);
  await syncBreakAssignmentsForSchedule(DB, current.schedule_id, isBreaksRole(shiftRole) ? { prioritizeAreaKey: homeAreaKey } : undefined);

  const priorityStatements = [DB.prepare('DELETE FROM shift_cover_priorities WHERE shift_id=?').bind(shiftId)];
  for (const [index, memberId] of uniquePreferredCovererIds.entries()) {
    priorityStatements.push(
      DB.prepare('INSERT INTO shift_cover_priorities (shift_id, member_id, priority) VALUES (?, ?, ?)')
        .bind(shiftId, memberId, index + 1)
    );
  }
  await DB.batch(priorityStatements);

  if (statusKey === 'sick') {
    // Clear any cover assignments that overlap the now-sick shift window.
    const sickRange = shiftRange({ start_time: resolvedStartTime, end_time: resolvedEndTime });
    if (sickRange) {
      const coverAssignments = (
        await DB.prepare(
          `SELECT b.id, b.start_time, b.duration_minutes
           FROM breaks b
           JOIN shifts s ON s.id = b.shift_id
           WHERE s.schedule_id=? AND b.cover_member_id=?`
        )
          .bind(current.schedule_id, current.member_id)
          .all()
      ).results as Array<{ id: number; start_time: string; duration_minutes: number }>;

      const clearingStatements = [];
      for (const assignment of coverAssignments) {
        const start = parseHHMM(assignment.start_time);
        if (start == null) continue;
        const end = start + Number(assignment.duration_minutes);
        if (start < sickRange.end && sickRange.start < end) {
          clearingStatements.push(DB.prepare('UPDATE breaks SET cover_member_id=NULL WHERE id=?').bind(assignment.id));
        }
      }
      if (clearingStatements.length > 0) {
        await DB.batch(clearingStatements);
      }
    }
  }

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
    notice: isBreaksRole(shiftRole)
      ? 'Breaks role updated and area break cover refreshed.'
      : statusKey === 'sick'
        ? 'Shift updated (Sick applied). Break plan cleared for that member.'
        : 'Shift updated. Break plan cleared for that member.'
  });
};
