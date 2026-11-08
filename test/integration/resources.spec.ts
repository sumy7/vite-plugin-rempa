import type { InlineConfig, ViteDevServer } from 'vite'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import rempa from '../../src/index.ts'
import { createTemporaryDirectory, testFixturesPlugin } from '../helpers.ts'

const fixtures: string[] = []
const servers: ViteDevServer[] = []
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect id="asset-marker" width="2" height="2" /></svg>'

async function fixture(name: string): Promise<string> {
  const root = await createTemporaryDirectory('resources-')
  fixtures.push(root)
  const directory = path.join(root, 'src/pages', name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(directory, 'config.json'), '{}')
  await writeFile(path.join(directory, 'index.tsx'), `import React from 'react'; import logo from './logo.svg'; import source from './logo.svg?raw'; import './style.css'; export default function Page() { return <img src={logo} data-source={source} className="resource" />; }`)
  await writeFile(path.join(directory, 'logo.svg'), svg)
  await writeFile(path.join(directory, 'style.css'), '.resource { background-image: url("./logo.svg#asset-marker"); color: rgb(3, 4, 5); }')
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
    build: { write: false, minify: false, assetsInlineLimit: 0 },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('resources in URL-unsafe page directories', () => {
  it.each(['with#hash', 'with%percent'])('builds SVG imports, raw queries and relative CSS assets in %s', async (name) => {
    const root = await fixture(name)

    const result = await build(configuration(root))
    if (!('output' in result))
      throw new Error('Expected a single build result')
    const image = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.svg'))
    expect(image?.type).toBe('asset')
    if (!image || image.type !== 'asset')
      throw new Error('Missing SVG asset')
    expect(String(image.source)).toBe(svg)
    const css = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.css'))
    expect(css?.type).toBe('asset')
    if (!css || css.type !== 'asset')
      throw new Error('Missing CSS asset')
    expect(String(css.source)).toContain(path.posix.basename(image.fileName))
    expect(String(css.source)).toContain('#asset-marker')
    expect(result.output.some(file => file.type === 'chunk' && file.code.includes('asset-marker'))).toBe(true)
  })

  it('runs user PostCSS plugins and CSS module scoping only in the normal Vite pipeline', async () => {
    const root = await fixture('with#hash')
    const directory = path.join(root, 'src/pages/with#hash')
    await rename(path.join(directory, 'style.css'), path.join(directory, 'style.module.css'))
    await writeFile(path.join(directory, 'index.tsx'), (await readFile(path.join(directory, 'index.tsx'), 'utf8')).replace('import \'./style.css\'', 'import styles from \'./style.module.css\'').replace('className="resource"', 'className={styles.resource}'))
    let visits = 0

    const result = await build({
      ...configuration(root),
      css: {
        postcss: {
          plugins: [
            {
              postcssPlugin: 'count-user-pipeline',
              Once() { visits++ },
            },
          ],
        },
        modules: {
          generateScopedName: name => `custom_${name}`,
        },
      },
    })

    if (!('output' in result))
      throw new Error('Expected a single build result')
    expect(visits).toBe(1)
    const css = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.css'))
    expect(css?.type).toBe('asset')
    if (!css || css.type !== 'asset')
      throw new Error('Missing CSS asset')
    expect(String(css.source)).toContain('.custom_resource')
    expect(String(css.source)).not.toContain('custom_custom_')
  })

  it.each(['with#hash', 'with%percent'])('serves SVG modules and relative CSS URLs in %s', async (name) => {
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
    const runtimeUrl = [
      ...html.matchAll(/<script[^>]*src="([^"]+)"/g),
    ].map(match => match[1]).find(url => !url.includes('@vite/client'))!
    const runtimeResponse = await fetch(new URL(runtimeUrl, origin))
    expect(runtimeResponse.status).toBe(200)
    const runtime = await runtimeResponse.text()
    const appUrl = [
      ...runtime.matchAll(/from\s*"([^"]+)"/g),
    ].map(match => match[1]).find(url => url.includes('/.rempa/modules/'))!
    const appResponse = await fetch(new URL(appUrl, origin))
    expect(appResponse.status).toBe(200)
    const app = await appResponse.text()
    const imports = [
      ...app.matchAll(/(?:from\s*|import\s*)"([^"]+)"/g),
    ].map(match => match[1])
    const imageUrl = imports.find(url => url.includes('.svg') && !url.includes('raw'))!
    const imageResponse = await fetch(new URL(imageUrl, origin))
    expect(imageResponse.status).toBe(200)
    const imageCode = await imageResponse.text()
    expect(imageCode).toMatch(/export default\s*"/)
    const resourceUrl = JSON.parse(imageCode.match(/export default\s*("(?:[^"\\]|\\.)*")/)![1])
    const resourceResponse = await fetch(new URL(resourceUrl, origin))
    expect(resourceResponse.status).toBe(200)
    expect(resourceResponse.headers.get('content-type')).toContain('image/svg+xml')
    expect(await resourceResponse.text()).toBe(svg)
    const rawUrl = imports.find(url => url.includes('.svg') && url.includes('raw'))!
    const rawResponse = await fetch(new URL(rawUrl, origin))
    expect(rawResponse.status).toBe(200)
    expect(await rawResponse.text()).toContain('asset-marker')
    const cssUrl = imports.find(url => url.includes('.css'))!
    const cssResponse = await fetch(new URL(cssUrl, origin))
    expect(cssResponse.status).toBe(200)
    const cssCode = await cssResponse.text()
    expect(cssCode).toContain('background-image')
    expect(cssCode).toContain(resourceUrl)
    await server.waitForRequestsIdle()
  })
})
