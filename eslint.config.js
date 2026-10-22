// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['lib/**', 'dist/**', 'coverage/**', 'node_modules/**', 'client/preview/dist/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.{js,mjs}', '*.config.{js,ts}', 'test/fixtures/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Node scripts next to the client (screenshot tooling, fixtures).
    files: ['client/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The screenshot script also hands callbacks to page.evaluate(), which run in the browser.
    files: ['client/preview/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
)
