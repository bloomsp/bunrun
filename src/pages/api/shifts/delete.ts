import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const shiftId = Number(form.get('shiftId'));
  const date = (form.get('date') || '').toString();

  if (!Number.isFinite(shiftId) || shiftId <= 0) return new Response('Invalid shiftId', { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });

  const DB = await getDB();
  await DB.prepare('DELETE FROM shifts WHERE id=?').bind(shiftId).run();

  return redirectWithMessage(`/admin/schedule/${date}#shifts`, { notice: 'Shift deleted' });
};
{ status: 303, headers: { Location: `/admin/schedule/${date}` } });
};
