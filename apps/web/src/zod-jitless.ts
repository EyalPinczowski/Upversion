import { z } from 'zod/v4';

// The app's Content-Security-Policy has no 'unsafe-eval'. When a schema is created, Zod probes for
// eval support with `new Function('')`; the browser reports that as a CSP violation even though
// the probe is caught. Switching the optimisation off skips the probe.
//
// Every `import ... from 'zod'` in the web build (the web's own code and `@upversion/shared`) is
// aliased to this module (see vite.config.ts), so the setting is applied before any schema exists
// whatever the chunk layout: a shared chunk can run before the entry chunk, but it cannot run
// before the modules it imports.
z.config({ jitless: true });

export * from 'zod/v4';
export { z, z as default };
