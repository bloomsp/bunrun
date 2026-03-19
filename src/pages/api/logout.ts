import type { APIRoute } from 'astro';
import { clearRoleCookie } from '../../lib/auth';

export const POST: APIRoute = async () => {
  const headers = new Headers();
  headers.append('Set-Cookie', clearRoleCookie());
  headers.set('Location', '/');
  return new Response(null, { status: 302, headers });
};
