import { defineConfig } from 'vite';

// Docs/demo site. The library build lives in vite.lib.config.ts.
export default defineConfig({
  build: {
    outDir: 'site-dist',
    target: 'es2022',
  },
});
