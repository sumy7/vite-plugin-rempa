import type { Page } from './pages.ts'
import type { PluginRempaOptions } from './types.ts'
import { readFileSync } from 'node:fs'
import ejs from 'ejs'

export function renderPage(page: Page, options: PluginRempaOptions): string {
  const data = { ...page.pageConfig }
  if (options.locals ?? true)
    data[options.localsName ?? 'locals'] = { ...page.pageConfig }

  // These template tags use = for raw markup and - for escaped text, opposite to EJS.
  const html = page.template
    ? ejs.render(readFileSync(page.template, 'utf8').replace(/<%([=-])/g, (_, delimiter) => delimiter === '='
        ? '<%-'
        : '<%='), data, {
        filename: page.template,
        localsName: '__rempaTemplateData',
      })
    : `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${ejs.escapeXML(page.title)}</title></head>
<body><div id="${ejs.escapeXML(page.pageConfig.mountElementId as string)}"></div></body></html>`
  const script = `<script type="module" src="${page.runtimeUrl}"></script>`
  // Keep template text intact: closing tags may also appear inside comments or scripts.
  // HTML parsers place this trailing script in the document body without changing its doctype.
  return `${html}\n${script}`
}
