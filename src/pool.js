/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Every outcome is captured rather than thrown: one project's analytics query
 * failing must never empty the whole dashboard, so callers get a per-item
 * verdict and decide what to surface.
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
