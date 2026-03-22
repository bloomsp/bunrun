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
  // Use node during prerender to avoid workerd module-runner quirks.
  adapter: cloudflare({ prerenderEnvironment: 'node' })
});