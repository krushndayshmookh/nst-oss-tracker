// DOM helpers and shared components. Contract: SPEC.md section 7.1; look and class names: DESIGN.md.
// Everything here builds real DOM nodes. API data is only ever inserted as text nodes, never as HTML.

/* ───────────── constants ───────────── */

export const CATEGORIES = ['open_source', 'practice', 'nst_internal', 'peer_repo', 'own_repo', 'low_signal'];
export const CATEGORY_LABELS = {
  open_source: 'Open source',
  practice: 'Practice repo',
  nst_internal: 'NST internal',
  peer_repo: 'Peer repo',
  own_repo: 'Own repo',
  low_signal: 'Low signal',
};
export const CATEGORY_HELP = {
  open_source: 'Pull requests to established public projects. This is what the headline numbers count.',
  practice: 'First-contribution and Hacktoberfest-style practice repositories.',
  nst_internal: 'Repositories owned by NST clubs, courses and organisations.',
  peer_repo: 'Repositories owned by another tracked student.',
  own_repo: 'The student’s own repositories.',
  low_signal: 'Forks, and projects below the star thresholds.',
};
export const TIERS = ['major', 'established', 'emerging'];
export const TIER_LABELS = { major: 'Major', established: 'Established', emerging: 'Emerging' };
export const STATE_LABELS = {
  open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft',
  queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', pending: 'Pending', cancelled: 'Cancelled',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const DASH = '—';

/* ───────────── element builder ───────────── */

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
}

/**
 * h(tag, attrs?, ...children) → Element.
 * attrs: `class` (string or array), `dataset` (object), `style` (object or string), `on<Event>` handlers,
 * boolean attributes (true sets, false / null / undefined skips), everything else via setAttribute.
 * Children: nodes, strings / numbers (text nodes), arrays (flattened); null / undefined / false are skipped.
 */
export function h(tag, attrs, ...children) {
  if (attrs !== null && attrs !== undefined && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (cls) node.className = cls;
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) node.dataset[k] = v;
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('--')) node.style.setProperty(k, v); else node.style[k] = v;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden' || key === 'open') {
      node[key] = value;
      if (value === true) node.setAttribute(key, '');
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}
export { h as el };

function svg(viewBox, paths, attrs = {}) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const [name, a] of paths) {
    const p = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(a)) p.setAttribute(k, v);
    node.append(p);
  }
  return node;
}

function getPath(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  if (key in Object(obj)) return obj[key];
  return String(key).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/* ───────────── formatters ───────────── */

const NUM = new Intl.NumberFormat('en-IN');
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_UTC = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const REL = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmt = {
  /** 49210 → '49,210' (Indian grouping above one lakh). null / undefined / NaN → '—'. */
  num(n) {
    if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return DASH;
    return NUM.format(Number(n));
  },
  /** 38000 → '38K'. For star counts where space is tight. */
  compact(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return DASH;
    return Number(n) < 1000 ? NUM.format(Number(n)) : COMPACT.format(Number(n));
  },
  /** pct(55, 600) → '9.2%'. A zero or missing denominator → '—'. */
  pct(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!y || Number.isNaN(x) || Number.isNaN(y)) return DASH;
    const p = (x / y) * 100;
    return `${p >= 99.95 || p === 0 ? p.toFixed(0) : p < 10 ? p.toFixed(1) : p.toFixed(0)}%`;
  },
  /** ISO string → '14 Nov 2026' in the reader's time zone. */
  date(iso) {
    const d = toDate(iso);
    return d ? DATE.format(d) : DASH;
  },
  /** ISO string → '14 Nov 2026, 08:06'. */
  datetime(iso) {
    const d = toDate(iso);
    return d ? DATETIME.format(d) : DASH;
  },
  /** '2026-10' → 'Oct 2026'. */
  month(ym) {
    const m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
    return m ? MONTH.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))) : DASH;
  },
  /** range('2026-07-01', '2027-06-30') → '1 Jul 2026 – 30 Jun 2027'. Plain calendar dates, no time-zone shift. */
  range(from, to) {
    const day = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
      return m ? DAY_UTC.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))) : null;
    };
    const a = day(from);
    const b = day(to);
    if (a && b) return `${a} – ${b}`;
    if (a) return `From ${a}`;
    if (b) return `Until ${b}`;
    return 'All time';
  },
  /** ISO string → '3 days ago', 'yesterday', 'in 2 hours'. */
  rel(iso) {
    const d = toDate(iso);
    if (!d) return DASH;
    const sec = (d.getTime() - Date.now()) / 1000;
    const abs = Math.abs(sec);
    if (abs < 45) return 'just now';
    const steps = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
    let unit = 'minute';
    let size = 60;
    for (const [s, u] of steps) if (abs >= s) { unit = u; size = s; }
    return REL.format(Math.round(sec / size), unit);
  },
};

