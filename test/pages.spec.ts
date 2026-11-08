import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPages } from '../src/pages'
import { useTemporaryDirectories, write, writePage } from './helpers'

const temporaryDirectory = useTemporaryDirectories()

function collect(root: string, options = {}) {
  return collectPages(root, path.join(root, 'src/pages'), options)
}

describe('page discovery', () => {
  it('collects root, nested and sibling pages while ignoring unconfigured components', async () => {
    const root = await temporaryDirectory()
    await writePage(root, '')
    await writePage(root, 'admin/users', { title: 'Users', mountElementId: 'users', description: 'Directory' })
    await writePage(root, 'hello')
    await write(root, 'src/pages/ignored/index.tsx', 'export default () => null')

    const pages = await collect(root)

    expect(pages.map(page => page.name).sort()).toEqual(['admin/users', 'hello', 'index'])
    expect(pages.find(page => page.name === 'hello')).toMatchObject({
      title: 'hello',
      layout: '',
      template: '',
      pageConfig: { title: 'hello', mountElementId: 'root' },
    })
    expect(pages.find(page => page.name === 'admin/users')).toMatchObject({
      title: 'Users',
      htmlPath: path.join(root, 'admin/users.html'),
      entryPath: path.join(root, 'src/pages/admin/users/index.tsx'),
      pageConfig: { title: 'Users', mountElementId: 'users', description: 'Directory' },
    })
  })

  it('resolves options against the application root and honors page overrides', async () => {
    const root = await temporaryDirectory()
    await write(root, 'templates/global.html', '<div id="root"></div>')
    await write(root, 'templates/page.html', '<div id="root"></div>')
    await write(root, 'layouts/Global.tsx', 'export default ({ children }) => children')
    await writePage(root, 'global', {}, 'screens')
    await writePage(root, 'custom', { layout: '@/Layout.tsx', template: 'templates/page.html' }, 'screens')

    const pages = await collectPages(root, path.join(root, 'screens'), { template: 'templates/global.html', layout: './layouts/Global.tsx' })

    expect(pages.find(page => page.name === 'global')).toMatchObject({
      template: path.join(root, 'templates/global.html'),
      layout: path.join(root, 'layouts/Global.tsx'),
    })
    expect(pages.find(page => page.name === 'custom')).toMatchObject({
      template: path.join(root, 'templates/page.html'),
      layout: '@/Layout.tsx',
    })
  })

  it('selects the root template before the public fallback and allows a plugin override', async () => {
    const root = await temporaryDirectory()
    await writePage(root, 'page')
    await write(root, 'public/index.html', 'public template')
    expect((await collect(root))[0].template).toBe(path.join(root, 'public/index.html'))
    await write(root, 'index.html', 'root template')
    expect((await collect(root))[0].template).toBe(path.join(root, 'index.html'))
    expect((await collect(root, { template: 'public/index.html' }))[0].template).toBe(path.join(root, 'public/index.html'))
  })

  it('reports a missing page collection with its directory', async () => {
    const root = await temporaryDirectory()
    await expect(collect(root)).rejects.toThrow(`No pages found in ${path.join(root, 'src/pages')}`)
  })

  it.each([
    'null',
    '[]',
    '42',
    '"page"',
    '{ malformed',
  ])('rejects an invalid configuration object: %s', async (contents) => {
    const root = await temporaryDirectory()
    await writePage(root, 'broken')
    await write(root, 'src/pages/broken/config.json', contents)
    await expect(collect(root)).rejects.toThrow(/Invalid page config .*broken\/config\.json/)
  })

  it.each([
    { title: 123 },
    { layout: true },
    { template: [] },
    { mountElementId: '' },
    { mountElementId: 123 },
  ])('rejects invalid page metadata: %j', async (config) => {
    const root = await temporaryDirectory()
    await writePage(root, 'broken', config)
    await expect(collect(root)).rejects.toThrow(/must be a .*string.*broken\/config\.json/)
  })

  it('reports a missing entry or template with the responsible file path', async () => {
    const root = await temporaryDirectory()
    await write(root, 'src/pages/missing/config.json', '{}')
    await expect(collect(root)).rejects.toThrow(/Missing page entry .*missing\/index\.tsx/)
    await write(root, 'src/pages/missing/index.tsx', 'export default () => null')
    await write(root, 'src/pages/missing/config.json', '{"template":"absent.html"}')
    await expect(collect(root)).rejects.toThrow(`Missing template ${path.join(root, 'absent.html')}`)
  })

  it('rejects conflicting root and index directory output names', async () => {
    const root = await temporaryDirectory()
    await writePage(root, '')
    await writePage(root, 'index')
    await expect(collect(root)).rejects.toThrow('Duplicate page name "index"')
  })
})
