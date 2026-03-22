import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { toHHMM } from '../../../lib/time';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const shiftId = Number(form.get('shiftId'));
  const hh = Number(form.get('hh'));
  const mm = Number(form.get('mm'));
  const duration = Number(form.get('duration'));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid date' });
  if (!Number.isFinite(shiftId) || shiftId <= 0) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid shift' });
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid hour' });
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid minutes' });
  if (![15, 30, 45, 60].includes(duration)) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid duration' });

  const startTime = toHHMM(hh * 60 + mm);

  const DB = await getDB();
  await DB.prepare('INSERT INTO breaks (shift_id, start_time, duration_minutes) VALUES (?, ?, ?)')
    .bind(shiftId, startTime, duration)
    .run();

  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Break added' });
};
