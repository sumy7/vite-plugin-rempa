import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ejs from 'ejs'
import { glob } from 'glob'
import type { Plugin, ResolvedConfig } from 'vite'
import { normalizePath } from 'vite'
import type { PageEntry, PluginRempaOptions } from './types'
import { getReactVersion, isReact18 } from './utils'

export type { PageEntry, PluginRempaOptions } from './types'

const RUNTIME_PREFIX = '/@rempa/'

interface Page extends PageEntry {
  configPath: string
  htmlPath: string
  runtimePath: string
  runtimeUrl: string
}

function defaultTemplate(root: string): string {
  return ['index.html', 'public/index.html']
    .map(file => path.resolve(root, file))
    .find(file => existsSync(file)) ?? ''
}

function resolveLayout(root: string, layout: string): string {
  if (!layout)
    return ''
  // Leave aliases and package imports to Vite's resolver.
  return layout.startsWith('.') || path.isAbsolute(layout) || existsSync(path.resolve(root, layout))
    ? normalizePath(path.resolve(root, layout))
    : layout
}

async function collectPages(root: string, pagesPath: string, options: PluginRempaOptions): Promise<Page[]> {
  const files = (await glob('**/config.json', { cwd: pagesPath, nodir: true })).sort()
  const template = options.template ?? defaultTemplate(root)
  const pages = files.map((file): Page => {
    const configPath = path.resolve(pagesPath, file)
    let config: Record<string, unknown>
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Expected a JSON object')
    }
    catch (error) {
      throw new Error(`[vite-plugin-rempa] Invalid page config ${configPath}: ${String(error)}`)
    }
    const directory = path.posix.dirname(normalizePath(file))
    const name = directory === '.' ? 'index' : directory
    const entryPath = path.resolve(pagesPath, directory, 'index.tsx')
    if (!existsSync(entryPath))
      throw new Error(`[vite-plugin-rempa] Missing page entry ${entryPath} (from ${configPath})`)

    const { title = name, layout = options.layout ?? '', template: pageTemplate = template, ...parameters } = config
    for (const [key, value] of Object.entries({ title, layout, template: pageTemplate })) {
      if (typeof value !== 'string')
        throw new TypeError(`[vite-plugin-rempa] ${key} must be a string in ${configPath}`)
    }
    const mountElementId = parameters.mountElementId ?? 'root'
    if (typeof mountElementId !== 'string' || !mountElementId)
      throw new TypeError(`[vite-plugin-rempa] mountElementId must be a non-empty string in ${configPath}`)

    const resolvedTemplate = pageTemplate ? path.resolve(root, pageTemplate as string) : ''
    if (resolvedTemplate && !existsSync(resolvedTemplate))
      throw new Error(`[vite-plugin-rempa] Missing template ${resolvedTemplate} (from ${configPath})`)

    return {
      name,
      entryPath: normalizePath(entryPath),
      layout: resolveLayout(root, layout as string),
      title: (title as string) || name,
      template: resolvedTemplate,
      pageConfig: { ...parameters, title: (title as string) || name, mountElementId },
      configPath,
      htmlPath: normalizePath(path.resolve(root, `${name}.html`)),
      runtimePath: normalizePath(path.resolve(root, '.rempa', `${name}.tsx`)),
      runtimeUrl: `${RUNTIME_PREFIX}${name}.tsx`,
    }
  })
  if (!pages.length)
    throw new Error(`[vite-plugin-rempa] No pages found in ${pagesPath}; add a config.json and index.tsx`)
  const names = new Set<string>()
  for (const page of pages) {
    if (names.has(page.name))
      throw new Error(`[vite-plugin-rempa] Duplicate page name "${page.name}" in ${pagesPath}`)
    names.add(page.name)
  }
  return pages
}

function runtimeSource(page: Page, modernReact: boolean): string {
  return `import React from 'react';
import * as ReactDOM from '${modernReact ? 'react-dom/client' : 'react-dom'}';
import App from ${JSON.stringify(page.entryPath)};
${page.layout ? `import Layout from ${JSON.stringify(page.layout)};` : 'const Layout = React.Fragment;'}
const element = document.getElementById(${JSON.stringify(page.pageConfig.mountElementId)});
if (!element) throw new Error(${JSON.stringify(`[vite-plugin-rempa] Missing mount element for page ${page.name}`)});
${modernReact ? 'ReactDOM.createRoot(element).render(<Layout><App /></Layout>);' : 'ReactDOM.render(<Layout><App /></Layout>, element);'}
`
}

