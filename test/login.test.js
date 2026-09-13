import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApi } from '../src/api.js';
import { createGate } from '../server.js';
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
