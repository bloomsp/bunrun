import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const clientDir = path.join(distDir, 'client');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(clientDir))) {
  console.error('[pages-postbuild] dist/client not found. Did astro build run?');
  process.exit(1);
}

// Cloudflare Pages expects the asset output directory (dist) to contain /index.html etc.
// Astro's Cloudflare adapter outputs assets to dist/client, so we copy them up one level.
// We keep dist/server intact for the worker runtime.

const entries = await fs.readdir(clientDir);
for (const name of entries) {
  const src = path.join(clientDir, name);
  const dest = path.join(distDir, name);

  // Never overwrite the server directory.
  if (name === 'server') continue;

  // Remove any existing destination first (to avoid stale files).
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
}

// Ensure Pages Functions entrypoint exists.
// Cloudflare Pages looks for dist/_worker.js to enable SSR / Functions.
const serverEntry = path.join(distDir, 'server', 'entry.mjs');
if (!(await exists(serverEntry))) {
  console.error('[pages-postbuild] dist/server/entry.mjs not found. SSR entrypoint missing.');
  process.exit(1);
}

await fs.writeFile(
  path.join(distDir, '_worker.js'),
  `export { default } from "./server/entry.mjs";\n`,
  'utf8'
);

// Route all requests through the worker, but let static assets be served directly.
await fs.writeFile(
  path.join(distDir, '_routes.json'),
  JSON.stringify(
    {
      version: 1,
      include: ['/*'],
      exclude: ['/_astro/*', '/favicon*', '/robots.txt', '/sitemap.xml', '/assets/*']
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log('[pages-postbuild] Copied dist/client/* -> dist/* and wrote dist/_worker.js + dist/_routes.json');
