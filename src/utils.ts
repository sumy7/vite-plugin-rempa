import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

/** Read the app's installed React version, including hoisted workspace installs. */
export function getReactVersion(cwd: string): string | false {
  try {
    const require = createRequire(path.resolve(cwd, 'package.json'))
    const reactPath = require.resolve('react/package.json')
    const { version } = JSON.parse(readFileSync(reactPath, 'utf8'))
    return typeof version === 'string'
      ? version
      : false
  }
  catch {
    return false
  }
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
