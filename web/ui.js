// web/ui.js
//
// Pure DOM/data helpers shared by app.js and the views. `el` and `clear` are
// the only exports that touch `document`; everything else is a pure function
// so it can run — and be unit-tested — under plain Node with no DOM at all.

/** `n` plus the singular or plural word, chosen by `n === 1`. */
export function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Grouped, locale-formatted count for display (`25333` -> `'25,333'`). */
export function formatCount(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/**
 * The one sentence that keeps the combined visitor figure honest. Vercel
 * deduplicates visitors only within a single project, so this total counts a
 * person once for each site they visited. Saying "unique" here would be
 * false, so it never appears — see test/ui.test.js.
 */
export function formatVisitorsSumNote() {
  return 'Summed across projects — someone who visits two of your sites is counted twice.';
}

/**
 * A short, human, UTC-based relative time string, used to show how stale
 * `fetchedAt` is so a cached number never reads as live. `now` defaults to
 * the current time but is always overridable so callers (and tests) can pin
 * it.
 */
export function relativeTime(iso, now = new Date()) {
  if (!iso) return 'never';

  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();

  if (diffMs < 60_000) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${pluralise(hours, 'hour', 'hours')} ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 30) return `${pluralise(days, 'day', 'days')} ago`;

  const sameYear = then.getUTCFullYear() === now.getUTCFullYear();
  return then.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * The reporting-window caveat: null unless the leading days of a range are
 * all zero, in which case it names the first day with any pageviews. Plans
 * differ in how far back Vercel reports (Hobby keeps 1 month, Pro 12), and
 * the API never announces which one a project is on — so this labels the
 * gap instead of guessing, and callers must never disable range buttons
 * because of it (a page can mix projects on different plans).
 */
export function reportingWindowNote(days, pageviews) {
  if (!days?.length || !pageviews?.length) return null;
  const firstNonZero = pageviews.findIndex((v) => v > 0);
  if (firstNonZero <= 0) return null; // no leading gap (or no data at all)
  const firstDay = new Date(`${days[firstNonZero]}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  return `Days before ${firstDay} are outside your plan's reporting window (Hobby keeps 1 month, Pro 12).`;
}

const DIRECT_PROPS = ['className', 'id', 'type', 'href', 'title', 'disabled', 'tabIndex', 'open', 'value'];

/**
 * A minimal `document.createElement` wrapper. This is one of only two
 * exports that touch the DOM, and it is deliberately narrow: no `innerHTML`
 * path exists here at all, so untrusted strings (project names, dimension
 * values) can only ever land via `textContent` (through `props.text` or a
 * plain-string child).
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const key of DIRECT_PROPS) {
    if (props[key] !== undefined) node[key] = props[key];
  }

  if (props.dataset) {
    for (const [k, v] of Object.entries(props.dataset)) {
      node.dataset[k] = v;
    }
  }

  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, v);
    }
  }

  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      node.addEventListener(type, handler);
    }
  }

  if (props.text !== undefined) {
    node.textContent = props.text;
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/** Removes every child of `node`. */
export function clear(node) {
  node.replaceChildren();
}
