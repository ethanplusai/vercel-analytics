// web/api.js
//
// Typed fetch wrappers around the same-origin JSON API documented in
// src/api.js. Every non-2xx response — and every network failure — comes out
// the other end as an `ApiError`, so callers never have to branch on
// `res.ok` themselves.

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the Vercel Analytics server.', { status: 0, code: 'offline' });
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(body?.error?.message || res.statusText, {
      status: res.status,
      code: body?.error?.code,
    });
  }

  return body;
}

export function getProjects({ signal } = {}) {
  return request('/api/projects', { signal });
}

export function getOverview(range, { signal } = {}) {
  const qs = range ? `?range=${encodeURIComponent(range)}` : '';
  return request(`/api/overview${qs}`, { signal });
}

export function getProject(id, { range, signal } = {}) {
  const qs = range ? `?range=${encodeURIComponent(range)}` : '';
  return request(`/api/projects/${encodeURIComponent(id)}${qs}`, { signal });
}

export function getDimension(name, { range, signal } = {}) {
  const qs = range ? `?range=${encodeURIComponent(range)}` : '';
  return request(`/api/dimension/${encodeURIComponent(name)}${qs}`, { signal });
}
