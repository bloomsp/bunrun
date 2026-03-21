import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const allAreas = (form.get('allAreas') || '1').toString() === '1' ? 1 : 0;

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return new Response('Invalid memberId', { status: 400 });
  }

  const DB = await getDB();

  await DB.prepare('UPDATE members SET all_areas=? WHERE id=?').bind(allAreas, memberId).run();
  if (allAreas === 1) {
    // Clear explicit restrictions.
    await DB.prepare('DELETE FROM member_area_permissions WHERE member_id=?').bind(memberId).run();
  }

  return Response.redirect('/admin/members', 302);
};

