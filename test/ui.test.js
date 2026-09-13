import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCount, formatVisitorsSumNote, reportingWindowNote, pluralise, relativeTime,
} from '../web/ui.js';

test('counts are grouped for readability', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(25333), '25,333');
});

test('the visitors note says plainly that people are counted more than once', () => {
  const note = formatVisitorsSumNote();
  assert.match(note, /counted (once )?(per|for each) site|twice/i);
  // It must never claim to be a unique or deduplicated figure.
  assert.doesNotMatch(note, /\bunique\b/i);
  assert.doesNotMatch(note, /deduplicat/i);
});

test('reportingWindowNote is null when the range has no leading zero gap', () => {
  assert.equal(reportingWindowNote(['2026-09-01', '2026-09-02'], [5, 6]), null);
  assert.equal(reportingWindowNote(['2026-09-01', '2026-09-02'], [0, 0]), null); // no data at all, not a gap
  assert.equal(reportingWindowNote([], []), null);
});

test('reportingWindowNote names the first non-zero day when leading days are all zero', () => {
  const note = reportingWindowNote(
    ['2026-08-01', '2026-08-02', '2026-08-03'],
    [0, 0, 4],
  );
  assert.match(note, /Aug 3, 2026/);
  assert.match(note, /Hobby keeps 1 month, Pro 12/);
});

test('pluralise picks the singular or plural word', () => {
  assert.equal(pluralise(1, 'project', 'projects'), '1 project');
  assert.equal(pluralise(2, 'project', 'projects'), '2 projects');
  assert.equal(pluralise(0, 'project', 'projects'), '0 projects');
});

test('relativeTime reports a short human string relative to a pinned now', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  assert.equal(relativeTime(null, now), 'never');
  assert.equal(relativeTime('2026-09-04T11:59:30.000Z', now), 'just now');
  assert.equal(relativeTime('2026-09-04T10:00:00.000Z', now), '2 hours ago');
});
