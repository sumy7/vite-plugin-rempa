// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: ['**/dist/**', 'pnpm-lock.yaml'],
}, {
  rules: {
    'no-console': 'off',
  },
})
