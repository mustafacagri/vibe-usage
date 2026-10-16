'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'release/', 'artifacts/'] },
  js.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'commonjs', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error'
    }
  },
  {
    // Renderer classic scripts: browser globals plus the UMD modules loaded before them.
    files: ['src/ui/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'script',
      globals: { ...globals.browser, VibeCatalog: 'readonly', VibeFormat: 'readonly', VibeI18n: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    // UMD modules shared by Node and the renderer.
    files: ['src/catalog.cjs', 'src/shared.cjs', 'src/ui/i18n.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // ui-check's preload runs in the page; main.cjs serializes a function that runs there too.
    files: ['scripts/ui-check/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
];
