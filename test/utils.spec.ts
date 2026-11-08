import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getReactVersion, isReact18, resolveFramework } from '../src/utils'
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

  it('returns false for an inaccessible, malformed or non-string installed version', async () => {
    const root = await temporaryDirectory()
    // Block the hoisted React package so this case exercises resolution failure.
    await write(root, 'node_modules/react/package.json', '{"name":"react","exports":{}}')
    expect(getReactVersion(root)).toBe(false)
    expect(isReact18(root)).toBe(false)
    await installReact(root, 19)
    expect(getReactVersion(root)).toBe(false)
    await write(root, 'node_modules/react/package.json', '{ malformed')
    expect(getReactVersion(root)).toBe(false)
  })
})

describe('framework detection', () => {
  it.each([
    {
      dependencies: { react: '*' },
      expected: 'react',
    },
    {
      dependencies: { vue: '*' },
      expected: 'vue',
    },
    {
      devDependencies: { vue: '*' },
      expected: 'vue',
    },
    {
      dependencies: { react: '*', vue: '*' },
      expected: 'react',
    },
  ])('prefers application dependencies: $expected', async ({ expected, ...pkg }) => {
    const root = await temporaryDirectory()
    await write(root, 'package.json', JSON.stringify(pkg))
    // Both packages are visible here, as in a hoisted monorepo installation.
    await installReact(root, '19.3.1')
    await write(root, 'node_modules/vue/package.json', '{"version":"3.5.45"}')
    expect(resolveFramework(root)).toBe(expected)
  })

  it('uses the nearest application manifest for nested roots and hoisted dependencies', async () => {
    const root = await temporaryDirectory()
    await write(root, 'package.json', '{"dependencies":{"react":"*","vue":"*"}}')
    await installReact(root, '19.3.1')
    await write(root, 'node_modules/vue/package.json', '{"version":"3.5.45"}')
    const application = path.join(root, 'examples/vue')
    await write(application, 'package.json', '{"dependencies":{"vue":"*"}}')
    expect(resolveFramework(application)).toBe('vue')
    expect(resolveFramework(path.join(application, 'src'))).toBe('vue')
  })

  it.each(['react', 'vue'] as const)('lets an explicit %s override installed dependencies', async (framework) => {
    const root = await temporaryDirectory()
    await write(root, 'package.json', JSON.stringify({
      dependencies: { [framework === 'react'
        ? 'vue'
        : 'react']: '*' },
    }))
    expect(resolveFramework(root, framework)).toBe(framework)
  })

  it.each([
    { react: false, vue: true, expected: 'vue' },
    { react: true, vue: true, expected: 'react' },
    { react: true, vue: false, expected: 'react' },
    { react: false, vue: false, expected: 'react' },
  ])('uses installed packages or the React fallback: $react / $vue', async ({ react, vue, expected }) => {
    const root = await temporaryDirectory()
    await write(root, 'package.json', '{}')
    for (const [name, installed] of [
      ['react', react],
      ['vue', vue],
    ] as const) {
      await write(root, `node_modules/${name}/package.json`, JSON.stringify(installed
        ? {
            name,
            version: name === 'react'
              ? '18.3.1'
              : '3.5.45',
          }
        : { name, exports: {} }))
    }
    expect(resolveFramework(root)).toBe(expected)
  })
})
