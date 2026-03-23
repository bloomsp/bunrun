// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [react()],

  // Cloudflare Pages adapter
  // Avoid Cloudflare build/runtime feature auto-enablement that can trigger workerd module-runner issues.
  adapter: cloudflare({
    prerenderEnvironment: 'node',
    imageService: 'passthrough',
    sessions: false
  })
});