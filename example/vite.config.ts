import rempa from 'vite-plugin-rempa'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/the-base',
  server: {
    host: true,
  },
  plugins: [
      react(),
    rempa(),
  ],
})
