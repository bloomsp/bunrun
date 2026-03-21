import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const active = (form.get('active') || '0').toString() === '1' ? 1 : 0;

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return new Response('Invalid memberId', { status: 400 });
  }

  const DB = await getDB();
  await DB.prepare('UPDATE members SET active=? WHERE id=?').bind(active, memberId).run();

  return Response.redirect('/admin/members', 302);
};

