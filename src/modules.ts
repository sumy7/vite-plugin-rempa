import { createHash } from 'node:crypto'
import path from 'node:path'
import { normalizePath } from 'vite'

/** Keep source filenames separate from the URL-safe module IDs exposed to Vite. */
export function createPageModules(root: string): {
  register: (filename: string) => string
  get: (id: string) => string | undefined
} {
  const files = new Map<string, string>()
  return {
    register(filename) {
      const file = normalizePath(path.resolve(filename))
      const id = normalizePath(path.resolve(root, '.rempa', 'modules', `${createHash('sha256').update(file).digest('hex')}${path.extname(file)}`))
      files.set(id, file)
      return id
    },
    get(id) {
      return files.get(normalizePath(id.split('?')[0]))
    },
  }
}
