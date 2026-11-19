// Boots createApp() on a random port and wraps fetch with cookie + JSON handling.
import { createApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

export const TEST_PASSWORD = 'correct horse battery staple';

export function testConfig(overrides = {}) {
  return { ...loadConfig({ NODE_ENV: 'test', ADMIN_PASSWORD: TEST_PASSWORD, SESSION_SECRET: 'test-secret' }), ...overrides };
}

export async function startApp(db, overrides = {}, deps = {}) {
  const config = testConfig(overrides);
  const app = createApp({ db, config, ...deps });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  /** request('GET', '/api/x') or request('POST', '/api/x', body, {headers, raw}) -> { status, body, headers, text } */
  async function request(method, path, body, { headers = {}, csrf = true, raw = false } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (method !== 'GET' && csrf) h['x-requested-with'] = 'oss-admin';
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0];
    const text = await res.text();
    let parsed = null;
    if (!raw) { try { parsed = JSON.parse(text); } catch { /* not json */ } }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  return {
    base, config, request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body = {}, opts) => request('POST', path, body, opts),
    put: (path, body = {}, opts) => request('PUT', path, body, opts),
    patch: (path, body = {}, opts) => request('PATCH', path, body, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
    login: (password = TEST_PASSWORD) => request('POST', '/api/admin/login', { password }),
    clearCookie() { cookie = ''; },
    setCookie(v) { cookie = v; },
    getCookie: () => cookie,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
