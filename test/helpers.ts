import type { Plugin } from 'vite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'

export const testCacheRoot = fileURLToPath(new URL('../node_modules/.cache/vite-plugin-rempa/tests/', import.meta.url))

export async function createTemporaryDirectory(prefix = 'unit-'): Promise<string> {
  await mkdir(testCacheRoot, { recursive: true })
  return mkdtemp(path.join(testCacheRoot, prefix))
}

/** The fixture sources live in node_modules, but still need normal Vite file watching. */
export function testFixturesPlugin(): Plugin {
  const root = testCacheRoot.replaceAll('\\', '/').replace(/\/$/, '')
  return {
    name: 'test-fixture-watching',
    config() {
      return {
        server: {
          watch: {
            ignored: [`!${root}/*`, `!${root}/*/!(node_modules|dist|cache|.git){,/**}`],
          },
        },
      }
    },
  }
}

export async function write(root: string, filename: string, contents: string): Promise<void> {
  const target = path.join(root, filename)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

export function useTemporaryDirectories(): () => Promise<string> {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })
  return async () => {
    const directory = await createTemporaryDirectory()
    directories.push(directory)
    return directory
  }
}

export async function writePage(root: string, name: string, config: Record<string, unknown> = {}, pagesPath = 'src/pages'): Promise<void> {
  const directory = path.posix.join(pagesPath, name)
  await write(root, `${directory}/index.tsx`, 'export default function Page() { return null }')
  await write(root, `${directory}/config.json`, JSON.stringify(config))
}
