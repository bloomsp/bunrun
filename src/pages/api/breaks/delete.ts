import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const breakId = Number(form.get('breakId'));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid date' });
  if (!Number.isFinite(breakId) || breakId <= 0) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid break' });

  const DB = await getDB();
  await DB.prepare('DELETE FROM breaks WHERE id=?').bind(breakId).run();

  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Break deleted' });
};
