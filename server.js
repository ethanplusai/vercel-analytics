import { createServer } from 'node:http';
import { loadConfig } from './src/config.js';
import { createVercelClient } from './src/vercel.js';
import { createCache } from './src/cache.js';
import { createAuth } from './src/auth.js';
import { createApi } from './src/api.js';
import { sendError } from './src/http.js';

const MIN_PASSPHRASE = 20;

export function assertSafeToStart(config, auth) {
  if (!config.token) {
    throw new Error('VERCEL_TOKEN is required. Create a token at https://vercel.com/account/tokens');
  }
  if (!config.exposedBeyondLoopback) return;
  if (!auth.enabled && !config.allowPublic) {
    throw new Error(
      'This deployment is reachable beyond loopback with no VA_PASSWORD. '
      + 'Set VA_PASSWORD, or set VA_ALLOW_PUBLIC=1 to deliberately publish your analytics.',
    );
  }
  // Measured on the effective (trimmed) passphrase, not the raw env value —
  // otherwise VA_PASSWORD='abc' padded with 20 trailing spaces would satisfy
  // a raw-length check while the effective secret stayed 3 characters.
  if (auth.enabled && auth.effectiveLength < MIN_PASSPHRASE) {
    throw new Error(`VA_PASSWORD must be at least ${MIN_PASSPHRASE} characters after trimming.`);
  }
}

function build(env = process.env) {
  const config = loadConfig(env);
  const auth = createAuth({ passphrase: config.password });
  assertSafeToStart(config, auth);
  const client = createVercelClient({ token: config.token, baseUrl: config.apiBaseUrl });
  const cache = createCache({ ttlMs: config.cacheTtlMs });
  return { config, handler: createApi({ config, client, cache, auth }) };
}

export async function main() {
  const { config, handler } = build();
  createServer(handler).listen(config.port, config.host, () => {
    console.log(`vercel-analytics on http://${config.host}:${config.port}`);
  });
}

// Vercel loads this module and demands a default export that is a function.
// Build once per instance, caching the promise, and reset it on failure so
// one transient error cannot poison the instance for its whole lifetime —
// the next request after a failure tries the build again from scratch.
let ready = null;
export default async function handler(req, res) {
  if (!ready) {
    ready = Promise.resolve().then(build).catch((err) => {
      ready = null;
      throw err;
    });
  }
  let app;
  try {
    app = await ready;
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, 'internal_error', err.message);
    return;
  }
  return app.handler(req, res);
}

const invokedDirectly = process.argv[1] && /(^|[\\/])(server\.js|start\.js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n  vercel-analytics could not start: ${err.message}\n`);
    process.exit(1);
  });
}
