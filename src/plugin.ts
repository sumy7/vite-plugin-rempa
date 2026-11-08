import type { Api as VuePluginApi } from '@vitejs/plugin-vue'
import type { Plugin, ResolvedConfig } from 'vite'
import type { Page } from './pages.ts'
import type { PluginRempaOptions } from './types.ts'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { normalizePath } from 'vite'
import { createPageModules } from './modules.ts'
import { collectPages, encodePageUrl } from './pages.ts'
import { createPageResources } from './resources.ts'
import { runtimeSource } from './runtime.ts'
import { renderPage } from './template.ts'
import { getReactVersion, isReact18, resolveFramework } from './utils.ts'

/** Discover pages and expose them as Vite HTML entries. */
export function pluginRempa(options: PluginRempaOptions = {}): Plugin {
  let pages: Page[] = []
  let config: ResolvedConfig
  let pagesPath: string
  let modernReact = false
  let framework: 'react' | 'vue'
  let pageModules: ReturnType<typeof createPageModules>
  let resources: ReturnType<typeof createPageResources>
  const moduleFiles = new Set<string>()
  const htmlPages = new Map<string, Page>()
  const runtimePages = new Map<string, Page>()

  async function refreshPages(): Promise<void> {
    const nextPages = await collectPages(config.root, pagesPath, { ...options, framework })
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
      framework = resolveFramework(config.root, options.framework)
      pageModules = createPageModules(config.root)
      resources = createPageResources(config)
      moduleFiles.clear()
      pagesPath = path.resolve(config.root, options.pagesPath ?? 'src/pages')
      await refreshPages()
      if (framework === 'vue') {
        const vue = config.plugins.find(plugin => plugin.name === 'vite:vue') as Plugin<VuePluginApi> | undefined
        if (vue?.api) {
          const vueOptions = vue.api.options
          const compiler = vueOptions.compiler
          vue.api.options = {
            ...vueOptions,
            compiler: {
              ...compiler,
              compileScript(descriptor, scriptOptions) {
                // Type imports are resolved by Vue's compiler rather than Vite's resolver.
                // Keep URL-safe module IDs while resolving types from the original SFC.
                const filename = pageModules.get(descriptor.filename)
                return compiler.compileScript(filename
                  ? { ...descriptor, filename }
                  : descriptor, scriptOptions)
              },
              compileTemplate(templateOptions) {
                const assets = templateOptions.transformAssetUrls
                const userAssets = vueOptions.template?.transformAssetUrls
                if (pageModules.get(templateOptions.filename) && assets !== false
                  && !(typeof userAssets === 'object' && 'base' in userAssets)) {
                  // Resolve relative assets as imports, instead of URLs under the virtual directory.
                  templateOptions = {
                    ...templateOptions,
                    transformAssetUrls: {
                      ...(typeof assets === 'object'
                        ? assets
                        : {}),
                      base: null,
                    },
                  }
                }
                return compiler.compileTemplate(templateOptions)
              },
            },
          }
        }
      }
      if (framework !== 'vue' && !getReactVersion(config.root))
        throw new Error(`[vite-plugin-rempa] Cannot resolve React from ${config.root}; install react and react-dom in the app`)
      modernReact = framework !== 'vue' && isReact18(config.root)
      const dependencies = config.environments.client.optimizeDeps
      dependencies.entries ??= pages.map(page => page.entryPath)
      const runtimeDependencies = (framework === 'vue'
        ? ['vue']
        : [
            'react',
            modernReact ? 'react-dom/client' : 'react-dom',
          ])
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
          let resolvedId = resolved.id
          // Vite may insert a dependency version before a literal # in a filename.
          const versionedHash = /^([^?]+)\?(v=[^#]+)#([^?]+)(\?.*)?$/.exec(resolvedId)
          if (versionedHash) {
            const file = `${versionedHash[1]}#${versionedHash[3]}`
            if (existsSync(file)) {
              resolvedId = `${file}${versionedHash[4]
                ? `${versionedHash[4]}&`
                : '?'}${versionedHash[2]}`
            }
          }
          const filename = resolvedId.split('?')[0]
          if (/[#%]/.test(filename)) {
            const isSource = /\.(?:[cm]?[jt]sx?|json|vue)$/i.test(filename) && !/[?&](?:raw|url)(?:[=&]|$)/.test(resolvedId)
            const safeId = isSource
              ? pageModules.register(filename)
              : await resources.materialize(filename)
            return { ...resolved, id: safeId + resolvedId.slice(filename.length) }
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
        return runtimeSource(runtime, modernReact, entry, framework)
      }
      const source = pageModules.get(id)
      if (source) {
        this.addWatchFile(source)
        moduleFiles.add(source)
        // Vue's compiler owns SFC script/style subrequests and its descriptor cache.
        if (id.includes('?vue') && !new URLSearchParams(id.slice(id.indexOf('?') + 1)).has('src'))
          return null
        return readFileSync(source, 'utf8')
      }
    },
    async transform(code, id) {
      const source = pageModules.get(id)
      const query = new URLSearchParams(id.slice(id.indexOf('?') + 1))
      if (source && query.has('vue') && query.get('type') === 'style' && query.has('lang.css')) {
        const rewritten = await resources.rewriteCss(code, source, async (asset, importer) => {
          const resolved = await this.resolve(asset, importer)
          return resolved && !resolved.external
            ? resolved.id
            : undefined
        })
        for (const dependency of rewritten.dependencies)
          this.addWatchFile(dependency)
        return { code: rewritten.code, map: null }
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
              for (const module of graph.getModulesByFile(pageModules.register(file)) ?? [])
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
