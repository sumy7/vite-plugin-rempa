# vite-plugin-rempa

<p>
  <a href="https://npmjs.com/package/vite-plugin-rempa">
    <img src="https://img.shields.io/npm/v/vite-plugin-rempa?style=flat-square&colorA=564341&colorB=EDED91" alt="npm version" />
  </a>
  <a href="https://npmjs.com/package/vite-plugin-rempa">
    <img src="https://img.shields.io/npm/types/vite-plugin-rempa?style=flat-square&colorA=564341&colorB=EDED91" alt="TypeScript definitions" />
  </a>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square&colorA=564341&colorB=EDED91" alt="license" />
  <a href="https://npmcharts.com/compare/vite-plugin-rempa?minimal=true"><img src="https://img.shields.io/npm/dm/vite-plugin-rempa.svg?style=flat-square&colorA=564341&colorB=EDED91" alt="monthly downloads" /></a>
</p>

A Vite plugin to generate React and Vue 3 multi-page applications from page configurations.

Automatically discover nested pages, generate HTML and framework entries, and apply shared layouts and templates. Supports React Fast Refresh, Vue SFC hot updates, and automatic React version detection.

## Usage

Install:

```sh
pnpm add react react-dom
pnpm add -D vite vite-plugin-rempa @vitejs/plugin-react
```

Requires Vite `^8.3.6` and Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`.

Add the plugin to `vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import rempa from 'vite-plugin-rempa'

export default defineConfig({
  plugins: [
    react(),
    rempa(),
  ],
})
```

## Vue 3

Install Vue and its Vite compiler plugin:

```sh
pnpm add vue
pnpm add -D vite vite-plugin-rempa @vitejs/plugin-vue
```

```ts
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import rempa from 'vite-plugin-rempa'

export default defineConfig({
  plugins: [
    vue(),
    rempa()
  ],
})
```

Place an `index.vue` next to each `config.json`. Vue layouts are `.vue` components that render the page through `<slot />`:

```vue
<template>
  <main>
    <header>Shared layout</header>
    <slot />
  </main>
</template>
```

Set `layout: '@/layout/Layout.vue'` in a page config or in the plugin options. Without a layout, the page mounts directly. Vue and React share the same template parameters, page discovery, and `mountElementId` option (default `root`). Vue apps do not need React installed. The framework is detected from the app's nearest `package.json` (`dependencies` and `devDependencies`). A Vue-only declaration selects Vue even if React is hoisted by another workspace app. When both are declared, React takes priority for compatibility. With neither declared, the plugin checks installed React, then Vue, and finally defaults to React. Set `framework: 'vue'` or `framework: 'react'` to override detection. Select one framework per plugin configuration; Vue 2 and Vue JSX entries are not supported.

Run the complete example with `pnpm play:vue`, or build it with `pnpm build:example:vue`.

## Page Discovery

By default, the plugin scans `src/pages` for `config.json` files. Each page needs an `index.tsx` exporting a React component, or an `index.vue` when Vue is detected or selected; an empty configuration `{}` is valid.

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

Development also supports extensionless URLs such as `/hello`. Pages respect Vite's `base` option. Page configuration changes restart the server; template changes reload the page.

## Options

Pass an options object to `rempa` to customize discovery and shared defaults:

| Name | Default | Description |
| --- | --- | --- |
| `framework` | Auto-detected | Override the detected framework: `react` for `index.tsx`, `vue` for Vue 3 `index.vue`. React wins ties. |
| `pagesPath` | `src/pages` | Page directory, relative to Vite's `root`. |
| `template` | Automatically selected | Default HTML template file. |
| `layout` | No wrapper | Layout receiving React `children` or the Vue default slot. Supports paths, aliases, and package imports. |
| `aliasAtToSrc` | `true` | Add a fallback `@` alias for `<root>/src`, preserving existing aliases. |
| `locals` | `true` | Also expose template parameters through the object named by `localsName`. |
| `localsName` | `locals` | Name of the template parameters object. |

Relative template and layout paths resolve from Vite's `root`. The named export `pluginRempa` and types `PluginRempaOptions` and `PageEntry` are also available.

## Page Configuration

Use `config.json` to override defaults for a page:

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
| `title` | Page name | HTML page title. |
| `layout` | Plugin `layout` | Layout component for this page. |
| `template` | Plugin `template` | HTML template for this page. |
| `mountElementId` | `root` | ID of the mount element, which custom templates must provide. |

Additional properties are passed to the HTML template as parameters.

## HTML Templates

Template priority: page `template`, plugin `template`, `<root>/index.html`, `<root>/public/index.html`, then the built-in template.

```html
<!doctype html>
<html lang="en">
  <head>
    <title><%- title %></title>
  </head>
  <body>
    <div id="<%- mountElementId %>"></div>
  </body>
</html>
```

The page entry script is injected automatically. Use `<% ... %>` for JavaScript, `<%- ... %>` for escaped text, and `<%= ... %>` for raw HTML. Parameters are available directly and through `locals`, for example `title` and `locals.title`.

Files in `public` are copied unchanged. Keep shared templates in `src/template` when they should only generate pages.

## Development and Build

For your application:

```sh
pnpm exec vite
pnpm exec vite build
pnpm exec vite preview
```

For plugin development, use Node.js 24.12.0 (see `.nvmrc`) and run `pnpm install` first:

| Command | Description |
| --- | --- |
| `pnpm dev` | Watch and rebuild the plugin. |
| `pnpm play` / `pnpm play:vue` | Start the React or Vue example at `/rempa/`. |
| `pnpm build` | Build ESM, CommonJS, and TypeScript declarations. |
| `pnpm build:example` / `pnpm build:example:vue` | Build the plugin and React or Vue example. |
| `pnpm preview` / `pnpm preview:vue` | Preview the built React or Vue example at `/rempa/`. |
| `pnpm lint` / `pnpm typecheck` | Check formatting and types. |
| `pnpm test` | Run unit and integration tests. |
| `pnpm test:e2e` | Build the plugin and run browser tests. |

Install the browser with `pnpm exec playwright install chromium` before running browser tests.

## License

MIT.
