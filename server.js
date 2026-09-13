import { createServer } from 'node:http';
import { loadConfig } from './src/config.js';
import { createVercelClient } from './src/vercel.js';
import { createCache } from './src/cache.js';
import { createAuth } from './src/auth.js';
import { createApi } from './src/api.js';
import { sendError, isRequestLocal } from './src/http.js';
import { renderLoginPage } from './src/login-page.js';

const MIN_PASSPHRASE = 20;

// Fixed delay after a failed login, in milliseconds. Serverless instances
// share no memory, so there is no rate limiter to lean on here — this
// constant-time penalty is the only thing that costs an online attacker
// anything per guess. Injectable via `sleep` so tests don't have to pay it.
const FAILED_LOGIN_DELAY_MS = 400;

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Read an `application/x-www-form-urlencoded` body: accumulate, reject past
// a size limit, destroy the socket rather than keep buffering. Kept local to
// server.js (rather than added to http.js) because it's login-form-specific.
function readFormBody(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > limit) {
        const err = new Error('Request body too large');
        err.code = 'TOO_LARGE';
        setImmediate(() => req.destroy());
        fail(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      fail(err);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

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
  // VA_ALLOWED_HOSTS is documented as optional ("behind a proxy"), but the
  // host guard below (isRequestLocal, shared with src/api.js) is
  // unconditional: it accepts only loopback names plus whatever this list
  // adds. Leaving it empty on a real deployment means /login renders and
  // the passphrase is even accepted, then EVERY subsequent request 403s as
  // a forbidden host — a failure that reads as a login bug and is nearly
  // impossible to diagnose from the browser. Refusing to start names the
  // actual cause instead.
  if ((config.allowedHosts ?? []).length === 0) {
    throw new Error(
      'VA_ALLOWED_HOSTS must list the hostname(s) this deployment is served on '
      + '(e.g. "analytics.example.com"), or every request will be refused as a forbidden host.',
    );
  }
  // Measured on the effective (trimmed) passphrase, not the raw env value —
  // otherwise VA_PASSWORD='abc' padded with 20 trailing spaces would satisfy
  // a raw-length check while the effective secret stayed 3 characters.
  if (auth.enabled && auth.effectiveLength < MIN_PASSPHRASE) {
    throw new Error(`VA_PASSWORD must be at least ${MIN_PASSPHRASE} characters after trimming.`);
  }
}

// Wraps the plain (req, res) handler returned by createApi with the session
// gate. Only exists at all when `auth.enabled` — with no VA_PASSWORD (local
// use) this is never called and there is no redirect, no cookie, and no
// /login route. Exported so tests can compose it directly the same way
// test/api.test.js composes createApi, without going through build()'s
// VERCEL_TOKEN requirement.
export function createGate({
  auth, config, api, sleep = defaultSleep,
}) {
  return async function gate(req, res) {
    // Must run before ANY /login or /logout handling, not just before the
    // authenticated routes below — createApi has its own copy of this same
    // check (shared via src/http.js, not reimplemented), but that copy is
    // reached only *after* this gate's login/logout branches return, so
    // without a check here those two routes would be wide open to a
    // spoofed Host header: a cross-origin login/logout CSRF, or worse, a
    // DNS-rebinding page brute-forcing the passphrase off the 303-vs-401
    // response with nothing but the fixed delay in the way.
    if (!isRequestLocal(req, { extraHosts: config.allowedHosts ?? [] })) {
      sendError(res, 403, 'forbidden_host', 'This server only accepts requests from the local machine.');
      return;
    }

    if (!auth.enabled) {
      await api(req, res);
      return;
    }

    const secure = Boolean(config.secureCookies);

    // Parsed once and reused everywhere below, so there is exactly one
    // notion of "what path is this request for" in this handler — the raw
    // req.url must never be re-tested separately (e.g. with
    // startsWith('/api/')), or the two checks can drift apart.
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login') {
      if (req.method === 'GET') {
        // Already signed in: re-rendering the form here would invite
        // resubmission and just bounces the user right back regardless, so
        // send them on to / instead of showing a login page they don't need.
        if (auth.isAuthenticated(req, { secure })) {
          res.writeHead(303, { location: '/', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderLoginPage({}));
        return;
      }
      if (req.method === 'POST') {
        let params;
        try {
          params = await readFormBody(req);
        } catch (err) {
          const code = err.code === 'TOO_LARGE' ? 'too_large' : 'bad_request';
          sendError(res, err.code === 'TOO_LARGE' ? 413 : 400, code, err.message);
          return;
        }
        const candidate = params.get('password') ?? '';
        if (auth.checkPassphrase(candidate)) {
          res.writeHead(303, {
            location: '/', 'set-cookie': auth.issueCookie({ secure }), 'cache-control': 'no-store',
          });
          res.end();
        } else {
          await sleep(FAILED_LOGIN_DELAY_MS);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderLoginPage({ error: 'Incorrect passphrase.' }));
        }
        return;
      }
      sendError(res, 404, 'not_found', 'Not found.');
      return;
    }

    if (url.pathname === '/logout' && req.method === 'POST') {
      res.writeHead(303, {
        location: '/login', 'set-cookie': auth.clearCookie({ secure }), 'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    // This project has no cron and no poll endpoint, so — unlike the
    // sibling this gate was ported from — every remaining route goes
    // through the session check below. There is no exemption to carve out.
    if (!auth.isAuthenticated(req, { secure })) {
      if (url.pathname.startsWith('/api/')) {
        sendError(res, 401, 'unauthorized', 'Sign in to use this API.');
      } else {
        res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
        res.end();
      }
      return;
    }

    await api(req, res);
  };
}

function build(env = process.env, { client: clientOverride, sleep } = {}) {
  const config = loadConfig(env);
  const auth = createAuth({ passphrase: config.password });
  assertSafeToStart(config, auth);
  const client = clientOverride ?? createVercelClient({ token: config.token, baseUrl: config.apiBaseUrl });
  const cache = createCache({ ttlMs: config.cacheTtlMs });
  const api = createApi({ config, client, cache });
  const handler = createGate({
    auth, config, api, sleep,
  });
  return {
    config, auth, handler,
  };
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
    ready = Promise.resolve().then(() => build()).catch((err) => {
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

// Matches ONLY server.js's own path. bin/start.js is the real entry point —
// it always calls main() itself — so if this also matched "start.js", an
// `import('../server.js')` from bin/start.js would see argv[1] still ending
// in "start.js" and auto-run main() here too, racing bin/start.js's own call
// for the same port and crashing the second listen() with EADDRINUSE.
// Exported (rather than kept as a bare regex literal) so the exact bug —
// this guard also matching bin/start.js's path — has a direct regression
// test; see test/server.test.js.
export function isInvokedDirectly(argv1) {
  return Boolean(argv1) && /(^|[\\/])server\.js$/.test(argv1);
}
const invokedDirectly = isInvokedDirectly(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n  vercel-analytics could not start: ${err.message}\n`);
    process.exit(1);
  });
}
