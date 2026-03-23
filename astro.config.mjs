// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',

  vite: { plugins: [tailwindcss()] },

  integrations: [react()],

  // Explicitly disable Astro Sessions. Cloudflare's build module-runner is crashing
  // when the adapter enables KV-backed sessions (`require_dist is not a function`).
  // @ts-expect-error session config is not present in all Astro public typings.
  session: { driver: 'memory' },

  adapter: cloudflare({ prerenderEnvironment: 'node', imageService: 'passthrough' }),
});

