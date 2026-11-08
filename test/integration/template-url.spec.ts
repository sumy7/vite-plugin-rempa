import type { InlineConfig, ViteDevServer } from 'vite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import rempa from '../../src/index.ts'
import { createTemporaryDirectory, testFixturesPlugin } from '../helpers.ts'

const fixtures: string[] = []
const servers: ViteDevServer[] = []

async function write(root: string, file: string, contents: string): Promise<void> {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function fixture(name: string, template?: string): Promise<string> {
  const root = await createTemporaryDirectory('template-url-')
  fixtures.push(root)
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, `src/pages/${name}/index.tsx`, `import React from 'react'; import Child from './child'; export default function Page() { return <h1>Page marker<Child /></h1>; }`)
  await write(root, `src/pages/${name}/child.tsx`, `export default function Child() { return 'Child marker' }`)
  await write(root, `src/pages/${name}/config.json`, JSON.stringify(template
    ? { template: 'template.html' }
    : {}))
  if (template)
    await write(root, 'template.html', template)
  return root
}

function configuration(root: string): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      testFixturesPlugin(),
      rempa(),
    ],
    server: { host: '127.0.0.1', port: 0, preTransformRequests: false },
    build: { write: false, minify: false },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('template and URL integration', () => {
  it.each([
    '<!doctype html><html><body><!-- closing marker: </body> --><div id="root"></div></body></html>',
    '<!doctype html><html><head><script>window.previewMarkup = \'<body>Preview</body>\';</script></head><body><div id="root"></div></body></html>',
  ])('bundles the bootstrap without rewriting closing-body markers', async (template) => {
    const root = await fixture('hello', template)

    const result = await build(configuration(root))
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const html = result.output.find(file => file.type === 'asset' && file.fileName === 'hello.html')
    expect(html?.type).toBe('asset')
    if (!html || html.type !== 'asset')
      throw new Error('Missing generated page')
    expect(String(html.source)).toMatch(/<script[^>]+src="[^"]+\.js"/)
    expect(result.output.some(file => file.type === 'chunk' && file.code.includes('Page marker'))).toBe(true)
    expect(String(html.source)).toContain(template.includes('closing marker')
      ? '<!-- closing marker: </body> -->'
      : 'window.previewMarkup = \'<body>Preview</body>\';')
  })

  it.each([
    'with#hash',
    'with%percent',
    '中文 space',
  ])('serves a usable bootstrap for the page %s', async (name) => {
    const root = await fixture(name)
    const server = await createServer(configuration(root))
    servers.push(server)
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a listening TCP server')
    const origin = `http://127.0.0.1:${address.port}`
    const htmlResponse = await fetch(`${origin}/${encodeURIComponent(name)}.html`)
    expect(htmlResponse.status).toBe(200)
    const html = await htmlResponse.text()
    const scripts = [
      ...html.matchAll(/<script[^>]*src="([^"]+)"/g),
    ].map(match => match[1])
    const runtimeUrl = scripts.find(src => !src.includes('@vite/client'))
    expect(runtimeUrl).toBeDefined()
    const runtimeResponse = await fetch(new URL(runtimeUrl!, origin))
    expect(runtimeResponse.status).toBe(200)
    const code = await runtimeResponse.text()
    const imports = [
      ...code.matchAll(/from\s*"([^"]+)"/g),
    ].map(match => match[1])
    expect(imports.length).toBeGreaterThan(0)
    const visited = new Set<string>()
    const loadModule = async (imported: string, importer: string): Promise<string> => {
      const url = new URL(imported, importer).href
      if (visited.has(url))
        return ''
      visited.add(url)
      const response = await fetch(url)
      expect(response.status, imported).toBe(200)
      const module = await response.text()
      if (url.includes('/.rempa/modules/') || url.includes('/src/pages/')) {
        const children = [
          ...module.matchAll(/from\s*"([^"]+)"/g),
        ].map(match => match[1])
        return module + (await Promise.all(children.map(child => loadModule(child, url)))).join('\n')
      }
      return module
    }
    const modules = await Promise.all(imports.map(imported => loadModule(imported, origin)))
    expect(modules.join('\n')).toContain('Child marker')
    await server.waitForRequestsIdle()
  })

  it.each([
    'with#hash',
    'with%percent',
    '中文 space',
  ])('bundles a usable bootstrap for the page %s', async (name) => {
    const root = await fixture(name)

    const result = await build(configuration(root))
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const html = result.output.find(file => file.type === 'asset' && file.fileName === `${name}.html`)
    expect(html?.type).toBe('asset')
    expect(result.output.some(file => file.type === 'chunk' && file.code.includes('Page marker'))).toBe(true)
  })
})
