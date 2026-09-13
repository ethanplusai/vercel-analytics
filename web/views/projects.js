// web/views/projects.js
//
// One row per project: name, team, and — on demand — its own daily traffic
// via `GET /api/projects/:id`. That endpoint is scoped to exactly one
// project, so its `visitors` figure IS Vercel's own deduplicated count for
// that project, not a sum (see web/ui.js and src/aggregate.js's header).
//
// Fetched lazily, the first time a row is opened — never on page load. A
// dashboard with dozens of projects would otherwise cost one extra upstream
// call per project just for a page that hasn't been scrolled to, on top of
// the two-call initial load the loading strategy relies on.

import { el, clear, formatCount } from '../ui.js';
import { getProject } from '../api.js';
import { renderSparkline } from '../charts.js';

function buildRow(project, { range }) {
  let loaded = false;
  let loading = false;
  let abortController = null;
  let sparkHandle = null;

  const stats = el('div', { className: 'project-row__stats' });
  stats.append(el('span', { className: 'muted', text: 'Not opened yet' }));

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

  function destroySpark() {
    if (sparkHandle) sparkHandle.destroy();
    sparkHandle = null;
  }

  async function load() {
    if (loading) return;
    loading = true;
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;

    clear(body);
    body.append(el('div', { className: 'skeleton skeleton-line' }), el('div', { className: 'skeleton skeleton-block' }));

    try {
      const data = await getProject(project.id, { range, signal: controller.signal });
      if (controller.signal.aborted) return;
      const { totals } = data;

      clear(stats);
      const pvText = totals.pageviews === 0 ? 'enabled, no traffic' : `${formatCount(totals.pageviews)} pageviews`;
      stats.append(el('span', { className: 'project-row__pv', text: pvText }));
      if (totals.pageviews > 0) {
        stats.append(el('span', { className: 'project-row__visitors muted', text: `${formatCount(totals.visitors)} visitors` }));
      }

      clear(body);
      destroySpark();
      if (totals.pageviews === 0) {
        body.append(el('p', { className: 'muted', text: 'enabled, no traffic' }));
      } else {
        body.append(el('p', {}, [
          `${formatCount(totals.pageviews)} pageviews · ${formatCount(totals.visitors)} visitors (unique to this project)`,
        ]));
        const sparkContainer = el('div', { className: 'project-row__spark' });
        body.append(sparkContainer);
        sparkHandle = renderSparkline(sparkContainer, {
          values: data.pageviews,
          days: data.days,
          label: `${project.name} pageviews`,
          height: 40,
          slot: 1,
        });
      }
      loaded = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      clear(body);
      destroySpark();
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
      destroySpark();
    },
  };
}

/** `renderProjects(container, { projects, range }) -> { destroy() }` */
export function renderProjects(container, { projects, range }) {
  clear(container);

  const section = el('section', { className: 'projects-section' });
  section.append(el('h2', { className: 'section-title', text: 'Projects' }));

  if (projects.length === 0) {
    section.append(el('p', { className: 'muted', text: 'No analytics-enabled projects found.' }));
    container.append(section);
    return { destroy() {} };
  }

  const list = el('div', { className: 'project-list' });
  const rows = projects.map((p) => buildRow(p, { range }));
  for (const r of rows) list.append(r.node);
  section.append(list);
  container.append(section);

  return {
    destroy() {
      for (const r of rows) r.destroy();
    },
  };
}
