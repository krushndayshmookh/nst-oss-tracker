// SPEC addendum I6, public frontend: the pages render real DOM nodes against a stubbed API shaped exactly like I5,
// without a browser. A small DOM (only what the page modules use) and a fetch stub are installed on globalThis before
// the modules load; Chart.js is a stub that records the chart configs. Covers: the Contributions page tabs and the
// endpoint and params of each kind, the issue and review tables, the new students columns and sorts, the profile tabs
// and state chips, the overview cards and chart series, the activity metric options, campus columns, project and
// organisation links, admin summaries, pages against an API without the addendum, and that API text stays text.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ───────────── a minimal DOM ───────────── */

let innerHtmlWrites = 0;

class Node {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.documentElement; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v !== null && v !== undefined) this.append(String(v)); }
  get parentElement() { return this.parentNode; }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof Node ? n : new Text(String(n));
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  after(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const list = nodes.map((n) => (n instanceof Node ? n : new Text(String(n))));
    for (const n of list) { n.remove(); n.parentNode = p; }
    p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...list);
  }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
}
class Text extends Node {
  constructor(t) { super(); this.data = t; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
const REFLECT = ['title', 'id', 'type', 'name', 'href', 'role'];
class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = new Map();
    this.listeners = {};
    this.dataset = {};
    const style = {};
    style.setProperty = (k, v) => { style[k] = v; };
    this.style = style;
    this.hidden = false;
    const el = this;
    this.classList = {
      add: (...c) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); el.className = [...s].join(' '); },
      remove: (...c) => { el.className = el.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      toggle: (c, force) => { const on = force ?? !el.classList.contains(c); if (on) el.classList.add(c); else el.classList.remove(c); return on; },
      contains: (c) => el.className.split(/\s+/).includes(c),
    };
  }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  get className() { return this.attrs.get('class') || ''; }
  set className(v) { this.attrs.set('class', String(v)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const f of this.listeners[type] || []) f(ev);
  }
  click() { this.dispatch('click'); }
  focus() {}
  getContext() { return {}; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get innerHTML() { throw new Error('innerHTML read'); }
  set innerHTML(v) { innerHtmlWrites++; throw new Error('innerHTML used'); }
  insertAdjacentHTML() { innerHtmlWrites++; throw new Error('insertAdjacentHTML used'); }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && matches(n, sel)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
for (const k of REFLECT) {
  Object.defineProperty(Element.prototype, k, {
    get() { return this.getAttribute(k) ?? ''; },
    set(v) { this.setAttribute(k, v); },
    configurable: true,
  });
}

function walk(node, fn) { for (const c of node.childNodes) { if (c instanceof Element) { fn(c); walk(c, fn); } } }

/** Compound selectors (tag, .class, #id, [attr], [attr=v], [attr^=v], [attr*=v]), descendant combinator, comma lists. */
function matchCompound(el, comp) {
  const m = /^([a-z0-9*]+)?(.*)$/i.exec(comp);
  if (m[1] && m[1] !== '*' && el.tagName !== m[1].toUpperCase()) return false;
  const re = /\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([\^*]?=)"?([^\]"]*)"?)?\]/g;
  let x;
  while ((x = re.exec(m[2]))) {
    if (x[1] && !el.classList.contains(x[1])) return false;
    if (x[2] && el.getAttribute('id') !== x[2]) return false;
    if (x[3]) {
      const v = x[3] === 'class' ? el.className : el.getAttribute(x[3]);
      if (v === null) return false;
      if (x[4] === '=' && v !== x[5]) return false;
      if (x[4] === '^=' && !v.startsWith(x[5])) return false;
      if (x[4] === '*=' && !v.includes(x[5])) return false;
    }
  }
  return true;
}
function matches(el, sel) {
  return sel.split(',').some((group) => {
    const parts = group.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    let n = el.parentNode;
    while (i >= 0 && n) { if (n instanceof Element && matchCompound(n, parts[i])) i--; n = n.parentNode; }
    return i < 0;
  });
}

const documentElement = new Element('html');
const body = new Element('body');
documentElement.append(body);
const document = {
  documentElement, body, title: 'NST Open Source', activeElement: null,
  createElement: (t) => new Element(t),
  createElementNS: (_ns, t) => new Element(t),
  createTextNode: (t) => new Text(String(t)),
  querySelectorAll: (s) => documentElement.querySelectorAll(s),
  querySelector: (s) => documentElement.querySelector(s),
  addEventListener() {},
};
const location = { hash: '' };
Object.assign(globalThis, {
  Node, Text, Element, document, location,
  window: globalThis,
  history: { replaceState(_s, _t, url) { location.hash = url; } },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (f) => setTimeout(f, 0),
  scrollTo() {},
  addEventListener() {},
  CSS: { escape: (s) => s },
});

