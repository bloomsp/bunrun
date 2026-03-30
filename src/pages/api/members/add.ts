import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const name = (form.get('name') || '').toString().trim();
  if (!name) return new Response('Name is required', { status: 400 });

  const DB = await getDB();

  await DB.prepare('INSERT OR IGNORE INTO members (name, active, break_preference) VALUES (?, 1, ?)')
    .bind(name, '15+30')
    .run();

  return new Response(null, { status: 303, headers: { Location: '/admin/members' } });
};
