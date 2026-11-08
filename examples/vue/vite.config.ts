import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig(async ({ command, isPreview }) => {
  const { default: rempa } = command === 'serve' && !isPreview
    ? await import('../../src/index.ts')
    : await import('vite-plugin-rempa')

  return {
    base: '/rempa/',
    plugins: [
      vue(),
      rempa(),
    ],
  }
})
