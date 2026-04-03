import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { parseHHMM } from '../../../lib/time';
import { findOverlappingShift } from '../../../lib/shifts';
import { assertMemberCanWorkArea } from '../../../lib/area-permissions';
import { clearMemberBreakPlanForSchedule, recomputeWorkBlocksForSchedule } from '../../../lib/work-blocks';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const memberId = Number(form.get('memberId'));
  const homeAreaKey = (form.get('homeAreaKey') || '').toString();
  const statusKey = (form.get('statusKey') || '').toString();
  const shiftRole = ((form.get('shiftRole') || 'normal').toString() === 'floater' ? 'floater' : 'normal');

  const startTimeRaw = (form.get('startTime') || '').toString();
  const endTimeRaw = (form.get('endTime') || '').toString();

  const startHH = (form.get('startHH') || '').toString();
  const startMM = (form.get('startMM') || '').toString();
  const endHH = (form.get('endHH') || '').toString();
  const endMM = (form.get('endMM') || '').toString();

  const startTime = startTimeRaw || `${startHH}:${startMM}`;
  const endTime = endTimeRaw || `${endHH}:${endMM}`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid date' });
  if (!Number.isFinite(memberId) || memberId <= 0) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid member' });

  const startMin = parseHHMM(startTime);
  const endMin = parseHHMM(endTime);
  if (startMin == null || endMin == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Invalid time' });
  if (endMin <= startMin) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'End time must be after start time (same day).' });

  const shiftMinutes = endMin - startMin;
  if (shiftMinutes > 10 * 60) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift exceeds 10 hours max.' });

  const DB = await getDB();
  const permissionError = await assertMemberCanWorkArea(DB, memberId, homeAreaKey);
  if (permissionError) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: permissionError });
  }

  await DB.prepare('INSERT OR IGNORE INTO schedules (date) VALUES (?)').bind(date).run();
  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  const scheduleId = sched.id as number;

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
    .bind(scheduleId, memberId, homeAreaKey, statusKey, shiftRole, startTime, endTime, shiftMinutes)
    .run();

  await recomputeWorkBlocksForSchedule(DB, scheduleId);
  await clearMemberBreakPlanForSchedule(DB, scheduleId, memberId);

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, { notice: 'Shift added. Break plan cleared for that member.' });
};
