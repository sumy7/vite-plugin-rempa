import type { Browser, Page as BrowserPage } from 'playwright'
import type { InlineConfig, PreviewServer, ViteDevServer } from 'vite'
import { cp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { build, createServer, preview } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import rempa from '../src/index.ts'
import { createTemporaryDirectory, testFixturesPlugin, write } from '../test/helpers.ts'

const example = fileURLToPath(new URL('../examples/vue/', import.meta.url))
let fixture: string
let browser: Browser
let page: BrowserPage
let server: ViteDevServer | undefined
let previewServer: PreviewServer | undefined
const errors: string[] = []
const diagnostics: string[] = []

function origin(httpServer: ViteDevServer['httpServer']): string {
  const address = httpServer?.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a listening HTTP server')
  return `http://127.0.0.1:${address.port}`
}

function configuration(plugin = rempa()): InlineConfig {
  return {
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    base: '/rempa/',
    plugins: [
      testFixturesPlugin(),
      vue(),
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
  fixture = await createTemporaryDirectory('vue-browser-')
  await cp(path.join(example, 'src'), path.join(fixture, 'src'), { recursive: true })
  await write(fixture, 'package.json', '{"type":"module","dependencies":{"vue":"*"}}')
  await write(fixture, 'node_modules/react/package.json', '{"name":"react","exports":{}}')
  errors.length = 0
  diagnostics.length = 0
  page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400)
      diagnostics.push(`${response.status()} ${response.url()}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error')
      diagnostics.push(`${message.text()} ${message.location().url}`)
  })
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

async function verifyPages(url: string): Promise<void> {
  await page.goto(`${url}/rempa/`)
  await page.getByRole('heading', { name: 'Vue multi-page example', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Count: 0', exact: true }).click()
  await page.getByRole('button', { name: 'Count: 1', exact: true }).waitFor()
  await page.goto(`${url}/rempa/hello-world.html`)
  await page.locator('#app').getByRole('heading', { name: 'Hello World', exact: true }).waitFor()
  await page.getByText('Shared layout', { exact: true }).waitFor()
  expect(await page.title()).toBe('Hello World')
  await page.goto(`${url}/rempa/admin/users.html`)
  await page.getByRole('heading', { name: 'Users', exact: true }).waitFor()
  await page.getByText('Ada', { exact: true }).waitFor()
}

describe('vue example in a real browser', () => {
  it('mounts root, nested and slotted pages and preserves state during template hot updates', async () => {
    server = await createServer(configuration())
    await server.listen()
    const url = origin(server.httpServer)
    await verifyPages(url)
    await page.goto(`${url}/rempa/`)
    await page.getByRole('button', { name: 'Count: 0', exact: true }).click()
    const filename = 'src/pages/index.vue'
    await write(fixture, filename, (await readFile(path.join(fixture, filename), 'utf8')).replace('Count:', 'Updated count:'))
    await page.getByRole('button', { name: 'Updated count: 1', exact: true }).waitFor()
    expect(errors).toEqual([])
  })

  it.each(['esm', 'cjs'])('renders production Vue pages through the %s package export', async (format) => {
    const packageName = 'vite-plugin-rempa'
    const plugin = format === 'esm'
      ? (await import(packageName)).default
      : createRequire(import.meta.url)(packageName).default
    await build(configuration(plugin()))
    previewServer = await preview(configuration(plugin()))
    await verifyPages(origin(previewServer.httpServer))
    expect(errors).toEqual([])
  })

  it.each(['with#hash', 'with%percent'])('mounts SFCs, relative children and scoped CSS in %s', async (name) => {
    await write(fixture, `src/pages/${name}/config.json`, '{}')
    await write(fixture, `src/pages/${name}/index.vue`, `<script setup lang="ts">import Child from './Child.vue'; import External from './External.vue'; import type { Props } from './types'; defineProps<Props>()</script><template><main><h1>Special Vue page</h1><Child /><External /><img src="./logo.svg" alt="Logo" /></main></template><style scoped>main { color: rgb(1, 2, 3); background-image: url("./logo.svg"); }</style>`)
    await write(fixture, `src/pages/${name}/External.vue`, '<script src="./logic.js"></script><template><p>{{ message }}</p></template>')
    await write(fixture, `src/pages/${name}/logic.js`, 'export default { data() { return { message: "External script" } } }')
    await write(fixture, `src/pages/${name}/Child.vue`, '<template><p>Child component</p></template>')
    await write(fixture, `src/pages/${name}/types.ts`, 'export interface Props { message?: string }')
    await write(fixture, `src/pages/${name}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" /></svg>')
    server = await createServer(configuration())
    await server.listen()
    const route = `/rempa/${encodeURIComponent(name)}.html`
    await page.goto(`${origin(server.httpServer)}${route}`)
    let externalMessage = 'External script'
    const verifyPage = async (): Promise<void> => {
      await page.getByRole('heading', { name: 'Special Vue page', exact: true }).waitFor().catch((error) => {
        throw new Error(`${error.message}\nBrowser errors: ${[
          ...errors,
          ...diagnostics,
        ].join('\n')}`)
      })
      await page.getByText('Child component', { exact: true }).waitFor()
      await page.getByText(externalMessage, { exact: true }).waitFor()
      await expect.poll(async () => {
        try {
          return await page.locator('main').evaluate(async (element) => {
            const background = getComputedStyle(element).backgroundImage
            const url = background.match(/url\(["']?(.*?)["']?\)/)?.[1]
            if (!url)
              return 0
            const image = new Image()
            image.src = url
            await image.decode()
            return image.naturalWidth
          })
        }
        catch {
          return 0
        }
      }).toBe(10)
      await expect.poll(() => page.getByAltText('Logo', { exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(10)
      await expect.poll(async () => {
        try {
          return await page.locator('main').evaluate(element => getComputedStyle(element).color)
        }
        catch {
          return ''
        }
      }).toBe('rgb(1, 2, 3)')
    }
    await verifyPage()
    const logic = `src/pages/${name}/logic.js`
    await write(fixture, logic, (await readFile(path.join(fixture, logic), 'utf8')).replace('External script', 'Updated external script'))
    externalMessage = 'Updated external script'
    await verifyPage()
    await server.close()
    server = undefined
    await build(configuration())
    previewServer = await preview(configuration())
    await page.goto(`${origin(previewServer.httpServer)}${route}`)
    await verifyPage()
    expect(errors).toEqual([])
  })
})
