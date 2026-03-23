import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { redirectWithMessage } from '../../../lib/redirect';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid date' });
  }

  // Revalidation is computed on page render; this just refreshes and shows a notice.
  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Revalidated' });
};
