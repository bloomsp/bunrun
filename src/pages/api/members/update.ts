import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { isBreakPreference } from '../../../lib/member-config';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const name = (form.get('name') || '').toString().trim();
  const selectedAreas = form.getAll('areas').map((v) => v.toString());
  const defaultAreaKeyRaw = (form.get('defaultAreaKey') || '').toString().trim();
  const defaultAreaKey = defaultAreaKeyRaw === '' ? null : defaultAreaKeyRaw;
  const breakPreference = (form.get('breakPreference') || '15+30').toString();
  const returnTo = (form.get('returnTo') || '/admin/members').toString();

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return redirectWithMessage('/admin/members', { error: 'Invalid member' });
  }
  if (!name) {
    return redirectWithMessage('/admin/members', { error: 'Name is required' });
  }
  if (!isBreakPreference(breakPreference)) {
    return redirectWithMessage('/admin/members', { error: 'Invalid break preference' });
  }

  const DB = await getDB();

  const areaRows = (await DB.prepare('SELECT key FROM areas').all()).results as any[];
  const known = new Set(areaRows.map((r) => r.key as string));

  for (const k of selectedAreas) {
    if (!known.has(k)) return redirectWithMessage('/admin/members', { error: `Unknown area: ${k}` });
  }
  if (defaultAreaKey && !known.has(defaultAreaKey)) {
    return redirectWithMessage('/admin/members', { error: `Unknown default area: ${defaultAreaKey}` });
  }

  const allSelected = selectedAreas.length > 0 && selectedAreas.length === known.size;

  try {
    await DB.prepare('UPDATE members SET name=?, all_areas=?, default_area_key=?, break_preference=? WHERE id=?')
      .bind(name, allSelected ? 1 : 0, defaultAreaKey, breakPreference, memberId)
      .run();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return redirectWithMessage('/admin/members', { error: `Could not update member: ${msg}` });
  }

  await DB.prepare('DELETE FROM member_area_permissions WHERE member_id=?').bind(memberId).run();
  if (!allSelected) {
    for (const k of selectedAreas) {
      await DB.prepare('INSERT OR IGNORE INTO member_area_permissions (member_id, area_key) VALUES (?, ?)')
        .bind(memberId, k)
        .run();
    }
  }

  return redirectWithMessage(returnTo, { notice: 'Member updated' });
};
