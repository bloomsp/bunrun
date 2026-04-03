import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const fromKey = (form.get('fromKey') || '').toString().trim();
  const toKey = (form.get('toKey') || '').toString().trim();

  if (!fromKey || !toKey) return redirectWithMessage('/admin/areas', { error: 'Both source and destination areas are required' });
  if (fromKey === toKey) return redirectWithMessage('/admin/areas', { error: 'Choose two different areas to migrate' });

  const DB = await getDB();
  const knownRows = (await DB.prepare('SELECT key FROM areas WHERE key IN (?, ?)').bind(fromKey, toKey).all()).results as Array<{ key: string }>;
  const knownKeys = new Set(knownRows.map((row) => row.key));
  if (!knownKeys.has(fromKey) || !knownKeys.has(toKey)) {
    return redirectWithMessage('/admin/areas', { error: 'Unknown source or destination area' });
  }

  await DB.batch([
    DB.prepare('UPDATE members SET default_area_key=? WHERE default_area_key=?').bind(toKey, fromKey),
    DB.prepare('UPDATE OR IGNORE member_area_permissions SET area_key=? WHERE area_key=?').bind(toKey, fromKey),
    DB.prepare('DELETE FROM member_area_permissions WHERE area_key=?').bind(fromKey),
    DB.prepare('UPDATE shifts SET home_area_key=? WHERE home_area_key=?').bind(toKey, fromKey)
  ]);

  return redirectWithMessage('/admin/areas', { notice: 'Area members and shifts migrated' });
};
