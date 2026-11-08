/** Resolved page information. */
export interface PageEntry {
  name: string
  entryPath: string
  layout: string
  title: string
  template: string
  pageConfig: Record<string, unknown>
}

export interface PluginRempaOptions {
  /** Default HTML template, relative to Vite's root. Supports EJS/lodash-style tags. */
  template?: string
  /** Default layout module. Relative file paths resolve from Vite's root; aliases are supported. */
  layout?: string
  /** Page discovery directory, relative to Vite's root. @default 'src/pages' */
  pagesPath?: string
  /** Add the @ -> src alias if the app has not already defined it. @default true */
  aliasAtToSrc?: boolean
  /** Also expose template parameters under localsName. @default true */
  locals?: boolean
  /** Name of the template parameters object. @default 'locals' */
  localsName?: string
}
