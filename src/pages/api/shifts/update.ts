import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { parseHHMM } from '../../../lib/time';

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

  const current = (await DB.prepare('SELECT schedule_id, member_id FROM shifts WHERE id=?').bind(shiftId).first()) as any;
  if (!current) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: 'Shift not found' });

  await DB.prepare(
    'UPDATE shifts SET home_area_key=?, status_key=?, start_time=?, end_time=?, shift_minutes=? WHERE id=?'
  )
    .bind(homeAreaKey, statusKey, startTime, endTime, shiftMinutes, shiftId)
    .run();

  if (statusKey === 'sick') {
    // Delete breaks for this shift (requirement A)
    await DB.prepare('DELETE FROM breaks WHERE shift_id=?').bind(shiftId).run();

    // Clear any cover assignments where this member was covering others on the same schedule day
    await DB.prepare(
      `UPDATE breaks
       SET cover_member_id=NULL
       WHERE cover_member_id=?
         AND shift_id IN (SELECT id FROM shifts WHERE schedule_id=?)`
    )
      .bind(current.member_id, current.schedule_id)
      .run();
  }

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
    notice: statusKey === 'sick' ? 'Shift updated (Sick applied)' : 'Shift updated'
  });
};