/* ───────────── Chart.js + fetch stubs ───────────── */

const charts = [];
globalThis.Chart = class { constructor(canvas, config) { this.canvas = canvas; this.config = config; charts.push(config); } destroy() {} update() {} };

let calls = [];
let routes = {};
globalThis.fetch = async (url) => {
  const u = new URL(String(url), 'http://test');
  const path = u.pathname.replace(/^\/api/, '');
  const params = Object.fromEntries(u.searchParams);
  calls.push({ path, params });
  const handler = routes[path] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && path.startsWith(k.slice(0, -1)))?.[1];
  const result = typeof handler === 'function' ? handler(params, path) : handler;
  if (result === undefined) {
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => JSON.stringify({ error: { code: 'not_found', message: `no stub for ${path}` } }) };
  }
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(result) };
};

// common.js caches /api/meta for five minutes: each render moves the clock on so every test gets its own meta
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

/* ───────────── fixtures shaped like SPEC addendum I5 ───────────── */

const RANGE = { key: 'ay', label: 'AY 2026-27', from: '2026-07-01', to: '2027-06-30' };
const metaOld = {
  presets: [{ key: 'ay', label: 'AY 2026-27', from: '2026-07-01', to: '2027-06-30' }, { key: 'all', label: 'All time' }],
  campuses: ['ADYPU', 'RU'], years: ['1st year', '2nd year'], batches: [2025, 2026],
  counts: { students: 10, prs: 20 }, categories: ['open_source'], tiers: ['major'],
  academicYear: { current: { start: '2026-07-01', end: '2027-06-30', label: '2026-27' } },
  rulesSummary: { tiers: { major: 1000, established: 200 } }, tz: 'Asia/Kolkata',
};
const metaNew = { ...metaOld, counts: { ...metaOld.counts, issues: 7, reviews: 5 }, kinds: ['pr', 'issue', 'review'], features: { contributions: true } };

const XSS = '<img src=x onerror=alert(1)>';
const issue = (over = {}) => ({
  kind: 'issue', url: 'https://github.com/apache/airflow/issues/77', number: 77, title: 'Scheduler crashes on empty DAG',
  author: 'AarushKarva', authorName: 'Aarush Anand Karva', repo: 'apache/airflow', owner: 'apache', ownerType: 'Organization',
  stars: 38000, state: 'closed', stateReason: 'not_planned', createdAt: '2026-10-02T10:00:00.000Z', closedAt: '2026-10-09T10:00:00.000Z', comments: 4,
  prUrl: null, prAuthor: null, prState: null, reviewCount: null, lastReviewedAt: null,
  campus: 'ADYPU', batch: 2026, year: '1st year', category: 'open_source', tier: 'major', reason: 'major', ...over,
});
const review = (over = {}) => ({
  kind: 'review', url: 'https://github.com/apache/airflow/pull/123#pullrequestreview-1', number: 123, title: 'Fix scheduler race',
  author: 'AarushKarva', authorName: 'Aarush Anand Karva', repo: 'apache/airflow', owner: 'apache', ownerType: 'Organization',
  stars: 38000, state: 'changes_requested', stateReason: null, createdAt: '2026-11-01T10:00:00.000Z', closedAt: null, comments: null,
  prUrl: 'https://github.com/apache/airflow/pull/123', prAuthor: 'someone', prState: 'merged', reviewCount: 2, lastReviewedAt: '2026-11-03T10:00:00.000Z',
  campus: 'ADYPU', batch: 2026, year: '1st year', category: 'open_source', tier: 'major', reason: 'major', ...over,
});
const pr = (over = {}) => ({
  url: 'https://github.com/apache/airflow/pull/9', number: 9, title: 'Add docs', author: 'AarushKarva', authorName: 'Aarush Anand Karva',
  repo: 'apache/airflow', stars: 38000, state: 'merged', isDraft: false, category: 'open_source', tier: 'major',
  createdAt: '2026-09-01T10:00:00.000Z', mergedAt: '2026-09-03T10:00:00.000Z', additions: 10, deletions: 2, ...over,
});
const page = (items) => ({ items, total: items.length, page: 1, limit: 25 });
const oldStats = {
  osMerged: 3, osPrs: 6, osOpen: 2, osMajorMerged: 1, osRepos: 2, osOrgs: 1, totalPrs: 9, mergedPrs: 4,
  byCategory: { open_source: 6, own_repo: 3 }, lastPrAt: '2026-10-01T10:00:00.000Z', firstPrAt: '2026-01-01T10:00:00.000Z', lastOsMergedAt: '2026-09-03T10:00:00.000Z',
};
const newStats = { ...oldStats, osClosed: 1, totalIssues: 7, osIssues: 3, totalReviews: 5, osReviews: 2, osContributions: 11, lastActivityAt: '2026-11-20T10:00:00.000Z' };
const student = (stats, over = {}) => ({ username: 'AarushKarva', name: 'Aarush Anand Karva', campus: 'ADYPU', year: '1st year', batch: 2026, stats, ...over });

