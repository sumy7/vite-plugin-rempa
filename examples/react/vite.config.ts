import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(async ({ command, isPreview }) => {
  const { default: rempa } = command === 'serve' && !isPreview
    ? await import('../../src/index.ts')
    : await import('vite-plugin-rempa')

  return {
    base: '/rempa/',
    plugins: [
      react(),
      rempa(),
    ],
  }
})