/** ghUrl('apache') → https://github.com/apache · ghUrl('apache/airflow') → repo URL. Full URLs pass through. */
export function ghUrl(pathOrLogin) {
  const s = String(pathOrLogin || '').trim();
  if (/^https:\/\//i.test(s)) return s;
  // anything else, also another URL scheme, becomes a path under github.com
  return `https://github.com/${s.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}

/** Only https:// links leave the site: a javascript: or data: URL that ever reached the database must not become an href. */
export function safeUrl(url) {
  const s = String(url || '').trim();
  return /^https:\/\//i.test(s) ? s : null;
}

/** External link that opens in a new tab and carries the ↗ marker. A URL that is not https:// renders as plain text. */
export function extLink(text, url, attrs = {}) {
  const href = safeUrl(url);
  if (!href) return h('span', { class: attrs.class, title: attrs.title }, text);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: ['ext', attrs.class], title: attrs.title }, text);
}

/** Link to GitHub: ghLink('apache/airflow') or ghLink('octocat', 'GitHub profile'). */
export function ghLink(pathOrLogin, text) {
  return extLink(text || pathOrLogin, ghUrl(pathOrLogin));
}

/* ───────────── badges ───────────── */

/** badge('Fork') · badge('Excluded', 'danger'). kind: 'neutral' (default) | 'ok' | 'warn' | 'danger' | 'info'. */
export function badge(text, kind = 'neutral') {
  return h('span', { class: `badge badge-${kind}` }, text);
}

const STATE_ICONS = {
  // filled dot: finished and accepted
  merged: [['circle', { cx: 6, cy: 6, r: 5, fill: 'currentColor' }]],
  done: [['circle', { cx: 6, cy: 6, r: 5, fill: 'currentColor' }]],
  // ring: still in play
  open: [['circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  running: [['circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': '5 3' }]],
  // cross: ended without merging
  closed: [['path', { d: 'M2.5 2.5l7 7M9.5 2.5l-7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  error: [['path', { d: 'M2.5 2.5l7 7M9.5 2.5l-7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  cancelled: [['path', { d: 'M2.5 6h7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  // dashed ring: not started
  draft: [['circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }]],
  queued: [['circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }]],
  pending: [['circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }]],
};

/**
 * PR state ('open' | 'merged' | 'closed' | 'draft'), job status ('queued' | 'running' | 'done' | 'error')
 * or backfill status ('pending' | …) as glyph + label. Shape differs per state, so it never relies on colour.
 */
export function stateBadge(state, label) {
  const key = String(state || '').toLowerCase();
  const icon = STATE_ICONS[key] || STATE_ICONS.pending;
  return h('span', { class: `badge badge-state state-${key || 'pending'}` },
    svg('0 0 12 12', icon, { class: 'state-icon' }),
    h('span', null, label || STATE_LABELS[key] || state || DASH));
}

/** Tier as three pips (major 3, established 2, emerging 1) plus the tier name. */
export function tierBadge(tier, { label = true } = {}) {
  if (!tier) return document.createTextNode('');
  const name = TIER_LABELS[tier] || tier;
  return h('span', { class: `badge badge-tier`, title: `${name} project` },
    h('span', { class: `tier tier-${tier}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    label ? name : h('span', { class: 'sr-only' }, name));
}

/** Category as colour swatch + label; with `tier` the pips and tier name follow ('Open source ▮▮▮ Major'). */
export function categoryBadge(category, tier) {
  const node = h('span', { class: `badge badge-cat cat-${category}`, title: CATEGORY_HELP[category] },
    h('span', { class: 'swatch', 'aria-hidden': 'true' }),
    CATEGORY_LABELS[category] || category || DASH);
  if (!tier) return node;
  return h('span', { class: 'nowrap' }, node, ' ', tierBadge(tier));
}

/** Marks a row whose category was set by an admin: overrideBadge('not_open_source', note). */
export function overrideBadge(override, note) {
  if (!override) return document.createTextNode('');
  const labels = { open_source: 'Marked open source', not_open_source: 'Marked not open source', include: 'Included', exclude: 'Excluded', nst_internal: 'Marked NST internal' };
  return h('span', { class: 'badge badge-override', title: note || 'Set by an admin' }, labels[override] || override);
}

