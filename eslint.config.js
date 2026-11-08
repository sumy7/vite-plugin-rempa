// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: ['dist/**', 'src/compiled/**', 'example/**', '.rempa-test-*/**'],
}, {
  rules: {
    'no-console': 'off',
  },
})
