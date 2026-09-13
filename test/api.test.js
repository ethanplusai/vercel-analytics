import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApi, DIMENSIONS, resolveRange } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { createCache } from '../src/cache.js';

const NOW = new Date('2026-09-13T12:00:00Z');

// `projectsByScope`, keyed by teamId ('personal' for the personal scope),
// lets a test give each scope its own project list — the default
// (`projects` alone, same list for every scope) is what most tests here
// want, but it can never exercise per-scope attribution or the dedup
// preference between a personal and a team-scoped copy of the same id.
function stubClient({ projects = [], projectsByScope = null, rows = [] } = {}) {
  return {
    listTeams: async () => [{ id: 'team_example', slug: 'acme', name: 'Acme' }],
    listProjects: async ({ teamId } = {}) => {
      if (projectsByScope) return projectsByScope[teamId ?? 'personal'] ?? [];
      return projects;
    },
    visitsAggregate: async () => rows,
  };
}

async function withApi({ client = stubClient(), env = {} }, fn) {
  const config = loadConfig(env);
  const handler = createApi({
    config,
    client,
    cache: createCache({ ttlMs: 1000, now: () => Date.now() }),
    now: () => NOW,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('resolveRange accepts only the documented windows and defaults to 30', () => {
  assert.equal(resolveRange('7', NOW).days, 7);
  assert.equal(resolveRange('365', NOW).days, 365);
  assert.equal(resolveRange('banana', NOW).days, 30);
  assert.equal(resolveRange(undefined, NOW).days, 30);
});

test('resolveRange does not resolve inherited Object.prototype keys', () => {
  // A bare `rangeParam in TABLE` check would treat 'constructor' as valid.
  assert.equal(resolveRange('constructor', NOW).days, 30);
  assert.equal(resolveRange('toString', NOW).days, 30);
});

test('GET /api/projects lists analytics-enabled projects with their team', async () => {
  const client = stubClient({ projects: [{ id: 'prj_1', name: 'acme-site', enabledAt: 1 }] });
  await withApi({ client }, async (base) => {
    const body = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(body.projects.length > 0, true);
    assert.equal(body.projects[0].name, 'acme-site');
    assert.ok(body.fetchedAt);
  });
});

test('GET /api/overview sums pageviews and reports visitorsSum, never visitors', async () => {
  const client = stubClient({
    projects: [{ id: 'prj_1', name: 'one', enabledAt: 1 }, { id: 'prj_2', name: 'two', enabledAt: 1 }],
    rows: [{ timestamp: '2026-09-13T00:00:00.000Z', pageviews: 10, visitors: 4 }],
  });
  await withApi({ client }, async (base) => {
    const body = await (await fetch(`${base}/api/overview?range=7`)).json();
    // Both projects return the same stub row, so pageviews double.
    assert.equal(body.totals.pageviews, 20);
    assert.equal(body.totals.visitorsSum, 8);
    assert.equal('visitors' in body.totals, false, 'a key named `visitors` would be read as a unique count');
  });
});

test('GET /api/projects/:id reports one project\'s own daily series as `visitors`, never `visitorsSum`', async () => {
  const client = stubClient({
    projects: [{ id: 'prj_1', name: 'acme-site', enabledAt: 1 }, { id: 'prj_2', name: 'acme-blog', enabledAt: 1 }],
    rows: [{ timestamp: '2026-09-13T00:00:00.000Z', pageviews: 10, visitors: 4 }],
  });
  await withApi({ client }, async (base) => {
    const res = await fetch(`${base}/api/projects/prj_1?range=7`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.project.id, 'prj_1');
    assert.equal(body.project.name, 'acme-site');
    assert.equal(body.totals.pageviews, 10, 'only the requested project is queried, not both');
    // Scoped to exactly one project, so this figure IS Vercel's own
    // deduplicated count — the endpoint must name it `visitors`, and must
    // never carry a `visitorsSum` key (that name means "summed across
    // projects", which a single-project response never is).
    assert.equal(body.totals.visitors, 4);
    assert.equal('visitorsSum' in body.totals, false, 'a single project\'s figure must never be named visitorsSum');
    assert.equal('visitorsSum' in body, false);
    assert.ok(Array.isArray(body.days));
    assert.ok(Array.isArray(body.pageviews));
    assert.ok(Array.isArray(body.visitors));
    assert.ok(body.fetchedAt);
  });
});

test('GET /api/projects/:id 404s for an id with no analytics-enabled project', async () => {
  const client = stubClient({ projects: [{ id: 'prj_1', name: 'acme-site', enabledAt: 1 }] });
  await withApi({ client }, async (base) => {
    const missing = await fetch(`${base}/api/projects/prj_does_not_exist?range=7`);
    assert.equal(missing.status, 404);

    // A project the token can see but that never turned Web Analytics on
    // looks identical here: discover() never returns it at all, so it 404s
    // the same way an unknown id does.
    const notEnabled = await fetch(`${base}/api/projects/prj_no_analytics?range=7`);
    assert.equal(notEnabled.status, 404);
  });
});

test('GET /api/projects/:id only queries the one requested project upstream', async () => {
  const calls = [];
  const client = {
    listTeams: async () => [],
    listProjects: async () => [
      { id: 'prj_1', name: 'acme-site', enabledAt: 1 },
      { id: 'prj_2', name: 'acme-blog', enabledAt: 1 },
    ],
    visitsAggregate: async (args) => { calls.push(args.projectId); return []; },
  };
  await withApi({ client }, async (base) => {
    await fetch(`${base}/api/projects/prj_1?range=7`);
    assert.deepEqual(calls, ['prj_1'], 'the other project must never be queried for a single-project view');
  });
});

test('an unknown dimension is rejected rather than passed upstream', async () => {
  await withApi({}, async (base) => {
    const res = await fetch(`${base}/api/dimension/not_a_dimension?range=7`);
    assert.equal(res.status, 400);
  });
});

test('an inherited property name is not a valid dimension', async () => {
  await withApi({}, async (base) => {
    assert.equal((await fetch(`${base}/api/dimension/constructor`)).status, 400);
  });
});

test('every allowlisted dimension is accepted', async () => {
  await withApi({}, async (base) => {
    for (const name of DIMENSIONS) {
      const res = await fetch(`${base}/api/dimension/${name}?range=7`);
      assert.equal(res.status, 200, `${name} should be allowed`);
    }
  });
});

test('projects from different scopes keep their own team attribution, and it reaches visitsAggregate', async () => {
  const calls = [];
  const client = stubClient({
    projectsByScope: {
      personal: [{ id: 'prj_solo', name: 'solo-site', enabledAt: 1 }],
      team_example: [{ id: 'prj_team', name: 'acme-site', enabledAt: 1 }],
    },
  });
  client.visitsAggregate = async (args) => { calls.push(args); return []; };

  await withApi({ client }, async (base) => {
    const body = await (await fetch(`${base}/api/projects`)).json();
    const byName = Object.fromEntries(body.projects.map((p) => [p.name, p]));
    assert.equal(byName['solo-site'].team, 'Personal');
    assert.equal(byName['solo-site'].teamSlug, null);
    assert.equal(byName['acme-site'].team, 'Acme');
    assert.equal(byName['acme-site'].teamSlug, 'acme');

    await fetch(`${base}/api/overview?range=7`);
    const teamIdByProject = Object.fromEntries(calls.map((c) => [c.projectId, c.teamId]));
    // `in`, not a bare undefined check: a missing key also reads as undefined,
    // so the plain assertion would pass even if the personal project were
    // never queried at all.
    assert.ok('prj_solo' in teamIdByProject, 'the personal project must actually be queried');
    assert.equal(teamIdByProject.prj_solo, undefined, 'the personal scope must query with no teamId');
    assert.equal(teamIdByProject.prj_team, 'team_example', 'the team scope must query with its own teamId');
  });
});

test('when personal and a team both report the same project id, the team-scoped copy wins', async () => {
  // A quirky API response, or a token whose personal and team listings
  // overlap: both scopes report the same project id here (the default
  // stub ignores teamId, so both the personal and the acme-team scan see
  // it). The surviving record after dedup must be the team-scoped one —
  // the personal copy carries no teamId, which would query Vercel unscoped.
  const client = stubClient({ projects: [{ id: 'prj_shared', name: 'shared-site', enabledAt: 1 }] });
  await withApi({ client }, async (base) => {
    const body = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].team, 'Acme', 'the team-scoped copy should survive dedup, not Personal');
  });
});

test('one failing project does not empty the dashboard', async () => {
  let call = 0;
  const client = {
    listTeams: async () => [{ id: 'team_example', slug: 'acme', name: 'Acme' }],
    listProjects: async () => [
      { id: 'prj_ok', name: 'ok', enabledAt: 1 },
      { id: 'prj_bad', name: 'bad', enabledAt: 1 },
    ],
    visitsAggregate: async ({ projectId }) => {
      call += 1;
      if (projectId === 'prj_bad') throw new Error('project vanished');
      return [{ timestamp: '2026-09-13T00:00:00.000Z', pageviews: 6, visitors: 2 }];
    },
  };
  await withApi({ client }, async (base) => {
    const body = await (await fetch(`${base}/api/overview?range=7`)).json();
    assert.equal(body.totals.pageviews, 6, 'the healthy project still reports');
    assert.equal(body.failures.length, 1);
    assert.match(body.failures[0].message, /vanished/);
  });
});
