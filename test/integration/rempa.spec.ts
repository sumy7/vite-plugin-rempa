import type { InlineConfig, ViteDevServer } from 'vite'
import type { PluginRempaOptions } from '../../src/types'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, createServer, resolveConfig } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import rempa from '../../src/index'
import { createTemporaryDirectory, testFixturesPlugin } from '../helpers.ts'

const fixtures: string[] = []
const servers: ViteDevServer[] = []

async function write(root: string, name: string, contents: string) {
  const filename = path.join(root, name)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, contents)
}

async function fixture(reactVersion = '18.3.1') {
  const root = await createTemporaryDirectory('rempa-')
  fixtures.push(root)
  await write(root, 'package.json', JSON.stringify({
    type: 'module',
    dependencies: { 'react': reactVersion, 'react-dom': reactVersion },
  }))
  await write(root, 'node_modules/react/package.json', JSON.stringify({
    name: 'react',
    version: reactVersion,
    type: 'module',
    exports: {
      '.': './index.js',
      './jsx-runtime': './jsx-runtime.js',
      './jsx-dev-runtime': './jsx-runtime.js',
      './package.json': './package.json',
    },
  }))
  await write(root, 'node_modules/react/index.js', `
export const Fragment = Symbol.for('react.fragment');
export function createElement(type, props, ...children) { return { type, props, children }; }
export default { Fragment, createElement };
`)
  await write(root, 'node_modules/react/jsx-runtime.js', `
export { Fragment } from './index.js';
export function jsx(type, props) { return { type, props }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
`)
  await write(root, 'node_modules/react-dom/package.json', JSON.stringify({
    name: 'react-dom',
    version: reactVersion,
    type: 'module',
    exports: { '.': './index.js', './client': './client.js' },
  }))
  await write(root, 'node_modules/react-dom/index.js', `
export function render(tree, node) { globalThis.__rempaRender = { tree, node, api: 'legacy-render' }; }
export default { render };
`)
  await write(root, 'node_modules/react-dom/client.js', `
export function createRoot(node) { return { render(tree) { globalThis.__rempaRender = { tree, node, api: 'create-root' }; } }; }
export default { createRoot };
`)
  return root
}

async function page(root: string, name: string, config: Record<string, unknown> = {}, pagesPath = 'src/pages') {
  const directory = path.posix.join(pagesPath, name)
  await write(root, `${directory}/config.json`, JSON.stringify(config))
  await write(root, `${directory}/index.tsx`, `import React from 'react'; export default function Page() { return <div>${name || 'home'}</div>; }`)
}

function viteConfig(root: string, options: PluginRempaOptions = {}, config: InlineConfig = {}): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      testFixturesPlugin(),
      rempa(options),
    ],
    build: { minify: false },
    ...config,
  }
}

async function javascript(root: string, directory = 'dist'): Promise<string> {
  const files = await readdir(path.join(root, directory), { withFileTypes: true })
  const sources = await Promise.all(files.map(async (file) => {
    const name = path.posix.join(directory, file.name)
    if (file.isDirectory())
      return javascript(root, name)
    return file.name.endsWith('.js')
      ? readFile(path.join(root, name), 'utf8')
      : ''
  }))
  return sources.join('\n')
}

