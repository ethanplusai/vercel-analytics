// web/charts.js
//
// Zero-dependency SVG chart module. This file is imported by Node for its
// pure-function tests AND served to the browser as an ES module, so it must
// never touch `document` (or any other DOM global) at module scope. All DOM
// access happens inside the three render* functions below.
//
// Chart rules enforced throughout (see the `dataviz` design system):
//   - Exactly two categorical slots, always in order: slot 1 = blue
//     (--series-1), slot 2 = orange (--series-2). No third slot.
//   - One y-axis, never two.
//   - 2px lines, round join/cap; 10%-opacity area fill; r=4 end markers with
//     a 2px surface-colour ring; solid hairline gridlines; no drop shadows.
//   - A legend is present whenever there are two series.
//   - Text is never coloured by series — axis/label/legend text uses the
//     muted/secondary/primary text tokens; identity comes from a coloured
//     mark beside the text.
//   - Every value is reachable without hovering via the chart's Table toggle.
//   - Untrusted strings (repo names, referrers, paths) go through
//     textContent/createTextNode — never innerHTML.

// ---------------------------------------------------------------------------
// Pure functions: scales, formatting, path building
// ---------------------------------------------------------------------------

export function niceTicks(min, max, target = 5, { integer = false } = {}) {
  const span = (max - min) || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10);
  if (integer) step = Math.max(1, Math.round(step));
  let start = Math.floor(min / step) * step;
  let end = Math.ceil(max / step) * step;
  if (end <= start) end = start + step;
  const ticks = [];
  for (let v = start; v <= end + step / 1e6; v += step) {
    ticks.push(integer ? Math.round(v) : Number(v.toFixed(10)));
  }
  return ticks;
}

export function linearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return String(r);
};

export function buildLinePath(points) {
  if (!points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)},${round2(p.y)}`).join('');
}

export function buildAreaPath(points, baselineY) {
  if (!points.length) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${buildLinePath(points)}L${round2(last.x)},${round2(baselineY)}L${round2(first.x)},${round2(baselineY)}Z`;
}

export function formatFullCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function formatCount(n) {
  const v = Number(n || 0);
  if (v < 10000) return formatFullCount(v);
  for (const [limit, div, suffix] of [[1e6, 1e3, 'K'], [1e9, 1e6, 'M'], [Infinity, 1e9, 'B']]) {
    if (v < limit) {
      const scaled = v / div;
      const rounded = Number(scaled.toFixed(1));
      if (rounded >= 1000) continue;           // 999,999 promotes to 1M rather than 1000.0K
      const s = rounded.toFixed(1).replace(/\.0$/, '');
      return `${s}${suffix}`;
    }
  }
  return formatFullCount(v);
}

