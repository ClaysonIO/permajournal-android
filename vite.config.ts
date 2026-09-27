/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    // github.com's OAuth endpoints don't send CORS headers. On Android we use
    // native HTTP; in the browser dev server we proxy them instead.
    proxy: {
      '/github-com': {
        target: 'https://github.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/github-com/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
