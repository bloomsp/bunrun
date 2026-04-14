import type { APIRoute } from 'astro';
import { cookieForRole, clearRoleCookie, isSecureRequest } from '../../lib/auth';

function badRequest(msg: string) {
  return new Response(msg, { status: 400 });
}

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return badRequest('Invalid form submission');
  }

  const form = await request.formData();
  const role = (form.get('role') || 'team').toString();
  const password = (form.get('password') || '').toString().trim();

  // Env handling:
  // - In Astro dev: use import.meta.env (loaded from .env)
  // - In Cloudflare Pages/Workers: use runtime env from `cloudflare:workers`
  let viewPassword: string | undefined;
  let adminPassword: string | undefined;

  try {
    const mod = await import('cloudflare:workers');
    const runtimeEnv = (mod as any).env as any;
    viewPassword = typeof runtimeEnv?.BUNRUN_VIEW_PASSWORD === 'string' ? runtimeEnv.BUNRUN_VIEW_PASSWORD.trim() : undefined;
    adminPassword = typeof runtimeEnv?.BUNRUN_ADMIN_PASSWORD === 'string' ? runtimeEnv.BUNRUN_ADMIN_PASSWORD.trim() : undefined;
  } catch {
    // ignore
  }

  viewPassword ||= (import.meta.env.BUNRUN_VIEW_PASSWORD as string | undefined)?.trim();
  adminPassword ||= (import.meta.env.BUNRUN_ADMIN_PASSWORD as string | undefined)?.trim();

  if (!viewPassword || !adminPassword) {
    return new Response('Server not configured (missing passwords)', { status: 500 });
  }

  if (role !== 'team' && role !== 'view' && role !== 'admin') return badRequest('Unknown role');

  const normalizedRole = role === 'view' ? 'team' : role;
  const ok = normalizedRole === 'admin' ? password === adminPassword : password === viewPassword;
  if (!ok) {
    return new Response('Incorrect password', { status: 401 });
  }

  const headers = new Headers();
  const secureCookie = isSecureRequest(request);
  headers.append('Set-Cookie', clearRoleCookie({ secure: secureCookie }));
  headers.append('Set-Cookie', cookieForRole(normalizedRole as 'team' | 'admin', { secure: secureCookie }));
  headers.set('Location', normalizedRole === 'admin' ? '/admin' : '/breaks');

  return new Response(null, { status: 303, headers });
};
