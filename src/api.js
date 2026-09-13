import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRouter, sendJson, sendError, createStaticHandler, isRequestLocal,
} from './http.js';
import { mapPool } from './pool.js';
import { combineSeries, combineDimension } from './aggregate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The dashboard built in a later task lives at the project root's `web/`,
// a sibling of `src/`.
const PUBLIC_DIR = join(HERE, '..', 'web');

const RANGE_DAYS = { 7: 7, 30: 30, 90: 90, 365: 365 };
const DEFAULT_RANGE_DAYS = 30;

// A fixed allowlist. `Object.hasOwn` rather than `in`, so an inherited name
// like `constructor` cannot reach the upstream query string.
export const DIMENSIONS = [
  'country', 'referrer_hostname', 'device_type',
  'browser_name', 'os_name', 'request_path', 'route',
];
const DIMENSION_SET = new Set(DIMENSIONS);

const PROJECT_NOT_FOUND_MESSAGE = 'No analytics-enabled project with that id.';

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

export function resolveRange(rangeParam, now) {
  const days = Object.hasOwn(RANGE_DAYS, rangeParam) ? RANGE_DAYS[rangeParam] : DEFAULT_RANGE_DAYS;
  const untilDay = isoDay(now);
  const sinceDay = isoDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  return { days, sinceDay, untilDay };
}

