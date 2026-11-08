import type { InlineConfig, Rolldown, ViteDevServer } from 'vite'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import rempa from '../../src/index.ts'
import { write, writePage } from '../helpers.ts'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const directories: string[] = []
const servers: ViteDevServer[] = []
const watchers: Rolldown.RolldownWatcher[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(projectRoot, '.rempa-test-lifecycle-'))
  directories.push(root)
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, 'node_modules/react/package.json', JSON.stringify({
    name: 'react',
    version: '19.3.1',
    type: 'module',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
      './jsx-runtime': './index.js',
      './jsx-dev-runtime': './index.js',
    },
  }))
  await write(root, 'node_modules/react/index.js', `
export const Fragment = Symbol.for('react.fragment');
export function createElement(type, props, ...children) { return { type, props, children }; }
export const jsx = createElement;
export const jsxs = createElement;
export const jsxDEV = createElement;
export default { Fragment, createElement };
`)
  await write(root, 'node_modules/react-dom/package.json', JSON.stringify({
    name: 'react-dom',
    type: 'module',
    exports: { './client': './client.js' },
  }))
  await write(root, 'node_modules/react-dom/client.js', 'export function createRoot() { return { render() {} }; }')
  return root
}

function configuration(root: string, options: InlineConfig = {}): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      rempa(),
    ],
    server: { host: '127.0.0.1', port: 0 },
    ...options,
  }
}

function origin(server: ViteDevServer): string {
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a listening HTTP server')
  return `http://127.0.0.1:${address.port}`
}

function nextBuild(watcher: Rolldown.RolldownWatcher): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>
    const onEvent = (event: { code: string, error?: unknown }): void => {
      if (event.code !== 'END' && event.code !== 'ERROR')
        return
      clearTimeout(timeout)
      watcher.off('event', onEvent)
      if (event.code === 'ERROR')
        reject(event.error)
      else
        resolve()
    }
    timeout = setTimeout(() => {
      watcher.off('event', onEvent)
      reject(new Error('Timed out waiting for build watch'))
    }, 5000)
    watcher.on('event', onEvent)
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(watchers.splice(0).map(watcher => watcher.close()))
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('vite configuration and build lifecycle', () => {
  it.each([false, true])('serves pages through a symlink root with preserveSymlinks=%s', async (preserveSymlinks) => {
    const root = await fixture()
    await writePage(root, 'about', { title: 'Linked application' })
    const link = `${root}-link`
    directories.push(link)
    await symlink(root, link, 'junction')
    const server = await createServer(configuration(link, {
      resolve: { preserveSymlinks },
    }))
    servers.push(server)
    await server.listen()

    const response = await fetch(`${origin(server)}/about.html`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Linked application</title>')
    await server.waitForRequestsIdle()
  })

  it.each([false, true])('builds pages through a symlink root with preserveSymlinks=%s', async (preserveSymlinks) => {
    const root = await fixture()
    await writePage(root, 'about', { title: 'Linked production' })
    const link = `${root}-link`
    directories.push(link)
    await symlink(root, link, 'junction')

    await build(configuration(link, {
      resolve: { preserveSymlinks },
    }))

    expect(await readFile(path.join(root, 'dist/about.html'), 'utf8')).toContain('<title>Linked production</title>')
  })

  it('reuses inline configuration after restarts and removes obsolete generated inputs', async () => {
    const root = await fixture()
    await writePage(root, 'kept')
    await writePage(root, 'removed')
    await write(root, 'manual.html', '<html><head><title>Manual page</title></head><body>Manual page</body></html>')
    const inlineConfig = configuration(root, {
      input: {
        manual: path.join(root, 'manual.html'),
      },
    })
    const server = await createServer(inlineConfig)
    servers.push(server)
    await server.listen()
    await server.restart()
    await server.restart()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    await rm(path.join(root, 'src/pages/removed/config.json'))

    await build(inlineConfig)

    expect(existsSync(path.join(root, 'dist/removed.html'))).toBe(false)
    expect(await readFile(path.join(root, 'dist/kept.html'), 'utf8')).toContain('<title>kept</title>')
    expect(await readFile(path.join(root, 'dist/manual.html'), 'utf8')).toContain('<title>Manual page</title>')
  })

  it.each(['string', 'array'])('keeps inferred JavaScript entry names for a %s input', async (shape) => {
    const root = await fixture()
    await writePage(root, 'generated')
    await write(root, 'manual.js', 'globalThis.manualEntry = true')
    const manual = path.join(root, 'manual.js')

    await build(configuration(root, {
      input: shape === 'string'
        ? manual
        : [manual],
      build: {
        rolldownOptions: {
          output: { entryFileNames: '[name].js' },
        },
      },
    }))

    expect(await readFile(path.join(root, 'dist/manual.js'), 'utf8')).toContain('manualEntry')
    expect(existsSync(path.join(root, 'dist/generated.html'))).toBe(true)
  })

  it('keeps generated pages when the client environment overrides build inputs', async () => {
    const root = await fixture()
    await writePage(root, 'generated')
    await write(root, 'manual.html', '<html><head><title>Client input</title></head><body>Manual page</body></html>')

    await build(configuration(root, {
      environments: {
        client: {
          build: {
            rolldownOptions: {
              input: {
                manual: path.join(root, 'manual.html'),
              },
            },
          },
        },
      },
    }))

    expect(await readFile(path.join(root, 'dist/manual.html'), 'utf8')).toContain('<title>Client input</title>')
    expect(await readFile(path.join(root, 'dist/generated.html'), 'utf8')).toContain('<title>generated</title>')
  })

  it('refreshes page metadata when a watched configuration triggers a rebuild', async () => {
    const root = await fixture()
    await writePage(root, 'watched', { title: 'Before update', mountElementId: 'initial-node' })
    const result = await build(configuration(root, {
      build: { watch: {}, modulePreload: false },
    }))
    if (Array.isArray(result) || !('on' in result))
      throw new Error('Expected a Vite build watcher')
    const watcher = result as Rolldown.RolldownWatcher
    watchers.push(watcher)
    await nextBuild(watcher)
    expect(await readFile(path.join(root, 'dist/watched.html'), 'utf8')).toContain('<title>Before update</title>')
    const rebuilt = nextBuild(watcher)

    await write(root, 'src/pages/watched/config.json', '{"title":"After update","mountElementId":"updated-node"}')
    await rebuilt

    const html = await readFile(path.join(root, 'dist/watched.html'), 'utf8')
    expect(html).toContain('<title>After update</title>')
    expect(html).toContain('id="updated-node"')
    const runtime = html.match(/src="\/([^"]+\.js)"/)?.[1]
    expect(runtime).toBeDefined()
    const mountedIds: string[] = []
    runInNewContext(await readFile(path.join(root, 'dist', runtime!), 'utf8'), {
      document: {
        getElementById: (id: string) => {
          mountedIds.push(id)
          return { id }
        },
      },
    })
    expect(mountedIds).toEqual(['updated-node'])
  })
})
