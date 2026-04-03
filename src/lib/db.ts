// Cloudflare D1 access
//
// In Astro v6 + Cloudflare adapter, `Astro.locals.runtime.env` is no longer available.
// The recommended approach is `import { env } from "cloudflare:workers"`.
//
// In `astro dev` (Node), Cloudflare runtime bindings (D1) are not available.
// We surface a clear error so pages can show a friendly "DB not configured" message.

export type Env = {
  DB: D1Database;
};

export async function getDB(): Promise<D1Database> {
  try {
    // Only works in the Cloudflare runtime (Pages/Workers).
    const mod = await import('cloudflare:workers');
    const cfEnv = (mod as any).env as Env | undefined;
    if (!cfEnv?.DB) throw new Error('Missing D1 binding: DB');
    return cfEnv.DB;
  } catch (e) {
    throw new Error(
      'D1 is not available in astro dev. Use the deployed Cloudflare Worker, or run via wrangler dev to test D1 bindings.'
    );
  }
}
