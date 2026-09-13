// web/app.js
//
// Bootstraps the whole dashboard: the topbar (theme toggle), the range
// selector, the failures notice, and the three bands — overview, projects,
// dimensions. There is no router: this is a single page, not a set of
// drill-down views, so there is nothing here to hash-route between.

import {
  el, clear, relativeTime, describeFailures,
} from './ui.js';
import { getProjects, getOverview } from './api.js';
import { renderOverview } from './views/overview.js';
import { renderProjects } from './views/projects.js';
import { renderDimensions } from './views/dimensions.js';

// ---------------------------------------------------------------------
// Storage — wrapped because localStorage can throw (private browsing,
// disabled storage) and a preference read must never take the dashboard
// down.
// ---------------------------------------------------------------------

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Losing a preference is fine; crashing the app over it is not.
  }
}

// ---------------------------------------------------------------------
// DOM references from the shell in index.html
// ---------------------------------------------------------------------

const root = document.getElementById('app-root');
const noticesEl = document.getElementById('notices');
const themeBtn = document.getElementById('theme-btn');
const fetchedAtEl = document.getElementById('fetched-at');
const refreshBtn = document.getElementById('refresh-btn');

// ---------------------------------------------------------------------
// Theme toggle — auto -> light -> dark -> auto. The no-flash inline script
// in index.html already applied any stored explicit choice before first
// paint; this only keeps it in sync going forward.
// ---------------------------------------------------------------------

const THEME_ORDER = ['auto', 'light', 'dark'];

function getTheme() {
  const stored = safeGet(localStorage, 'va-theme');
  return THEME_ORDER.includes(stored) ? stored : 'auto';
}

function applyTheme(mode) {
  const html = document.documentElement;
  if (mode === 'auto') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', mode);
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  themeBtn.title = `Theme: ${label}`;
  themeBtn.setAttribute('aria-label', `Theme: ${label}. Activate to change.`);
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(getTheme()) + 1) % THEME_ORDER.length];
  safeSet(localStorage, 'va-theme', next);
  applyTheme(next);
}

themeBtn.addEventListener('click', cycleTheme);
applyTheme(getTheme());

// ---------------------------------------------------------------------
// Range selector
// ---------------------------------------------------------------------

const RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

const state = {
  range: RANGE_OPTIONS.some((o) => o.value === safeGet(localStorage, 'va-range'))
    ? safeGet(localStorage, 'va-range')
    : '30',
};

const segmented = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': 'Date range' } });
const segButtons = new Map();
for (const opt of RANGE_OPTIONS) {
  const btn = el('button', {
    type: 'button',
    text: opt.label,
    attrs: { 'aria-pressed': String(opt.value === state.range) },
    on: { click: () => selectRange(opt.value) },
  });
  segButtons.set(opt.value, btn);
  segmented.append(btn);
}

function setPressed(value) {
  for (const [v, btn] of segButtons) btn.setAttribute('aria-pressed', String(v === value));
}

document.getElementById('range-controls-row').append(segmented);

// Range buttons are never disabled — a Hobby project and a Pro project can
// appear on the same page with different reporting windows, so there is no
// single "this plan can't show that range" gate that would be correct for
// everyone on it. The reporting-window note (in overview.js) labels the gap
// instead.
function selectRange(value) {
  if (value === state.range) return;
  state.range = value;
  safeSet(localStorage, 'va-range', value);
  setPressed(value);
  load();
}

// ---------------------------------------------------------------------
// Failures notice — dismissible, never replaces the page.
// ---------------------------------------------------------------------

function renderFailuresNotice(failures) {
  clear(noticesEl);
  const text = describeFailures(failures);
  if (!text) return;

  // An authentication failure gets the louder treatment (`notice--error`,
  // the same class an outright load error would use) rather than the quiet
  // warning style — a wrong or expired VERCEL_TOKEN should be unmistakable,
  // not one dismissible line away from reading as an ordinary quiet week.
  const isAuth = failures.some((f) => f.type === 'auth');
  const notice = el('div', { className: `notice notice--${isAuth ? 'error' : 'warn'}` });
  const body = el('div', { className: 'notice__body' }, [text]);
  const close = el('button', {
    className: 'btn btn--icon notice__close',
    type: 'button',
    attrs: { 'aria-label': 'Dismiss' },
    on: { click: () => notice.remove() },
  }, ['×']);
  notice.append(body, close);
  noticesEl.append(notice);
}

// ---------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------

const overviewContainer = el('div');
const projectsContainer = el('div');
const dimensionsContainer = el('div');
root.append(overviewContainer, projectsContainer, dimensionsContainer);

let overviewView = null;
let projectsView = null;
let dimensionsView = null;
let abortController = null;

function destroyViews() {
  if (overviewView) overviewView.destroy();
  if (projectsView) projectsView.destroy();
  if (dimensionsView) dimensionsView.destroy();
  overviewView = null;
  projectsView = null;
  dimensionsView = null;
}

function renderLoadError(err) {
  clear(overviewContainer);
  clear(projectsContainer);
  clear(dimensionsContainer);
  const empty = el('div', { className: 'empty' });
  empty.append(el('p', { className: 'empty__title', text: "Couldn't load analytics" }));
  empty.append(el('p', { className: 'empty__body error-text', text: err.message || 'Unknown error' }));
  const btn = el('button', { className: 'btn', type: 'button', text: 'Try again' });
  btn.addEventListener('click', load);
  empty.append(btn);
  overviewContainer.append(empty);
}

function renderLoadingSkeleton() {
  clear(overviewContainer);
  const wrap = el('div', { className: 'chart' });
  wrap.append(el('div', { className: 'skeleton skeleton-line' }), el('div', { className: 'skeleton skeleton-block' }));
  overviewContainer.append(wrap);
}

async function load() {
  if (abortController) abortController.abort();
  const controller = new AbortController();
  abortController = controller;

  renderLoadingSkeleton();

  try {
    // Exactly the two calls the loading strategy allows on load. Everything
    // else (per-dimension breakdowns, per-project totals) fetches lazily,
    // the first time a reader opens that panel — see views/dimensions.js
    // and views/projects.js.
    const [projectsData, overviewData] = await Promise.all([
      getProjects({ signal: controller.signal }),
      getOverview(state.range, { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;

    destroyViews();
    renderFailuresNotice([...projectsData.failures, ...overviewData.failures]);

    overviewView = renderOverview(overviewContainer, { data: overviewData });
    projectsView = renderProjects(projectsContainer, {
      projects: projectsData.projects,
      range: state.range,
    });
    dimensionsView = renderDimensions(dimensionsContainer, { range: state.range });

    // fetchedAt is the OLDER of the two responses — the cache can serve
    // entries fetched at different moments, and the age shown should be the
    // worst case, not a flattering one.
    const oldest = [projectsData.fetchedAt, overviewData.fetchedAt].sort()[0];
    fetchedAtEl.textContent = `Data as of ${relativeTime(oldest)}`;
    fetchedAtEl.title = new Date(oldest).toISOString();
  } catch (err) {
    if (controller.signal.aborted) return;
    renderLoadError(err);
  }
}

refreshBtn.addEventListener('click', () => load());

load();
