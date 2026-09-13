const DEFAULT_PORT = 4320;
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_CONCURRENCY = 5;

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
  // Whether anything other than this machine can reach us. `VERCEL` names one
  // public shape; a non-empty host allowlist names the other one this project
  // documents (self-hosted behind a proxy). Both the cookie flags and the
  // passphrase floor read this single value so they cannot drift apart.
  const exposedBeyondLoopback = Boolean(env.VERCEL) || allowedHosts.length > 0;
  return {
    token: env.VERCEL_TOKEN || null,
    port: num(env.PORT || env.VA_PORT, DEFAULT_PORT),
    host: env.VA_HOST || '127.0.0.1',
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
