import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/pool.js';

test('results keep input order regardless of completion order', async () => {
  const delays = [30, 1, 20, 2];
  const out = await mapPool(delays, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out.map((r) => r.value), [0, 1, 2, 3]);
});

test('never runs more than `limit` at once', async () => {
  let running = 0;
  let peak = 0;
  await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });
  assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
});

test('one rejection does not sink the others', async () => {
  const out = await mapPool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n * 10;
  });
  assert.deepEqual(out.map((r) => r.ok), [true, false, true]);
  assert.equal(out[0].value, 10);
  assert.equal(out[1].error.message, 'boom');
  assert.equal(out[2].value, 30);
});

test('an empty list resolves to an empty array without calling fn', async () => {
  let calls = 0;
  const out = await mapPool([], 3, async () => { calls += 1; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