/* ───────────── stats ───────────── */

/**
 * One figure in a `.cards` band. `value` numbers are formatted; strings and nodes pass through.
 * Extras: `key: true` (the headline figure: marigold bar, larger numeral), `href` (whole cell becomes a link), `title`.
 */
export function statCard({ label, value, sub, key = false, href = null, title = null }) {
  const shown = typeof value === 'number' ? fmt.num(value) : value === null || value === undefined ? DASH : value;
  return h(href ? 'a' : 'div', { class: ['stat', key && 'stat-key'], href, title },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, shown),
    sub !== null && sub !== undefined && sub !== '' ? h('div', { class: 'stat-sub' }, sub) : null);
}

/**
 * Horizontal funnel: funnel([{ label, value }, …]). Bars are scaled to the first step; each row also shows
 * its share of the first step. The last step takes the accent colour.
 */
export function funnel(steps) {
  const base = Number(steps[0] && steps[0].value) || 0;
  return h('ol', { class: 'funnel' }, steps.map((s, i) => {
    const w = base ? Math.max(0, Math.min(100, (Number(s.value) / base) * 100)) : 0;
    return h('li', { class: 'funnel-row' },
      h('span', { class: 'funnel-label' }, s.label),
      h('span', { class: 'funnel-track', 'aria-hidden': 'true' }, h('span', { class: 'funnel-fill', style: { width: `${w}%` } })),
      h('span', { class: 'funnel-value' }, fmt.num(s.value), i > 0 ? h('small', null, fmt.pct(s.value, base)) : null));
  }));
}

/**
 * Category mix as a thin 100% bar: categoryBar(stats.byCategory). `legend: true` adds a labelled key with counts.
 * Segment order and colours are fixed (CATEGORIES), so bars in a column can be compared at a glance.
 */
export function categoryBar(byCategory, { legend = false, large = false } = {}) {
  const counts = byCategory || {};
  const total = CATEGORIES.reduce((sum, c) => sum + (Number(counts[c]) || 0), 0);
  const summary = total
    ? CATEGORIES.filter((c) => counts[c]).map((c) => `${CATEGORY_LABELS[c]} ${fmt.num(counts[c])}`).join(', ')
    : 'No pull requests';
  const bar = h('span', { class: ['mix', large && 'mix-lg'], role: 'img', 'aria-label': summary, title: summary },
    total ? CATEGORIES.filter((c) => counts[c]).map((c) =>
      h('span', { class: `cat-${c}`, style: { flex: `${counts[c]} 0 0`, background: 'var(--cat-color)' } })) : null);
  if (!legend) return bar;
  return h('div', null, bar,
    h('ul', { class: 'legend' }, CATEGORIES.map((c) =>
      h('li', { class: `cat-${c}`, title: CATEGORY_HELP[c] },
        h('span', { class: 'swatch', style: { background: 'var(--cat-color)' }, 'aria-hidden': 'true' }),
        CATEGORY_LABELS[c], ' ', h('b', null, fmt.num(counts[c] || 0))))));
}

/** A number with an in-cell bar scaled to `max`: for the leading metric column of a ranked table. */
export function barCell(value, max) {
  const w = max ? Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100)) : 0;
  return h('span', { class: 'barcell' },
    h('span', { class: 'barcell-value' }, fmt.num(value)),
    h('span', { class: 'barcell-track', 'aria-hidden': 'true' }, h('span', { class: 'barcell-fill', style: { width: `${w}%` } })));
}

/* ───────────── feedback ───────────── */

/** Placeholder shown while data loads. */
export function loading(text = 'Loading…') {
  return h('div', { class: 'loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'loading-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
    h('span', { class: 'sr-only' }, text));
}

/** Empty state: one plain sentence saying what is missing and, where possible, what to do. */
export function empty(text = 'Nothing to show yet.', action = null) {
  return h('div', { class: 'empty empty-box' }, h('p', null, text), action);
}

const ERROR_TITLES = {
  network: 'Can’t reach the server',
  not_found: 'Not found',
  unauthorized: 'Sign in required',
  forbidden: 'Not allowed',
  rate_limited: 'Too many requests',
  unavailable: 'Temporarily unavailable',
  bad_request: 'That request didn’t work',
  conflict: 'Already exists',
};

/** Error panel for a failed load. `opts.retry` adds a "Try again" button. */
export function errorBox(err, opts = {}) {
  const code = (err && err.code) || '';
  const message = (err && err.message) || String(err || 'Unknown error');
  return h('div', { class: 'error-box', role: 'alert' },
    h('h2', null, ERROR_TITLES[code] || 'Something went wrong'),
    h('p', null, message),
    opts.retry ? h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onClick: opts.retry }, 'Try again')) : null);
}

