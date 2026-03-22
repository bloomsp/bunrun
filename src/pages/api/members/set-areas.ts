import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const areas = form.getAll('areas').map((v) => v.toString());
  const returnTo = (form.get('returnTo') || '/admin/members').toString();

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return redirectWithMessage('/admin/members', { error: 'Invalid member' });
  }

  const DB = await getDB();

  // Force restricted mode.
  await DB.prepare('UPDATE members SET all_areas=0 WHERE id=?').bind(memberId).run();

  const known = new Set(
    (await DB.prepare('SELECT key FROM areas').all()).results.map((r: any) => r.key as string)
  );
  for (const k of areas) {
    if (!known.has(k)) return redirectWithMessage('/admin/members', { error: `Unknown area: ${k}` });
  }

  await DB.prepare('DELETE FROM member_area_permissions WHERE member_id=?').bind(memberId).run();

  for (const k of areas) {
    await DB.prepare('INSERT OR IGNORE INTO member_area_permissions (member_id, area_key) VALUES (?, ?)')
      .bind(memberId, k)
      .run();
  }

  return redirectWithMessage(returnTo, { notice: 'Areas updated' });
};
