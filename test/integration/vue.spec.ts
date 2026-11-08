import type { InlineConfig, ViteDevServer } from 'vite'
import type { PluginRempaOptions } from '../../src/types.ts'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { build, createServer, resolveConfig } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import rempa from '../../src/index.ts'
import { createTemporaryDirectory, testFixturesPlugin, write } from '../helpers.ts'

const fixtures: string[] = []
const servers: ViteDevServer[] = []

async function fixture(): Promise<string> {
  const root = await createTemporaryDirectory('vue-')
  fixtures.push(root)
  await write(root, 'package.json', '{"type":"module","dependencies":{"vue":"*"}}')
  // A Vue-only app must never need React, even when it is installed higher in the workspace.
  await write(root, 'node_modules/react/package.json', '{"name":"react","exports":{}}')
  return root
}

async function page(root: string, name: string, config: Record<string, unknown> = {}): Promise<void> {
  const directory = path.posix.join('src/pages', name)
  await write(root, `${directory}/config.json`, JSON.stringify(config))
  await write(root, `${directory}/index.vue`, `<script setup lang="ts">
import { ref } from 'vue'
import Child from './Child.vue'
import External from './External.vue'
import type { Props } from './types'
defineProps<Props>()
const count = ref<number>(0)
</script>
<template><main><h1>Vue page</h1><button @click="count++">{{ count }}</button><Child /><External /><img src="./logo.svg" alt="Logo" /></main></template>
<style scoped>main { color: rgb(1, 2, 3); background-image: url("./logo.svg"); }</style>`)
  await write(root, `${directory}/External.vue`, '<script src="./logic.js"></script><template><p>{{ message }}</p></template>')
  await write(root, `${directory}/logic.js`, 'export default { data() { return { message: "External script" } } }')
  await write(root, `${directory}/Child.vue`, '<template><p>Child component</p></template><style scoped>p { font-weight: bold; }</style>')
  await write(root, `${directory}/types.ts`, 'export interface Props { message?: string }')
  await write(root, `${directory}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" /></svg>')
}

function configuration(root: string, options: PluginRempaOptions = {}): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    base: '/demo/',
    plugins: [
      testFixturesPlugin(),
      vue(),
      rempa(options),
    ],
    server: { host: '127.0.0.1', port: 0, preTransformRequests: false },
    build: { minify: false },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('vue integration', () => {
  it('lets an explicit Vue framework override a project that declares both frameworks', async () => {
    const root = await fixture()
    await write(root, 'package.json', '{"type":"module","dependencies":{"react":"*","vue":"*"}}')
    await page(root, 'override')
    await build(configuration(root, { framework: 'vue' }))
    expect(await readFile(path.join(root, 'dist/override.html'), 'utf8')).toContain('<title>override</title>')
  })

  it('builds root and nested SFC pages, custom mounts, templates and slot layouts without React', async () => {
    const root = await fixture()
    await write(root, 'src/layout/Global.vue', '<template><section data-layout="global"><slot /></section></template>')
    await write(root, 'src/layout/Page.vue', '<template><article data-layout="page"><slot /></article></template>')
    await write(root, 'template.html', '<html><head><title><%- title %></title></head><body><div id="<%- mountElementId %>"></div></body></html>')
    await page(root, '', { layout: '' })
    await page(root, 'hello', { title: 'Hello Vue', mountElementId: 'app', template: 'template.html' })
    await page(root, 'admin/users', { layout: '@/layout/Page.vue' })

    const result = await build({
      ...configuration(root, { layout: 'src/layout/Global.vue' }),
      build: { write: false, minify: false },
    })
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const html = result.output.find(file => file.fileName === 'hello.html')
    expect(html?.type === 'asset' && String(html.source)).toContain('id="app"')
    expect(html?.type === 'asset' && String(html.source)).toContain('<title>Hello Vue</title>')
    expect(result.output.some(file => file.fileName === 'index.html')).toBe(true)
    expect(result.output.some(file => file.fileName === 'admin/users.html')).toBe(true)
    const code = result.output.filter(file => file.type === 'chunk').map(file => file.code).join('\n')
    expect(code).toContain('global')
    expect(code).toContain('data-layout')
    expect(code).toContain('Child component')
    expect(code).not.toContain('react-dom')
    const css = result.output.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css')
      ? [
          String(file.source),
        ]
      : []).join('\n')
    expect(css).toContain('data-v-')
    expect(css).toContain('font-weight')
    const config = await resolveConfig(configuration(root), 'serve')
    expect(config.environments.client.optimizeDeps.include).toContain('vue')
    expect(config.environments.client.optimizeDeps.include?.some(id => id.startsWith('react'))).toBe(false)
  })

  it.each(['ordinary', 'with#hash', 'with%percent'])('builds SFC styles and relative child components in %s', async (name) => {
    const root = await fixture()
    await page(root, name)
    const result = await build({
      ...configuration(root),
      build: { write: false, assetsInlineLimit: 0, minify: false },
    })
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const image = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.svg'))
    expect(image).toBeDefined()
    const css = result.output.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css')
      ? [
          String(file.source),
        ]
      : []).join('\n')
    expect(css).toContain(path.posix.basename(image!.fileName))
    expect(css).not.toContain('url("./logo.svg")')
  })

  it('preserves CSS aliases and runs user PostCSS plugins once for mapped inline styles', async () => {
    const root = await fixture()
    await page(root, 'with#hash')
    const filename = path.join(root, 'src/pages/with#hash/index.vue')
    await write(root, 'src/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" />')
    await write(root, 'src/pages/with#hash/index.vue', (await readFile(filename, 'utf8')).replace('url("./logo.svg")', 'url("@/logo.svg")'))
    let visits = 0
    const result = await build({
      ...configuration(root),
      css: {
        postcss: {
          plugins: [
            {
              postcssPlugin: 'count-style-visits',
              Declaration(declaration: { prop: string }) {
                if (declaration.prop === 'color')
                  visits++
              },
            },
          ],
        },
      },
      build: { write: false, assetsInlineLimit: 0 },
    })
    expect(visits).toBe(1)
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const css = result.output.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css')
      ? [
          String(file.source),
        ]
      : []).join('\n')
    expect(css).not.toContain('@/logo.svg')
    expect(css).toContain('/demo/assets/logo-')
  })

  it.each(['ordinary', 'with#hash', 'with%percent'])('serves Vue entry and style subrequests in %s', async (name) => {
    const root = await fixture()
    await page(root, name)
    const server = await createServer(configuration(root))
    servers.push(server)
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP server')
    const origin = `http://127.0.0.1:${address.port}`
    const html = await (await fetch(`${origin}/demo/${encodeURIComponent(name)}`)).text()
    const runtimeUrl = [
      ...html.matchAll(/<script[^>]*src="([^"]+)"/g),
    ].map(match => match[1]).find(id => id.includes('@rempa'))!
    const runtime = await (await fetch(new URL(runtimeUrl, origin))).text()
    expect(runtime).toContain('createApp')
    expect(runtime).not.toContain('react')
    const entryUrl = [
      ...runtime.matchAll(/from\s*"([^"]+)"/g),
    ].map(match => match[1]).find(id => id.includes('.vue'))!
    const response = await fetch(new URL(entryUrl, origin))
    expect(response.status).toBe(200)
    const source = await response.text()
    expect(source).toContain('Vue page')
    expect(source).not.toContain('/.rempa/modules/logo.svg')
    const requests = [
      ...source.matchAll(/(?:from\s*|import\s*)"([^"]+)"/g),
    ].map(match => match[1])
    const styleUrl = requests.find(id => id.includes('type=style'))!
    expect(styleUrl).toBeDefined()
    const style = await fetch(new URL(styleUrl, origin))
    expect(style.status).toBe(200)
    expect(await style.text()).toContain('data-v-')
    const childUrl = requests.find(id => id.includes('Child.vue') || id.includes('/.rempa/modules/'))!
    const child = await fetch(new URL(childUrl, origin))
    expect(child.status).toBe(200)
    expect(await child.text()).toContain('Child component')
    await server.waitForRequestsIdle()
  })
})
