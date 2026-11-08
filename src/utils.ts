import type { PluginRempaOptions } from './types.ts'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

/** Read the app's installed version, including hoisted workspace installs. */
function getInstalledVersion(cwd: string, name: 'react' | 'vue'): string | false {
  try {
    const require = createRequire(path.resolve(cwd, 'package.json'))
    const packagePath = require.resolve(`${name}/package.json`)
    const { version } = JSON.parse(readFileSync(packagePath, 'utf8'))
    return typeof version === 'string'
      ? version
      : false
  }
  catch {
    return false
  }
}

export function getReactVersion(cwd: string): string | false {
  return getInstalledVersion(cwd, 'react')
}

/** Prefer the app's declared framework over unrelated packages hoisted by a workspace. */
export function resolveFramework(cwd: string, framework?: PluginRempaOptions['framework']): 'react' | 'vue' {
  if (framework !== undefined) {
    if (framework !== 'react' && framework !== 'vue')
      throw new TypeError('[vite-plugin-rempa] framework must be "react" or "vue"')
    return framework
  }
  let directory = path.resolve(cwd)
  while (true) {
    const filename = path.join(directory, 'package.json')
    if (existsSync(filename)) {
      const pkg = JSON.parse(readFileSync(filename, 'utf8'))
      const dependencies = {
        ...pkg.devDependencies,
        ...pkg.dependencies,
      }
      if (typeof dependencies.react === 'string')
        return 'react'
      if (typeof dependencies.vue === 'string')
        return 'vue'
      break
    }
    const parent = path.dirname(directory)
    if (parent === directory)
      break
    directory = parent
  }
  if (getInstalledVersion(cwd, 'react'))
    return 'react'
  return getInstalledVersion(cwd, 'vue')
    ? 'vue'
    : 'react'
}

/** React 18 and later use the client root API. */
export function isReact18(cwd: string = process.cwd()): boolean {
  const version = getReactVersion(cwd)
  if (!version)
    return false
  // package.json contains the installed version, not a dependency range.
  // Prereleases of React 18+ also expose react-dom/client.
  const major = /^(\d+)\./.exec(version)?.[1]
  return major !== undefined && Number(major) >= 18
}
