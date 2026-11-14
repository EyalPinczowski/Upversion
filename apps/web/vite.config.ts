import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { cspMetaPlugin } from './src/build/csp';

export default defineConfig(({ mode }) => {
  // loadEnv also reads the VITE_ variables Vercel sets in the process environment.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // TEST-ONLY: VITE_E2E=1 builds the end-to-end variant (a fake sign-in that reads a token from
  // localStorage, see src/e2e/). Any other value, or none, removes that code from the bundle.
  const e2e = env.VITE_E2E === '1';
  if (e2e && (env.VITE_APP_ENV ?? 'operational') === 'operational') {
    throw new Error(
      'VITE_E2E=1 is a test build and must not be combined with VITE_APP_ENV=operational.',
    );
  }
  return {
    define: { __E2E__: JSON.stringify(e2e) },
    resolve: {
      // Zod with `jitless` already set, for every importer: see src/zod-jitless.ts.
      alias: [
        {
          find: /^zod$/,
          replacement: fileURLToPath(new URL('./src/zod-jitless.ts', import.meta.url)),
        },
      ],
    },
    plugins: [
      react(),
      tailwindcss(),
      cspMetaPlugin({ apiUrl: env.VITE_API_URL, supabaseUrl: env.VITE_SUPABASE_URL }),
    ],
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test/setup.ts'],
    },
  };
});
