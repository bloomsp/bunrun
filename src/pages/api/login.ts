import type { APIRoute } from 'astro';
import { cookieForRole, clearRoleCookie } from '../../lib/auth';

function badRequest(msg: string) {
  return new Response(msg, { status: 400 });
}

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return badRequest('Invalid form submission');
  }

  const form = await request.formData();
  const role = (form.get('role') || 'view').toString();
  const password = (form.get('password') || '').toString();

  const viewPassword = process.env.BUNRUN_VIEW_PASSWORD;
  const adminPassword = process.env.BUNRUN_ADMIN_PASSWORD;

  if (!viewPassword || !adminPassword) {
    return new Response('Server not configured (missing passwords)', { status: 500 });
  }

  if (role !== 'view' && role !== 'admin') return badRequest('Unknown role');

  const ok = role === 'admin' ? password === adminPassword : password === viewPassword;
  if (!ok) {
    return new Response('Incorrect password', { status: 401 });
  }

  const headers = new Headers();
  headers.append('Set-Cookie', clearRoleCookie());
  headers.append('Set-Cookie', cookieForRole(role));
  headers.set('Location', role === 'admin' ? '/admin' : '/view');

  return new Response(null, { status: 302, headers });
};
