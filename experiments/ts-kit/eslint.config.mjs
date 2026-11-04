import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default tseslint.config(
  ...tseslint.configs.recommended,
  security.configs.recommended,
  { files: ['**/*.ts'], rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' } },
);
