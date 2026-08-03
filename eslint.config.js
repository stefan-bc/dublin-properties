import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // Browser-side dashboard code (app.js is a real ES module; lib.js is its
    // testable core).
    files: ['app.js', 'lib.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Declared as top-level `const` in classic (non-module) <script>
        // tags loaded before app.js — visible to it via the shared global
        // lexical environment, not an import.
        Chart: 'readonly',
        SUPABASE_URL: 'readonly',
        SUPABASE_ANON_KEY: 'readonly',
        DUBLIN_DISTRICT_GEOMETRY: 'readonly',
      },
    },
  },
  {
    // Classic <script>s that exist only to declare the globals above.
    files: ['config.js', 'dublin-districts.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: { 'no-unused-vars': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    ignores: ['node_modules/**'],
  },
];
