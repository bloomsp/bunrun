import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const key = (form.get('key') || '').toString().trim();
  const label = (form.get('label') || '').toString().trim();
  const minStaff = Number(form.get('minStaff'));

  if (!key) return redirectWithMessage('/admin/areas', { error: 'Invalid area key' });
  if (!label) return redirectWithMessage('/admin/areas', { error: 'Area name is required' });
  if (!Number.isFinite(minStaff) || minStaff < 0 || minStaff > 99) {
    return redirectWithMessage('/admin/areas', { error: 'Minimum staff must be between 0 and 99' });
  }

  const DB = await getDB();
  const updated = await DB.prepare('UPDATE areas SET label=?, min_staff=? WHERE key=?')
    .bind(label, minStaff, key)
    .run();

  if (Number(updated.meta?.changes ?? 0) === 0) {
    return redirectWithMessage('/admin/areas', { error: 'Area not found' });
  }

  return redirectWithMessage('/admin/areas', { notice: 'Area updated' });
};
