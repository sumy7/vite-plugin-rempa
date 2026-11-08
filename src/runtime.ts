import type { Page } from './pages.ts'

export function runtimeSource(page: Page, modernReact: boolean, appImport = page.entryPath): string {
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
