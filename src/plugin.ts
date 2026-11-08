import type { Plugin, ResolvedConfig } from 'vite'
import type { Page } from './pages.ts'
import type { PluginRempaOptions } from './types.ts'
import path from 'node:path'
import process from 'node:process'
import { normalizePath } from 'vite'
import { collectPages } from './pages.ts'
import { runtimeSource } from './runtime.ts'
import { renderPage } from './template.ts'
import { getReactVersion, isReact18 } from './utils.ts'

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

      const buildInput = userConfig.build?.rolldownOptions?.input ?? userConfig.build?.rollupOptions?.input
      const existingInput = env.command === 'build'
        ? buildInput ?? userConfig.input
        : userConfig.input
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
      const runtimeDependencies = [
        'react',
        modernReact ? 'react-dom/client' : 'react-dom',
      ]
        .filter(dependency => !userConfig.optimizeDeps?.include?.includes(dependency)
          && !userConfig.optimizeDeps?.exclude?.some(excluded => dependency === excluded || dependency.startsWith(`${excluded}/`)))

      // Replace inputs directly to avoid generic config merging of arrays and objects.
      // A build-specific override takes precedence over Vite's shared input option.
      if (env.command === 'build' && buildInput !== undefined) {
        userConfig.build ??= {}
        userConfig.build.rolldownOptions ??= {}
        userConfig.build.rolldownOptions.input = input
      }
      else {
        userConfig.input = input
      }
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

      return {
        appType: 'mpa',
        optimizeDeps: {
          // The scanner cannot read virtual HTML/runtime files, so provide their source dependencies.
          ...(!userConfig.optimizeDeps?.entries
            ? {
                entries: pages.map(page => page.entryPath),
              }
            : {}),
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
      const watcher = server.watcher
      watcher.add([pagesPath, ...templates])
      const onFile = (_event: string, file: string): void => {
        const relative = path.relative(pagesPath, file)
        if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(file) === 'config.json') {
          void server.restart().catch(error => config.logger.error(String(error)))
        }
        else if (templates.includes(file)) {
          server.ws.send({ type: 'full-reload', path: '*' })
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
          const html = await server.transformIndexHtml(`/${page.name}.html`, renderPage(page, options), req.originalUrl)
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