let toastHost = null;
/** Transient message, bottom right. kind: 'ok' (default) | 'error'. Errors stay longer. */
export function toast(message, kind = 'ok') {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : null }, String(message));
  toastHost.append(node);
  const timer = setTimeout(() => node.remove(), kind === 'error' ? 8000 : 4000);
  node.addEventListener('click', () => { clearTimeout(timer); node.remove(); });
  return node;
}

/* ───────────── dialogs ───────────── */

/**
 * modal({ title, body, actions?, wide?, onClose? }) → { close(), el }.
 * actions: [{ label, kind?: 'primary' | 'danger', onClick?(close) }]; an action without onClick just closes.
 * Uses the native <dialog>: focus is trapped, Esc closes, focus returns to the opener.
 */
export function modal({ title, body, actions = [], wide = false, onClose = null }) {
  const opener = document.activeElement;
  const titleId = nextId('dialog-title');
  let closed = false;
  const dialog = h('dialog', { class: ['dialog', wide && 'dialog-wide'], 'aria-labelledby': titleId });
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (onClose) onClose();
  };
  dialog.append(h('div', { class: 'dialog-box' },
    h('div', { class: 'dialog-head' },
      h('h2', { id: titleId }, title),
      h('button', { class: 'dialog-close', type: 'button', 'aria-label': 'Close', onClick: close }, '×')),
    h('div', { class: 'dialog-body' }, body),
    actions.length ? h('div', { class: 'dialog-actions' }, actions.map((a) =>
      h('button', {
        type: 'button',
        class: ['btn', a.kind === 'primary' && 'btn-primary', a.kind === 'danger' && 'btn-danger btn-primary'],
        onClick: () => (a.onClick ? a.onClick(close) : close()),
      }, a.label))) : null));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  return { close, el: dialog };
}

/**
 * confirmDialog('Deactivate octocat?', { confirmLabel: 'Deactivate', danger: true }) → Promise<boolean>.
 * With `input: { label, value?, placeholder?, required? }` it resolves to the entered string (may be '') or false.
 */
export function confirmDialog(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, input = null, title = 'Please confirm' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    let field = null;
    const body = [typeof message === 'string' ? h('p', null, message) : message];
    if (input) {
      const id = nextId('confirm-input');
      field = h('input', { type: 'text', id, name: 'confirm-input', value: input.value || '', placeholder: input.placeholder, autocomplete: 'off' });
      body.push(h('div', { class: 'form-row' }, h('label', { for: id }, input.label), field));
    }
    const submit = (close) => {
      if (field && input.required && !field.value.trim()) { field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
      result = field ? field.value.trim() : true;
      close();
    };
    const m = modal({
      title,
      body: h('div', null, body),
      actions: [
        { label: cancelLabel },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: submit },
      ],
      onClose: () => resolve(result),
    });
    if (field) {
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(m.close); } });
      field.focus();
    } else {
      const buttons = m.el.querySelectorAll('.dialog-actions .btn');
      // destructive confirmations start on Cancel; ordinary ones on the confirm button
      (danger ? buttons[0] : buttons[buttons.length - 1]).focus();
    }
  });
}

/* ───────────── table ───────────── */

/**
 * table({ columns, rows, sort?, order?, onSort?, empty?, caption?, rowClass?, sticky?, compact? }) → Element (.table-wrap)
 * columns: [{ key, label, num?, sortable?, render?(row, index) → Node | string, wrap?, title?, width?, class?, sortKey? }]
 *   - cells are single-line and clip with an ellipsis at 44ch; `wrap: true` lets a column (descriptions, notes) wrap
 *   - without `render` the cell shows row[key] (dot paths work: 'stats.osMerged'); `num` cells are formatted and right-aligned
 *   - `sortable` headers are buttons; clicking calls onSort(key, order). A new column starts 'desc' when `num`, else 'asc';
 *     clicking the active column flips it.
 * `sort` / `order` mark the active column (aria-sort). Sorting itself happens on the server.
 * `caption` names the table for screen readers (visually hidden unless `captionVisible`).
 * `sticky` (default true) pins the first column while scrolling sideways on narrow screens.
 * `empty` is the text shown when rows is empty.
 */
