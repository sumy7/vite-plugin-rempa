import type { Page } from './pages.ts'
import type { PluginRempaOptions } from './types.ts'

export function runtimeSource(page: Page, modernReact: boolean, appImport = page.entryPath, framework: PluginRempaOptions['framework'] = 'react'): string {
  if (framework === 'vue') {
    return `import { createApp${page.layout ? ', h' : ''} } from 'vue';
import App from ${JSON.stringify(appImport)};
${page.layout
  ? `import Layout from ${JSON.stringify(page.layout)};`
  : ''}
const element = document.getElementById(${JSON.stringify(page.pageConfig.mountElementId)});
if (!element) throw new Error(${JSON.stringify(`[vite-plugin-rempa] Missing mount element for page ${page.name}`)});
createApp(${page.layout ? '{ render: () => h(Layout, null, { default: () => h(App) }) }' : 'App'}).mount(element);
`
  }
  return `import React from 'react';
import * as ReactDOM from '${modernReact ? 'react-dom/client' : 'react-dom'}';
import App from ${JSON.stringify(appImport)};
${page.layout
  ? `import Layout from ${JSON.stringify(page.layout)};`
  : 'const Layout = React.Fragment;'}
const element = document.getElementById(${JSON.stringify(page.pageConfig.mountElementId)});
if (!element) throw new Error(${JSON.stringify(`[vite-plugin-rempa] Missing mount element for page ${page.name}`)});
${modernReact ? 'ReactDOM.createRoot(element).render(<Layout><App /></Layout>);' : 'ReactDOM.render(<Layout><App /></Layout>, element);'}
`
}
