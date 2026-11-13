import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WRITE_NAMES = '/^(insertEvent|patchEvent|deleteEvent)$/';
const GUARD_MESSAGE =
  'Calendar events may only be written through the write guard (modules/calendar/write-guard.ts, spec 3.8).';
const nameSelectors = (prop) =>
  `CallExpression[callee.${prop}.name=${WRITE_NAMES}], CallExpression[callee.${prop}.value=${WRITE_NAMES}]`;
// Calls on a receiver that looks like a provider (the event-log repo also has an insertEvent).
const providerWriteCall = {
  selector: [
    `CallExpression[callee.property.name=${WRITE_NAMES}][callee.object.name=/provider/i]`,
    `CallExpression[callee.property.name=${WRITE_NAMES}][callee.object.property.name=/provider/i]`,
    `CallExpression[callee.property.value=${WRITE_NAMES}][callee.object.name=/provider/i]`,
    `CallExpression[callee.property.value=${WRITE_NAMES}][callee.object.property.name=/provider/i]`,
  ].join(', '),
  message: GUARD_MESSAGE,
};
const anyWriteCall = { selector: nameSelectors('property'), message: GUARD_MESSAGE };
const destructuredWrite = {
  selector: `ObjectPattern > Property[key.name=${WRITE_NAMES}]`,
  message: GUARD_MESSAGE + ' Do not pull the write methods off a provider.',
};
const guardedCasts = [
  {
    selector: 'TSAsExpression[typeAnnotation.typeName.name=/^Guarded/]',
    message: 'Guarded targets are minted only by write-guard.ts; do not assert them.',
  },
  {
    selector: 'TSTypeAssertion[typeAnnotation.typeName.name=/^Guarded/]',
    message: 'Guarded targets are minted only by write-guard.ts; do not assert them.',
  },
];
const mintImport = {
  group: ['**/guarded'],
  importNames: ['mintTarget', 'mintInsertTarget'],
  message: 'Guarded targets are minted only by write-guard.ts (spec 3.8).',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'data/**',
      'apps/web/src/api/schema.d.ts',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Spec 3.8: only the write guard may write calendar events. The provider's write methods also
    // demand a guard-branded target (compile-time); these rules are the second layer.
    files: ['apps/api/**/*.ts'],
    ignores: [
      'apps/api/src/modules/calendar/write-guard.ts',
      'apps/api/src/modules/calendar/guarded.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', providerWriteCall, destructuredWrite, ...guardedCasts],
      'no-restricted-imports': ['error', { patterns: [mintImport] }],
    },
  },
  {
    // Inside the calendar module the write methods may not be called on ANY receiver (aliases
    // included), except by the guard itself and the provider that implements them.
    files: ['apps/api/src/modules/calendar/**/*.ts'],
    ignores: [
      'apps/api/src/modules/calendar/write-guard.ts',
      'apps/api/src/modules/calendar/guarded.ts',
      'apps/api/src/modules/calendar/google-provider.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', anyWriteCall, destructuredWrite, ...guardedCasts],
    },
  },
  {
    // The guard may call the provider but may not forge targets by assertion.
    files: ['apps/api/src/modules/calendar/write-guard.ts'],
    rules: { 'no-restricted-syntax': ['error', ...guardedCasts] },
  },
  {
    // These tests exercise the provider's write methods directly, on purpose.
    files: [
      'apps/api/test/calendar-google-provider.test.ts',
      'apps/api/test/calendar-write-guard.test.ts',
    ],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      // ADR 017: the plan builder and the bundled catalog (about 180 items of JSON) are for the API.
      // A static import would put them in the main bundle; a lazy `import()` (a route chunk) is the
      // only way the web may load them, and `no-restricted-imports` does not check dynamic imports.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@upversion/shared/plan-builder',
              message:
                'Do not import the plan builder statically in the web app: it pulls the catalog JSON into the main bundle. Use a lazy import() in a route chunk, or call the API.',
            },
          ],
        },
      ],
    },
  },
);