export function table({ columns, rows, sort = null, order = 'desc', onSort = null, empty: emptyText = 'No rows match.', caption = null, captionVisible = false, rowClass = null, sticky = true, compact = false }) {
  const list = Array.isArray(rows) ? rows : [];
  const head = h('tr', null, columns.map((col) => {
    const active = sort !== null && (col.sortKey || col.key) === sort;
    const attrs = {
      scope: 'col',
      class: [col.num && 'num', col.class],
      title: col.title,
      style: col.width ? { width: col.width } : null,
      'aria-sort': col.sortable ? (active ? (order === 'asc' ? 'ascending' : 'descending') : 'none') : null,
    };
    if (!col.sortable || !onSort) return h('th', attrs, col.label);
    return h('th', attrs, h('button', {
      type: 'button',
      class: 'th-sort',
      name: `sort-${col.sortKey || col.key}`,
      onClick: () => onSort(col.sortKey || col.key, active ? (order === 'asc' ? 'desc' : 'asc') : (col.num ? 'desc' : 'asc')),
    }, col.label));
  }));

  const body = h('tbody');
  if (!list.length) {
    body.append(h('tr', null, h('td', { class: 'empty-cell', colspan: columns.length }, h('div', { class: 'empty' }, emptyText))));
  }
  list.forEach((row, index) => {
    const cls = typeof rowClass === 'function' ? rowClass(row, index) : null;
    body.append(h('tr', { class: cls }, columns.map((col) => {
      let content;
      if (col.render) content = col.render(row, index);
      else {
        const v = getPath(row, col.key);
        content = col.num ? fmt.num(v) : v;
      }
      if (content === null || content === undefined || content === '') content = h('span', { class: 'muted' }, DASH);
      const tip = typeof content === 'string' && content.length > 40 ? content : null;
      return h('td', { class: [col.num && 'num', col.wrap && 'wrap', col.class], title: tip }, content);
    })));
  });

  return h('div', { class: ['table-wrap', sticky && 'table-sticky', compact && 'table-compact'], tabindex: '0', role: 'region', 'aria-label': caption || 'Table' },
    h('table', { class: 'data' },
      caption ? h('caption', { class: captionVisible ? null : 'sr-only' }, caption) : null,
      h('thead', null, head),
      body));
}
export { table as dataTable };

/**
 * pagination({ page, limit, total, onPage }) → Element. Shows "26–50 of 1,411" and Previous / page numbers / Next.
 * Returns only the count when everything fits on one page.
 */
export function pagination({ page = 1, limit = 25, total = 0, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const from = total ? (current - 1) * limit + 1 : 0;
  const to = Math.min(total, current * limit);
  const count = h('span', { class: 'pagination-count' },
    total ? `${fmt.num(from)}–${fmt.num(to)} of ${fmt.num(total)}` : 'No results');
  const nav = h('nav', { class: 'pagination', 'aria-label': 'Pagination' }, count);
  if (pages <= 1) return nav;

  const go = (p) => () => { if (onPage) onPage(p); };
  const btn = (label, p, { disabled = false, isCurrent = false, aria = null } = {}) =>
    h('button', { type: 'button', class: 'btn btn-sm', name: `page-${label}`, disabled, 'aria-current': isCurrent ? 'page' : null, 'aria-label': aria, onClick: go(p) }, label);

  const numbers = new Set([1, pages, current - 1, current, current + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...numbers].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push(h('span', { class: 'gap', 'aria-hidden': 'true' }, '…'));
    items.push(btn(String(p), p, { isCurrent: p === current, aria: `Page ${p}` }));
  });
  nav.append(h('div', { class: 'pagination-pages' },
    btn('Previous', current - 1, { disabled: current <= 1 }),
    items,
    btn('Next', current + 1, { disabled: current >= pages })));
  return nav;
}

/* ───────────── filter bar ───────────── */

/**
 * filterBar({ fields, values, onChange, clear? }) → Element (.filters)
 * fields: [{ name, label, type: 'select' | 'search' | 'date' | 'checkbox', options?, placeholder?, allLabel? }]
 *   - select options are strings or { value, label }; an "All" option (value '') is added unless one is present
 *   - checkbox values are '1' (checked) or '' (unchecked)
 * values: current values keyed by field name (normally ctx.query).
 * onChange(values): called with every field's current value ('' when cleared) — pass it straight to setQuery,
 *   adding `page: ''` to return to the first page. Search input is debounced by 300 ms.
 * A "Clear filters" button appears when any field is set (`clear: false` hides it).
 */