export function createApi({ config, client, cache, now = () => new Date() }) {
  const router = createRouter();
  const serveStatic = createStaticHandler({ root: PUBLIC_DIR });

  // Runs the actual discovery: every scope (personal, plus each team the
  // token can see) queried for its projects, merged and de-duplicated. Never
  // throws — a failure at any stage (listTeams, or one scope's listProjects)
  // is recorded in `failures` and everything else still gets queried, so a
  // single upstream failure degrades the result instead of emptying it.
  async function runDiscovery() {
    const scopes = [{ teamId: undefined, slug: null, name: 'Personal' }];
    const failures = [];

    // A failed listTeams() must not skip the personal scope below — it
    // needs no teams call at all, so there is no reason personal projects
    // should vanish just because team discovery failed (a 429/5xx surviving
    // retries, or an expired token).
    let teams = [];
    try {
      teams = await client.listTeams();
    } catch (err) {
      failures.push({ scope: 'teams', type: err.kind ?? 'unknown', message: err.message });
    }
    for (const t of teams) {
      if (config.teams.length && !config.teams.includes(t.slug)) continue;
      scopes.push({ teamId: t.id, slug: t.slug, name: t.name });
    }

    const results = await mapPool(scopes, config.concurrency, async (scope) => {
      const list = await client.listProjects({ teamId: scope.teamId });
      return list.map((p) => ({ ...p, team: scope.name, teamSlug: scope.slug, teamId: scope.teamId }));
    });

    // A project belongs to exactly one real scope, but keep this
    // defensive: de-duplicate by id so a scope that reports a project
    // already seen (a quirky API response, or a token whose personal and
    // team listings overlap) can never double-count it in a combined
    // total. A team-scoped copy is preferred over the personal one when
    // both exist: the personal scope carries `teamId: undefined`, so if
    // the surviving record were the personal copy, `perProject` below
    // would query Vercel for it with no teamId — the wrong scope for a
    // project that actually lives under a team. Among same-typed
    // duplicates (two teams both listing it, say), first occurrence wins.
    const byId = new Map();
    results.forEach((r, i) => {
      if (r.ok) {
        for (const p of r.value) {
          const existing = byId.get(p.id);
          if (!existing || (existing.teamId == null && p.teamId != null)) {
            byId.set(p.id, p);
          }
        }
      } else {
        failures.push({
          scope: scopes[i].slug ?? 'personal', type: r.error.kind ?? 'unknown', message: r.error.message,
        });
      }
    });
    return { projects: [...byId.values()], failures };
  }

  // Discover every analytics-enabled project the token can see, once per
  // TTL. A degraded result (any failures at all — teams or a scope) is
  // never cached: cache.wrap only withholds a REJECTED loader from the
  // cache, but runDiscovery() always resolves (so a failed listTeams()
  // doesn't also wipe the personal scope, see above) — so this wraps the
  // cache itself rather than relying on wrap() to notice the failure.
  // Caching a degraded result would mean Refresh cannot recover for the
  // whole TTL even after the underlying problem (an expired token, a
  // transient 5xx) is fixed.
  async function discover() {
    const hit = cache.get('projects');
    if (hit) return hit;
    const result = await runDiscovery();
    if (result.failures.length === 0) {
      return cache.set('projects', result);
    }
    return { value: result, storedAt: now().getTime() };
  }

  // Fan out one analytics query per project and collect partial failures.
  async function perProject({ projects, since, until, by, projectFilter }) {
    const targets = projectFilter ? projects.filter((p) => p.id === projectFilter) : projects;
    const results = await mapPool(targets, config.concurrency, async (p) => {
      const key = `q:${p.id}:${since}:${until}:${by ?? 'day'}`;
      const hit = await cache.wrap(key, () => client.visitsAggregate({
        projectId: p.id, teamId: p.teamId, since, until, by,
      }));
      return { projectId: p.id, rows: hit.value, storedAt: hit.storedAt };
    });

    const ok = [];
    const failures = [];
    results.forEach((r, i) => {
      if (r.ok) ok.push(r.value);
      else failures.push({ scope: targets[i].name, type: r.error.kind ?? 'unknown', message: r.error.message });
    });
    // The age shown is the worst case, not a flattering one: the OLDEST
    // contributing response, because cache entries expire independently and
    // a combined view can be assembled from responses of different ages.
    const oldest = ok.length ? Math.min(...ok.map((o) => o.storedAt)) : now().getTime();
    return { perProject: ok, failures, fetchedAt: new Date(oldest).toISOString() };
  }

  router.get('/api/health', async (req, res) => sendJson(res, 200, { ok: true }));

  router.get('/api/projects', async (req, res) => {
    const { value, storedAt } = await discover();
    sendJson(res, 200, {
      projects: value.projects.map(({ id, name, team, teamSlug, enabledAt }) => (
        { id, name, team, teamSlug, enabledAt }
      )),
      failures: value.failures,
      fetchedAt: new Date(storedAt).toISOString(),
    });
  });

  // A single project's own daily series. Unlike /api/overview and
  // /api/dimension/:name, this is scoped to exactly one project — so its
  // visitor figure IS Vercel's own deduplicated count for that project, and
  // the field is named `visitors`, never `visitorsSum` (that name is
  // reserved for a figure summed across projects, which this is not; see
  // src/aggregate.js's header comment). A project id that does not resolve
  // to an analytics-enabled project (unknown, deleted, or analytics simply
  // never turned on) is a 404 either way — discover() only ever returns
  // analytics-enabled projects, so both cases look identical here.
  router.get('/api/projects/:id', async (req, res, ctx) => {
    const { sinceDay, untilDay } = resolveRange(ctx.query.range, now());
    const { value } = await discover();
    const project = value.projects.find((p) => p.id === ctx.params.id);
    if (!project) {
      sendError(res, 404, 'not_found', PROJECT_NOT_FOUND_MESSAGE);
      return;
    }
    const q = await perProject({
      projects: value.projects, since: sinceDay, until: untilDay, by: 'day', projectFilter: project.id,
    });
    const combined = combineSeries(q.perProject, { sinceDay, untilDay });
    sendJson(res, 200, {
      project: {
        id: project.id, name: project.name, team: project.team, teamSlug: project.teamSlug, enabledAt: project.enabledAt,
      },
      days: combined.days,
      pageviews: combined.pageviews,
      visitors: combined.visitorsSum,
      totals: {
        pageviews: combined.totals.pageviews,
        visitors: combined.totals.visitorsSum,
      },
      failures: [...value.failures, ...q.failures],
      fetchedAt: q.fetchedAt,
    });
  });

  router.get('/api/overview', async (req, res, ctx) => {
    const { sinceDay, untilDay } = resolveRange(ctx.query.range, now());
    const { value } = await discover();
    const q = await perProject({ projects: value.projects, since: sinceDay, until: untilDay, by: 'day' });
    const combined = combineSeries(q.perProject, { sinceDay, untilDay });
    sendJson(res, 200, {
      ...combined,
      failures: [...value.failures, ...q.failures],
      fetchedAt: q.fetchedAt,
    });
  });

  router.get('/api/dimension/:name', async (req, res, ctx) => {
    const name = ctx.params.name;
    if (!DIMENSION_SET.has(name)) {
      sendError(res, 400, 'unknown_dimension', `Not a supported dimension: ${name}`);
      return;
    }
    const projectId = ctx.query.projectId ?? null;
    const { sinceDay, untilDay } = resolveRange(ctx.query.range, now());
    const { value } = await discover();
    // Consistent with GET /api/projects/:id: an unknown/unresolvable
    // project id is a 404, not a silently empty result. Without this check,
    // `perProject`'s filter below simply matches nothing and the response
    // reads as "this project has no traffic" rather than "this project
    // doesn't exist" — indistinguishable from a real quiet week.
    if (projectId && !value.projects.some((p) => p.id === projectId)) {
      sendError(res, 404, 'not_found', PROJECT_NOT_FOUND_MESSAGE);
      return;
    }
    const q = await perProject({
      projects: value.projects, since: sinceDay, until: untilDay,
      by: name, projectFilter: projectId,
    });
    sendJson(res, 200, {
      dimension: name,
      ...combineDimension(q.perProject),
      failures: [...value.failures, ...q.failures],
      fetchedAt: q.fetchedAt,
    });
  });

  // createRouter/createStaticHandler each resolve to Promise<boolean> (route
  // matched or not) rather than owning the whole response cycle, so this is
  // the single place that composes the full request lifecycle: the host
  // guard, then the API router, then static files, then a 404. Session auth
  // (the /login and /logout routes, and gating everything else while
  // unauthenticated) is a layer server.js wraps around the handler returned
  // here — this function has no notion of it, so it stays testable, as
  // test/api.test.js does, without ever standing up a passphrase. A handler
  // that throws is already caught inside `router.handle` and turned into a
  // 500, so nothing here needs its own try/catch.
  return async function handleRequest(req, res) {
    if (!isRequestLocal(req, { extraHosts: config.allowedHosts ?? [] })) {
      sendError(res, 403, 'forbidden_host', 'This server only accepts requests from the local machine.');
      return;
    }

    if (await router.handle(req, res)) return;
    if (await serveStatic(req, res)) return;
    sendError(res, 404, 'not_found', 'Not found.');
  };
}