export function formatDayLabel(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

export function formatDayLong(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

export function pickDayTicks(days, maxTicks = 6) {
  const n = days.length;
  if (n === 0) return [];
  if (n <= maxTicks) return days.map((_, i) => i);
  const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
  const out = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  if (out.length && (n - 1) - out[out.length - 1] < step) out.pop();
  out.push(n - 1);
  return out;
}

export function nearestIndex(count, ratio) {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}

export function seriesColorVar(slot) {
  if (slot !== 1 && slot !== 2) throw new Error(`unsupported series slot: ${slot}`);
  return `var(--series-${slot})`;
}

// ---------------------------------------------------------------------------
// DOM helpers (used only inside the render* functions below)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

function el(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The header used by renderTimeSeries: title, optional subtitle, an
// optional legend (only ever two coloured line-keys — never coloured text),
// and the Table toggle that is every chart's no-hover path to its data.
function buildChartHead({ title, subtitle, seriesForLegend, onToggleTable }) {
  const figcaption = el('figcaption', { className: 'chart__head' });
  figcaption.append(el('h3', { className: 'chart__title', text: title }));
  if (subtitle) figcaption.append(el('p', { className: 'chart__sub', text: subtitle }));

  const tools = el('div', { className: 'chart__tools' });
  if (seriesForLegend && seriesForLegend.length === 2) {
    const legend = el('div', { className: 'chart__legend' });
    for (const s of seriesForLegend) {
      const item = el('span', { className: 'chart__legend-item' });
      const key = el('span', { className: 'chart__legend-key' });
      key.style.background = seriesColorVar(s.slot);
      item.append(key, el('span', { className: 'chart__legend-label', text: s.label }));
      legend.append(item);
    }
    tools.append(legend);
  }
  const tableButton = el('button', { className: 'btn btn--ghost btn--xs', text: 'Table' });
  tableButton.type = 'button';
  tableButton.addEventListener('click', onToggleTable);
  tools.append(tableButton);
  figcaption.append(tools);

  return { figcaption, tableButton };
}

function buildTooltip() {
  const tip = el('div', { className: 'chart__tip' });
  tip.style.position = 'absolute';
  tip.style.display = 'none';
  tip.style.pointerEvents = 'none';
  return tip;
}

// Places an already-visible `tip` at (x, y) relative to `anchor` (the tip's
// `position: relative` ancestor), then clamps it against the viewport so it
// can never be cut off at a right or bottom edge — used by
// renderTimeSeries' crosshair tooltip. Must be called after
// `tip.style.display = 'block'` (and its content is in place) so
// `getBoundingClientRect()` measures its real, painted size.
function positionTip(tip, anchor, x, y) {
  tip.style.right = '';
  tip.style.bottom = '';
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;

  const tipRect = tip.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (tipRect.right > vw) {
    tip.style.left = '';
    tip.style.right = `${Math.max(0, anchorRect.width - x)}px`;
  }
  if (tipRect.bottom > vh) {
    tip.style.top = '';
    tip.style.bottom = `${Math.max(0, anchorRect.height - y)}px`;
  }
  if (tipRect.left < 0) {
    tip.style.right = '';
    tip.style.left = '0px';
  }
  if (tipRect.top < 0) {
    tip.style.bottom = '';
    tip.style.top = '0px';
  }
}

function tipRow(swatchColor, value, label) {
  const row = el('div', { className: 'chart__tip-row' });
  if (swatchColor) {
    const key = el('span', { className: 'chart__tip-key' });
    key.style.background = swatchColor;
    row.append(key);
  }
  row.append(
    el('span', { className: 'chart__tip-value', text: value }),
    el('span', { className: 'chart__tip-label', text: label }),
  );
  return row;
}

// ---------------------------------------------------------------------------
// renderTimeSeries — the main line/area chart, used for the combined
// overview and for each project's own daily series.
// ---------------------------------------------------------------------------

function buildTimeSeriesTable(days, series) {
  const table = el('table', { className: 'datatable' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { text: 'Date' }));
  for (const s of series) headRow.append(el('th', { text: s.label }));
  thead.append(headRow);

  const tbody = el('tbody');
  for (let i = days.length - 1; i >= 0; i--) {
    const tr = el('tr');
    tr.append(el('td', { text: formatDayLabel(days[i]) }));
    for (const s of series) {
      tr.append(el('td', { className: 'tabular-nums', text: formatFullCount(s.values[i] ?? 0) }));
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = el('div', { className: 'table-scroll' });
  scroll.append(table);
  return scroll;
}

function buildTimeSeriesSvg({ title, days, series, height, container, cleanupFns }) {
  const measured = container.clientWidth;
  const width = measured > 0 ? measured : 640;
  const padLeft = 48;
  const padRight = 16;
  const padTop = 8;
  const padBottom = 26;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const baselineY = height - padBottom;

  let yMax = 1;
  for (const s of series) for (const v of s.values) if (v > yMax) yMax = v;
  const ticks = niceTicks(0, yMax, 4, { integer: true });
  const y = linearScale([0, ticks.at(-1)], [baselineY, padTop]);
  const x = linearScale([0, Math.max(1, days.length - 1)], [padLeft, width - padRight]);

  const wrap = el('div', { className: 'chart__plot' });
  wrap.style.position = 'relative';

  const svg = svgEl('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0',
  });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = `${height}px`;

  const totals = series.map((s) => s.values.reduce((a, b) => a + b, 0));
  const ariaLabel = [
    title || 'Time series chart',
    days.length ? `${formatDayLong(days[0])} to ${formatDayLong(days.at(-1))}` : '',
    ...series.map((s, i) => `${s.label} total ${formatFullCount(totals[i])}`),
  ].filter(Boolean).join(', ');
  svg.setAttribute('aria-label', ariaLabel);

  // Gridlines (hairline, solid, never dashed) + y tick labels.
  for (const t of ticks) {
    const ty = y(t);
    svg.append(svgEl('line', {
      x1: padLeft, x2: width - padRight, y1: ty, y2: ty, stroke: 'var(--grid)', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: padLeft - 8, y: ty, class: 'chart__tick', 'text-anchor': 'end',
      'dominant-baseline': 'middle', fill: 'var(--text-muted)',
    });
    label.textContent = formatCount(t);
    svg.append(label);
  }

  // x baseline
  svg.append(svgEl('line', {
    x1: padLeft, x2: width - padRight, y1: baselineY, y2: baselineY, stroke: 'var(--axis)', 'stroke-width': 1,
  }));

  // x tick labels
  for (const i of pickDayTicks(days, 6)) {
    const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
    const label = svgEl('text', {
      x: x(i), y: height - 6, class: 'chart__tick', 'text-anchor': anchor, fill: 'var(--text-muted)',
    });
    label.textContent = formatDayLabel(days[i]);
    svg.append(label);
  }

  // One y-axis, up to two series: area fill first, then lines on top, so
  // series 2's line is never obscured by series 1's fill.
  const seriesPoints = series.map((s) => days.map((_, i) => ({ x: x(i), y: y(s.values[i] ?? 0) })));
  for (let si = 0; si < series.length; si++) {
    svg.append(svgEl('path', {
      d: buildAreaPath(seriesPoints[si], baselineY),
      fill: seriesColorVar(series[si].slot), 'fill-opacity': 0.1, stroke: 'none',
    }));
  }
  for (let si = 0; si < series.length; si++) {
    svg.append(svgEl('path', {
      d: buildLinePath(seriesPoints[si]), fill: 'none', stroke: seriesColorVar(series[si].slot),
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // End markers.
  const endPoints = seriesPoints.map((pts) => pts.at(-1));
  series.forEach((s, si) => {
    svg.append(svgEl('circle', {
      cx: endPoints[si].x, cy: endPoints[si].y, r: 4,
      fill: seriesColorVar(s.slot), stroke: 'var(--surface-1)', 'stroke-width': 2,
    }));
  });

  // Direct end labels — the endpoint only, and only when there is room.
  // Text is never coloured by series: the label sits beside a coloured mark.
  const endX = endPoints[0].x;
  const hasRoom = (width - padRight - endX) > 42;
  const separated = endPoints.length < 2 || Math.abs(endPoints[0].y - endPoints[1].y) >= 14;
  if (hasRoom && separated) {
    series.forEach((s, si) => {
      const label = svgEl('text', {
        x: endPoints[si].x + 8, y: endPoints[si].y, 'dominant-baseline': 'middle',
        class: 'chart__endlabel', fill: 'var(--text-secondary)',
      });
      label.textContent = formatCount(s.values.at(-1) ?? 0);
      svg.append(label);
    });
  }

  // Hover/keyboard crosshair layer — hidden until interaction.
  const hoverLine = svgEl('line', {
    x1: padLeft, x2: padLeft, y1: padTop, y2: baselineY, stroke: 'var(--axis)', 'stroke-width': 1,
  });
  hoverLine.style.visibility = 'hidden';
  svg.append(hoverLine);

  const focusDots = series.map((s) => {
    const dot = svgEl('circle', { r: 4, fill: seriesColorVar(s.slot), stroke: 'var(--surface-1)', 'stroke-width': 2 });
    dot.style.visibility = 'hidden';
    svg.append(dot);
    return dot;
  });

  const hoverRect = svgEl('rect', {
    x: padLeft, y: padTop, width: plotWidth, height: Math.max(1, baselineY - padTop),
    fill: 'transparent', 'pointer-events': 'all',
  });
  svg.append(hoverRect);

  const tip = buildTooltip();
  wrap.append(svg, tip);

  function moveCrosshair(i) {
    const px = x(i);
    hoverLine.setAttribute('x1', px);
    hoverLine.setAttribute('x2', px);
    hoverLine.style.visibility = 'visible';
    series.forEach((s, si) => {
      focusDots[si].setAttribute('cx', px);
      focusDots[si].setAttribute('cy', y(s.values[i] ?? 0));
      focusDots[si].style.visibility = 'visible';
    });
    return px;
  }

  function showTooltip(i) {
    const px = moveCrosshair(i);
    tip.replaceChildren();
    tip.append(el('div', { className: 'chart__tip-heading', text: formatDayLong(days[i]) }));
    series.forEach((s) => {
      tip.append(tipRow(seriesColorVar(s.slot), formatFullCount(s.values[i] ?? 0), s.label));
    });
    tip.style.display = 'block';
    // `px` is in the SVG's user-unit coordinate space (its viewBox), but
    // `wrap` — the tooltip's positioned ancestor — is sized in CSS pixels.
    // The svg is rendered at `width` user units stretched (or shrunk) to
    // fill its measured CSS width, so convert through that ratio.
    const r = svg.getBoundingClientRect();
    const scale = r.width > 0 ? r.width / width : 1;
    positionTip(tip, wrap, px * scale + 12, padTop);
  }

  function hideTooltip() {
    hoverLine.style.visibility = 'hidden';
    focusDots.forEach((d) => { d.style.visibility = 'hidden'; });
    tip.style.display = 'none';
  }

  function onPointerMove(evt) {
    // `evt.offsetX` is CSS pixels measured from whichever element the event
    // target is (not necessarily the svg root), while `padLeft`/`plotWidth`
    // are viewBox user units. Measure the svg's own box and convert through
    // it instead of trusting offsetX's scale or origin.
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return; // hidden/zero-size container: nothing to hit-test
    const userX = (evt.clientX - r.left) * (width / r.width);
    const ratio = (userX - padLeft) / plotWidth;
    showTooltip(nearestIndex(days.length, ratio));
  }
  hoverRect.addEventListener('pointermove', onPointerMove);
  hoverRect.addEventListener('pointerleave', hideTooltip);
  cleanupFns.push(() => {
    hoverRect.removeEventListener('pointermove', onPointerMove);
    hoverRect.removeEventListener('pointerleave', hideTooltip);
  });

  // Keyboard: the same tooltip, driven by ArrowLeft/ArrowRight (Shift = 7
  // days), Home/End, and Escape.
  let focusIndex = null;
  const lastIndex = days.length - 1;
  function onKeyDown(evt) {
    switch (evt.key) {
      case 'ArrowLeft':
        focusIndex = Math.max(0, (focusIndex ?? lastIndex) - (evt.shiftKey ? 7 : 1));
        break;
      case 'ArrowRight':
        focusIndex = Math.min(lastIndex, (focusIndex ?? -1) + (evt.shiftKey ? 7 : 1));
        break;
      case 'Home':
        focusIndex = 0;
        break;
      case 'End':
        focusIndex = lastIndex;
        break;
      case 'Escape':
        focusIndex = null;
        hideTooltip();
        return;
      default:
        return;
    }
    evt.preventDefault();
    showTooltip(focusIndex);
  }
  svg.addEventListener('keydown', onKeyDown);
  cleanupFns.push(() => svg.removeEventListener('keydown', onKeyDown));

  return wrap;
}

/**
 * spec = { title, subtitle, days: string[], series: [{ key, label, values, slot }],
 *          height = 260, emptyMessage }
 * 1 or 2 series only — a third slot is not supported by the colour system.
 */
export function renderTimeSeries(container, spec) {
  const {
    title, subtitle, days = [], series = [], height = 260,
    emptyMessage = 'No data for this period.',
  } = spec;
  if (series.length < 1 || series.length > 2) {
    throw new Error(`renderTimeSeries supports 1 or 2 series, got ${series.length}`);
  }

  let destroyed = false;
  let showingTable = false;
  let cleanupFns = [];
  let resizeObserver = null;
  let rafId = null;

  function runCleanup() {
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  }

  function toggleTable() {
    showingTable = !showingTable;
    draw();
  }

  function draw() {
    if (destroyed) return;
    runCleanup();
    container.replaceChildren();

    const figure = el('figure', { className: 'chart' });
    figure.style.position = 'relative';
    const { figcaption, tableButton } = buildChartHead({
      title, subtitle, seriesForLegend: series, onToggleTable: toggleTable,
    });
    figure.append(figcaption);

    if (days.length === 0) {
      figure.append(el('p', { className: 'chart__empty', text: emptyMessage }));
      container.append(figure);
      return;
    }

    if (showingTable) {
      tableButton.textContent = 'Chart';
      figure.append(buildTimeSeriesTable(days, series));
    } else {
      tableButton.textContent = 'Table';
      figure.append(buildTimeSeriesSvg({ title, days, series, height, container, cleanupFns }));
    }
    container.append(figure);
  }

  draw();

  if (typeof ResizeObserver !== 'undefined') {
    let lastWidth = container.clientWidth;
    resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (Math.abs(w - lastWidth) < 1) return;
      lastWidth = w;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        draw();
      });
    });
    resizeObserver.observe(container);
  }

  return {
    destroy() {
      destroyed = true;
      runCleanup();
      if (resizeObserver) resizeObserver.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}

// ---------------------------------------------------------------------------
// renderSparkline — a single-series stat-tile trend. No legend, no tooltip:
// the card's own title says what it is, and dataviz allows this one form to
// skip the hover layer. The viewBox is stretched to the container's width
// via preserveAspectRatio="none", so no resize handling is needed here.
// ---------------------------------------------------------------------------

const SPARK_VIEW_WIDTH = 100;

/** spec = { values: number[], days: string[], label, height = 34, slot = 1 } */
export function renderSparkline(container, spec) {
  const { values = [], days = [], label = '', height = 34, slot = 1 } = spec;
  container.replaceChildren();

  const svg = svgEl('svg', {
    viewBox: `0 0 ${SPARK_VIEW_WIDTH} ${height}`, preserveAspectRatio: 'none', role: 'img',
  });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = `${height}px`;

  if (values.length < 2) {
    const midY = height / 2;
    svg.append(svgEl('line', {
      x1: 0, x2: SPARK_VIEW_WIDTH, y1: midY, y2: midY, stroke: 'var(--grid)', 'stroke-width': 1,
    }));
    svg.setAttribute('aria-label', `${label}: no data`);
    container.append(svg);
    return { destroy() {} };
  }

  const peak = Math.max(1, ...values);
  const x = linearScale([0, values.length - 1], [0, SPARK_VIEW_WIDTH]);
  const y = linearScale([0, peak], [height - 1.5, 1.5]);
  const points = values.map((v, i) => ({ x: x(i), y: y(v) }));
  const color = seriesColorVar(slot);

  svg.append(svgEl('path', {
    d: buildAreaPath(points, height), fill: color, 'fill-opacity': 0.1, stroke: 'none',
  }));
  svg.append(svgEl('path', {
    d: buildLinePath(points), fill: 'none', stroke: color, 'stroke-width': 1.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  const last = points.at(-1);
  svg.append(svgEl('circle', {
    cx: last.x, cy: last.y, r: 3, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2,
  }));

  const range = days.length ? `${formatDayLabel(days[0])} to ${formatDayLabel(days.at(-1))}` : '';
  svg.setAttribute('aria-label', `${label}: ${range}, peak ${formatFullCount(peak)}`);

  container.append(svg);
  return { destroy() {} };
}
