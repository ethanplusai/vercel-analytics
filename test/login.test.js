import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createApi } from '../src/api.js';
import { createGate, assertSafeToStart } from '../server.js';
import { createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createCache } from '../src/cache.js';

const PASS = 'a-sufficiently-long-test-passphrase';

function stubClient({ projects = [], rows = [] } = {}) {
  return {
    listTeams: async () => [{ id: 'team_example', slug: 'acme', name: 'Acme' }],
    listProjects: async () => projects,
    visitsAggregate: async () => rows,
  };
}

// Built the same way test/api.test.js builds a server — loadConfig plus a
// stub client, never the real Vercel API — but wrapped with the session
// gate this test file exists to cover. `sleep` defaults to a no-op so the
// failed-login tests here don't pay the real fixed delay; the one test that
// must measure the real delay overrides it explicitly.
async function withServer({ password, client = stubClient(), sleep = () => Promise.resolve() } = {}, fn) {
  const config = loadConfig({ VA_PASSWORD: password ?? '' });
  const auth = createAuth({ passphrase: password });
  const api = createApi({
    config, client, cache: createCache({ ttlMs: 1000, now: () => Date.now() }),
  });
  const handler = createGate({
    auth, config, api, sleep,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

// Node's fetch() silently drops an explicit `host` header override, so a
// fetch-based test of the host guard would pass even against a completely
// broken check. node:http's request() honours a caller-supplied Host header
// verbatim, which is what actually lets us reproduce a spoofed-Host request.
function rawRequest(base, {
  method = 'GET', path = '/', headers = {}, body = null,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(base);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('GET /login renders a form when auth is enabled', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await fetch(`${base}/login`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<form/i);
    assert.match(html, /type="password"/i);
  });
});

test('an unauthenticated page request is redirected to /login', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  });
});

test('an unauthenticated API request gets 401 JSON, not an HTML redirect', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await fetch(`${base}/api/overview`, { redirect: 'manual' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type') ?? '', /json/);
  });
});

test('the correct passphrase issues a session and lets the API through', async () => {
  await withServer({ password: PASS }, async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASS }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie, 'a session cookie must be issued');

    const res = await fetch(`${base}/api/projects`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(res.status, 200);
  });
});

test('a wrong passphrase is refused and issues no cookie', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong' }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('logout clears the cookie and sends you back to /login', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);
  });
});

test('with no passphrase there is no gate at all and /login does not exist', async () => {
  await withServer({ password: null }, async (base) => {
    assert.equal((await fetch(`${base}/api/projects`)).status, 200);
    assert.equal((await fetch(`${base}/login`, { redirect: 'manual' })).status, 404);
  });
});

test('an over-sized login body is rejected with 413', async () => {
  await withServer({ password: PASS }, async (base) => {
    const oversized = `password=${'x'.repeat(1_100_000)}`;
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: oversized,
      redirect: 'manual',
    });
    assert.equal(res.status, 413);
  });
});

// Without this test, nothing stops a future change from "optimising away"
// the fixed delay on a failed login — the only cost an online attacker pays
// per guess, since serverless instances share no memory for a rate limiter.
// Uses the real sleep (not the no-op default above), so it pays the actual
// 400ms penalty; the generous timeout and 300ms floor leave headroom for
// scheduling jitter without letting the delay quietly disappear.
test('a wrong passphrase really waits before responding, not just in theory', { timeout: 5000 }, async () => {
  await withServer({ password: PASS, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, async (base) => {
    const started = Date.now();
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong' }),
      redirect: 'manual',
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 401);
    assert.ok(elapsed >= 300, `expected the failed-login delay to be paid before responding, took ${elapsed}ms`);
  });
});

// Regression coverage for a real finding: the host guard lives inside
// createApi, which the gate wraps — so /login and /logout, handled entirely
// inside the gate, ran with NO host check at all before this test existed.
// A spoofed Host header could reach GET /login (200) and even POST /login
// with a matching Origin (303 plus an issued session cookie). Both must now
// be 403 before any login/logout logic runs.
test('a foreign Host header is refused for GET /login, before the form ever renders', async () => {
  await withServer({ password: PASS }, async (base) => {
    const res = await rawRequest(base, { path: '/login', headers: { host: 'evil.example.com' } });
    assert.equal(res.status, 403);
  });
});

test('a foreign Host header is refused for POST /login, before any session is issued', async () => {
  await withServer({ password: PASS }, async (base) => {
    const body = `password=${encodeURIComponent(PASS)}`;
    const res = await rawRequest(base, {
      method: 'POST',
      path: '/login',
      headers: {
        host: 'evil.example.com',
        origin: 'http://evil.example.com',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
      body,
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined, 'a spoofed Host header must never earn a session cookie');
  });
});

test('assertSafeToStart refuses an exposed deployment with no VA_ALLOWED_HOSTS', () => {
  const config = loadConfig({
    VERCEL_TOKEN: 'token', VERCEL: '1', VA_PASSWORD: PASS,
  });
  const auth = createAuth({ passphrase: PASS });
  assert.throws(() => assertSafeToStart(config, auth), /VA_ALLOWED_HOSTS/);
});

test('assertSafeToStart passes an exposed deployment once VA_ALLOWED_HOSTS is set', () => {
  const config = loadConfig({
    VERCEL_TOKEN: 'token', VERCEL: '1', VA_PASSWORD: PASS, VA_ALLOWED_HOSTS: 'analytics.example.com',
  });
  const auth = createAuth({ passphrase: PASS });
  assert.doesNotThrow(() => assertSafeToStart(config, auth));
});

test('GET /login while already authenticated redirects to / instead of re-rendering the form', async () => {
  await withServer({ password: PASS }, async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASS }),
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${base}/login`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
  });
});

test('the login page and its redirects are never cached by an intermediary', async () => {
  await withServer({ password: PASS }, async (base) => {
    const page = await fetch(`${base}/login`);
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const redirectToLogin = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(redirectToLogin.headers.get('cache-control'), 'no-store');

    const loginSuccess = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASS }),
      redirect: 'manual',
    });
    assert.equal(loginSuccess.headers.get('cache-control'), 'no-store');

    const logout = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual' });
    assert.equal(logout.headers.get('cache-control'), 'no-store');
  });
});
