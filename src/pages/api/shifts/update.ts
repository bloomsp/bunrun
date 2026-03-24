import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { parseHHMM } from '../../../lib/time';
import { findOverlappingShift, shiftRange } from '../../../lib/shifts';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const shiftId = Number(form.get('shiftId'));
  const homeAreaKey = (form.get('homeAreaKey') || '').toString();
  const statusKey = (form.get('statusKey') || '').toString();
  const startTime = (form.get('startTime') || '').toString();
  const endTime = (form.get('endTime') || '').toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid date' });
  if (!Number.isFinite(shiftId) || shiftId <= 0) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid shift' });

  const startMin = parseHHMM(startTime);
  const endMin = parseHHMM(endTime);
  if (startMin == null || endMin == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid time' });
  if (endMin <= startMin) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'End time must be after start time (same day).' });

  const shiftMinutes = endMin - startMin;
  if (shiftMinutes > 10 * 60) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift exceeds 10 hours max.' });

  const DB = await getDB();

  const current = (await DB.prepare('SELECT schedule_id, member_id, start_time, end_time FROM shifts WHERE id=?').bind(shiftId).first()) as any;
  if (!current) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift not found' });

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
    'UPDATE shifts SET home_area_key=?, status_key=?, start_time=?, end_time=?, shift_minutes=? WHERE id=?'
  )
    .bind(homeAreaKey, statusKey, startTime, endTime, shiftMinutes, shiftId)
    .run();

  if (statusKey === 'sick') {
    // Delete breaks for this shift (requirement A)
    await DB.prepare('DELETE FROM breaks WHERE shift_id=?').bind(shiftId).run();

    // Clear any cover assignments that overlap the now-sick shift window.
    const sickRange = shiftRange({ start_time: startTime, end_time: endTime });
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

      for (const assignment of coverAssignments) {
        const start = parseHHMM(assignment.start_time);
        if (start == null) continue;
        const end = start + assignment.duration_minutes;
        if (start < sickRange.end && sickRange.start < end) {
          await DB.prepare('UPDATE breaks SET cover_member_id=NULL WHERE id=?').bind(assignment.id).run();
        }
      }
    }
  }

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
    notice: statusKey === 'sick' ? 'Shift updated (Sick applied)' : 'Shift updated'
  });
};
