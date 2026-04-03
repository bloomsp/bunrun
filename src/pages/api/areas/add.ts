import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

function slugifyAreaKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const label = (form.get('label') || '').toString().trim();
  const keyInput = (form.get('key') || '').toString().trim();
  const minStaff = Number(form.get('minStaff'));

  if (!label) return redirectWithMessage('/admin/areas', { error: 'Area name is required' });
  if (!Number.isFinite(minStaff) || minStaff < 0 || minStaff > 99) {
    return redirectWithMessage('/admin/areas', { error: 'Minimum staff must be between 0 and 99' });
  }

  const key = slugifyAreaKey(keyInput || label);
  if (!key) return redirectWithMessage('/admin/areas', { error: 'Area key could not be generated' });

  const DB = await getDB();

  try {
    await DB.prepare('INSERT INTO areas (key, label, min_staff) VALUES (?, ?, ?)')
      .bind(key, label, minStaff)
      .run();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      return redirectWithMessage('/admin/areas', { error: 'That area key or name is already in use' });
    }
    return redirectWithMessage('/admin/areas', { error: `Could not add area: ${msg}` });
  }

  return redirectWithMessage('/admin/areas', { notice: 'Area added' });
};
