// Fetch wrapper for the JSON API. Paths are relative to /api: api.get('/students', { campus: 'RU' }).
// Contract: SPEC.md section 7.1. No dependencies.

const BASE = '/api';
const ADMIN_HEADER = 'oss-admin';

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 when the request never reached the server)
   * @param {string} code   error.code from the API ('not_found', 'unauthorized', … or 'network' / 'bad_response')
   * @param {string} message human-readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const STATUS_CODES = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict',
  429: 'rate_limited', 503: 'unavailable',
};

/** Serialise params; null / undefined / '' are dropped, arrays repeat the key, booleans become 1 / 0. */
export function buildQuery(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === null || v === undefined || v === '') continue;
      sp.append(key, typeof v === 'boolean' ? (v ? '1' : '0') : v instanceof Date ? v.toISOString() : String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function url(path, params) {
  const p = String(path || '');
  return BASE + (p.startsWith('/') ? p : `/${p}`) + buildQuery(params);
}

async function request(method, path, { params, body, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal };
  if (method !== 'GET') {
    init.headers['X-Requested-With'] = ADMIN_HEADER;
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url(path, params), init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
  const text = res.status === 204 ? '' : await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = undefined; }
  }
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiError(
      res.status,
      (e && e.code) || STATUS_CODES[res.status] || (res.status >= 500 ? 'internal' : 'bad_request'),
      (e && e.message) || `Request failed (${res.status} ${res.statusText || ''})`.replace(' )', ')'),
    );
  }
  if (data === undefined) throw new ApiError(res.status, 'bad_response', 'The server sent a response that is not JSON.');
  return data;
}

export const api = {
  /** GET → parsed JSON. `opts.signal` aborts the request. */
  get: (path, params, opts) => request('GET', path, { params, ...opts }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, params, opts) => request('DELETE', path, { params, ...opts }),
  /** URL string for links and downloads: api.url('/export/prs.csv', filters). */
  url,
};

export default api;
