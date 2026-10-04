import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.generated/**',
      '.local/**',
      '.scratch/**',
      'coverage/**',
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      '**/*.min.js',
      'public/vendor/**',
      'release/**',
      'test-results/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // ActionInspector predates this lint setup and has an early return before
    // two UI-only hooks. Keep the existing runtime behavior while the
    // component is split into stable hook-bearing sections.
    files: ['src/ui/timeline/ActionInspector.tsx'],
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
    },
  },
);
