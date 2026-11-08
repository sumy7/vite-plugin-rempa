import type { Browser, Page as BrowserPage } from 'playwright'
import type { InlineConfig, Plugin, PreviewServer, ViteDevServer } from 'vite'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { build, createServer, preview } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import rempa from '../src/index'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
let fixture: string
let browser: Browser
let server: ViteDevServer | undefined
let previewServer: PreviewServer | undefined
let page: BrowserPage
const errors: string[] = []

function origin(httpServer: ViteDevServer['httpServer']): string {
  const address = httpServer?.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a listening HTTP server')
  return `http://127.0.0.1:${address.port}`
}

function configuration(plugin: Plugin): InlineConfig {
  return {
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    base: '/rempa/',
    plugins: [
      react(),
      plugin,
    ],
    server: { host: '127.0.0.1', port: 0 },
    preview: { host: '127.0.0.1', port: 0 },
  }
}

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  })
})

beforeEach(async () => {
  fixture = await mkdtemp(path.join(projectRoot, '.rempa-test-browser-'))
  const example = path.join(projectRoot, 'examples/react')
  await cp(path.join(example, 'src'), path.join(fixture, 'src'), { recursive: true })
  await cp(path.join(example, 'index.html'), path.join(fixture, 'index.html'))
  await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}')
  errors.length = 0
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
})

afterEach(async () => {
  await page?.close()
  await server?.close()
  server = undefined
  if (previewServer) {
    await new Promise<void>((resolve, reject) => previewServer!.httpServer.close(error => error
      ? reject(error)
      : resolve()))
    previewServer = undefined
  }
  if (fixture)
    await rm(fixture, { recursive: true, force: true })
})

afterAll(async () => {
  await browser?.close()
})

describe('react example in a real browser', () => {
  it('serves root and nested pages, mounts layouts and preserves state during Fast Refresh', async () => {
    server = await createServer(configuration(rempa()))
    await server.listen()
    const url = origin(server.httpServer)
    await page.goto(`${url}/rempa/index.html`)
    await page.getByRole('heading', { name: 'React multi-page example', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Count: 0', exact: true }).click()
    await page.getByRole('button', { name: 'Count: 1', exact: true }).waitFor()

    const source = path.join(fixture, 'src/pages/index.tsx')
    const previousSource = await readFile(source, 'utf8')
    expect(previousSource).toContain('Count:')
    await writeFile(source, previousSource.replace('Count:', 'Updated count:'))
    await page.getByRole('button', { name: 'Updated count: 1', exact: true }).waitFor()

    await page.goto(`${url}/rempa/hello-world.html`)
    await page.getByRole('heading', { name: 'Hello World', exact: true }).waitFor()
    await page.getByText('Shared layout', { exact: true }).waitFor()

    const configFile = path.join(fixture, 'src/pages/hello-world/config.json')
    const pageConfig = JSON.parse(await readFile(configFile, 'utf8'))
    await writeFile(configFile, JSON.stringify({ ...pageConfig, title: 'Updated page title' }))
    await expect.poll(() => page.title(), { timeout: 10000 }).toBe('Updated page title')
    await page.getByRole('heading', { name: 'Hello World', exact: true }).waitFor()
    await expect.poll(() => server?.ws.clients.size ?? 0, { timeout: 10000 }).toBeGreaterThan(0)
    const template = path.join(fixture, 'src/template/index.html')
    await writeFile(template, (await readFile(template, 'utf8')).replace('<body>', '<body data-template-updated="true">'))
    await expect.poll(() => page.locator('body').getAttribute('data-template-updated'), { timeout: 10000 }).toBe('true')

    await page.goto(`${url}/rempa/admin/users.html`)
    await page.getByRole('heading', { name: 'Users', exact: true }).waitFor()
    expect(errors).toEqual([])
    await server.close()
    server = undefined
  })

  it.each(['esm', 'cjs'])('builds through the %s package export and renders production pages with preview', async (format) => {
    const packageName = 'vite-plugin-rempa'
    const { default: builtRempa, pluginRempa } = await import(packageName)
    const require = createRequire(import.meta.url)
    const commonjs = require(packageName)
    expect(builtRempa).toBe(pluginRempa)
    expect(commonjs.default).toBe(commonjs.pluginRempa)
    expect(commonjs.default().name).toBe('vite-plugin-rempa')
    const plugin = format === 'esm'
      ? builtRempa
      : commonjs.default
    await build(configuration(plugin()))
    previewServer = await preview(configuration(plugin()))
    const url = origin(previewServer.httpServer)
    await page.goto(`${url}/rempa/index.html`)
    await page.getByRole('heading', { name: 'React multi-page example', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Count: 0', exact: true }).click()
    await page.getByRole('button', { name: 'Count: 1', exact: true }).waitFor()
    await page.goto(`${url}/rempa/hello-world.html`)
    await page.getByRole('heading', { name: 'Hello World', exact: true }).waitFor()
    await page.getByText('Shared layout', { exact: true }).waitFor()
    await page.goto(`${url}/rempa/admin/users.html`)
    await page.getByRole('heading', { name: 'Users', exact: true }).waitFor()
    expect(errors).toEqual([])
  })
})
