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
      '/awareness/backlog': 'http://localhost:3002',
      '/awareness/stream': 'http://localhost:3002',
      '/terminal': { target: 'ws://localhost:3002', ws: true },
      '/voice/stream': { target: 'ws://localhost:8766', ws: true },
      '/health': 'http://localhost:3002',
      '/status': 'http://localhost:3002',
    },
  },
});
