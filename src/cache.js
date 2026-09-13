/**
 * A tiny per-instance TTL cache.
 *
 * Deliberately not shared between instances: this project has no database, and
 * a cold serverless instance refetching is correct behaviour rather than a
 * cache miss worth engineering around.
 *
 * `storedAt` is returned alongside the value because the API reports the age of
 * the OLDEST contributing response, so callers need the fetch time, not the
 * read time.
 */
export function createCache({ ttlMs, now = () => Date.now() } = {}) {
  const entries = new Map();

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.storedAt >= ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit;
    },

    set(key, value) {
      const entry = { value, storedAt: now() };
      entries.set(key, entry);
      return entry;
    },

    // A rejected loader must not be cached — a transient 500 would otherwise
    // be served as the answer for the whole TTL.
    async wrap(key, load) {
      const hit = this.get(key);
      if (hit) return hit;
      return this.set(key, await load());
    },
  };
}
