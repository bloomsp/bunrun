import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { parseHHMM } from '../../../lib/time';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const memberId = Number(form.get('memberId'));
  const homeAreaKey = (form.get('homeAreaKey') || '').toString();
  const statusKey = (form.get('statusKey') || '').toString();
  const startTime = (form.get('startTime') || '').toString();
  const endTime = (form.get('endTime') || '').toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });
  if (!Number.isFinite(memberId) || memberId <= 0) return new Response('Invalid member', { status: 400 });

  const startParsed = parseTimeInput(startTime, { defaultMeridiem: 'am' });
  const endParsed = parseTimeInput(endTime, { defaultMeridiem: 'pm' });
  if (!startParsed || !endParsed) return new Response('Invalid time', { status: 400 });
  if (endParsed.minutes <= startParsed.minutes) return new Response('End time must be after start time', { status: 400 });

  const shiftMinutes = endParsed.minutes - startParsed.minutes;
  if (shiftMinutes > 10 * 60) return new Response('Shift exceeds 10 hours max', { status: 400 });

  const DB = await getDB();

  // Ensure schedule exists
  await DB.prepare('INSERT OR IGNORE INTO schedules (date) VALUES (?)').bind(date).run();
  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  const scheduleId = sched.id as number;

  // Insert shift
  await DB.prepare(
    `INSERT INTO shifts (schedule_id, member_id, home_area_key, status_key, start_time, end_time, shift_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(scheduleId, memberId, homeAreaKey, statusKey, startParsed.hhmm, endParsed.hhmm, shiftMinutes)
    .run();

  return new Response(null, { status: 303, headers: { Location: `/admin/schedule/${date}` } });
};
