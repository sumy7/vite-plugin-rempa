import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

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
    const directory = await mkdtemp(path.join(os.tmpdir(), 'vite-plugin-rempa-test-'))
    directories.push(directory)
    return directory
  }
}

export async function writePage(root: string, name: string, config: Record<string, unknown> = {}, pagesPath = 'src/pages'): Promise<void> {
  const directory = path.posix.join(pagesPath, name)
  await write(root, `${directory}/index.tsx`, 'export default function Page() { return null }')
  await write(root, `${directory}/config.json`, JSON.stringify(config))
}
