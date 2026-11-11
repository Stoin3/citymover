import { defineConfig } from 'vite';

// base: './' so the build works on GitHub Pages / any sub-path
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
