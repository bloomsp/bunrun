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

  // Env handling:
  // - In Astro dev: use import.meta.env (loaded from .env)
  // - In Cloudflare Pages/Workers: use runtime env from `cloudflare:workers`
  let viewPassword: string | undefined;
  let adminPassword: string | undefined;

  try {
    const mod = await import('cloudflare:workers');
    const runtimeEnv = (mod as any).env as any;
    viewPassword = runtimeEnv?.BUNRUN_VIEW_PASSWORD;
    adminPassword = runtimeEnv?.BUNRUN_ADMIN_PASSWORD;
  } catch {
    // ignore
  }

  viewPassword ||= import.meta.env.BUNRUN_VIEW_PASSWORD as string | undefined;
  adminPassword ||= import.meta.env.BUNRUN_ADMIN_PASSWORD as string | undefined;

  if (!viewPassword || !adminPassword) {
    return new Response('Server not configured (missing passwords)', { status: 500 });
  }

  if (role !== 'view' && role !== 'admin') return badRequest('Unknown role');

  const ok = role === 'admin' ? password === adminPassword : password === viewPassword;
  if (!ok) {
    return new Response('Incorrect password', { status: 401 });
  }

  const headers = new Headers();
  const secureCookie = new URL(request.url).protocol === 'https:';
  headers.append('Set-Cookie', clearRoleCookie());
  headers.append('Set-Cookie', cookieForRole(role, { secure: secureCookie }));
  headers.set('Location', role === 'admin' ? '/admin' : '/view');

  return new Response(null, { status: 302, headers });
};
