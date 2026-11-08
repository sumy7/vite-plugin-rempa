import type { ResolvedConfig } from 'vite'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizePath, preprocessCSS } from 'vite'

interface Resource {
  filename: string
  dependencies: Set<string>
}

interface Declaration {
  value: string
  source?: { input: { file?: string } }
}

// Match URL values after PostCSS has separated declarations from comments and rules.
const cssUrlRE = /(?<=^|[^\w\-\u0080-\uFFFF])url\((\s*'[^']*'\s*|\s*"[^"]*"\s*|[^'")]+)\)/g

export function createPageResources(config: ResolvedConfig): {
  materialize: (filename: string) => Promise<string>
  get: (id: string) => string | undefined
  dependencies: (id: string) => string[]
  refresh: (filename: string) => Promise<string[]>
} {
  const resources = new Map<string, Resource>()
  const pending = new Map<string, Promise<string>>()
  const key = (id: string): string => normalizePath(id.split('?')[0])

  async function materialize(filename: string): Promise<string> {
    const file = normalizePath(path.resolve(filename))
    const existing = pending.get(file)
    if (existing)
      return existing
    const operation = copy(file)
    pending.set(file, operation)
    try {
      return await operation
    }
    finally {
      pending.delete(file)
    }
  }

  async function copy(filename: string): Promise<string> {
    const directory = createHash('sha256').update(filename).digest('hex')
    const basename = path.basename(filename).replace(/[^\w.-]/g, '_')
    const target = normalizePath(path.resolve(config.cacheDir, 'rempa', 'resources', directory, basename))
    const dependencies = new Set([filename])
    let contents = await readFile(filename)
    if (path.extname(filename) === '.css') {
      const parserFilename = `${filename}.rempa.css`
      const plugin = {
        postcssPlugin: 'rempa-resource-urls',
        async Declaration(declaration: Declaration): Promise<void> {
          const importer = declaration.source?.input.file ?? parserFilename
          const source = importer === parserFilename
            ? filename
            : importer
          const matches = [
            ...declaration.value.matchAll(cssUrlRE),
          ]
          for (const match of matches.reverse()) {
            const raw = match[1].trim().replace(/^(['"])(.*)\1$/s, '$2')
            if (!raw || /^(?:[a-z][\w+.-]*:|\/|#)/i.test(raw))
              continue
            const suffixIndex = raw.search(/[?#]/)
            const pathname = suffixIndex < 0
              ? raw
              : raw.slice(0, suffixIndex)
            const postfix = suffixIndex < 0
              ? ''
              : raw.slice(suffixIndex)
            if (!pathname)
              continue
            const referenced = path.resolve(path.dirname(source), decodeURIComponent(pathname))
            const cached = await materialize(referenced)
            dependencies.add(normalizePath(referenced))
            const replacement = `url(${JSON.stringify(cached + postfix)})`
            declaration.value = declaration.value.slice(0, match.index) + replacement + declaration.value.slice(match.index! + match[0].length)
          }
        },
      }
      const parsed = await preprocessCSS(contents.toString('utf8'), parserFilename, {
        ...config,
        css: {
          ...config.css,
          transformer: 'postcss',
          modules: false,
          preprocessorOptions: {},
          devSourcemap: false,
          postcss: {
            plugins: [plugin],
          },
        },
      })
      for (const dependency of parsed.deps ?? [])
        dependencies.add(normalizePath(dependency))
      contents = Buffer.from(parsed.code)
    }
    await mkdir(path.dirname(target), { recursive: true })
    let previous: Buffer | undefined
    try {
      previous = await readFile(target)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    if (!previous?.equals(contents))
      await writeFile(target, contents)
    resources.set(target, { filename, dependencies })
    return target
  }

  return {
    materialize,
    get(id) {
      return resources.get(key(id))?.filename
    },
    dependencies(id) {
      return [
        ...resources.get(key(id))?.dependencies ?? [],
      ]
    },
    async refresh(filename) {
      const file = normalizePath(path.resolve(filename))
      const affected = [
        ...resources.values(),
      ].filter(resource => resource.dependencies.has(file))
      return [
        ...new Set(await Promise.all(affected.map(resource => materialize(resource.filename)))),
      ]
    },
  }
}