export function filterBar({ fields, values = {}, onChange, clear = true }) {
  const controls = new Map();
  let timer = null;
  const read = () => {
    const out = {};
    for (const [name, { field, input }] of controls) {
      out[name] = field.type === 'checkbox' ? (input.checked ? '1' : '') : input.value.trim();
    }
    return out;
  };
  const emit = () => { clearTimeout(timer); if (onChange) onChange(read()); };
  const emitSoon = () => { clearTimeout(timer); timer = setTimeout(emit, 300); };

  const rows = fields.map((field) => {
    const id = nextId(`f-${field.name}`);
    const value = values[field.name] ?? '';
    let input;
    if (field.type === 'select') {
      const opts = (field.options || []).map((o) => (typeof o === 'object' && o !== null ? o : { value: String(o), label: String(o) }));
      if (!opts.some((o) => String(o.value) === '')) opts.unshift({ value: '', label: field.allLabel || 'All' });
      input = h('select', { id, name: field.name, class: value !== '' ? 'is-set' : null, onChange: emit },
        opts.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
    } else if (field.type === 'checkbox') {
      input = h('input', { type: 'checkbox', id, name: field.name, checked: value === '1' || value === 'true' || value === true, onChange: emit });
      controls.set(field.name, { field, input });
      return h('div', { class: 'form-row form-row-check' }, input, h('label', { for: id }, field.label));
    } else if (field.type === 'date') {
      input = h('input', { type: 'date', id, name: field.name, value, class: value ? 'is-set' : null, onChange: emit });
    } else {
      input = h('input', {
        type: 'search', id, name: field.name, value, placeholder: field.placeholder || 'Search', autocomplete: 'off', spellcheck: 'false',
        class: value ? 'is-set' : null,
        onInput: emitSoon,
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); emit(); } },
      });
    }
    controls.set(field.name, { field, input });
    return h('div', { class: `form-row form-row-${field.type === 'search' ? 'search' : field.type}` }, h('label', { for: id }, field.label), input);
  });

  const anySet = fields.some((f) => {
    const v = values[f.name];
    return v !== undefined && v !== null && v !== '';
  });
  const clearBtn = clear && anySet ? h('button', {
    type: 'button', class: 'btn btn-link filters-clear', name: 'filters-clear',
    onClick: () => {
      for (const { field, input } of controls.values()) { if (field.type === 'checkbox') input.checked = false; else input.value = ''; }
      emit();
    },
  }, 'Clear filters') : null;

  return h('form', { class: 'filters', role: 'search', 'aria-label': 'Filters', onSubmit: (e) => { e.preventDefault(); emit(); } }, rows, clearBtn);
}

/**
 * tabs([{ label, href?, value?, count?, active? }], { onSelect? }) → Element (.tabs).
 * With `href` the tabs are links (state lives in the hash); otherwise buttons calling onSelect(value).
 */
export function tabs(items, { onSelect = null, label = 'Sections' } = {}) {
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': label }, items.map((item) => {
    const count = item.count !== undefined && item.count !== null ? h('span', { class: 'count' }, fmt.num(item.count)) : null;
    if (item.href) return h('a', { class: 'tab', role: 'tab', href: item.href, 'aria-selected': item.active ? 'true' : 'false' }, item.label, count);
    return h('button', { class: 'tab', role: 'tab', type: 'button', name: `tab-${item.value}`, 'aria-selected': item.active ? 'true' : 'false', onClick: () => onSelect && onSelect(item.value) }, item.label, count);
  }));
}

/**
 * Page header: pageHead({ title, range?, lede?, crumbs?: [{ label, href }], actions?: Node[] }) → Element (.page-head).
 * `range` is the active date range, shown as its own line under the title ("AY 2026-27 · 1 Jul 2026 – 30 Jun 2027").
 */
export function pageHead({ title, lede = null, crumbs = null, actions = null, range = null }) {
  return h('header', { class: 'page-head' },
    h('div', null,
      crumbs && crumbs.length ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
        crumbs.map((c, i) => [i ? ' / ' : null, c.href ? h('a', { href: c.href }, c.label) : c.label])) : null,
      h('h1', null, title),
      range ? h('p', { class: 'page-range' }, range) : null,
      lede ? h('p', { class: 'lede' }, lede) : null),
    actions ? h('div', { class: 'toolbar' }, actions) : null);
}

