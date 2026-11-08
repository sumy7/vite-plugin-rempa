import type { Browser, Page as BrowserPage } from 'playwright'
import type { InlineConfig, Plugin, PreviewServer, ViteDevServer } from 'vite'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { build, createServer, preview } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import rempa from '../src/index'
import { createTemporaryDirectory, testFixturesPlugin } from '../test/helpers.ts'

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
      testFixturesPlugin(),
      react({ include: `${fixture.replaceAll('\\', '/')}/**/*.{js,jsx,ts,tsx}`, exclude: [] }),
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
  fixture = await createTemporaryDirectory('browser-')
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
  it.each(['with#hash', 'with%percent'])('mounts and builds %s with closing-body markers in the template', async (name) => {
    const directory = path.join(fixture, 'src/pages', name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'config.json'), JSON.stringify({ template: 'markers.html' }))
    await writeFile(path.join(directory, 'index.tsx'), `import React from 'react'; import Child from './Child'; import logo from './logo.svg'; import raw from './logo.svg?raw'; import url from './logo.svg?url'; import './style.css'; export default function SpecialPage() { return <main><h1>Special page</h1><Child /><img alt="Logo" src={logo} /><img alt="URL logo" src={url} /><p>{raw.includes('svg') ? 'Raw resource loaded' : 'Raw resource missing'}</p><div className="background">Background</div></main>; }`)
    await writeFile(path.join(directory, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')
    await writeFile(path.join(directory, 'background.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>')
    await writeFile(path.join(directory, 'style.css'), '.background { width: 10px; height: 10px; background-image: url("./background.svg"); }')
    const child = path.join(directory, 'Child.tsx')
    await writeFile(child, `import React from 'react'; export default function Child() { return <p>Child marker</p>; }`)
    await writeFile(path.join(fixture, 'markers.html'), `<!doctype html><html><head><script>window.previewMarkup = '<body>Preview</body>';</script></head><body><!-- closing marker: </body> --><div id="root"></div></body></html>`)
    const route = `/rempa/${encodeURIComponent(name)}.html`
    server = await createServer(configuration(rempa()))
    await server.listen()
    await page.goto(`${origin(server.httpServer)}${route}`)
    await page.getByRole('heading', { name: 'Special page', exact: true }).waitFor()
    await page.getByText('Child marker', { exact: true }).waitFor()
    await page.getByText('Raw resource loaded', { exact: true }).waitFor()
    const verifyImages = async (): Promise<void> => {
      for (const name of ['Logo', 'URL logo'])
        await expect.poll(() => page.getByAltText(name, { exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(10)
      const background = await page.getByText('Background', { exact: true }).evaluate(element => getComputedStyle(element).backgroundImage)
      const url = background.match(/url\(["']?(.*?)["']?\)/)?.[1]
      expect(url).toBeDefined()
      expect(await page.evaluate(async (url) => {
        const image = new Image()
        image.src = url
        await image.decode()
        return image.naturalWidth
      }, url!)).toBe(10)
    }
    await verifyImages()
    await writeFile(child, (await readFile(child, 'utf8')).replace('Child marker', 'Updated child'))
    await page.getByText('Updated child', { exact: true }).waitFor()
    await writeFile(path.join(directory, 'logo.svg'), (await readFile(path.join(directory, 'logo.svg'), 'utf8')).replace('red', 'green'))
    await expect.poll(() => page.getByAltText('Logo', { exact: true }).evaluate(async image => (await fetch((image as HTMLImageElement).src)).text())).toContain('green')
    await server.close()
    server = undefined
    const packageName = 'vite-plugin-rempa'
    const { default: builtRempa } = await import(packageName)
    await build({
      ...configuration(builtRempa()),
      build: { assetsInlineLimit: 0 },
    })
    previewServer = await preview(configuration(builtRempa()))
    await page.goto(`${origin(previewServer.httpServer)}${route}`)
    await page.getByRole('heading', { name: 'Special page', exact: true }).waitFor()
    await page.getByText('Updated child', { exact: true }).waitFor()
    await page.getByText('Raw resource loaded', { exact: true }).waitFor()
    await verifyImages()
    expect(errors).toEqual([])
  })

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
