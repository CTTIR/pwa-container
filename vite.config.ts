import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Two pages: index.html (participants, installable and offline-capable) and admin.html
// (results, served only after authentication and never cached by the service worker).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/icon.svg'],
      manifest: {
        name: 'Umfrage',
        short_name: 'Umfrage',
        description: 'Anonyme Umfrage',
        lang: 'de',
        theme_color: '#1f2933',
        background_color: '#f5f7f9',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        globIgnores: ['admin.html', 'assets/admin-*', 'assets/xlsx-*'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/admin/, /^\/api\//, /^\/healthz/, /^\/themes\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && /^\/api\/surveys\/[^/]+$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'survey-definitions',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 20 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/themes/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'survey-themes', expiration: { maxEntries: 60 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      input: { index: 'index.html', admin: 'admin.html' },
    },
  },
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8080', '/admin/api': 'http://localhost:8080', '/themes': 'http://localhost:8080' },
  },
});
