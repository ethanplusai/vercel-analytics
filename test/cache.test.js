import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';

test('a value is reused until it expires, then refetched', async () => {
  let clock = 1000;
  let calls = 0;
  const cache = createCache({ ttlMs: 100, now: () => clock });
  const load = async () => { calls += 1; return `v${calls}`; };

  assert.equal((await cache.wrap('k', load)).value, 'v1');
  clock = 1050;
  assert.equal((await cache.wrap('k', load)).value, 'v1', 'still inside the TTL');
  clock = 1101;
  assert.equal((await cache.wrap('k', load)).value, 'v2', 'TTL elapsed');
  assert.equal(calls, 2);
});

test('storedAt reports when the value was fetched, not when it was read', async () => {
  let clock = 500;
  const cache = createCache({ ttlMs: 1000, now: () => clock });
  await cache.wrap('k', async () => 'x');
  clock = 900;
  assert.equal((await cache.wrap('k', async () => 'y')).storedAt, 500);
});

test('a rejected loader is not cached', async () => {
  const cache = createCache({ ttlMs: 1000, now: () => 0 });
  await assert.rejects(cache.wrap('k', async () => { throw new Error('nope'); }));
  assert.equal((await cache.wrap('k', async () => 'ok')).value, 'ok');
});

test('keys are independent', async () => {
  const cache = createCache({ ttlMs: 1000, now: () => 0 });
  await cache.wrap('a', async () => 1);
  assert.equal((await cache.wrap('b', async () => 2)).value, 2);
  assert.equal((await cache.wrap('a', async () => 99)).value, 1);
});
