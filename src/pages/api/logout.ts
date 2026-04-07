import type { APIRoute } from 'astro';
import { clearRoleCookie, isSecureRequest } from '../../lib/auth';

export const POST: APIRoute = async ({ request }) => {
  const headers = new Headers();
  headers.append('Set-Cookie', clearRoleCookie({ secure: isSecureRequest(request) }));
  headers.set('Location', '/');
  return new Response(null, { status: 302, headers });
};
