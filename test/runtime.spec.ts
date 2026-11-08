import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { collectPages } from '../src/pages.ts'
import { runtimeSource } from '../src/runtime.ts'
import { useTemporaryDirectories, write } from './helpers.ts'

const temporaryDirectory = useTemporaryDirectories()

describe('vue runtime', () => {
  it.each(['', '@/Layout.vue'])('mounts the configured element with layout %s', async (layout) => {
    const root = await temporaryDirectory()
    const mountElementId = 'quoted"mount\\id'
    await write(root, 'src/pages/config.json', JSON.stringify({ layout, mountElementId }))
    await write(root, 'src/pages/index.vue', '<template><h1>Page</h1></template>')
    const [page] = await collectPages(root, path.join(root, 'src/pages'), { framework: 'vue' })
    const code = runtimeSource(page, false, page.entryPath, 'vue').replace(/^import .*;$/gm, '')
    const App = { name: 'App' }
    const Layout = { name: 'Layout' }
    const node = { id: mountElementId }
    let component: unknown
    let mounted: unknown
    const context = {
      App,
      Layout,
      document: {
        getElementById: (id: string) => id === mountElementId
          ? node
          : null,
      },
      h: (type: unknown, props: unknown, slots: unknown) => ({ type, props, slots }),
      createApp: (root: unknown) => {
        component = root
        return {
          mount: (element: unknown) => { mounted = element },
        }
      },
    }
    runInNewContext(code, context)
    expect(mounted).toBe(node)
    if (layout) {
      const tree = (component as {
        render: () => { type: unknown, slots: { default: () => { type: unknown } } }
      }).render()
      expect(tree.type).toBe(Layout)
      expect(tree.slots.default().type).toBe(App)
    }
    else {
      expect(component).toBe(App)
    }
    expect(() => runInNewContext(code, {
      ...context,
      document: {
        getElementById: () => null,
      },
    })).toThrow('Missing mount element for page index')
  })
})
