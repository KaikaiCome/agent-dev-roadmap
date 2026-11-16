/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built site works from any static host or subpath.
  base: './',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Node 25+ ships a global localStorage that shadows jsdom's implementation.
    execArgv: ['--no-experimental-webstorage'],
  },
})
