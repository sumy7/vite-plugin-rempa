import type { PageEntry, PluginRempaOptions } from './types.ts'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import { normalizePath } from 'vite'

const RUNTIME_PREFIX = '/@rempa/'

export interface Page extends PageEntry {
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

export async function collectPages(root: string, pagesPath: string, options: PluginRempaOptions): Promise<Page[]> {
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
    const name = directory === '.'
      ? 'index'
      : directory
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

    const resolvedTemplate = pageTemplate
      ? path.resolve(root, pageTemplate as string)
      : ''
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
