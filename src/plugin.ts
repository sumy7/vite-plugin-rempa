import type { Plugin, ResolvedConfig } from 'vite'
import type { Page } from './pages.ts'
import type { PluginRempaOptions } from './types.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { normalizePath } from 'vite'
import { createPageModules } from './modules.ts'
import { collectPages, encodePageUrl } from './pages.ts'
import { createPageResources } from './resources.ts'
import { runtimeSource } from './runtime.ts'
import { renderPage } from './template.ts'
import { getReactVersion, isReact18 } from './utils.ts'

/** Discover React pages and expose them as Vite HTML entries. */
export function pluginRempa(options: PluginRempaOptions = {}): Plugin {
  let pages: Page[] = []
  let config: ResolvedConfig
  let pagesPath: string
  let modernReact = false
  let pageModules: ReturnType<typeof createPageModules>
  let resources: ReturnType<typeof createPageResources>
  const moduleFiles = new Set<string>()
  const htmlPages = new Map<string, Page>()
  const runtimePages = new Map<string, Page>()

  async function refreshPages(): Promise<void> {
    const nextPages = await collectPages(config.root, pagesPath, options)
    pages = nextPages
    htmlPages.clear()
    runtimePages.clear()
    for (const page of pages) {
      htmlPages.set(page.htmlPath, page)
      runtimePages.set(page.runtimePath, page)
      runtimePages.set(page.runtimeUrl, page)
      runtimePages.set(decodeURIComponent(page.runtimeUrl), page)
    }
  }

  return {
    name: 'vite-plugin-rempa',
    enforce: 'pre',
    config(userConfig) {
      const root = path.resolve(userConfig.root ?? process.cwd())
      const aliases = userConfig.resolve?.alias
      const hasAtAlias = Array.isArray(aliases)
        ? aliases.some(alias => alias.find === '@')
        : aliases && Object.hasOwn(aliases, '@')
      if (options.aliasAtToSrc !== false && !hasAtAlias) {
        userConfig.resolve ??= {}
        const replacement = normalizePath(path.resolve(root, 'src'))
        userConfig.resolve.alias = Array.isArray(aliases)
          ? [
              ...aliases,
              { find: '@', replacement },
            ]
          : { ...aliases, '@': replacement }
      }

      return { appType: 'mpa' }
    },
    async configResolved(resolvedConfig) {
      config = resolvedConfig
      pageModules = createPageModules(config.root)
      resources = createPageResources(config)
      moduleFiles.clear()
      pagesPath = path.resolve(config.root, options.pagesPath ?? 'src/pages')
      await refreshPages()
      if (!getReactVersion(config.root))
        throw new Error(`[vite-plugin-rempa] Cannot resolve React from ${config.root}; install react and react-dom in the app`)
      modernReact = isReact18(config.root)
      const dependencies = config.environments.client.optimizeDeps
      dependencies.entries ??= pages.map(page => page.entryPath)
      const runtimeDependencies = [
        'react',
        modernReact ? 'react-dom/client' : 'react-dom',
      ]
        .filter(dependency => !dependencies.include?.includes(dependency)
          && !dependencies.exclude?.some(excluded => dependency === excluded || dependency.startsWith(`${excluded}/`)))
      dependencies.include = [
        ...dependencies.include ?? [],
        ...runtimeDependencies,
      ]
    },
    options(bundlerOptions) {
      if (this.environment.name !== 'client')
        return null
      // Merge the effective environment inputs without changing the reusable caller config.
      const environment = this.environment.config
      const original = environment.build.rolldownOptions.input ?? environment.input
      const generated = pages.map(page => page.htmlPath)
      if (original === undefined || typeof original === 'string' || Array.isArray(original)) {
        const entries = typeof original === 'string'
          ? [original]
          : original ?? []
        return {
          ...bundlerOptions,
          input: [
            ...new Set([
              ...entries,
              ...generated,
            ]),
          ],
        }
      }
      const input = { ...original }
      for (const page of pages) {
        if (Object.values(input).includes(page.htmlPath))
          continue
        let key = page.name
        while (key in input)
          key = `rempa-${key}`
        input[key] = page.htmlPath
      }
      return { ...bundlerOptions, input }
    },
    async buildStart() {
      if (this.environment.name === 'client' && this.environment.mode === 'build' && this.environment.config.build.watch) {
        await refreshPages()
      }
    },
    async watchChange(id) {
      if (this.environment.name === 'client' && this.environment.mode === 'build')
        await resources.refresh(id)
    },
    async resolveId(id, importer) {
      if (htmlPages.has(normalizePath(id)))
        return normalizePath(id)
      const runtime = runtimePages.get(normalizePath(id))
      if (runtime)
        return runtime.runtimePath
      if (pageModules.get(id))
        return id
      const source = importer && (pageModules.get(importer) ?? runtimePages.get(normalizePath(importer))?.entryPath)
      if (source) {
        const resolved = await this.resolve(id, source, { skipSelf: true })
        if (resolved && !resolved.external) {
          const filename = resolved.id.split('?')[0]
          if (/[#%]/.test(filename)) {
            const isSource = /\.(?:[cm]?[jt]sx?|json)$/i.test(filename) && !/[?&](?:raw|url)(?:[=&]|$)/.test(resolved.id)
            const safeId = isSource
              ? pageModules.register(filename)
              : await resources.materialize(filename)
            return { ...resolved, id: safeId + resolved.id.slice(filename.length) }
          }
        }
        return resolved
      }
    },
    load(id) {
      if (resources.get(id)) {
        for (const file of resources.dependencies(id))
          this.addWatchFile(file)
        return null
      }
      const page = htmlPages.get(normalizePath(id))
      if (page) {
        this.addWatchFile(page.configPath)
        if (page.template)
          this.addWatchFile(page.template)
        return renderPage(page, options)
      }
      const runtime = runtimePages.get(normalizePath(id))
      if (runtime) {
        this.addWatchFile(runtime.configPath)
        const entry = /[#%?]/.test(runtime.entryPath)
          ? pageModules.register(runtime.entryPath)
          : runtime.entryPath
        return runtimeSource(runtime, modernReact, entry)
      }
      const source = pageModules.get(id)
      if (source) {
        this.addWatchFile(source)
        moduleFiles.add(source)
        return readFileSync(source, 'utf8')
      }
    },
    configureServer(server) {
      const templates = pages.filter(page => page.template).map(page => page.template)
      const watcher = server.watcher
      watcher.add([pagesPath, ...templates])
      const onFile = (_event: string, file: string): void => {
        const relative = path.relative(pagesPath, file)
        if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(file) === 'config.json') {
          void server.restart().catch(error => config.logger.error(String(error)))
        }
        else {
          const reload = async (): Promise<void> => {
            const resourcesChanged = await resources.refresh(normalizePath(file))
            const sourceChanged = moduleFiles.has(normalizePath(file))
            if (!resourcesChanged.length && !sourceChanged && !templates.includes(file))
              return
            const graph = server.environments.client.moduleGraph
            if (sourceChanged) {
              const module = graph.getModuleById(pageModules.register(file))
              if (module)
                graph.invalidateModule(module, undefined, Date.now(), true)
            }
            for (const id of resourcesChanged) {
              for (const module of graph.getModulesByFile(id) ?? [])
                graph.invalidateModule(module, undefined, Date.now(), true)
            }
            server.ws.send({ type: 'full-reload', path: '*' })
          }
          void reload().catch(error => config.logger.error(String(error)))
        }
      }
      watcher.on('all', onFile)
      server.httpServer?.once('close', () => watcher.off('all', onFile))

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
          const route = pathname.endsWith('/')
            ? `${pathname}index.html`
            : pathname.endsWith('.html')
              ? pathname
              : `${pathname}.html`
          const page = htmlPages.get(normalizePath(path.resolve(config.root, `.${route}`)))
          if (!page)
            return next()
          const html = await server.transformIndexHtml(`/${encodePageUrl(page.name)}.html`, renderPage(page, options), req.originalUrl)
          for (const [name, value] of Object.entries(config.server.headers ?? {})) {
            if (value !== undefined)
              res.setHeader(name, value)
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(req.method === 'HEAD'
            ? undefined
            : html)
        }
        catch (error) {
          next(error)
        }
      })
    },
  }
}
