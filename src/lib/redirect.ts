export function redirectWithMessage(to: string, opts?: { error?: string; notice?: string }) {
  const url = new URL(to, 'https://example.local');
  if (opts?.error) url.searchParams.set('error', opts.error);
  if (opts?.notice) url.searchParams.set('notice', opts.notice);
  // Strip fake origin
  const loc = url.pathname + (url.search ? url.search : '') + (url.hash ? url.hash : '');
  return new Response(null, { status: 303, headers: { Location: loc } });
}
