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

console.log('[pages-postbuild] Copied dist/client/* -> dist/*');
