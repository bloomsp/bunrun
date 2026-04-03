import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { toHHMM } from '../../../lib/time';
import { activeShiftAtTime } from '../../../lib/work-blocks';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const workBlockId = Number(form.get('workBlockId'));
  const hh = Number(form.get('hh'));
  const mm = Number(form.get('mm'));
  const duration = Number(form.get('duration'));
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (!Number.isFinite(workBlockId) || workBlockId <= 0) return redirectWithMessage(returnTo, { error: 'Invalid work block' });
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return redirectWithMessage(returnTo, { error: 'Invalid hour' });
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return redirectWithMessage(returnTo, { error: 'Invalid minutes' });
  if (![15, 30, 45, 60].includes(duration)) return redirectWithMessage(returnTo, { error: 'Invalid duration' });

  const startTime = toHHMM(hh * 60 + mm);
  const DB = await getDB();
  const block = (await DB.prepare('SELECT id, member_id FROM work_blocks WHERE id=?').bind(workBlockId).first()) as any;
  if (!block) return redirectWithMessage(returnTo, { error: 'Work block not found' });

  const shifts = (
    await DB.prepare(
      'SELECT id, schedule_id, member_id, status_key, home_area_key, start_time, end_time, shift_minutes, work_block_id FROM shifts WHERE work_block_id=? ORDER BY start_time ASC, id ASC'
    ).bind(workBlockId).all()
  ).results as any[];
  const activeShift = activeShiftAtTime(shifts, block.member_id, startTime);
  if (!activeShift) return redirectWithMessage(returnTo, { error: 'Break must fall within the continuous work block' });

  await DB.prepare('INSERT INTO breaks (work_block_id, shift_id, start_time, duration_minutes) VALUES (?, ?, ?, ?)')
    .bind(workBlockId, activeShift.id, startTime, duration)
    .run();

  return redirectWithMessage(returnTo, { notice: 'Break added' });
};
