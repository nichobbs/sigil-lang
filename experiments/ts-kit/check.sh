#!/bin/sh
# The TypeScript arm's feedback pipeline: strict typecheck, security lint, then your tests.
set -e
npx tsc --noEmit -p tsconfig.json
npx eslint solution.ts
npx vitest run
