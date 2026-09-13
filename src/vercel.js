const DEFAULT_BASE_URL = 'https://api.vercel.com';

export class VercelError extends Error {
  constructor(message, { kind = 'unknown', status = null, path = null } = {}) {
    super(message);
    this.name = 'VercelError';
    this.kind = kind;
    this.status = status;
    this.path = path;
  }
}

function classify(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

// Only these are worth trying again. A 401 will not become valid, and a 400
// means the request itself is wrong.
const RETRYABLE = new Set(['rate_limit', 'server', 'network']);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVercelClient({
  token,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  sleep = defaultSleep,
  maxRetries = 3,
} = {}) {
  async function request(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          // The token goes in a header, never the query string: URLs end up in
          // logs, proxies and referrer headers.
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new VercelError(err.message, { kind: 'network', path });
      }

      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }

      if (res.ok) return body;

      const kind = classify(res.status);
      if (RETRYABLE.has(kind) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : 500 * 2 ** attempt;
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      const message = body?.error?.message || `Vercel API returned ${res.status}`;
      throw new VercelError(message, { kind, status: res.status, path });
    }
  }

  return {
    request,

    async listTeams() {
      const body = await request('/v2/teams', { limit: 100 });
      return (body?.teams ?? []).map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
    },

    /**
     * Every analytics-enabled project in one scope.
     *
     * `/v9/projects` paginates: the response carries `pagination.next`, a
     * timestamp cursor passed back as `until`. A single limit=100 request
     * silently truncates a larger account, which is why this loops.
     */
    async listProjects({ teamId } = {}) {
      const out = [];
      let until;
      // A bounded loop rather than trusting the API to eventually stop.
      for (let page = 0; page < 50; page += 1) {
        const body = await request('/v9/projects', { teamId, limit: 100, until });
        for (const p of body?.projects ?? []) {
          const enabledAt = p?.webAnalytics?.enabledAt ?? null;
          if (enabledAt) out.push({ id: p.id, name: p.name, enabledAt });
        }
        const next = body?.pagination?.next;
        if (!next) break;
        until = next;
      }
      return out;
    },

    async visitsAggregate({ projectId, teamId, since, until, by, limit = 100 }) {
      const body = await request('/v1/query/web-analytics/visits/aggregate', {
        projectId, teamId, since, until, by, limit,
      });
      return body?.data ?? [];
    },
  };
}