async function loadPageModules(html: string, origin: string) {
  const scripts = [
    ...html.matchAll(/<script[^>]*src="([^"]+)"/g),
  ].map(match => match[1])
  const runtimeUrl = scripts.find(src => !src.includes('@vite/client'))
  expect(runtimeUrl).toBeDefined()
  const runtime = await fetch(new URL(runtimeUrl!, origin))
  expect(runtime.status).toBe(200)
  const code = await runtime.text()
  // Follow imports as a browser would, completing Vite's dependency optimization before edits or shutdown.
  const imports = [
    ...code.matchAll(/from\s*"([^"]+)"/g),
  ].map(match => match[1])
  for (const imported of imports) {
    const module = await fetch(new URL(imported, origin))
    expect(module.status).toBe(200)
    await module.text()
  }
  return code
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('rempa Vite integration', () => {
  it('builds root, nested and sibling pages without writing HTML into the source root', async () => {
    const root = await fixture()
    await page(root, '')
    await page(root, 'account/settings', { title: 'Account settings' })
    await page(root, 'about')

    await build(viteConfig(root))

    expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).toContain('<title>index</title>')
    expect(await readFile(path.join(root, 'dist/account/settings.html'), 'utf8')).toContain('<title>Account settings</title>')
    expect(await readFile(path.join(root, 'dist/about.html'), 'utf8')).toContain('<title>about</title>')
    expect(await javascript(root)).toContain('create-root')
    expect(existsSync(path.join(root, 'index.html'))).toBe(false)
    expect(existsSync(path.join(root, 'about.html'))).toBe(false)
    expect(existsSync(path.join(root, 'account/settings.html'))).toBe(false)
  })

  it.each([
    { version: '17.0.2', api: 'legacy-render' },
    { version: '18.3.1', api: 'create-root' },
  ])('executes the generated React $version entry with the configured mount node', async ({ version, api }) => {
    const root = await fixture(version)
    const mountElementId = 'quoted"mount\\id'
    await page(root, 'runtime', { mountElementId })
    await build(viteConfig(root, {}, {
      build: { minify: false, modulePreload: false },
    }))
    const requestedIds: string[] = []
    const node = { id: mountElementId }
    const context = {
      document: {
        getElementById: (id: string) => {
          requestedIds.push(id)
          return node
        },
      },
    }

    runInNewContext(await javascript(root), context)

    expect(requestedIds).toEqual([mountElementId])
    expect(context).toHaveProperty('__rempaRender.api', api)
    expect(context).toHaveProperty('__rempaRender.node', node)
  })

  it('honors global and per-page templates, layouts, aliases, parameters and mount IDs', async () => {
    const root = await fixture()
    const originalTemplate = '<html><head><title><%= title %></title></head><body data-template="root"><div id="<%= mountElementId %>"></div></body></html>'
    await write(root, 'index.html', originalTemplate)
    await write(root, 'global.html', '<html><head><title><%= title %></title></head><body data-template="global"><%= injectScript %><p><%- escapedValue %></p><div id="<%= locals.mountElementId %>"></div></body></html>')
    await write(root, 'custom.html', '<html><head><title><%= locals.title %></title></head><body data-template="page"><div id="<%= mountElementId %>"></div></body></html>')
    await write(root, 'src/layout/Global.tsx', 'import React from "react"; export default function Layout({ children }) { return <section data-layout="global-layout">{children}</section>; }')
    await write(root, 'src/layout/Page.tsx', 'import React from "react"; export default function Layout({ children }) { return <article data-layout="page-layout">{children}</article>; }')
    await page(root, 'global', { mountElementId: 'global-root', injectScript: '<script>globalThis.injected = true</script>', escapedValue: '<b>&</b>' })
    await page(root, 'override', {
      title: 'Override',
      template: 'custom.html',
      layout: '@/layout/Page.tsx',
      mountElementId: 'page-root',
    })

    await build(viteConfig(root, { template: 'global.html', layout: 'src/layout/Global.tsx' }))

    const globalHtml = await readFile(path.join(root, 'dist/global.html'), 'utf8')
    const pageHtml = await readFile(path.join(root, 'dist/override.html'), 'utf8')
    expect(globalHtml).toContain('data-template="global"')
    expect(globalHtml).toContain('id="global-root"')
    expect(globalHtml).toContain('<script>globalThis.injected = true</script>')
    expect(globalHtml).toContain('<p>&lt;b&gt;&amp;&lt;/b&gt;</p>')
    expect(pageHtml).toContain('data-template="page"')
    expect(pageHtml).toContain('<title>Override</title>')
    expect(pageHtml).toContain('id="page-root"')
    const code = await javascript(root)
    expect(code).toContain('global-layout')
    expect(code).toContain('page-layout')
    expect(code).toContain('global-root')
    expect(code).toContain('page-root')
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(originalTemplate)
  })

  it.each([
    {
      options: { localsName: 'pageData' },
      expression: 'pageData.message',
      expected: 'custom locals',
    },
    {
      options: { locals: false },
      expression: 'typeof locals',
      expected: 'undefined',
    },
  ])('respects template locals options: $options', async ({ options, expression, expected }) => {
    const root = await fixture()
    await page(root, 'hello', { message: 'custom locals' })
    await write(root, 'template.html', `<html><head><title><%= title %></title></head><body><p><%= ${expression} %></p><div id="root"></div></body></html>`)

    await build(viteConfig(root, { template: 'template.html', ...options }))

    expect(await readFile(path.join(root, 'dist/hello.html'), 'utf8')).toContain(`<p>${expected}</p>`)
  })

  it.each(['/demo/', './'])('rewrites generated asset URLs for base %s', async (base) => {
    const root = await fixture()
    await page(root, 'nested/page')

    await build(viteConfig(root, {}, { base }))

    const html = await readFile(path.join(root, 'dist/nested/page.html'), 'utf8')
    expect(html).toMatch(base === './'
      ? /src="\.\.\/assets\/[^"\s]+\.js"/
      : /src="\/demo\/assets\/[^"\s]+\.js"/)
    expect(html).not.toContain('.tsx')
  })

  it('uses the project root for default templates, custom pages paths and React version detection', async () => {
    const root = await fixture('17.0.2')
    await write(root, 'public/index.html', '<html><head><title><%= title %></title></head><body data-template="public-fallback"><div id="root"></div></body></html>')
    await page(root, 'old-react', {}, 'screens')

    await build(viteConfig(root, { pagesPath: 'screens' }))

    expect(await readFile(path.join(root, 'dist/old-react.html'), 'utf8')).toContain('data-template="public-fallback"')
    expect(await javascript(root)).toContain('legacy-render')
    expect(await javascript(root)).not.toContain('create-root')
  })

  it.each([
    { aliasAtToSrc: undefined, regex: false },
    { aliasAtToSrc: false, regex: false },
    { aliasAtToSrc: undefined, regex: true },
  ])('keeps existing build inputs and user aliases: $aliasAtToSrc, regex=$regex', async ({ aliasAtToSrc, regex }) => {
    const root = await fixture()
    await page(root, 'generated', { layout: '@/Layout.tsx' })
    await write(root, 'custom/Layout.tsx', 'import React from "react"; export default function Layout({ children }) { return <main data-layout="custom-alias">{children}</main>; }')
    await write(root, 'manual.html', '<html><head><title>Manual page</title></head><body><script type="module" src="/manual.ts"></script></body></html>')
    await write(root, 'manual.ts', 'globalThis.manualPage = true')

    await build(viteConfig(root, { aliasAtToSrc }, {
      resolve: {
        alias: regex
          ? [
              {
                find: /^@(?=\/)/,
                replacement: path.join(root, 'custom'),
              },
            ]
          : {
              '@': path.join(root, 'custom'),
            },
      },
      build: {
        minify: false,
        rollupOptions: {
          input: {
            manual: path.join(root, 'manual.html'),
          },
        },
      },
    }))

    expect(await readFile(path.join(root, 'dist/manual.html'), 'utf8')).toContain('<title>Manual page</title>')
    expect(await readFile(path.join(root, 'dist/generated.html'), 'utf8')).toContain('<title>generated</title>')
    expect(await javascript(root)).toContain('custom-alias')
    const config = await resolveConfig(viteConfig(root, { aliasAtToSrc: false }), 'build')
    expect(config.resolve.alias.some(alias => alias.find === '@')).toBe(false)
  })

  it.each(['array', 'string'])('preserves a legacy user input supplied as %s', async (shape) => {
    const root = await fixture()
    await page(root, 'generated')
    await write(root, 'manual.html', '<html><head><title>Manual input</title></head><body><script type="module" src="/manual.ts"></script></body></html>')
    await write(root, 'manual.ts', 'globalThis.manualInput = true')
    const manual = path.join(root, 'manual.html')

    await build(viteConfig(root, {}, {
      build: {
        rollupOptions: {
          input: shape === 'array'
            ? [manual]
            : manual,
        },
      },
    }))

    expect(await readFile(path.join(root, 'dist/manual.html'), 'utf8')).toContain('<title>Manual input</title>')
    expect(await readFile(path.join(root, 'dist/generated.html'), 'utf8')).toContain('<title>generated</title>')
  })

  it.each(['top-level', 'rolldown'])('preserves a modern Vite input supplied through %s configuration', async (location) => {
    const root = await fixture()
    await page(root, 'generated')
    await write(root, 'manual.html', '<html><head><title>Modern input</title></head><body><script type="module" src="/manual.ts"></script></body></html>')
    await write(root, 'manual.ts', 'globalThis.modernInput = true')
    const input = {
      manual: path.join(root, 'manual.html'),
    }
    const options: InlineConfig = location === 'top-level'
      ? { input }
      : {
          build: {
            rolldownOptions: { input },
          },
        }

    await build(viteConfig(root, {}, options))

    expect(await readFile(path.join(root, 'dist/manual.html'), 'utf8')).toContain('<title>Modern input</title>')
    expect(await readFile(path.join(root, 'dist/generated.html'), 'utf8')).toContain('<title>generated</title>')
  })

  it('serves generated dev HTML through Vite, including nested routes and non-root base', async () => {
    const root = await fixture()
    await page(root, 'hello', { title: 'Dev hello' })
    await page(root, 'nested/detail')
    const server = await createServer(viteConfig(root, {}, {
      base: '/demo/',
      server: { host: '127.0.0.1', port: 0 },
    }))
    servers.push(server)
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP dev server address')
    const origin = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${origin}/demo/hello.html?preview=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('<title>Dev hello</title>')
    expect(html).toContain('/demo/@vite/client')
    expect(await loadPageModules(html, origin)).toContain('hello')
    const nested = await fetch(`${origin}/demo/nested/detail.html`)
    expect(nested.status).toBe(200)
    expect(await nested.text()).toContain('<title>nested/detail</title>')
    const head = await fetch(`${origin}/demo/hello.html`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await fetch(`${origin}/demo/missing.html`)).status).toBe(404)
    expect((await fetch(`${origin}/hello.html`)).status).toBe(404)
    expect((await fetch(`${origin}/demo/hello.html?preview=html-proxy`)).status).toBe(200)
    await server.waitForRequestsIdle()
  })

  it('refreshes page discovery after config changes, page additions and removals', async () => {
    const root = await fixture()
    await page(root, 'initial', { title: 'Before edit' })
    const server = await createServer(viteConfig(root, {}, {
      server: { host: '127.0.0.1', port: 0 },
    }))
    servers.push(server)
    await server.listen()
    const html = async (route: string) => {
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string')
        return ''
      try {
        const origin = `http://127.0.0.1:${address.port}`
        const response = await fetch(`${origin}/${route}`)
        if (response.status !== 200)
          return String(response.status)
        const contents = await response.text()
        await loadPageModules(contents, origin)
        return contents
      }
      catch {
        return ''
      }
    }
    await expect.poll(() => Object.values(server.watcher.getWatched()).some(files => files.includes('config.json'))).toBe(true)
    await expect.poll(() => html('initial.html'), { timeout: 5000 }).toContain('<title>Before edit</title>')

    await write(root, 'src/pages/initial/config.json', JSON.stringify({ title: 'After edit' }))
    await expect.poll(() => html('initial.html'), { timeout: 5000 }).toContain('<title>After edit</title>')

    await write(root, 'src/pages/added/index.tsx', 'export default () => null')
    await write(root, 'src/pages/added/config.json', JSON.stringify({ title: 'Added page' }))
    await expect.poll(() => html('added.html'), { timeout: 5000 }).toContain('<title>Added page</title>')

    await rm(path.join(root, 'src/pages/added/config.json'))
    await expect.poll(() => html('added.html'), { timeout: 5000 }).toBe('404')
  }, 20000)

  it.each(['malformed config', 'missing index.tsx'])('reports a useful error for %s', async (problem) => {
    const root = await fixture()
    if (problem === 'malformed config') {
      await write(root, 'src/pages/broken/config.json', '{ invalid json')
      await write(root, 'src/pages/broken/index.tsx', 'export default () => null')
    }
    else {
      await write(root, 'src/pages/broken/config.json', '{}')
    }

    await expect(build(viteConfig(root))).rejects.toThrow(/broken/)
  })
})
