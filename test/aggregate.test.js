import test from 'node:test';
import assert from 'node:assert/strict';
import { utcDay, dayRange, combineSeries, combineDimension } from '../src/aggregate.js';

test('timestamps become UTC day strings regardless of local zone', () => {
  assert.equal(utcDay('2026-09-01T00:00:00.000Z'), '2026-09-01');
  assert.equal(utcDay('2026-09-01T23:59:59.999Z'), '2026-09-01');
  assert.equal(utcDay('2026-09-02T00:00:00.000Z'), '2026-09-02');
});

test('dayRange is inclusive and rolls over months', () => {
  assert.deepEqual(dayRange('2026-08-30', '2026-09-02'),
    ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  assert.deepEqual(dayRange('2026-09-01', '2026-09-01'), ['2026-09-01']);
});

test('pageviews are summed across projects and missing days are zero-filled', () => {
  const out = combineSeries([
    { projectId: 'a', rows: [
      { timestamp: '2026-09-01T00:00:00.000Z', pageviews: 10, visitors: 4 },
      { timestamp: '2026-09-03T00:00:00.000Z', pageviews: 5, visitors: 2 },
    ] },
    { projectId: 'b', rows: [
      { timestamp: '2026-09-01T00:00:00.000Z', pageviews: 7, visitors: 3 },
    ] },
  ], { sinceDay: '2026-09-01', untilDay: '2026-09-03' });

  assert.deepEqual(out.days, ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(out.pageviews, [17, 0, 5]);
  assert.equal(out.totals.pageviews, 22);
  assert.equal(out.totals.projects, 2);
});

// THE RULE THIS PRODUCT EXISTS TO KEEP.
test('visitorsSum is an ADDITION of per-project visitors, never a deduplication', () => {
  // The same human visits both sites on the same day. Vercel reports 1 visitor
  // for each project, because it deduplicates only within one project's query.
  // The honest combined figure is 2 — "visitor-days across sites" — not 1.
  // There is no cross-project unique count available from the API, so anything
  // that returns 1 here is inventing a number.
  const out = combineSeries([
    { projectId: 'a', rows: [{ timestamp: '2026-09-01T00:00:00.000Z', pageviews: 3, visitors: 1 }] },
    { projectId: 'b', rows: [{ timestamp: '2026-09-01T00:00:00.000Z', pageviews: 4, visitors: 1 }] },
  ], { sinceDay: '2026-09-01', untilDay: '2026-09-01' });

  assert.deepEqual(out.visitorsSum, [2]);
  assert.equal(out.totals.visitorsSum, 2);
});

test('a project with no rows contributes nothing but still counts as a project', () => {
  const out = combineSeries([
    { projectId: 'a', rows: [{ timestamp: '2026-09-01T00:00:00.000Z', pageviews: 3, visitors: 1 }] },
    { projectId: 'b', rows: [] },
  ], { sinceDay: '2026-09-01', untilDay: '2026-09-01' });
  assert.deepEqual(out.pageviews, [3]);
  assert.equal(out.totals.projects, 2);
});

test('dimension rows merge by value and sort by pageviews descending', () => {
  const out = combineDimension([
    { projectId: 'a', rows: [
      { value: 'US', pageviews: 10, visitors: 6 },
      { value: 'DE', pageviews: 3, visitors: 2 },
    ] },
    { projectId: 'b', rows: [
      { value: 'US', pageviews: 5, visitors: 4 },
      { value: 'FR', pageviews: 9, visitors: 7 },
    ] },
  ]);
  assert.deepEqual(out.rows.map((r) => [r.value, r.pageviews, r.visitorsSum]), [
    ['US', 15, 10], ['FR', 9, 7], ['DE', 3, 2],
  ]);
});

test('an Others bucket is kept, flagged, and sorted last however large it is', () => {
  // Each project's "Others" means a different set of values, so the merged
  // bucket is not comparable with real rows and must never outrank them.
  const out = combineDimension([
    { projectId: 'a', rows: [{ value: 'Others', pageviews: 900, visitors: 500 }] },
    { projectId: 'b', rows: [{ value: 'US', pageviews: 10, visitors: 6 }] },
  ]);
  assert.deepEqual(out.rows.map((r) => r.value), ['US', 'Others']);
  assert.equal(out.rows[1].others, true);
  assert.equal(out.rows[0].others, false);
});

test('dimension values are read from whichever key Vercel used', () => {
  // Grouped responses name the column after the dimension (e.g. `country`),
  // so the merger must not assume a literal `value` key.
  const out = combineDimension([
    { projectId: 'a', rows: [{ country: 'US', pageviews: 4, visitors: 2 }] },
  ]);
  assert.deepEqual(out.rows.map((r) => [r.value, r.pageviews]), [['US', 4]]);
});
