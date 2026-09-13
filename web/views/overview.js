// web/views/overview.js
//
// The combined chart: one time series across every project the token can
// see. `data` is already fetched by app.js (part of the two-call initial
// load) — this view only renders it.

import { el, clear, formatCount, formatVisitorsSumNote, reportingWindowNote } from '../ui.js';
import { renderTimeSeries } from '../charts.js';

/** `renderOverview(container, { data }) -> { destroy() }` */
export function renderOverview(container, { data }) {
  clear(container);

  const section = el('section', { className: 'overview-section' });
  const chartContainer = el('div');
  // The visitors-sum caveat and the reporting-window note are appended as
  // SIBLINGS of chartContainer, never children of it: renderTimeSeries calls
  // `container.replaceChildren()` on every redraw (including the Table
  // toggle), which would silently erase anything appended inside it.
  const windowNote = el('p', { className: 'muted overview-note' });
  const visitorsNote = el('p', { className: 'muted overview-note', text: formatVisitorsSumNote() });

  const note = reportingWindowNote(data.days, data.pageviews);
  if (note) windowNote.textContent = note;
  else windowNote.hidden = true;

  section.append(chartContainer, windowNote, visitorsNote);
  container.append(section);

  const chartHandle = renderTimeSeries(chartContainer, {
    title: 'All projects',
    subtitle: `${formatCount(data.totals.pageviews)} pageviews across ${data.totals.projects} projects`,
    days: data.days,
    series: [
      { key: 'pageviews', label: 'Pageviews', values: data.pageviews, slot: 1 },
      { key: 'visitorsSum', label: 'Visitors (summed)', values: data.visitorsSum, slot: 2 },
    ],
    emptyMessage: 'No analytics recorded in this range.',
  });

  return {
    destroy() {
      chartHandle.destroy();
    },
  };
}
