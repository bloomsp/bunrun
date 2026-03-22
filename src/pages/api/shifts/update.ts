import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });
  if (!Number.isFinite(shiftId) || shiftId <= 0) return new Response('Invalid shiftId', { status: 400 });

  const startMin = parseHHMM(startTime);
  const endMin = parseHHMM(endTime);
  if (startMin == null || endMin == null) return new Response('Invalid time', { status: 400 });
  if (endMin <= startMin) return new Response('End time must be after start time', { status: 400 });

  const shiftMinutes = endMin - startMin;
  if (shiftMinutes > 10 * 60) return new Response('Shift exceeds 10 hours max', { status: 400 });

  const DB = await getDB();

  // Load current shift for schedule/member context
  const current = (await DB.prepare('SELECT schedule_id, member_id FROM shifts WHERE id=?').bind(shiftId).first()) as any;
  if (!current) return new Response('Shift not found', { status: 404 });

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

  return new Response(null, { status: 303, headers: { Location: `/admin/schedule/${date}` } });
};
