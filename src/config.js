const DEFAULT_PORT = 4320;
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_CONCURRENCY = 5;

// The bind-interface knob (VA_HOST) counts as loopback only for these exact
// names, unset included — an empty/unset value falls back to 127.0.0.1
// below. Anything else, including 0.0.0.0 (all interfaces), means the
// server can be reached from somewhere other than this machine.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopbackHost(value) {
  if (!value) return true;
  return LOOPBACK_HOSTS.has(value.toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env) {
  const allowedHosts = (env.VA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = env.VA_HOST || '127.0.0.1';
  // Whether anything other than this machine can reach us. `VERCEL` names one
  // public shape; a non-empty host allowlist names another (self-hosted
  // behind a proxy); a non-loopback VA_HOST names a third — binding to
  // 0.0.0.0 or a LAN address hands out the port to anyone who can reach that
  // interface, proxy or not. All three feed this single value so the cookie
  // flags and the passphrase floor cannot drift apart from any of them.
  const exposedBeyondLoopback = Boolean(env.VERCEL) || allowedHosts.length > 0 || !isLoopbackHost(host);
  return {
    token: env.VERCEL_TOKEN || null,
    port: num(env.PORT || env.VA_PORT, DEFAULT_PORT),
    host,
    apiBaseUrl: env.VA_API_BASE_URL || 'https://api.vercel.com',
    password: env.VA_PASSWORD || null,
    allowPublic: bool(env.VA_ALLOW_PUBLIC, false),
    allowedHosts,
    exposedBeyondLoopback,
    secureCookies: bool(env.VA_SECURE_COOKIES, exposedBeyondLoopback),
    cacheTtlMs: num(env.VA_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    concurrency: num(env.VA_CONCURRENCY, DEFAULT_CONCURRENCY),
    teams: (env.VA_TEAMS || '').split(',').map((s) => s.trim()).filter(Boolean),
    serverless: Boolean(env.VERCEL),
  };
}
