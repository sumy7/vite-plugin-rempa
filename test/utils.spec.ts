import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getReactVersion, isReact18 } from '../src/utils'
import { useTemporaryDirectories, write } from './helpers'

const temporaryDirectory = useTemporaryDirectories()

async function installReact(root: string, version: unknown): Promise<void> {
  await write(root, 'node_modules/react/package.json', JSON.stringify({
    name: 'react',
    version,
    exports: { './package.json': './package.json' },
  }))
}

describe('installed React version', () => {
  it.each([
    ['16.14.0', false],
    ['17.0.2', false],
    ['18.0.0', true],
    ['18.0.0-rc.1', true],
    ['19.3.1', true],
    ['invalid', false],
  ])('selects the renderer for installed React %s', async (version, modern) => {
    const root = await temporaryDirectory()
    await installReact(root, version)
    expect(getReactVersion(root)).toBe(version)
    expect(isReact18(root)).toBe(modern)
  })

  it('finds a hoisted package from a nested workspace application', async () => {
    const root = await temporaryDirectory()
    await installReact(root, '19.3.1')
    const application = path.join(root, 'examples/react')
    await write(application, 'package.json', '{"type":"module"}')
    expect(getReactVersion(application)).toBe('19.3.1')
    expect(isReact18(application)).toBe(true)
  })

  it('returns false for an absent, malformed or non-string installed version', async () => {
    const root = await temporaryDirectory()
    expect(getReactVersion(root)).toBe(false)
    expect(isReact18(root)).toBe(false)
    await installReact(root, 19)
    expect(getReactVersion(root)).toBe(false)
    await write(root, 'node_modules/react/package.json', '{ malformed')
    expect(getReactVersion(root)).toBe(false)
  })
})
