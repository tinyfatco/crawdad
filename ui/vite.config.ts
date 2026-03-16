import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/web/chat': 'http://localhost:3002',
      '/api/files': 'http://localhost:3002',
      '/api/file': 'http://localhost:3002',
      '/health': 'http://localhost:3002',
      '/status': 'http://localhost:3002',
    },
  },
});
