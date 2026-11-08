# vite-plugin-rempa

**vite-plugin-rempa** is a Vite plugin that generates React multi-page applications from page directories and configuration files.

## Features

- Discover pages automatically from `config.json` and `index.tsx` files.
- Generate HTML and React entry modules without writing generated files into the source directory.
- Support nested pages, shared layouts, page titles, custom mount elements, and HTML templates.
- Pass page configuration values to templates directly or through a named parameters object.
- Use `createRoot` with React 18 and later, and `ReactDOM.render` with earlier versions.
- Support Vite development, Fast Refresh with `@vitejs/plugin-react`, production builds, and preview.
- Preserve existing build inputs and aliases, and support Vite's `root` and `base` options.

## Installation

Install React and React DOM in your application, then install the plugin and Vite development tools:

```sh
pnpm add react react-dom
pnpm add -D vite vite-plugin-rempa @vitejs/plugin-react
```

The plugin is tested with Vite 5.

## Usage

Add the plugin to `vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import rempa from 'vite-plugin-rempa'

export default defineConfig({
  plugins: [react(), rempa()],
})
```

The named export `pluginRempa` is also available. TypeScript users can import the `PluginRempaOptions` and `PageEntry` types.

### Page Structure

Each page directory must contain a `config.json` file and an `index.tsx` file that exports a React component as its default export. An empty configuration object `{}` is valid.

```text
src/pages/
├── config.json                 → /index.html
├── index.tsx
├── hello/
│   ├── config.json              → /hello.html
│   └── index.tsx
└── admin/users/
    ├── config.json              → /admin/users.html
    └── index.tsx
```

For example, create `src/pages/hello/index.tsx`:

```tsx
import type { ReactElement } from 'react'

export default function HelloPage(): ReactElement {
  return <h1>Hello World</h1>
}
```

Then add `src/pages/hello/config.json`:

```json
{
  "title": "Hello World"
}
```

Run the development server and open `/hello.html`.

### Plugin Options

```ts
rempa({
  pagesPath: 'src/pages',
  template: 'src/template/index.html',
  layout: '@/layout/Layout.tsx',
  aliasAtToSrc: true,
  locals: true,
  localsName: 'locals',
})
```

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `pagesPath` | `string` | `src/pages` | Directory to scan for page configurations, relative to Vite's `root`. |
| `template` | `string` | Automatically selected | Default HTML template path, relative to Vite's `root`. |
| `layout` | `string` | React Fragment | Default layout module that wraps each page. Supports file paths, aliases, and package imports. |
| `aliasAtToSrc` | `boolean` | `true` | Add a fallback `@` alias pointing to `<root>/src`, preserving existing alias precedence. |
| `locals` | `boolean` | `true` | Expose template parameters through the object named by `localsName`, in addition to top-level variables. |
| `localsName` | `string` | `locals` | Name of the template parameters object. |

Relative template and layout file paths resolve from Vite's `root`. A layout receives the page component through its `children` prop.

### Page Configuration

Page-level settings override the corresponding plugin defaults:

```json
{
  "title": "Hello World",
  "layout": "@/layout/Layout.tsx",
  "template": "src/template/index.html",
  "mountElementId": "app",
  "description": "An example page"
}
```

| Name | Default | Description |
| --- | --- | --- |
| `title` | Page name | Page title, available to the HTML template as `title`. |
| `layout` | Plugin `layout` or React Fragment | Layout module for this page. |
| `template` | Plugin or automatically selected template | HTML template for this page. |
| `mountElementId` | `root` | ID of the DOM element where the page is mounted. Custom templates must provide this element. |
| Additional properties | — | Values passed to the HTML template as parameters. |

Templates are selected in the following order:

1. Page-level `template`.
2. Plugin-level `template`.
3. `<root>/index.html`.
4. `<root>/public/index.html`.
5. The built-in HTML template.

### HTML Templates

Templates support these tags:

| Tag | Description |
| --- | --- |
| `<% ... %>` | Execute JavaScript statements. |
| `<%= ... %>` | Insert a value without HTML escaping. |
| `<%- ... %>` | Insert an HTML-escaped value. |

For example, create `src/template/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><%- title %></title>
    <% if (locals.description) { %>
    <meta name="description" content="<%- description %>">
    <% } %>
  </head>
  <body>
    <div id="<%- mountElementId %>"></div>
  </body>
</html>
```

The plugin injects the page entry script automatically. Use `<%- ... %>` for text that needs escaping and `<%= ... %>` for intentional HTML markup.

Parameters are available directly, such as `title`, and through `locals`, such as `locals.title`. Set `localsName` to change the object name, or set `locals: false` to expose only top-level parameters.

Existing static HTML files follow Vite's normal behavior, and files in `public` are copied unchanged to the output directory. Keep shared templates in `src/template` and select them with `template` when they should only be used to generate pages.

## Development and Build

### Application Workflow

```sh
# Start the development server
pnpm exec vite

# Build the application
pnpm exec vite build

# Preview the production build
pnpm exec vite preview
```

During development, `/hello.html` and `/hello` resolve to the same generated page. Nested pages retain their directory structure. When `base` is configured, access pages under that prefix. Generated pages use multi-page routing without SPA fallback.

Adding, removing, or changing a page configuration restarts the development server. Template changes trigger a full page reload. Production builds generate the corresponding `.html` files and bundled assets in Vite's output directory.

### Plugin Development

```sh
# Install workspace dependencies
pnpm install

# Generate development stubs
pnpm dev

# Check formatting and types
pnpm lint
pnpm typecheck

# Run integration tests
pnpm exec vitest run

# Build the plugin and TypeScript declarations
pnpm build
```

To run the example application, install its React dependencies first:

```sh
pnpm --dir example add react react-dom
pnpm build
pnpm --dir example dev
pnpm --dir example build
pnpm --dir example exec vite preview
```

## License

MIT
