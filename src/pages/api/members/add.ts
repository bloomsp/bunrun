import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { isBreakPreference } from '../../../lib/member-config';
import { loadAreaKeys } from '../../../lib/repositories';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const name = (form.get('name') || '').toString().trim();
  const selectedAreas = form.getAll('areas').map((v) => v.toString());
  const defaultAreaKeyRaw = (form.get('defaultAreaKey') || '').toString().trim();
  const defaultAreaKey = defaultAreaKeyRaw === '' ? null : defaultAreaKeyRaw;
  const breakPreference = (form.get('breakPreference') || '15+30').toString();
  const returnTo = (form.get('returnTo') || '/admin/members').toString();

  if (!name) return redirectWithMessage('/admin/members', { error: 'Name is required' });
  if (!isBreakPreference(breakPreference)) {
    return redirectWithMessage('/admin/members', { error: 'Invalid break preference' });
  }

  const DB = await getDB();
  const known = await loadAreaKeys(DB);

  for (const areaKey of selectedAreas) {
    if (!known.has(areaKey)) return redirectWithMessage('/admin/members', { error: `Unknown area: ${areaKey}` });
  }
  if (defaultAreaKey && !known.has(defaultAreaKey)) {
    return redirectWithMessage('/admin/members', { error: `Unknown default area: ${defaultAreaKey}` });
  }

  const allSelected = selectedAreas.length > 0 && selectedAreas.length === known.size;

  let memberId = 0;
  try {
    const inserted = await DB.prepare(
      'INSERT INTO members (name, active, all_areas, default_area_key, break_preference) VALUES (?, 1, ?, ?, ?)'
    )
      .bind(name, allSelected ? 1 : 0, defaultAreaKey, breakPreference)
      .run();
    memberId = Number(inserted.meta?.last_row_id ?? 0);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (/UNIQUE/i.test(msg)) {
      return redirectWithMessage('/admin/members', { error: 'A member with that name already exists' });
    }
    return redirectWithMessage('/admin/members', { error: `Could not add member: ${msg}` });
  }

  if (memberId > 0 && !allSelected) {
    await DB.batch(
      selectedAreas.map((areaKey) =>
        DB.prepare('INSERT OR IGNORE INTO member_area_permissions (member_id, area_key) VALUES (?, ?)')
          .bind(memberId, areaKey)
      )
    );
  }

  return redirectWithMessage(returnTo, { notice: 'Member added' });
};
