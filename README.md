# vercel-analytics

One dashboard for [Vercel Web Analytics](https://vercel.com/docs/analytics)
across **every project, on every team, that a single Vercel token can see** —
with a combined total.

Vercel's own dashboard shows one project at a time, inside one team, and has
no cross-team view at all. If you run several sites across a personal account
and one or more teams, there is no single page that answers "how is
everything doing today?" — you have to click through each project
individually and add it up yourself. This tool queries Vercel's documented
REST API live, on every request, and does that adding-up for you.

There is no database, no polling, no cron job, no build step, and **zero
npm dependencies**. It is plain Node.js, start to finish.

## Quick start

1. Create a Vercel access token at
   [vercel.com/account/tokens](https://vercel.com/account/tokens). Read
   access is enough — this tool never writes anything to your Vercel account.
2. Run it:

   ```bash
   VERCEL_TOKEN=your-token-here npm start
   ```

   There is no install step. The project has no dependencies, so there is
   nothing for `npm install` to fetch.
3. Open the page the server prints (`http://127.0.0.1:4320` by default).

That's it — every analytics-enabled project the token can see, across your
personal scope and every team, on one page.

## Configuration

All configuration is environment variables. Only `VERCEL_TOKEN` is required.

| Variable | Default | Meaning |
|---|---|---|
| `VERCEL_TOKEN` | — | **Required.** A Vercel access token with read access. |
| `PORT` (or `VA_PORT`) | `4320` | Port to listen on. `PORT` takes precedence if both are set. |
| `VA_HOST` | `127.0.0.1` | Interface to bind to. |
| `VA_API_BASE_URL` | `https://api.vercel.com` | Override the Vercel API base URL. Mainly for tests. |
| `VA_PASSWORD` | — | Passphrase login. Required once the server is reachable beyond loopback (see [Deployment](#deployment)). Must be 20+ characters after trimming. |
| `VA_ALLOW_PUBLIC` | `0` | Deliberate override to run exposed beyond loopback with **no** passphrase. |
| `VA_ALLOWED_HOSTS` | — | Comma-separated `Host` header values to accept in addition to loopback names — the hostname(s) this deployment is actually served on. Required once exposed beyond loopback (see [Deployment](#deployment)). |
| `VA_SECURE_COOKIES` | on when exposed beyond loopback, off otherwise | Force the session cookie's `Secure` flag on or off. |
| `VA_CACHE_TTL_MS` | `300000` (5 minutes) | How long a fetched Vercel API response is reused before being re-fetched. |
| `VA_CONCURRENCY` | `5` | How many upstream Vercel API requests run at once. |
| `VA_TEAMS` | all teams | Comma-separated allowlist of team slugs. When set, only these teams (plus your personal scope) are queried. |

`VERCEL_TOKEN` keeps its conventional name because it's what the Vercel CLI
and other Vercel tooling already use. Everything this project invents is
`VA_`-prefixed.

## The visitors rule — read this before you trust a combined number

**Pageviews sum across projects. Visitors do not, and the combined field
reflects that.**

Vercel deduplicates a "visitor" only *within the scope of a single query* —
one project, one time window. Every query this tool makes to Vercel's
Web Analytics API is scoped to exactly one project, because that is the only
scope the API supports. There is no endpoint, documented or otherwise, that
returns a deduplicated visitor count across multiple projects.

That means when this tool combines several projects' numbers into one total,
the visitor figure is a **sum of already-deduplicated per-project counts** —
not a fresh deduplication across all of them. Someone who visits two of your
sites in the same window is counted once for each site, so twice in the
total. There is no way to avoid this with the data the API provides; any tool
that claims a cross-project "unique visitors" number is either wrong or
guessing.

Because of this, the two figures are named differently and deliberately:

- A **single-project** view (`/api/projects/:id`, or the "Per project" band
  of the dashboard) reports a field called **`visitors`**. This is exactly
  Vercel's own number for that one project — genuinely deduplicated, because
  it never crosses a project boundary.
- Any **combined** view (`/api/overview`, `/api/dimension/:name`, the
  "Combined" band and the dimension tables) reports a field called
  **`visitorsSum`**, never `visitors`. It is a sum, and its name says so.

If you only care about one project's traffic, `visitors` is trustworthy as
Vercel reports it. If you're looking at a combined figure across projects,
treat it as an upper bound on how many people visited *something*, not a
count of distinct people.

## API

All four data routes return JSON and share two response conventions:

- `failures`: an array of `{ scope, message }` for any team or project that
  could not be reached. One failing project or team never empties the
  response for everything else — you get partial results plus a list of
  what didn't come back.
- `fetchedAt`: an ISO timestamp for the data's age. When a response mixes
  several cached upstream calls of different ages, this is the **oldest**
  of them, so it never reads more fresh than the stalest number it contains.

### `GET /api/health`

Liveness check. Returns `{ "ok": true }`. No auth beyond the host guard
below.

### `GET /api/projects`

Every analytics-enabled project the token can see, across your personal
scope and every team (or every team listed in `VA_TEAMS`, if set).

```json
{
  "projects": [
    { "id": "prj_example", "name": "acme-site", "team": "Acme", "teamSlug": "acme", "enabledAt": 1690000000000 }
  ],
  "failures": [],
  "fetchedAt": "2026-09-13T12:00:00.000Z"
}
```

### `GET /api/projects/:id?range=7|30|90|365`

One project's own daily series. `range` selects the window in days and
defaults to `30`. Because this is scoped to exactly one project, `visitors`
here is Vercel's own deduplicated figure for that project — see
[The visitors rule](#the-visitors-rule--read-this-before-you-trust-a-combined-number)
above. An id that doesn't resolve to an analytics-enabled project (unknown,
deleted, or analytics never enabled) is a `404`.

```json
{
  "project": { "id": "prj_example", "name": "acme-site", "team": "Acme", "teamSlug": "acme", "enabledAt": 1690000000000 },
  "days": ["2026-08-15", "..."],
  "pageviews": [120, 98, "..."],
  "visitors": [45, 39, "..."],
  "totals": { "pageviews": 4200, "visitors": 1500 },
  "failures": [],
  "fetchedAt": "2026-09-13T12:00:00.000Z"
}
```

### `GET /api/overview?range=7|30|90|365`

The combined daily series across every project. `range` defaults to `30`.

```json
{
  "days": ["2026-08-15", "..."],
  "pageviews": [820, 764, "..."],
  "visitorsSum": [310, 289, "..."],
  "totals": { "pageviews": 25000, "visitorsSum": 9200, "projects": 6 },
  "failures": [],
  "fetchedAt": "2026-09-13T12:00:00.000Z"
}
```

### `GET /api/dimension/:name?range=7|30|90|365&projectId=…`

A breakdown by one dimension, combined across projects (or scoped to one
project with `projectId`). `:name` must be one of the allowlisted
dimensions: `country`, `referrer_hostname`, `device_type`, `browser_name`,
`os_name`, `request_path`, `route`. Any other value is a `400`.

```json
{
  "dimension": "country",
  "rows": [
    { "value": "US", "pageviews": 9000, "visitorsSum": 3200, "others": false },
    { "value": "Others", "pageviews": 1200, "visitorsSum": 500, "others": true }
  ],
  "failures": [],
  "fetchedAt": "2026-09-13T12:00:00.000Z"
}
```

`Others` (Vercel's own long-tail bucket) is a different set of underlying
values per project, so it's not a comparable row with the rest — it's kept
for an honest total but always sorted last.

## Embedding

Two ways to use this outside its own dashboard:

- **Proxy the JSON API.** Point another frontend, or a server-side fetch, at
  the four routes above. They're plain JSON over HTTP with no
  framework-specific shape.
- **Import the aggregation core directly.** `src/vercel.js` (the Vercel API
  client) and `src/aggregate.js` (the merging logic, including the
  visitors-sum rule) are both plain ESM modules with no framework
  assumptions and no dependencies. `src/aggregate.js` in particular is pure
  and does no I/O at all — feed it the same `perProject` shape the API uses
  internally and it will merge it the same way, with no server required.

## Requirements

- **Node 20+** to run it.
- **Node 22+** to develop it — `node --test`'s glob support
  (`test/**/*.test.js`) requires Node 22; the test suite will not discover
  its files on Node 20 or 21.

The suite currently stands at **98 passing tests, 0 failing** (`npm test`,
run on Node 22.23.1).

## The reporting-window caveat

How far back Vercel's Web Analytics API reports data depends on your plan,
and the API never says which plan a project is on:

- **Hobby**: 1 month
- **Pro**: 12 months
- **Pro with Web Analytics Plus**: 24 months

Ask for a longer range than your plan retains and Vercel doesn't error —
it just returns empty days for the part outside the window. Since one page
here can mix projects from several plans at once, there's no single "disable
this range button" rule that would be right for all of them. Instead, the
dashboard **labels** the empty leading region ("outside your plan's
reporting window") rather than guessing or hiding it.

## Deployment

This is a plain Node HTTP server — deploy it anywhere Node runs, including
as a Vercel serverless function (`server.js` exports a handler Vercel's
platform can call directly). Two startup checks exist to keep an exposed
instance from being an accidental open door onto your traffic data:

- **No passphrase, no public exposure.** If the server is reachable beyond
  loopback (detected by running on Vercel, or by `VA_ALLOWED_HOSTS` being
  set) and `VA_PASSWORD` isn't set, startup fails with an error naming the
  fix: set `VA_PASSWORD` (20+ characters), or set `VA_ALLOW_PUBLIC=1` to
  deliberately run it with no login.
- **`VA_ALLOWED_HOSTS` is required once exposed.** Every request — including
  `/login` — is checked against an allowlist of loopback names plus whatever
  `VA_ALLOWED_HOSTS` adds. Deploy without setting it and the server starts
  but refuses every single request as a forbidden host, which reads like a
  broken login rather than a missing setting — so startup fails early
  instead, naming exactly which variable to set: list the hostname(s) this
  deployment is served on (e.g. `analytics.example.com`).

Both failures happen at startup, not at request time, and both name their
own fix in the error message.
