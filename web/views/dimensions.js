// web/views/dimensions.js
//
// One collapsed panel per dimension. Each panel fetches `/api/dimension/:name`
// the FIRST time it is opened — never on page load — because a full page of
// every dimension costs one upstream call per project, per dimension (~89
// calls total for a page this size). A reader who never opens "Referrers"
// never pays for it.
//
// `DIMENSIONS` is duplicated here (rather than imported) because this file
// runs in the browser and `src/api.js` pulls in Node built-ins (`node:path`,
// `node:url`) that have no browser equivalent.

import {
  el, clear, formatCount, formatVisitorsSumNote, pluralise,
} from '../ui.js';
import { getDimension } from '../api.js';

const DIMENSION_LABELS = [
  ['country', 'Countries'],
  ['referrer_hostname', 'Referrers'],
  ['device_type', 'Device types'],
  ['browser_name', 'Browsers'],
  ['os_name', 'Operating systems'],
  ['request_path', 'Pages'],
  ['route', 'Routes'],
];

function buildSkeleton() {
  const wrap = el('div', { className: 'dim-skeleton' });
  for (let i = 0; i < 4; i += 1) {
    wrap.append(el('div', { className: 'skeleton skeleton-line' }));
  }
  return wrap;
}

function buildTable(rows) {
  const table = el('table', { className: 'datatable' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Value' }),
      el('th', { text: 'Pageviews' }),
      el('th', { text: 'Visitors (summed)' }),
    ]),
  ]);
  const tbody = el('tbody');
  for (const row of rows) {
    const label = row.others ? 'Others (not comparable across projects)' : row.value;
    tbody.append(el('tr', { className: row.others ? 'dim-row--others' : undefined }, [
      el('td', { text: label }),
      el('td', { text: formatCount(row.pageviews) }),
      el('td', { text: formatCount(row.visitorsSum) }),
    ]));
  }
  table.append(thead, tbody);
  const scroll = el('div', { className: 'table-scroll' });
  scroll.append(table);
  return scroll;
}

function buildPanel(name, label, { range }) {
  let loaded = false;
  let loading = false;
  let abortController = null;

  const body = el('div', { className: 'panel__body' });
  const initial = el('p', { className: 'muted', text: 'Opens on first view.' });
  body.append(initial);

  const chevron = el('span', { className: 'dim-chevron', attrs: { 'aria-hidden': 'true' }, text: '›' });
  const summary = el('summary', { className: 'panel__head' }, [
    el('span', { className: 'panel__title', text: label }),
    chevron,
  ]);

  const details = el('details', { className: 'panel dim-panel' }, [summary, body]);

  async function load() {
    if (loading) return;
    loading = true;
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;

    clear(body);
    body.append(buildSkeleton());

    try {
      const data = await getDimension(name, { range, signal: controller.signal });
      if (controller.signal.aborted) return;
      clear(body);
      if (data.failures?.length) {
        body.append(el('p', {
          className: 'muted',
          text: `${pluralise(data.failures.length, 'project', 'projects')} could not be read for this breakdown.`,
        }));
      }
      if (!data.rows.length) {
        body.append(el('p', { className: 'muted', text: 'No data for this range.' }));
      } else {
        body.append(buildTable(data.rows));
      }
      loaded = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      clear(body);
      const errWrap = el('div', {});
      errWrap.append(el('p', { className: 'error-text', text: err.message || 'Could not load this breakdown.' }));
      const retry = el('button', { className: 'btn btn--xs', type: 'button', text: 'Try again' });
      retry.addEventListener('click', () => load());
      errWrap.append(retry);
      body.append(errWrap);
    } finally {
      loading = false;
    }
  }

  details.addEventListener('toggle', () => {
    chevron.classList.toggle('dim-chevron--open', details.open);
    if (details.open && !loaded) load();
  });

  return {
    node: details,
    destroy() {
      if (abortController) abortController.abort();
    },
  };
}

/** `renderDimensions(container, { range }) -> { destroy() }` */
export function renderDimensions(container, { range }) {
  clear(container);

  const section = el('section', { className: 'dimensions-section' });
  section.append(el('h2', { className: 'section-title', text: 'Dimensions' }));
  section.append(el('p', {
    className: 'muted',
    text: `Each panel loads when opened. ${formatVisitorsSumNote()}`,
  }));

  const panels = DIMENSION_LABELS.map(([name, label]) => buildPanel(name, label, { range }));
  for (const panel of panels) section.append(panel.node);

  container.append(section);

  return {
    destroy() {
      for (const panel of panels) panel.destroy();
    },
  };
}
