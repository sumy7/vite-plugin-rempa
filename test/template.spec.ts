import type { Page } from '../src/pages'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderPage } from '../src/template'
import { useTemporaryDirectories, write } from './helpers'

const temporaryDirectory = useTemporaryDirectories()

function page(overrides: Partial<Page> = {}): Page {
  return {
    name: 'hello',
    entryPath: '/src/pages/hello/index.tsx',
    configPath: '/src/pages/hello/config.json',
    htmlPath: '/hello.html',
    runtimePath: '/.rempa/hello.tsx',
    runtimeUrl: '/@rempa/hello.tsx',
    title: 'Hello <World>',
    layout: '',
    template: '',
    pageConfig: { title: 'Hello <World>', mountElementId: 'app"root', message: '<strong>hello & goodbye</strong>' },
    ...overrides,
  }
}

describe('html templates', () => {
  it('creates escaped default markup and injects one entry before the body closes', () => {
    const html = renderPage(page(), {})
    expect(html).toContain('<title>Hello &lt;World&gt;</title>')
    expect(html).toContain('id="app&#34;root"')
    expect(html.match(/src="\/@rempa\/hello\.tsx"/g)).toHaveLength(1)
    expect(html.indexOf('<script type="module"')).toBeLessThan(html.indexOf('</body>'))
  })

  it('evaluates statements and distinguishes raw from escaped interpolation', async () => {
    const root = await temporaryDirectory()
    const template = path.join(root, 'template.html')
    await write(root, 'template.html', '<html><body><% if (locals.message) { %><section><%= message %></section><p><%- message %></p><% } %></body></html>')
    const html = renderPage(page({ template }), {})
    expect(html).toContain('<section><strong>hello & goodbye</strong></section>')
    expect(html).toContain('<p>&lt;strong&gt;hello &amp; goodbye&lt;/strong&gt;</p>')
    expect(html).not.toContain('<%')
  })

  it.each([
    {
      options: { localsName: 'pageData' },
      expression: 'pageData.message',
      expected: '<strong>hello & goodbye</strong>',
    },
    {
      options: { locals: false },
      expression: 'typeof locals',
      expected: 'undefined',
    },
  ])('honors the parameters object settings: %j', async ({ options, expression, expected }) => {
    const root = await temporaryDirectory()
    const template = path.join(root, 'template.html')
    await write(root, 'template.html', `<p><%= ${expression} %></p>`)
    const html = renderPage(page({ template }), options)
    expect(html).toContain(`<p>${expected}</p>`)
    expect(html).toContain('<script type="module" src="/@rempa/hello.tsx"></script>')
  })

  it('preserves existing scripts and handles uppercase body tags', async () => {
    const root = await temporaryDirectory()
    const template = path.join(root, 'template.html')
    await write(root, 'template.html', '<HTML><BODY><script>window.existing = true</script></BODY></HTML>')
    const html = renderPage(page({ template }), {})
    expect(html).toContain('<script>window.existing = true</script>')
    expect(html.indexOf('/@rempa/hello.tsx')).toBeLessThan(html.toLowerCase().indexOf('</body>'))
  })
})
