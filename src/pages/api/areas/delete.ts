import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const key = (form.get('key') || '').toString().trim();

  if (!key) return redirectWithMessage('/admin/areas', { error: 'Invalid area key' });

  const DB = await getDB();

  const memberUsage = (await DB.prepare(
    `SELECT COUNT(DISTINCT member_id) AS count
     FROM (
       SELECT id AS member_id FROM members WHERE default_area_key = ?
       UNION
       SELECT member_id FROM member_area_permissions WHERE area_key = ?
     )`
  ).bind(key, key).first()) as { count?: number | string | null } | null;

  if (Number(memberUsage?.count ?? 0) > 0) {
    return redirectWithMessage('/admin/areas', { error: 'Area cannot be deleted while it still has members' });
  }

  const shiftUsage = (await DB.prepare('SELECT COUNT(*) AS count FROM shifts WHERE home_area_key=?').bind(key).first()) as
    | { count?: number | string | null }
    | null;

  if (Number(shiftUsage?.count ?? 0) > 0) {
    return redirectWithMessage('/admin/areas', { error: 'Area cannot be deleted while shifts still reference it' });
  }

  const deleted = await DB.prepare('DELETE FROM areas WHERE key=?').bind(key).run();
  if (Number(deleted.meta?.changes ?? 0) === 0) {
    return redirectWithMessage('/admin/areas', { error: 'Area not found' });
  }

  return redirectWithMessage('/admin/areas', { notice: 'Area deleted' });
};
