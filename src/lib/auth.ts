export type AuthRole = 'view' | 'admin';

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export function getRoleFromRequest(request: Request): AuthRole | null {
  const cookies = parseCookies(request.headers.get('cookie'));
  const role = cookies['bunrun_role'];
  if (role === 'view' || role === 'admin') return role;
  return null;
}

export function requireRole(request: Request, role: AuthRole): { ok: true } | { ok: false; redirect: Response } {
  const current = getRoleFromRequest(request);
  if (!current) {
    const to = role === 'admin' ? '/login?role=admin' : '/login?role=view';
    const url = new URL(to, request.url);
    return { ok: false, redirect: Response.redirect(url.toString(), 302) };
  }
  if (role === 'admin' && current !== 'admin') {
    return { ok: false, redirect: new Response('Forbidden', { status: 403 }) };
  }
  return { ok: true };
}

export function cookieForRole(role: AuthRole, opts?: { secure?: boolean }) {
  const maxAge = 60 * 60 * 12; // 12 hours
  const secure = opts?.secure ?? false;
  return `bunrun_role=${role}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearRoleCookie() {
  return `bunrun_role=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}