/** Titled panel: card({ title?, note?, flush?, class? }, ...children) → Element (.card). `flush` suits a table. */
export function card({ title = null, note = null, flush = false, class: cls = null } = {}, ...children) {
  return h('section', { class: ['card', flush && 'card-flush', cls] },
    title ? h('div', { class: 'card-head' }, h('h2', null, title), note ? h('span', { class: 'muted' }, note) : null) : null,
    children);
}

/* ───────────── date range + heatmaps (SPEC addendum A) ───────────── */

/**
 * Date-range control: preset buttons plus custom From / To dates.
 * rangeBar({ presets: [{ key, label, from?, to? }], query, onChange(patch), defaultKey? = 'ay' }) → Element (.rangebar)
 *   presets: `meta.presets` from GET /api/meta. `query`: ctx.query (reads `from`, `to`, `range`).
 *   onChange(patch): patch is { from, to, range } with '' for the keys to clear — pass it to setQuery (add page: '').
 *   The default preset clears all three keys (no params = current academic year); 'all' sets range=all;
 *   any other preset sets range=<key>; custom dates set from / to.
 */
export function rangeBar({ presets = [], query = {}, onChange, defaultKey = 'ay' }) {
  const custom = Boolean(query.from || query.to);
  const activeKey = custom ? null : (query.range || defaultKey);
  const emit = (patch) => { if (onChange) onChange({ from: '', to: '', range: '', ...patch }); };
  const fromId = nextId('range-from');
  const toId = nextId('range-to');
  const from = h('input', { type: 'date', id: fromId, name: 'from', value: query.from || '', class: query.from ? 'is-set' : null, max: query.to || null });
  const to = h('input', { type: 'date', id: toId, name: 'to', value: query.to || '', class: query.to ? 'is-set' : null, min: query.from || null });
  const onDate = () => { if (from.value || to.value) emit({ from: from.value, to: to.value }); else emit({}); };
  from.addEventListener('change', onDate);
  to.addEventListener('change', onDate);
  return h('div', { class: 'rangebar', role: 'group', 'aria-label': 'Date range' },
    h('div', { class: 'btn-group' }, presets.map((p) => h('button', {
      type: 'button', name: `range-${p.key}`, class: ['btn btn-sm', p.key === activeKey && 'is-on'], 'aria-pressed': p.key === activeKey ? 'true' : 'false',
      title: p.from || p.to ? fmt.range(p.from, p.to) : null,
      onClick: () => emit(p.key === defaultKey ? {} : { range: p.key }),
    }, p.label || p.key))),
    h('div', { class: 'rangebar-custom' },
      h('label', { for: fromId }, 'From'), from,
      h('label', { for: toId }, 'to'), to));
}

/**
 * Five-step scale for a heatmap. Steps start at the 40th, 70th and 90th percentile of the non-zero values rather than by the largest one,
 * so a single outlier (one 120-PR day) does not flatten every other cell into the palest step.
 * → { level(value) → 0..4, bounds: lowest value of steps 1..4 }
 */
function heatScale(values) {
  const nz = values.map((v) => Number(v) || 0).filter((v) => v > 0).sort((x, y) => x - y);
  if (!nz.length) return { level: () => 0, bounds: [] };
  const at = (f) => nz[Math.min(nz.length - 1, Math.floor(f * nz.length))];
  const bounds = [nz[0]];
  for (const f of [0.4, 0.7, 0.9]) { const v = at(f); if (v > bounds[bounds.length - 1]) bounds.push(v); }
  // few distinct values: let the largest take the darkest step so the scale is not all pale
  const top = nz[nz.length - 1];
  if (bounds.length < 4 && top > bounds[bounds.length - 1]) bounds.push(top);
  const steps = bounds.length;
  const level = (value) => {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    let n = 0;
    for (const bnd of bounds) if (v >= bnd) n += 1;
    // spread fewer than four steps over the 1..4 palette (2 steps → 2 and 4)
    return steps >= 4 ? n : Math.max(1, Math.round((n / steps) * 4));
  };
  return { level, bounds };
}

function heatKey(unit, scale) {
  const b = (scale && scale.bounds) || [];
  const darkest = b.length >= 2 ? `Darkest: ${fmt.num(b[b.length - 1])} or more` : null;
  return h('div', { class: 'heat-key muted', 'aria-hidden': 'true' },
    h('span', null, 'None'), h('i', { class: 'heat-0' }), h('span', { class: 'heat-key-gap' }, 'Fewer'),
    [1, 2, 3, 4].map((l) => h('i', { class: `heat-${l}` })), h('span', null, 'More'),
    darkest ? h('span', { class: 'heat-key-note' }, darkest) : null);
}

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

