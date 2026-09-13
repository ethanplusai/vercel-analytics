// web/views/projects.js
//
// One row per project: name, team, and — on demand — its own traffic. There
// is no per-project overview endpoint (the only project-scoped query the API
// exposes is `/api/dimension/:name?projectId=`), so a row's totals are
// derived by summing the "route" breakdown for that one project rather than
// fetched eagerly for every project on page load. That keeps the initial
// load to exactly the two calls the loading strategy requires — a project
// row a reader never expands never costs an upstream call — and the numbers
// it produces are genuinely accurate: scoped to a single project, Vercel's
// visitor count IS a true unique count, not a sum (see web/ui.js).

import { el, clear, formatCount } from '../ui.js';
import { getDimension } from '../api.js';

function totalsFromRows(rows) {
  return rows.reduce((acc, row) => {
    acc.pageviews += row.pageviews || 0;
    acc.visitors += row.visitorsSum || 0;
    return acc;
  }, { pageviews: 0, visitors: 0 });
}

function buildBar(pageviews, overallPageviews) {
  const pct = overallPageviews > 0 ? Math.min(100, (pageviews / overallPageviews) * 100) : 0;
  const track = el('div', { className: 'bar-track project-row__bar-track' });
  const bar = el('div', { className: 'bar' });
  bar.style.width = `max(2px, ${pct}%)`;
  track.append(bar);
  return track;
}

function buildRow(project, { range, overviewTotals }) {
  let loaded = false;
  let loading = false;
  let abortController = null;

  const stats = el('div', { className: 'project-row__stats' });
  const placeholder = el('span', { className: 'muted', text: 'Not opened yet' });
  stats.append(placeholder);

  const chevron = el('span', { className: 'dim-chevron', attrs: { 'aria-hidden': 'true' }, text: '›' });
  const summary = el('summary', { className: 'panel__head project-row__head' }, [
    el('div', { className: 'project-row__id' }, [
      el('span', { className: 'project-row__name', text: project.name }),
      el('span', { className: 'badge', text: project.team }),
    ]),
    stats,
    chevron,
  ]);

  const body = el('div', { className: 'panel__body' });

  const row = el('details', { className: 'panel project-row' }, [summary, body]);

  async function load() {
    if (loading) return;
    loading = true;
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;

    clear(body);
    body.append(el('div', { className: 'skeleton skeleton-line' }), el('div', { className: 'skeleton skeleton-line' }));

    try {
      const data = await getDimension('route', { range, projectId: project.id, signal: controller.signal });
      if (controller.signal.aborted) return;
      const totals = totalsFromRows(data.rows);

      clear(stats);
      const pvText = totals.pageviews === 0 ? 'enabled, no traffic' : `${formatCount(totals.pageviews)} pageviews`;
      stats.append(el('span', { className: 'project-row__pv', text: pvText }));
      if (totals.pageviews > 0) {
        stats.append(el('span', { className: 'project-row__visitors muted', text: `${formatCount(totals.visitors)} visitors` }));
      }

      clear(body);
      if (totals.pageviews === 0) {
        body.append(el('p', { className: 'muted', text: 'enabled, no traffic' }));
      } else {
        body.append(
          el('p', {}, [
            `${formatCount(totals.pageviews)} pageviews · ${formatCount(totals.visitors)} visitors (unique to this project) `,
          ]),
          buildBar(totals.pageviews, overviewTotals.pageviews),
          el('p', { className: 'muted project-row__share', text: 'Share of pageviews across every project in this range.' }),
        );
      }
      loaded = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      clear(body);
      const wrap = el('div');
      wrap.append(el('p', { className: 'error-text', text: err.message || 'Could not load this project.' }));
      const retry = el('button', { className: 'btn btn--xs', type: 'button', text: 'Try again' });
      retry.addEventListener('click', () => load());
      wrap.append(retry);
      body.append(wrap);
      clear(stats);
      stats.append(el('span', { className: 'error-text', text: 'Failed to load' }));
    } finally {
      loading = false;
    }
  }

  row.addEventListener('toggle', () => {
    chevron.classList.toggle('dim-chevron--open', row.open);
    if (row.open && !loaded) load();
  });

  return {
    node: row,
    destroy() {
      if (abortController) abortController.abort();
    },
  };
}

/** `renderProjects(container, { projects, range, overviewTotals }) -> { destroy() }` */
export function renderProjects(container, { projects, range, overviewTotals }) {
  clear(container);

  const section = el('section', { className: 'projects-section' });
  section.append(el('h2', { className: 'section-title', text: 'Projects' }));

  if (projects.length === 0) {
    section.append(el('p', { className: 'muted', text: 'No analytics-enabled projects found.' }));
    container.append(section);
    return { destroy() {} };
  }

  const list = el('div', { className: 'project-list' });
  const rows = projects.map((p) => buildRow(p, { range, overviewTotals }));
  for (const r of rows) list.append(r.node);
  section.append(list);
  container.append(section);

  return {
    destroy() {
      for (const r of rows) r.destroy();
    },
  };
}
