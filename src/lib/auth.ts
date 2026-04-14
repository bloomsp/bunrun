export type AuthRole = 'team' | 'admin';

const COOKIE_BASE = 'Path=/; HttpOnly; SameSite=Lax';

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
  if (role === 'admin') return role;
  if (role === 'team' || role === 'view') return 'team';
  return null;
}

export function requireRole(request: Request, role: AuthRole): { ok: true } | { ok: false; redirect: Response } {
  const current = getRoleFromRequest(request);
  if (!current) {
    const to = role === 'admin' ? '/login/admin' : '/login/team';
    // Use a relative redirect for maximum compatibility in the Pages/Workers runtime.
    return { ok: false, redirect: new Response(null, { status: 303, headers: { Location: to } }) };
  }
  if (role === 'admin' && current !== 'admin') {
    return {
      ok: false,
      redirect: new Response(null, {
        status: 303,
        headers: { Location: '/login/admin?error=Please+sign+in+with+the+admin+password' }
      })
    };
  }
  return { ok: true };
}

export function isSecureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:';
}

export function cookieForRole(role: AuthRole, opts?: { secure?: boolean }) {
  const maxAge = 60 * 60 * 12; // 12 hours
  const secure = opts?.secure ?? false;
  return `bunrun_role=${role}; ${COOKIE_BASE}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearRoleCookie(opts?: { secure?: boolean }) {
  const secure = opts?.secure ?? false;
  return `bunrun_role=; ${COOKIE_BASE}; Max-Age=0${secure ? '; Secure' : ''}`;
}
