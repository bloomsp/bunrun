import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const memberId = Number(form.get('memberId'));
  const name = (form.get('name') || '').toString().trim();
  const selectedAreas = form.getAll('areas').map((v) => v.toString());
  const defaultAreaKeyRaw = (form.get('defaultAreaKey') || '').toString().trim();
  const defaultAreaKey = defaultAreaKeyRaw === '' ? null : defaultAreaKeyRaw;
  const returnTo = (form.get('returnTo') || '/admin/members').toString();

  if (!Number.isFinite(memberId) || memberId <= 0) {
    return new Response('Invalid memberId', { status: 400 });
  }
  if (!name) {
    return new Response('Name is required', { status: 400 });
  }

  const DB = await getDB();

  // Validate provided keys against areas table
  const areaRows = (await DB.prepare('SELECT key FROM areas').all()).results as any[];
  const known = new Set(areaRows.map((r) => r.key as string));

  for (const k of selectedAreas) {
    if (!known.has(k)) return redirectWithMessage('/admin/members', { error: `Unknown area: ${k}` });
  }
  if (defaultAreaKey && !known.has(defaultAreaKey)) {
    return new Response(`Unknown default area: ${defaultAreaKey}`, { status: 400 });
  }

  // If all areas selected, treat as "allow all".
  const allSelected = selectedAreas.length > 0 && selectedAreas.length === known.size;

  try {
    await DB.prepare('UPDATE members SET name=?, all_areas=?, default_area_key=? WHERE id=?')
      .bind(name, allSelected ? 1 : 0, defaultAreaKey, memberId)
      .run();
  } catch (e: any) {
    // Name is UNIQUE; surface conflict nicely.
    const msg = e?.message ?? String(e);
    return new Response(`Could not update member: ${msg}`, { status: 409 });
  }

  // Replace permissions
  await DB.prepare('DELETE FROM member_area_permissions WHERE member_id=?').bind(memberId).run();
  if (!allSelected) {
    for (const k of selectedAreas) {
      await DB.prepare('INSERT OR IGNORE INTO member_area_permissions (member_id, area_key) VALUES (?, ?)')
        .bind(memberId, k)
        .run();
    }
  }

  return new Response(null, { status: 303, headers: { Location: returnTo } });
};
eturnTo } });
};
ation: returnTo } });
};
