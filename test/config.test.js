import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults are sensible with an empty environment', () => {
  const c = loadConfig({});
  assert.equal(c.token, null);
  assert.equal(c.port, 4320);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.cacheTtlMs, 300000);
  assert.equal(c.concurrency, 5);
  assert.deepEqual(c.teams, []);
  assert.equal(c.exposedBeyondLoopback, false);
  assert.equal(c.secureCookies, false);
});

test('VERCEL_TOKEN keeps its conventional name', () => {
  assert.equal(loadConfig({ VERCEL_TOKEN: 'abc' }).token, 'abc');
});

test('VA_TEAMS is split, trimmed and emptied of blanks', () => {
  assert.deepEqual(loadConfig({ VA_TEAMS: ' a , b ,,c ' }).teams, ['a', 'b', 'c']);
});

test('exposure is driven by VERCEL or a non-empty host allowlist, not by VERCEL alone', () => {
  assert.equal(loadConfig({ VERCEL: '1' }).exposedBeyondLoopback, true);
  assert.equal(loadConfig({ VA_ALLOWED_HOSTS: 'a.example.com' }).exposedBeyondLoopback, true);
  assert.equal(loadConfig({}).exposedBeyondLoopback, false);
});

test('a non-loopback VA_HOST also counts as exposure, including 0.0.0.0', () => {
  assert.equal(loadConfig({ VA_HOST: '0.0.0.0' }).exposedBeyondLoopback, true);
  assert.equal(loadConfig({ VA_HOST: '192.168.1.50' }).exposedBeyondLoopback, true);
});

test('every documented loopback form for VA_HOST stays unexposed', () => {
  assert.equal(loadConfig({ VA_HOST: '127.0.0.1' }).exposedBeyondLoopback, false);
  assert.equal(loadConfig({ VA_HOST: '::1' }).exposedBeyondLoopback, false);
  assert.equal(loadConfig({ VA_HOST: 'localhost' }).exposedBeyondLoopback, false);
  assert.equal(loadConfig({}).exposedBeyondLoopback, false, 'an unset VA_HOST defaults to loopback');
});

test('secure cookies follow exposure but can be overridden explicitly', () => {
  assert.equal(loadConfig({ VERCEL: '1' }).secureCookies, true);
  assert.equal(loadConfig({ VERCEL: '1', VA_SECURE_COOKIES: '0' }).secureCookies, false);
});

test('a non-numeric or non-positive override falls back to the default', () => {
  assert.equal(loadConfig({ VA_CONCURRENCY: 'abc' }).concurrency, 5);
  assert.equal(loadConfig({ VA_CONCURRENCY: '0' }).concurrency, 5);
  assert.equal(loadConfig({ VA_CONCURRENCY: '12' }).concurrency, 12);
});