function renderPage(page: Page, options: PluginRempaOptions): string {
  const data = { ...page.pageConfig }
  if (options.locals ?? true)
    data[options.localsName ?? 'locals'] = { ...page.pageConfig }

  // Lodash/Rsbuild and EJS assign opposite escaping behavior to = and -.
  const html = page.template
    ? ejs.render(readFileSync(page.template, 'utf8').replace(/<%([=-])/g, (_, delimiter) => delimiter === '=' ? '<%-' : '<%='), data, {
        filename: page.template,
        localsName: '__rempaTemplateData',
      })
    : `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${ejs.escapeXML(page.title)}</title></head>
<body><div id="${ejs.escapeXML(page.pageConfig.mountElementId as string)}"></div></body></html>`
  const script = `<script type="module" src="${page.runtimeUrl}"></script>`
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}\n</body>`) : `${html}\n${script}`
}

/** Discover React pages and expose them as Vite HTML entries. */
export function pluginRempa(options: PluginRempaOptions = {}): Plugin {
  let pages: Page[] = []
  let config: ResolvedConfig
  let pagesPath: string
  let modernReact = false
  const htmlPages = new Map<string, Page>()
  const runtimePages = new Map<string, Page>()

  return {
    name: 'vite-plugin-rempa',
    enforce: 'pre',
    async config(userConfig, env) {
      const root = path.resolve(userConfig.root ?? process.cwd())
      pagesPath = path.resolve(root, options.pagesPath ?? 'src/pages')
      pages = await collectPages(root, pagesPath, options)
      if (!getReactVersion(root))
        throw new Error(`[vite-plugin-rempa] Cannot resolve React from ${root}; install react and react-dom in the app`)
      modernReact = isReact18(root)
      htmlPages.clear()
      runtimePages.clear()
      for (const page of pages) {
        htmlPages.set(page.htmlPath, page)
        runtimePages.set(page.runtimePath, page)
        runtimePages.set(page.runtimeUrl, page)
      }

      const existingInput = userConfig.build?.rollupOptions?.input
      const input = typeof existingInput === 'string'
        ? { main: existingInput }
        : Array.isArray(existingInput)
          ? Object.fromEntries(existingInput.map((value, index) => [`entry${index}`, value]))
          : { ...existingInput }
      for (const page of pages) {
        // HTML filenames depend on paths, so keep unrelated inputs even on key collisions.
        let key = page.name
        while (key in input)
          key = `rempa-${key}`
        input[key] = page.htmlPath
      }
      const aliases = userConfig.resolve?.alias
      const hasAtAlias = Array.isArray(aliases)
        ? aliases.some(alias => alias.find === '@')
        : aliases && Object.hasOwn(aliases, '@')
      const runtimeDependencies = ['react', modernReact ? 'react-dom/client' : 'react-dom']
        .filter(dependency => !userConfig.optimizeDeps?.include?.includes(dependency)
          && !userConfig.optimizeDeps?.exclude?.some(excluded => dependency === excluded || dependency.startsWith(`${excluded}/`)))

      // Replace mixed input shapes directly: Vite's generic merge concatenates arrays and objects.
      if (env.command === 'build') {
        userConfig.build ??= {}
        userConfig.build.rollupOptions ??= {}
        userConfig.build.rollupOptions.input = input
      }
      if (options.aliasAtToSrc !== false && !hasAtAlias) {
        userConfig.resolve ??= {}
        const replacement = normalizePath(path.resolve(root, 'src'))
        userConfig.resolve.alias = Array.isArray(aliases)
          ? [...aliases, { find: '@', replacement }]
          : { ...aliases, '@': replacement }
      }

      return {
        appType: 'mpa',
        optimizeDeps: {
          // The scanner cannot read virtual HTML/runtime files, so provide their source dependencies.
          ...(!userConfig.optimizeDeps?.entries ? { entries: pages.map(page => page.entryPath) } : {}),
          include: runtimeDependencies,
        },
      }
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    resolveId(id) {
      if (htmlPages.has(normalizePath(id)))
        return normalizePath(id)
      return runtimePages.get(normalizePath(id))?.runtimePath
    },
    load(id) {
      const page = htmlPages.get(normalizePath(id))
      if (page) {
        this.addWatchFile(page.configPath)
        if (page.template)
          this.addWatchFile(page.template)
        return renderPage(page, options)
      }
      const runtime = runtimePages.get(normalizePath(id))
      if (runtime)
        return runtimeSource(runtime, modernReact)
    },
    configureServer(server) {
      const templates = pages.filter(page => page.template).map(page => page.template)
      server.watcher.add([pagesPath, ...templates])
      const onFile = (_event: string, file: string): void => {
        const relative = path.relative(pagesPath, file)
        if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(file) === 'config.json') {
          void server.restart().catch(error => config.logger.error(String(error)))
        }
        else if (templates.includes(file)) {
          server.ws.send({ type: 'full-reload', path: '*' })
        }
      }
      server.watcher.on('all', onFile)
      server.httpServer?.once('close', () => server.watcher.off('all', onFile))

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !['GET', 'HEAD'].includes(req.method ?? ''))
          return next()
        try {
          const url = new URL(req.url, 'http://rempa.local')
          if (url.searchParams.has('html-proxy'))
            return next()
          let pathname = decodeURIComponent(url.pathname)
          if (config.base !== '/') {
            if (!pathname.startsWith(config.base))
              return next()
            pathname = pathname.slice(config.base.length - 1)
          }
          const route = pathname.endsWith('/') ? `${pathname}index.html` : pathname.endsWith('.html') ? pathname : `${pathname}.html`
          const page = htmlPages.get(normalizePath(path.resolve(config.root, `.${route}`)))
          if (!page)
            return next()
          const html = await server.transformIndexHtml(`/${page.name}.html`, renderPage(page, options), req.originalUrl)
          for (const [name, value] of Object.entries(config.server.headers ?? {})) {
            if (value !== undefined)
              res.setHeader(name, value)
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(req.method === 'HEAD' ? undefined : html)
        }
        catch (error) {
          next(error)
        }
      })
    },
  }
}

export default pluginRempa
