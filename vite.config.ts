import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        cashier: 'kasir-offline.html',
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'CL Petshop POS',
        short_name: 'CL Petshop',
        description: 'Kasir offline-first CL Petshop',
        theme_color: '#15251f',
        background_color: '#f5f3ec',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/brand/cl-petshop-logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/brand/cl-petshop-logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallbackDenylist: [/^\/kasir-offline\.html(?:$|\?)/]
      }
    })
  ]
})
