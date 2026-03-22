import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const breakId = Number(form.get('breakId'));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });
  if (!Number.isFinite(breakId) || breakId <= 0) return new Response('Invalid breakId', { status: 400 });

  const DB = await getDB();
  await DB.prepare('DELETE FROM breaks WHERE id=?').bind(breakId).run();

  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Break deleted' });
};
s: 303, headers: { Location: `/admin/schedule/${date}#breaks` } });
};
});
};
