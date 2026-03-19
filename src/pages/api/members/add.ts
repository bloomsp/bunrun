import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getEnv } from '../../../lib/db';

export const POST: APIRoute = async ({ request, locals }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const name = (form.get('name') || '').toString().trim();
  if (!name) return new Response('Name is required', { status: 400 });

  const { DB } = getEnv(locals);

  await DB.prepare('INSERT OR IGNORE INTO members (name, active) VALUES (?, 1)')
    .bind(name)
    .run();

  return Response.redirect('/admin/members', 302);
};
