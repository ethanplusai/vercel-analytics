import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelClient, VercelError } from '../src/vercel.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

test('listProjects follows the pagination cursor to exhaustion', async () => {
  const seen = [];
  const pages = [
    {
      projects: [
        { id: 'prj_1', name: 'one', webAnalytics: { enabledAt: 1 } },
        { id: 'prj_2', name: 'two' },
        // Analytics object PRESENT but never enabled. This row is the reason the
        // filter tests `enabledAt` rather than the presence of `webAnalytics`:
        // a check like `'webAnalytics' in p` would wrongly include it.
        { id: 'prj_never', name: 'never-enabled', webAnalytics: {} },
      ],
      pagination: { next: 12345 },
    },
    {
      projects: [{ id: 'prj_3', name: 'three', webAnalytics: { enabledAt: 2 } }],
      pagination: { next: null },
    },
  ];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return jsonResponse(pages[seen.length - 1]);
  };
  const client = createVercelClient({ token: 't', fetchImpl });
  const projects = await client.listProjects({ teamId: 'team_example' });

  assert.equal(seen.length, 2, 'should have requested a second page');
  assert.ok(seen[1].includes('until=12345'), `second request should carry the cursor: ${seen[1]}`);
  // Only analytics-enabled projects survive; prj_2 has no webAnalytics.
  assert.deepEqual(projects.map((p) => p.id), ['prj_1', 'prj_3']);
});

test('listProjects omits teamId entirely for the personal scope', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return jsonResponse({ projects: [], pagination: { next: null } });
  };
  await createVercelClient({ token: 't', fetchImpl }).listProjects({});
  assert.ok(!seen[0].includes('teamId='), `personal scope must not send teamId: ${seen[0]}`);
});

test('a 401 is classified as auth and never retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ error: { message: 'bad token' } }, { status: 401 }); };
  const client = createVercelClient({ token: 't', fetchImpl, sleep: async () => {} });
  await assert.rejects(() => client.listTeams(), (err) => {
    assert.ok(err instanceof VercelError);
    assert.equal(err.kind, 'auth');
    return true;
  });
  assert.equal(calls, 1, 'a bad token will not become good; do not retry');
});

test('a 429 is retried and can succeed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } });
    return jsonResponse({ teams: [{ id: 'team_example', slug: 'acme', name: 'Acme' }] });
  };
  const client = createVercelClient({ token: 't', fetchImpl, sleep: async () => {} });
  assert.deepEqual(await client.listTeams(), [{ id: 'team_example', slug: 'acme', name: 'Acme' }]);
  assert.equal(calls, 2);
});

test('visitsAggregate sends the documented query parameters', async () => {
  let seen = '';
  const fetchImpl = async (url) => {
    seen = String(url);
    return jsonResponse({ data: [{ timestamp: '2026-09-01T00:00:00.000Z', pageviews: 5, visitors: 3 }] });
  };
  const client = createVercelClient({ token: 't', fetchImpl });
  const rows = await client.visitsAggregate({
    projectId: 'prj_example', teamId: 'team_example',
    since: '2026-09-01', until: '2026-09-07', by: 'day',
  });
  assert.ok(seen.includes('projectId=prj_example'));
  assert.ok(seen.includes('by=day'));
  assert.deepEqual(rows, [{ timestamp: '2026-09-01T00:00:00.000Z', pageviews: 5, visitors: 3 }]);
});

test('the token travels as a bearer header, never in the query string', async () => {
  let init = null;
  let url = '';
  const fetchImpl = async (u, i) => { url = String(u); init = i; return jsonResponse({ teams: [] }); };
  await createVercelClient({ token: 'secret-token', fetchImpl }).listTeams();
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.ok(!url.includes('secret-token'), 'a token in a URL leaks into logs and referrers');
});
