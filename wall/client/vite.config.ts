import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2022' },
  server: {
    proxy: {
      '/api': 'http://localhost:9600',
      '/healthz': 'http://localhost:9600',
    },
  },
});
