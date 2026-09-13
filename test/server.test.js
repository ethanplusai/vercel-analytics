import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { main, isInvokedDirectly } from '../server.js';

// Regression coverage for a real bug: server.js's own "was I run directly"
// guard used to also match bin/start.js's path (both end in "*.js" that the
// old regex accepted), so `bin/start.js` importing server.js made server.js
// call main() itself — and then bin/start.js called it again, and the
// second listen() crashed the whole process with an uncaught EADDRINUSE.
// `npm start` could not start at all.

const HERE = dirname(fileURLToPath(import.meta.url));
const START_SCRIPT = join(HERE, '..', 'bin', 'start.js');

test('main is exported as a function, and importing server.js alone does not call it', () => {
  // If importing this module ever auto-invoked main() again (the historical
  // failure mode), there would be nothing here to assert against directly —
  // that's exactly why the guard itself is exported and tested below, and
  // why the process-level test further down proves the real entry point
  // stays crash-free. This assertion just pins the shape main() must have.
  assert.equal(typeof main, 'function');
});

test('the invoked-directly guard matches server.js but never bin/start.js', () => {
  assert.equal(isInvokedDirectly('/proj/server.js'), true);
  assert.equal(isInvokedDirectly('server.js'), true);
  assert.equal(isInvokedDirectly('C:\\proj\\server.js'), true);
  // The exact bug: a path ending in start.js must never match.
  assert.equal(isInvokedDirectly('/proj/bin/start.js'), false);
  assert.equal(isInvokedDirectly('start.js'), false);
  assert.equal(isInvokedDirectly(undefined), false);
  assert.equal(isInvokedDirectly(''), false);
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('node bin/start.js binds exactly once and never throws EADDRINUSE', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [START_SCRIPT], {
    env: {
      ...process.env,
      VERCEL: '', // force exposedBeyondLoopback === false regardless of the host shell
      VERCEL_TOKEN: 'fake_test_token',
      // Unreachable on purpose: startup never calls out to Vercel, so this
      // is never dialled during this test.
      VA_API_BASE_URL: 'http://127.0.0.1:1',
      PORT: String(port),
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  // The old bug crashed the process (an uncaught 'error' event) within
  // milliseconds of printing its own "listening" line — this window is long
  // enough to catch that without making the suite noticeably slower.
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(child.exitCode, null, `process exited early (code ${child.exitCode}); stderr:\n${stderr}`);
  assert.doesNotMatch(stderr, /EADDRINUSE/);
  assert.match(stdout, new RegExp(`vercel-analytics on http://127\\.0\\.0\\.1:${port}`));
  // Exactly one successful listen — two would mean two servers raced for it.
  assert.equal((stdout.match(/vercel-analytics on/g) || []).length, 1);

  child.kill();
  await exited;
});
