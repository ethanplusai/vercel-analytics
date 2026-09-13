// A regression test for the exact trap the brief for this task called out:
// `renderTimeSeries` calls `container.replaceChildren()` on every redraw
// (including the Table toggle), so anything appended as a CHILD of the
// chart container is silently erased the first time someone toggles the
// table. `web/views/overview.js` appends the visitors-sum caveat as a
// SIBLING instead — this test proves that structurally, and proves it would
// actually catch the mistake if it ever came back.
//
// No DOM library is added for this (the project stays zero-dependency): a
// minimal fake `document` is built right here, covering exactly what
// `web/ui.js`'s `el()`/`clear()` and `web/charts.js`'s internal `el()`/
// `svgEl()`/`renderTimeSeries()` touch on a plain (non-empty-data,
// non-hover) render — createElement/createElementNS, append,
// replaceChildren, setAttribute, addEventListener (a no-op store; nothing
// here simulates pointer/keyboard events), textContent/className/style/
// hidden as plain settable properties, and a parentNode link so a note's
// position in the tree can be asserted directly. No getBoundingClientRect,
// ResizeObserver, or window is needed: those are only reached by
// renderTimeSeries' hover/resize paths, which a plain mount-and-toggle
// never exercises (ResizeObserver is simply absent from Node's global
// scope, so renderTimeSeries's own `typeof ResizeObserver !== 'undefined'`
// guard skips that setup entirely).

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatVisitorsSumNote } from '../web/ui.js';
import { renderOverview } from '../web/views/overview.js';

function makeFakeDocument() {
  function makeNode(tag) {
    const node = {
      tagName: tag,
      children: [],
      attributes: {},
      style: {},
      dataset: {},
      className: '',
      textContent: '',
      hidden: false,
      parentNode: null,
      listeners: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
      removeEventListener(type, handler) {
        const list = this.listeners[type];
        if (!list) return;
        const i = list.indexOf(handler);
        if (i !== -1) list.splice(i, 1);
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n === null || n === undefined) continue;
          const child = typeof n === 'string' ? makeTextNode(n) : n;
          child.parentNode = this;
          this.children.push(child);
        }
      },
      replaceChildren(...nodes) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        if (nodes.length) this.append(...nodes);
      },
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx !== -1) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      },
    };
    Object.defineProperty(node, 'childNodes', { get() { return node.children; } });
    return node;
  }

  function makeTextNode(text) {
    return { nodeType: 3, textContent: String(text), parentNode: null };
  }

  return {
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
    createTextNode: (text) => makeTextNode(text),
  };
}

const SAMPLE_DATA = {
  days: ['2026-09-01', '2026-09-02', '2026-09-03'],
  pageviews: [10, 12, 14],
  visitorsSum: [5, 6, 7],
  totals: { pageviews: 36, visitorsSum: 18, projects: 2 },
};

// Finds a node by exact textContent, anywhere in the mounted tree — not by
// position. A position-based lookup (e.g. "the third child of section")
// would itself break the moment the note moved into the chart container
// (the mistake this test exists to catch), masking the real failure behind
// an unrelated "wrong shape" error instead of the actual bug.
function findByText(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children ?? []) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
}

test('the visitors-sum note is a sibling of the chart container, and survives the chart container being cleared', () => {
  const previousDocument = globalThis.document;
  globalThis.document = makeFakeDocument();
  try {
    const root = document.createElement('div');
    renderOverview(root, { data: SAMPLE_DATA });

    const section = root.children[0];
    assert.ok(section, 'renderOverview must mount a section into the container');
    const chartContainer = section.children[0];

    const visitorsNote = findByText(section, formatVisitorsSumNote());
    assert.ok(visitorsNote, 'the visitors note must exist in the mounted tree');

    // 1 & 2: the note's parent is the section, never the chart container —
    // this is the actual mechanism that keeps it alive.
    assert.equal(visitorsNote.parentNode, section, 'the note must be a direct child of the section');
    assert.notEqual(visitorsNote.parentNode, chartContainer, 'the note must never be a child of the chart container');

    // 3: simulate a Table toggle exactly the way renderTimeSeries's own
    // draw() does at the top of every redraw — clear the chart container.
    chartContainer.replaceChildren();

    // 4: the note must still be present and unchanged afterwards.
    const stillThere = findByText(section, formatVisitorsSumNote());
    assert.ok(stillThere, 'the note must survive the chart container being cleared');
  } finally {
    globalThis.document = previousDocument;
  }
});