/* ───────────── helpers ───────────── */

let ui;
beforeEach(() => { calls = []; charts.length = 0; routes = {}; });

async function render(mod, { params = {}, query = {}, path = '/', meta = metaNew } = {}) {
  skew += 3600 * 1000;
  routes['/meta'] = meta;
  calls = [];
  const { href } = await import('../public/js/lib/router.js');
  location.hash = href(path, query);
  const page = await import(`../public/js/pages/${mod}.js`);
  const el = document.createElement('div');
  body.replaceChildren(el);
  await page.default(el, { params, query, path });
  return el;
}
const text = (el) => el.textContent.replace(/\s+/g, ' ');
const headers = (el) => el.querySelectorAll('th').map((th) => th.textContent);
const apiCalls = (path) => calls.filter((c) => c.path === path);

/* ───────────── tests ───────────── */

test('helpers: hasContributions, labels and the review / issue badges', async () => {
  const common = await import('../public/js/pages/common.js');
  ui = await import('../public/js/lib/ui.js');
  assert.equal(common.hasContributions(metaNew), true);
  assert.equal(common.hasContributions(metaOld), false);
  assert.equal(common.hasContributions(null), false);
  assert.deepEqual(ui.KIND_LABELS, { pr: 'Pull requests', issue: 'Issues', review: 'Reviews' });
  assert.deepEqual(Object.keys(ui.REVIEW_STATE_LABELS), ['approved', 'changes_requested', 'commented', 'dismissed']);
  assert.equal(common.REVIEW_STATE_LABELS, ui.REVIEW_STATE_LABELS);
  const b = ui.reviewStateBadge('changes_requested');
  assert.match(b.className, /badge-state state-changes_requested/);
  assert.equal(b.textContent, 'Changes requested');
  assert.ok(b.querySelector('svg'), 'every verdict has a glyph');
  assert.equal(ui.issueStateBadge('open').textContent, 'Open');
  assert.equal(ui.issueStateBadge('closed', 'not_planned').textContent, 'Not planned');
  assert.equal(ui.issueStateBadge('closed', 'completed').title, 'Closed as completed');
  assert.deepEqual([ui.issueStateBadge('closed', 'duplicate').textContent, ui.issueStateBadge('closed', 'duplicate').title], ['Duplicate', 'Closed as a duplicate']);
  assert.equal(common.contribHref('issue', { repo: 'a/b' }), '#/prs?kind=issue&repo=a%2Fb');
  assert.equal(common.contribHref('pr', { state: 'open' }), '#/prs?state=open');
});

test('contribution table: issue and review rows render every field; API text stays text', async () => {
  const { contributionTable } = await import('../public/js/pages/common.js');
  const ctx = { query: {}, params: {}, path: '/prs' };
  const it = contributionTable([issue({ title: XSS })], ctx, { kind: 'issue' });
  assert.deepEqual(headers(it), ['Issue', 'Student', 'Project', 'State', 'Category', 'Opened', 'Comments']);
  const row = text(it.querySelector('tbody'));
  for (const s of [XSS, 'apache/airflow#77', 'Aarush Anand Karva', '38K stars', 'Not planned', 'Open source', '2 Oct 2026', '4']) assert.ok(row.includes(s), s);
  assert.equal(it.querySelectorAll('img').length, 0, 'a title with markup is never parsed');
  assert.equal(it.querySelector('a.ext').getAttribute('href'), 'https://github.com/apache/airflow/issues/77');
  assert.equal(it.querySelector('caption').textContent, 'Issues raised');

  const rt = contributionTable([review()], ctx, { sort: 'createdAt', onSort: () => {} });
  assert.deepEqual(headers(rt), ['Pull request reviewed', 'Student', 'Project', 'Verdict', 'PR state', 'Category', 'Reviews', 'First reviewed']);
  const rrow = text(rt.querySelector('tbody'));
  for (const s of ['Fix scheduler race', 'apache/airflow#123 by someone', 'Changes requested', 'Merged', '2', '1 Nov 2026']) assert.ok(rrow.includes(s), s);
  assert.equal(rt.querySelector('a.ext').getAttribute('href'), 'https://github.com/apache/airflow/pull/123#pullrequestreview-1', 'links to the review');
  assert.ok(rt.querySelector('button[name=sort-createdAt]'), 'first reviewed is sortable');
  assert.equal(rt.querySelector('caption').textContent, 'Reviews given');
  assert.match(text(contributionTable([], ctx, { kind: 'review' })), /No reviews match these filters/);
  const unsafe = contributionTable([issue({ url: 'javascript:alert(1)' })], ctx);
  assert.equal(unsafe.querySelectorAll('a.ext').length, 0, 'a non-https url is not a link');
});