/**
 * Calendar heatmap, one square per day, weeks as columns (Monday on top).
 * calendarHeatmap([{ date: 'YYYY-MM-DD', value }], { unit? = 'pull requests', label? }) → Element (.calendar)
 * Pass every day in the range (zero-filled, as /api/activity byDate returns). Squares grow with the space available
 * (11 to 16 px) and the grid scrolls sideways when a long range does not fit.
 */
export function calendarHeatmap(days, { unit = 'pull requests', label = null } = {}) {
  const list = (days || []).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(String(d.date)));
  const max = list.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0);
  const total = list.reduce((m, d) => m + (Number(d.value) || 0), 0);
  const scale = heatScale(list.map((d) => d.value));
  const grid = h('div', { class: 'calendar-grid', 'aria-hidden': 'true' });
  const utc = (s) => new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
  grid.append(h('span'), ...WEEKDAY_LABELS.map((d) => h('span', { class: 'calendar-dow' }, d)));
  let week = null;
  let weeks = 0;
  let lastLabelWeek = -9;
  let firstLabel = null;
  const startWeek = () => { week = h('span', { class: 'calendar-month' }); weeks += 1; grid.append(week); };
  list.forEach((d, i) => {
    const date = utc(String(d.date));
    const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
    if (i === 0) { startWeek(); for (let k = 0; k < dow; k++) grid.append(h('i', { class: 'heat-blank' })); }
    else if (dow === 0) startWeek();
    // month name over the week that holds the 1st (and over the first week), never two labels on adjacent weeks
    // a partial first month gives way to the month that starts right after it
    if (date.getUTCDate() === 1 && i > 0 && firstLabel && weeks - lastLabelWeek <= 2) { firstLabel.textContent = ''; firstLabel = null; lastLabelWeek = -9; }
    if ((i === 0 || date.getUTCDate() === 1) && weeks - lastLabelWeek > 2) {
      firstLabel = i === 0 ? week : null;
      week.textContent = MONTH_SHORT.format(date) + (date.getUTCMonth() === 0 || lastLabelWeek === -9 ? ` ${String(date.getUTCFullYear()).slice(2)}` : '');
      lastLabelWeek = weeks;
    }
    grid.append(h('i', { class: `heat-${scale.level(d.value)}`, title: `${fmt.num(d.value || 0)} ${unit} on ${WEEKDAY_LONG.format(date)} ${DAY_UTC.format(date)}` }));
  });
  return h('div', { class: 'calendar', role: 'img', 'aria-label': label || `${fmt.num(total)} ${unit} over ${fmt.num(list.length)} days; busiest day ${fmt.num(max)}` },
    h('div', { class: 'calendar-scroll', tabindex: '0', style: { '--weeks': String(Math.max(1, weeks)) } }, grid), heatKey(unit, scale));
}
const WEEKDAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const MONTH_SHORT = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

/**
 * Grid heatmap for two dimensions, e.g. weekday × hour.
 * heatGrid({ rows: ['Mon', …], cols: ['0', '', '', '3', …], value(rowIndex, colIndex) → number, unit?, label?, cellTitle?(r, c, v) })
 * Empty strings in `cols` leave that column unlabelled (label every third hour).
 */
export function heatGrid({ rows, cols, value, unit = 'pull requests', label = null, cellTitle = null }) {
  const values = rows.map((_, r) => cols.map((__, c) => Number(value(r, c)) || 0));
  const scale = heatScale(values.flat());
  const grid = h('div', { class: 'heatgrid-grid', 'aria-hidden': 'true', style: { '--cols': String(cols.length) } },
    h('span'), cols.map((c) => h('span', { class: 'heatgrid-col' }, c)),
    rows.map((name, r) => [h('span', { class: 'heatgrid-row' }, name),
      cols.map((_, c) => h('i', { class: `heat-${scale.level(values[r][c])}`, title: cellTitle ? cellTitle(r, c, values[r][c]) : `${fmt.num(values[r][c])} ${unit}` }))]));
  return h('div', { class: 'heatgrid', role: 'img', 'aria-label': label || `Heatmap of ${unit}, ${rows.length} by ${cols.length}` }, grid, heatKey(unit, scale));
}
