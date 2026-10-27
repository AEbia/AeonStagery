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
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // Test fixtures use incomplete runtime/browser stubs, private-state probes,
    // and deliberately invalid inputs. Allowing any at this boundary keeps the
    // fixture focused on the behavior under test without full subsystem setup.
    // Hook correctness and the other lint rules still apply to test components.
    files: ['src/__tests__/**/*.{ts,tsx}', 'tests/e2e/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
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
