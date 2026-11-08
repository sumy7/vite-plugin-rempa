import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/index'],
  clean: false,
  declaration: true,
  externals: ['vite', 'fs'],
  rollup: {
    emitCJS: true,
    inlineDependencies: true,
    output: {
      exports: 'named',
    },
    dts: {
      respectExternal: true,
    },
  },
})
