import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Two pages: the Rixor app (index.html) and the Deploy Console (deploy.html, src/deploy). Paths are relative to the
// project root.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { input: { main: 'index.html', deploy: 'deploy.html' } } },
})