test('Contributions page: tabs, and each kind calls its endpoint with the right params', async () => {
  routes['/prs'] = { range: RANGE, ...page([pr()]) };
  routes['/contributions'] = (p) => ({ range: RANGE, kind: p.kind, ...page(p.kind === 'review' ? [review()] : [issue()]) });

  let el = await render('prs', { path: '/prs', query: { repo: 'apache/airflow', state: 'merged' } });
  assert.equal(el.querySelector('h1').textContent, 'Contributions');
  const tabLinks = el.querySelectorAll('.tabs a.tab');
  assert.deepEqual(tabLinks.map((a) => a.textContent.replace(/\d+$/, '')), ['Pull requests', 'Issues', 'Reviews']);
  assert.equal(tabLinks[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabLinks[1].getAttribute('href'), '#/prs?repo=apache%2Fairflow&kind=issue', 'tabs keep shared filters, drop the state');
  assert.deepEqual(apiCalls('/prs').map((c) => c.params), [{ repo: 'apache/airflow', state: 'merged' }]);
  assert.equal(apiCalls('/contributions').length, 0);
  assert.deepEqual(el.querySelectorAll('select[name=state] option').map((o) => o.value), ['', 'open', 'merged', 'closed']);
  assert.match(el.querySelector('a.btn[download]').getAttribute('href'), /^\/api\/export\/prs\.csv\?/);

  el = await render('prs', { path: '/prs', query: { kind: 'issue', state: 'closed', category: 'all', author: 'AarushKarva', sort: 'stars' } });
  assert.deepEqual(apiCalls('/contributions').at(-1).params, { kind: 'issue', state: 'closed', category: 'all', author: 'AarushKarva', sort: 'stars' });
  assert.deepEqual(el.querySelectorAll('select[name=state] option').map((o) => o.value), ['', 'open', 'closed']);
  assert.ok(el.querySelector('select[name=tier]'), 'tier filters issues by the tier of their project');
  assert.equal(el.querySelectorAll('.tabs a.tab')[1].getAttribute('aria-selected'), 'true');
  assert.match(text(el), /Showing issues by AarushKarva/);
  assert.deepEqual(headers(el).slice(0, 3), ['Issue', 'Project', 'State'], 'the Student column is dropped when scoped to a student');
  const csv = el.querySelector('a.btn[download]').getAttribute('href');
  assert.match(csv, /^\/api\/export\/contributions\.csv\?kind=issue&/);
  assert.match(csv, /state=closed/);

  // a PR state on the Reviews tab is never sent (the API would answer 400)
  el = await render('prs', { path: '/prs', query: { kind: 'review', state: 'merged', sort: 'mergedAt' } });
  assert.deepEqual(apiCalls('/contributions').at(-1).params, { kind: 'review', sort: 'createdAt' });
  assert.deepEqual(el.querySelectorAll('select[name=state] option').map((o) => o.value), ['', 'approved', 'changes_requested', 'commented', 'dismissed']);
  assert.equal(el.querySelector('label[for]') && el.querySelectorAll('label').some((l) => l.textContent === 'Verdict'), true);
  assert.ok(text(el).includes('Changes requested'));
  assert.equal(innerHtmlWrites, 0);
});

test('Contributions page against an API without the addendum: plain Pull requests page, no tabs, kind ignored', async () => {
  routes['/meta'] = metaOld;
  routes['/prs'] = { range: RANGE, ...page([pr()]) };
  const el = await render('prs', { path: '/prs', query: { kind: 'issue' }, meta: metaOld });
  assert.equal(el.querySelector('h1').textContent, 'Pull requests');
  assert.equal(el.querySelectorAll('.tabs').length, 0);
  assert.equal(apiCalls('/contributions').length, 0);
  assert.equal(apiCalls('/prs').length, 1);
});

test('students list: Open PRs, Issues, Reviews columns sort on the API keys; Last activity with fallback', async () => {
  routes['/students'] = { range: RANGE, ...page([student(newStats), student({ ...oldStats }, { username: 'old', name: 'Old Keys' })]) };
  const el = await render('students', { path: '/students', query: { sort: 'osIssues', hasContribution: '1' } });
  const h = headers(el);
  for (const col of ['Open PRs', 'Issues', 'Reviews', 'Last activity']) assert.ok(h.includes(col), col);
  assert.ok(!h.includes('Last PR'));
  for (const key of ['osOpen', 'osIssues', 'osReviews', 'osMerged', 'lastActivityAt']) assert.ok(el.querySelector(`button[name=sort-${key}]`), key);
  assert.equal(el.querySelector('th[aria-sort=descending]').textContent, 'Issues');
  assert.deepEqual(apiCalls('/students')[0].params, { hasContribution: '1', sort: 'osIssues' });
  assert.ok(el.querySelector('input[name=hasContribution]').checked);
  const rows = el.querySelectorAll('tbody tr');
  const cells = (r) => r.querySelectorAll('td').map((td) => td.textContent);
  const ci = (name) => h.indexOf(name);
  assert.equal(cells(rows[0])[ci('Issues')], '3');
  assert.equal(cells(rows[0])[ci('Reviews')], '2');
  assert.equal(cells(rows[1])[ci('Issues')], '0', 'a missing key shows 0');
  assert.equal(rows[0].querySelectorAll('td')[ci('Last activity')].querySelector('span').title, '20 Nov 2026');
  assert.equal(rows[1].querySelectorAll('td')[ci('Last activity')].querySelector('span').title, '1 Oct 2026', 'falls back to lastPrAt');

  const plain = await render('students', { path: '/students', meta: metaOld, query: {} });
  assert.ok(!headers(plain).includes('Issues'));
  assert.ok(headers(plain).includes('Last PR') && plain.querySelector('button[name=sort-lastPrAt]'), 'old API: Last PR sorted by lastPrAt');
  assert.equal(plain.querySelectorAll('input[name=hasContribution]').length, 0);
});

test('student profile: stat cards, tabs (?tab), state chips (?state) sent to /prs, chart series', async () => {
  const detail = (stats) => ({
    range: RANGE, student: student(stats), repos: [], tech: null, prs: page([pr()]),
    monthly: [{ month: '2026-10', osOpened: 2, osMerged: 1, osIssues: 3, osReviews: 1 }, { month: '2026-11', osOpened: 0, osMerged: 0, osIssues: 0, osReviews: 1 }],
    issues: page([issue()]), reviews: page([review()]),
  });
  routes['/students/AarushKarva'] = detail(newStats);
  routes['/prs'] = (p) => ({ range: RANGE, ...page([pr({ state: p.state || 'merged' })]) });
  routes['/contributions'] = (p) => ({ range: RANGE, kind: p.kind, ...page([issue({ title: 'Page two issue' })]), page: 2, total: 30 });
  routes['/activity'] = {};
  const at = { path: '/students/AarushKarva', params: { username: 'AarushKarva' } };

  let el = await render('student', { ...at, query: { state: 'open' } });
  const cardText = text(el.querySelector('.cards'));
  assert.match(cardText, /Open-source PRs6\s?2 open, 1 closed without merge/);
  assert.match(cardText, /Issues raised3in open source, 7 in all/);
  assert.match(cardText, /Reviews given2in open source, 5 in all/);
  assert.equal(el.querySelectorAll('.cards a.stat')[0].getAttribute('href'), '#/students/AarushKarva?tab=issues');
  assert.deepEqual(apiCalls('/prs').at(-1).params, { author: 'AarushKarva', category: 'open_source', state: 'open', page: '1' });
  const kindTabs = el.querySelector('[aria-label="Contribution type"]');
  assert.deepEqual(kindTabs.querySelectorAll('button').map((b) => b.textContent), ['Pull requests9', 'Issues1', 'Reviews1']);
  const chips = el.querySelector('[aria-label="Pull request state"]');
  assert.deepEqual(chips.querySelectorAll('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    [['All', 'false'], ['Open', 'true'], ['Merged', 'false'], ['Closed', 'false']]);
  chips.querySelectorAll('button')[3].click();
  assert.equal(location.hash, '#/students/AarushKarva?state=closed');
  const series = charts[0].data.datasets.map((d) => d.label);
  assert.deepEqual(series, ['Opened', 'Merged', 'Issues raised', 'Reviews given']);
  assert.deepEqual(charts[0].data.datasets[2].data, [3, 0]);

  el = await render('student', { ...at, query: { tab: 'reviews' } });
  assert.equal(apiCalls('/prs').length, 0, 'the reviews tab needs no PR page');
  assert.equal(apiCalls('/contributions').length, 0, 'page 1 comes with the profile');
  assert.ok(text(el).includes('Fix scheduler race'));
  assert.ok(el.querySelector('a[href="#/prs?kind=review&author=AarushKarva&category=all"]'), 'link to the Contributions page');

  el = await render('student', { ...at, query: { tab: 'issues', page: '2' } });
  assert.deepEqual(apiCalls('/contributions').at(-1).params, { kind: 'issue', author: 'AarushKarva', category: 'all', page: '2' });
  assert.ok(text(el).includes('Page two issue'));
});

test('student profile against an API without the addendum: old cards, one PR list, no tabs for kinds', async () => {
  routes['/students/AarushKarva'] = { range: RANGE, student: student(oldStats), repos: [], prs: page([pr()]), monthly: [{ month: '2026-10', osOpened: 2, osMerged: 1 }] };
  routes['/prs'] = { range: RANGE, ...page([pr()]) };
  routes['/activity'] = {};
  const el = await render('student', { path: '/students/AarushKarva', params: { username: 'AarushKarva' }, query: { tab: 'issues', state: 'open' }, meta: metaOld });
  assert.ok(!text(el.querySelector('.cards')).includes('Issues raised'));
  assert.equal(el.querySelectorAll('[aria-label="Contribution type"]').length, 0);
  assert.equal(el.querySelectorAll('[aria-label="Pull request state"]').length, 0);
  assert.equal(apiCalls('/prs').at(-1).params.state, undefined, 'no state is sent to an old API');
  assert.deepEqual(charts[0].data.datasets.map((d) => d.label), ['Opened', 'Merged']);
});

const overviewBody = (extra) => ({
  range: RANGE,
  students: { tracked: 100, withAnyPr: 40, withOsPr: 20, withOsMerged: 10, withMajorMerged: 2, ...extra.students },
  prs: { osMerged: 30, osPrs: 50, osOpen: 12, osMergedByTier: { major: 5, established: 10, emerging: 15 }, byCategory: { open_source: 50, own_repo: 50 }, total: 100 },
  monthly: [{ month: '2026-10', osOpened: 10, osMerged: 5, allOpened: 30, ...extra.month }],
  topRepos: [], topOrgs: [], topStudents: [],
  ...extra.top,
});

test('overview: the contributions section, its links, and two more monthly series', async () => {
  routes['/overview'] = overviewBody({
    students: { withOsIssue: 6, withOsReview: 4, withOsContribution: 25 },
    month: { osIssues: 4, osReviews: 2 },
    top: { contributions: { osPrsOpen: 12, osPrsMerged: 30, osPrsClosed: 8, osIssues: 9, osIssuesOpen: 5, osIssuesClosed: 4, osReviews: 7, osApprovals: 3, osChangesRequested: 2, totalIssues: 20, totalReviews: 11 } },
  });
  routes['/campuses'] = { rows: [], totals: [], total: null, campuses: [] };
  routes['/activity'] = {};
  const el = await render('overview', { path: '/', query: { campus: 'RU' } });
  const head = el.querySelectorAll('.section-head h2').map((x) => x.textContent);
  assert.ok(head.includes('Open-source contributions'));
  const band = el.querySelectorAll('.cards')[1];
  const stats = band.querySelectorAll('.stat').map((s) => [s.querySelector('.stat-label').textContent, s.querySelector('.stat-value').textContent, s.getAttribute('href')]);
  assert.deepEqual(stats, [
    ['Merged PRs', '30', '#/prs?campus=RU&state=merged'],
    ['Open PRs', '12', '#/prs?campus=RU&state=open'],
    ['Closed without merge', '8', '#/prs?campus=RU&state=closed'],
    ['Issues raised', '9', '#/prs?kind=issue&campus=RU'],
    ['Reviews given', '7', '#/prs?kind=review&campus=RU'],
    ['Students with any contribution', '25', '#/students?campus=RU&hasContribution=1'],
  ]);
  assert.match(text(band), /3 approvals, 2 with changes requested/);
  const trend = charts.find((c) => c.type === 'line');
  assert.deepEqual(trend.data.datasets.map((d) => [d.label, d.data]), [['Opened', [10]], ['Merged', [5]], ['Issues raised', [4]], ['Reviews given', [2]]]);
});

test('overview against an API without the addendum: no new section, two series, no errors', async () => {
  routes['/overview'] = overviewBody({});
  routes['/campuses'] = { rows: [], totals: [], total: null, campuses: [] };
  routes['/activity'] = {};
  const el = await render('overview', { path: '/', meta: metaOld });
  assert.ok(!el.querySelectorAll('.section-head h2').some((x) => x.textContent === 'Open-source contributions'));
  assert.deepEqual(charts.find((c) => c.type === 'line').data.datasets.map((d) => d.label), ['Opened', 'Merged']);
  // the feature flag on, but the overview still without the new keys: the section shows zeros, never NaN
  routes['/meta'] = metaNew;
  const el2 = await render('overview', { path: '/' });
  const values = el2.querySelectorAll('.cards')[1].querySelectorAll('.stat-value').map((v) => v.textContent);
  assert.deepEqual(values, ['30', '12', '8', '0', '0', '0']);
  assert.ok(!text(el2).includes('NaN'));
});

const activityBody = (key) => ({
  range: RANGE, tz: 'Asia/Kolkata', metric: key,
  totals: { opened: 6, merged: 0, activeStudents: 3, ...(key ? { [key]: 6 } : {}) },
  busiest: { day: { date: '2026-11-02', count: 4 } },
  byMonth: [{ month: '2026-11', opened: 6, merged: 0, ...(key ? { [key]: 6 } : {}) }],
  byWeek: [{ weekStart: '2026-11-02', opened: 6, merged: 0 }],
  byDate: [{ date: '2026-11-02', opened: 4, merged: 0 }, { date: '2026-11-03', opened: 2, merged: 0 }],
  byWeekday: [{ dow: 1, opened: 4, merged: 0 }, { dow: 2, opened: 2, merged: 0 }],
  byHour: [{ hour: 10, opened: 6, merged: 0 }], heatmap: [], byCampusMonth: [], cohorts: [],
});

test('activity: metric choices add issues and reviews; their counts and words follow the metric', async () => {
  routes['/activity'] = (p) => activityBody(p.metric === 'issues' || p.metric === 'reviews' ? p.metric : null);
  let el = await render('activity', { path: '/activity', query: { metric: 'reviews' } });
  assert.deepEqual(el.querySelectorAll('select[name=metric] option').map((o) => [o.value, o.textContent]),
    [['', 'Pull requests opened'], ['merged', 'Pull requests merged'], ['issues', 'Issues raised'], ['reviews', 'Reviews given']]);
  assert.equal(apiCalls('/activity').at(-1).params.metric, 'reviews');
  assert.equal(el.querySelector('.stat-key .stat-label').textContent, 'Reviews given');
  assert.equal(el.querySelector('.stat-key .stat-value').textContent, '6');
  assert.match(text(el), /When open-source reviews by tracked students are given/);
  assert.deepEqual(charts[0].data.datasets.map((d) => [d.label, d.data]), [['Given', [6]]]);
  assert.match(charts[1].data.datasets[0].label, /Given/);

  el = await render('activity', { path: '/activity', query: { metric: 'issues' } });
  assert.equal(el.querySelector('.stat-key .stat-label').textContent, 'Issues raised');

  el = await render('activity', { path: '/activity', query: { metric: 'issues' }, meta: (routes['/meta'] = metaOld) });
  assert.equal(apiCalls('/activity').at(-1).params.metric, 'opened', 'an old API is never asked for issues');
  assert.deepEqual(el.querySelectorAll('select[name=metric] option').map((o) => o.value), ['', 'merged']);
  assert.equal(el.querySelector('.stat-key .stat-label').textContent, 'Pull requests opened');
});

test('project and organisation pages: issue and review counts link to the Contributions page', async () => {
  routes['/repos/apache/airflow'] = {
    range: RANGE, students: [], prs: page([]),
    repo: { name: 'apache/airflow', owner: 'apache', category: 'open_source', tier: 'major', stars: 38000, stats: { merged: 3, prs: 5, students: 2, campuses: ['RU'], open: 1, closed: 1, firstPrAt: null, lastPrAt: null, issues: 4, reviews: 2 } },
  };
  routes['/activity'] = {};
  let el = await render('repo', { path: '/projects/apache/airflow', params: { owner: 'apache', name: 'airflow' } });
  const stat = (label) => el.querySelectorAll('.stat').find((s) => s.querySelector('.stat-label').textContent === label);
  assert.equal(stat('Issues raised').querySelector('.stat-value').textContent, '4');
  assert.equal(stat('Issues raised').getAttribute('href'), '#/prs?kind=issue&repo=apache%2Fairflow&category=all');
  assert.equal(stat('Reviews given').getAttribute('href'), '#/prs?kind=review&repo=apache%2Fairflow&category=all');

  routes['/orgs/apache'] = {
    range: RANGE, repos: [], students: [],
    org: { login: 'apache', type: 'Organization', stats: { osMerged: 3, osPrs: 5, students: 2, repos: 1, maxStars: 38000, prs: 5, merged: 3, byCategory: { open_source: 5 }, issues: 9, reviews: 3, osIssues: 8, osReviews: 3 } },
  };
  el = await render('org', { path: '/orgs/apache', params: { login: 'apache' } });
  assert.equal(stat('Issues raised').querySelector('.stat-value').textContent, '9');
  assert.match(stat('Issues raised').textContent, /8 in open source/);
  assert.equal(stat('Reviews given').getAttribute('href'), '#/prs?kind=review&owner=apache&category=all');

  // without the addendum: no such cards
  routes['/meta'] = metaOld;
  el = await render('org', { path: '/orgs/apache', params: { login: 'apache' }, meta: metaOld });
  assert.equal(stat('Issues raised'), undefined);
});

test('campus x year table: Open PRs, Issues, Reviews columns as counts, sortable, 0 for missing keys', async () => {
  const { campusYearTable, groupedRows } = await import('../public/js/pages/campus-common.js');
  const row = (campus, year, extra) => ({ campus, year, students: 10, withOsMerged: 1, withOsMergedPct: 10, osMergedPer100: 10, ...extra });
  const data = {
    rows: [row('RU', '1st year', { osOpen: 2, osIssues: 5, osReviews: 1 }), row('ADYPU', '1st year', {})],
    totals: [row('RU', 'All', { osOpen: 2, osIssues: 5, osReviews: 1 }), row('ADYPU', 'All', { osIssues: 9 })],
    total: row('All', 'All', { osOpen: 2, osIssues: 14, osReviews: 1 }),
  };
  const ctx = { query: {}, params: {}, path: '/campuses' };
  const t = campusYearTable(data, { ctx, contrib: true, rateMode: true, onSort: () => {} });
  const h = headers(t);
  for (const col of ['Open PRs', 'Issues', 'Reviews']) assert.ok(h.includes(col), col);
  assert.ok(t.querySelector('button[name=sort-osIssues]'));
  const adypu = t.querySelectorAll('tbody tr').find((r) => r.textContent.startsWith('ADYPU1st'));
  assert.equal(adypu.querySelectorAll('td')[h.indexOf('Reviews')].textContent, '0');
  assert.deepEqual(groupedRows(data, { sort: 'osIssues' }).filter((r) => r._kind === 'subtotal').map((r) => r.campus), ['ADYPU', 'RU']);
  assert.ok(!headers(campusYearTable(data, { ctx })).includes('Issues'), 'off unless asked for');
});

test('about page: the paragraph on what is counted, only with the addendum', async () => {
  routes['/overview'] = overviewBody({});
  let el = await render('about', { path: '/about' });
  assert.match(text(el), /pull requests in every state.*issues raised.*reviews given.*Comments, discussions and commits pushed directly are not counted/);
  const para = el.querySelectorAll('p').find((p) => p.textContent.startsWith('Beside the headline'));
  assert.ok(para && !para.textContent.includes('\u2014'), 'no em dashes in the new copy');
  routes['/meta'] = metaOld;
  el = await render('about', { path: '/about', meta: metaOld });
  assert.match(text(el), /Only pull requests are counted/);
});

test('admin run summaries: issue and review numbers only when present', async () => {
  const { contribBits } = await import('../public/js/admin/common.js');
  assert.deepEqual(contribBits({ ok: 3, prs: 10 }), []);
  assert.deepEqual(contribBits({ issues: 12, issuesNew: 3, reviews: 4, reviewsNew: 0, contribFailed: 1 }),
    ['12 issues (3 new)', '4 reviews', 'issues or reviews failed for 1 student']);
  assert.deepEqual(contribBits({ issues: 0, reviews: 0, contribFailed: 25, contribSkipped: 1 }),
    ['0 issues', '0 reviews', 'issues or reviews failed for 25 students', 'issues and reviews skipped for 1 student']);
  assert.deepEqual(contribBits(null), []);
});

test('wiring: the nav link to #/prs reads Contributions; no page module writes HTML strings', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
  assert.match(read('index.html'), /<a data-nav href="#\/prs">Contributions<\/a>/);
  assert.match(read('js/app.js'), /hasContributions\(meta\) \? 'Contributions' : 'Pull requests'/);
  for (const f of fs.readdirSync(new URL('../public/js/pages/', import.meta.url))) {
    assert.doesNotMatch(read(`js/pages/${f}`), /innerHTML|insertAdjacentHTML|outerHTML/, f);
  }
  assert.equal(innerHtmlWrites, 0);
});

test('project page without PRs (issues or reviews only): no PR tables, a plain note, contribution cards stay', async () => {
  routes['/repos/kubernetes/website'] = {
    range: { from: null, to: null, label: 'All time', preset: 'all' }, students: [], prs: page([]),
    repo: { name: 'kubernetes/website', owner: 'kubernetes', category: 'open_source', tier: 'major', stars: 4000, stats: { merged: 0, prs: 0, students: 0, campuses: [], open: 0, closed: 0, firstPrAt: null, lastPrAt: null, issues: 3, reviews: 0 } },
  };
  routes['/activity'] = {};
  const el = await render('repo', { path: '/projects/kubernetes/website', params: { owner: 'kubernetes', name: 'website' } });
  const labels = el.querySelectorAll('.stat-label').map((s) => s.textContent);
  assert.deepEqual(labels, ['Pull requests by NST students', 'Issues raised', 'Reviews given']);
  assert.match(text(el), /No pull requests by NST students in this project\./);
  assert.equal(el.querySelectorAll('table').length, 0);
});
