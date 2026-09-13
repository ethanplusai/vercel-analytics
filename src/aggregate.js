/**
 * Pure merging for Web Analytics responses. No I/O, no imports.
 *
 * THE RULE: pageviews may be summed across projects; visitors may not.
 * Vercel deduplicates visitors within the scope of a single query, and every
 * query here is scoped to one project. Adding two projects' visitor counts
 * therefore counts anyone who visited both of them twice. There is no
 * cross-project unique figure available from the API, so the summed value is
 * named `visitorsSum` everywhere and must never be presented as "visitors".
 */

const OTHERS = 'Others';

export function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function dayRange(sinceDay, untilDay) {
  const days = [];
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  let cursor = Date.parse(`${sinceDay}T00:00:00Z`);
  // Bounded so a malformed range cannot spin forever.
  for (let i = 0; cursor <= end && i < 4000; i += 1) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
}

export function combineSeries(perProject, { sinceDay, untilDay }) {
  const days = dayRange(sinceDay, untilDay);
  const index = new Map(days.map((d, i) => [d, i]));
  const pageviews = new Array(days.length).fill(0);
  const visitorsSum = new Array(days.length).fill(0);

  for (const project of perProject) {
    for (const row of project.rows ?? []) {
      const i = index.get(utcDay(row.timestamp));
      if (i === undefined) continue;
      pageviews[i] += row.pageviews ?? 0;
      visitorsSum[i] += row.visitors ?? 0;
    }
  }

  return {
    days,
    pageviews,
    visitorsSum,
    totals: {
      pageviews: pageviews.reduce((a, b) => a + b, 0),
      visitorsSum: visitorsSum.reduce((a, b) => a + b, 0),
      projects: perProject.length,
    },
  };
}

// A grouped response names its column after the dimension (`country`, `route`,
// …), so pick the first key that is not a metric rather than assuming `value`.
const METRIC_KEYS = new Set(['pageviews', 'visitors', 'timestamp']);

function valueOf(row) {
  if (row.value !== undefined) return String(row.value);
  for (const key of Object.keys(row)) {
    if (!METRIC_KEYS.has(key)) return String(row[key]);
  }
  return '(unknown)';
}

export function combineDimension(perProject) {
  const merged = new Map();

  for (const project of perProject) {
    for (const row of project.rows ?? []) {
      const value = valueOf(row);
      const entry = merged.get(value) ?? { value, pageviews: 0, visitorsSum: 0, others: value === OTHERS };
      entry.pageviews += row.pageviews ?? 0;
      entry.visitorsSum += row.visitors ?? 0;
      merged.set(value, entry);
    }
  }

  // Each project's Others covers a different set of values, so the merged
  // bucket is not comparable with real rows. It is kept for honesty about the
  // total but always sorted last, however large it is.
  const rows = [...merged.values()].sort((a, b) => {
    if (a.others !== b.others) return a.others ? 1 : -1;
    return b.pageviews - a.pageviews;
  });

  return { rows };
}
