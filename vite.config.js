import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Allows any .trycloudflare.com subdomain and localhost
    allowedHosts: ['.trycloudflare.com', 'localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4001',
        ws: true,
        changeOrigin: true,
      },
      // Mimics Discord's URL Mapping (/youtube-embed -> youtube.com)
      // for local development where the real mapping isn't active.
      '/youtube-embed': {
        target: 'https://www.youtube.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/youtube-embed/, ''),
      },
    },
  },
});