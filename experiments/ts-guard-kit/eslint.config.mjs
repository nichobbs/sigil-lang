import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

// Guard policy: no way to cast a Pii value to a public type (assertions, any, ts-comments, JSON round trips, inline disables).
export default tseslint.config(
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    files: ['**/*.ts'],
    rules: {
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-restricted-properties': ['error', { object: 'JSON', property: 'parse', message: 'Banned by the data-classification policy.' }],
    },
  },
);
