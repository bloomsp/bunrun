import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getEnv } from '../../../lib/db';

export const POST: APIRoute = async ({ request, locals }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const areas = form.getAll('areas').map((v) => v.toString());

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return new Response('Invalid memberId', { status: 400 });
  }

  const { DB } = getEnv(locals);

  // Force restricted mode.
  await DB.prepare('UPDATE members SET all_areas=0 WHERE id=?').bind(memberId).run();

  // Validate provided keys against areas table
  const known = new Set(
    (await DB.prepare('SELECT key FROM areas').all()).results.map((r: any) => r.key as string)
  );
  for (const k of areas) {
    if (!known.has(k)) return new Response(`Unknown area: ${k}`, { status: 400 });
  }

  // Replace permissions
  await DB.prepare('DELETE FROM member_area_permissions WHERE member_id=?').bind(memberId).run();

  for (const k of areas) {
    await DB.prepare('INSERT OR IGNORE INTO member_area_permissions (member_id, area_key) VALUES (?, ?)')
      .bind(memberId, k)
      .run();
  }

  return Response.redirect('/admin/members', 302);
};
