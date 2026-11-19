// Chart.js wrappers themed from the CSS custom properties in app.css. Contract: SPEC.md section 7.1.
// `Chart` is a global loaded by the shell from /vendor/chart.umd.js. Colours are read from the document at
// draw time and re-read when the colour scheme changes, so charts follow light / dark without a reload.
//
//   lineChart(canvas, { labels, series: [{ label, data, color?, dashed? }] })   → { destroy(), update(data), chart }
//   barChart(canvas, { labels, series, stacked?, horizontal? })                 → same
//   both also take, for rates (SPEC addendum D): format(value) → tick / tooltip text with its unit,
//   axisTitle (the unit, printed along the value axis), tooltipLabel(seriesIndex, dataIndex, value) → one tooltip line
//   doughnutChart(canvas, { labels, data, colors? })                            → same
//
// Colour is assigned by what a series IS, not by its position: a series or slice whose label (or `color`) names a
// category, tier or PR state always gets that entity's colour, the same one its badge uses. Anything else takes
// the categorical slots --chart-1 … --chart-5 in order, then --chart-other.

import { CATEGORY_LABELS, TIER_LABELS, fmt } from './ui.js';

const SLOTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];
const OTHER = '--chart-other';

// label / key → CSS variable
const NAMED = new Map();
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
for (const [key, label] of Object.entries(CATEGORY_LABELS)) { NAMED.set(norm(key), `--cat-${key}`); NAMED.set(norm(label), `--cat-${key}`); }
for (const [key, label] of Object.entries(TIER_LABELS)) { NAMED.set(norm(key), `--tier-${key}`); NAMED.set(norm(label), `--tier-${key}`); }
for (const key of ['open', 'merged', 'closed']) NAMED.set(key, `--state-${key}`);
NAMED.set('other', OTHER);
NAMED.set('others', OTHER);

const live = new Set();
let listening = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolve a colour spec: a category / tier / state key or label, 1-based slot number, '--css-var', or any CSS colour. */
export function chartColor(spec, index = 0) {
  if (typeof spec === 'number') return cssVar(SLOTS[spec - 1] || OTHER);
  if (typeof spec === 'string' && spec) {
    if (spec.startsWith('--')) return cssVar(spec);
    const named = NAMED.get(norm(spec));
    if (named) return cssVar(named);
    return spec;
  }
  return cssVar(SLOTS[index] || OTHER);
}

function pickColor(explicit, label, index) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return chartColor(explicit, index);
  const named = NAMED.get(norm(label));
  return named ? cssVar(named) : cssVar(SLOTS[index] || OTHER);
}

function theme() {
  return {
    surface: cssVar('--surface') || '#fff',
    ink: cssVar('--ink') || '#111',
    ink2: cssVar('--ink-2') || '#444',
    axis: cssVar('--chart-axis') || '#666',
    grid: cssVar('--chart-grid') || '#ddd',
    font: cssVar('--font-body') || 'system-ui, sans-serif',
  };
}

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s));
const showLabels = (labels) => (labels || []).map((l) => (isMonth(l) ? fmt.month(l) : l));

function listen() {
  if (listening || !window.matchMedia) return;
  listening = true;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    // let the new custom-property values apply before reading them back
    requestAnimationFrame(() => {
      for (const entry of [...live]) {
        // a page that forgot its cleanup leaves charts behind; drop them here instead of repainting a dead canvas
        if (!entry.chart.canvas || !entry.chart.canvas.isConnected) { live.delete(entry); entry.chart.destroy(); continue; }
        entry.paint();
        entry.chart.update('none');
      }
    });
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
}

function baseOptions(t, { legend, indexAxis = 'x' }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reducedMotion() ? false : { duration: 250 },
    indexAxis,
    interaction: { mode: 'index', intersect: false, axis: indexAxis },
    layout: { padding: { top: 4, right: 4 } },
    plugins: {
      legend: {
        display: legend,
        position: 'top',
        align: 'start',
        labels: { color: t.ink2, boxWidth: 10, boxHeight: 10, padding: 14, font: { family: t.font, size: 12 } },
      },
      tooltip: {
        backgroundColor: t.ink,
        titleColor: t.surface,
        bodyColor: t.surface,
        padding: 10,
        cornerRadius: 4,
        boxPadding: 4,
        usePointStyle: false,
        titleFont: { family: t.font, size: 12, weight: '600' },
        bodyFont: { family: t.font, size: 12 },
        callbacks: {
          label(ctx) {
            const v = ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : (ctx.parsed.y ?? ctx.parsed);
            const name = ctx.dataset.label || ctx.label || '';
            return ` ${name}: ${fmt.num(typeof v === 'number' ? v : ctx.raw)}`;
          },
        },
      },
    },
  };
}

function axes(t, { stacked = false, horizontal = false }) {
  const value = {
    stacked,
    beginAtZero: true,
    border: { display: false },
    grid: { color: t.grid, drawTicks: false },
    ticks: { color: t.axis, padding: 6, precision: 0, maxTicksLimit: 6, font: { family: t.font, size: 11 }, callback: (v) => fmt.compact(v) },
  };
  const category = {
    stacked,
    border: { color: t.grid },
    grid: { display: false },
    ticks: { color: t.axis, maxRotation: 0, autoSkipPadding: 12, font: { family: t.font, size: 11 } },
  };
  return horizontal ? { x: value, y: { ...category, ticks: { ...category.ticks, autoSkip: false } } } : { x: category, y: value };
}

function fallback(canvas, text) {
  const note = document.createElement('div');
  note.className = 'chart-fallback';
  note.textContent = text;
  canvas.hidden = true;
  canvas.after(note);
  return { destroy() { note.remove(); canvas.hidden = false; }, update() {}, chart: null };
}

function describe(canvas, label, labels, series) {
  canvas.setAttribute('role', 'img');
  if (!canvas.getAttribute('aria-label')) {
    const names = series.map((s) => s.label).filter(Boolean).join(', ');
    canvas.setAttribute('aria-label', label || `Chart${names ? ` of ${names}` : ''}${labels && labels.length ? `, ${labels.length} points` : ''}`);
  }
}

function mount(canvas, build) {
  if (!canvas || !canvas.getContext) throw new TypeError('charts: a <canvas> element is required');
  const ChartJs = globalThis.Chart;
  if (!ChartJs) return fallback(canvas, 'The chart library did not load. The figures are in the table.');
  let entry;
  try {
    const { config, paint, set } = build();
    const chart = new ChartJs(canvas, config);
    entry = { chart, paint: () => paint(chart), set };
  } catch (err) {
    console.error(err);
    return fallback(canvas, 'This chart could not be drawn.');
  }
  live.add(entry);
  listen();
  return {
    chart: entry.chart,
    /** Replace the data in place: update({ labels, series }) or update({ labels, data }) for a doughnut. */
    update(next) { entry.set(next || {}); entry.paint(); entry.chart.update(); },
    destroy() { live.delete(entry); entry.chart.destroy(); },
  };
}

function cartesian(type, canvas, input, style) {
  let current = input;
  const handle = mount(canvas, () => {
    const paint = (chart) => {
      const t = theme();
      const { labels = [], series = [], stacked = false, horizontal = false, format = null, axisTitle = null, tooltipLabel = null } = current;
      chart.data.labels = showLabels(labels);
      chart.data.datasets = series.map((s, i) => {
        const color = pickColor(s.color, s.label, i);
        const dash = s.dashed ? { borderDash: [5, 4] } : {};
        return { label: s.label, data: s.data, ...style(color, t, { stacked, horizontal, count: series.length }), ...dash };
      });
      const base = baseOptions(t, { legend: series.length > 1, indexAxis: horizontal ? 'y' : 'x' });
      const scales = axes(t, { stacked, horizontal });
      const valueAxis = horizontal ? scales.x : scales.y;
      if (format) {
        // a rate axis: fractional ticks are fine, and the tick text carries the unit ("12%", "7.5")
        valueAxis.ticks = { ...valueAxis.ticks, precision: undefined, callback: (v) => format(v) };
        base.plugins.tooltip.callbacks.label = (ctx) => {
          const v = horizontal ? ctx.parsed.x : ctx.parsed.y;
          return ` ${ctx.dataset.label || ctx.label || ''}: ${format(v)}`;
        };
      }
      // on a phone the unit is read from the line above the chart; a rotated title would only take width
      const roomy = !chart.canvas || !chart.canvas.clientWidth || chart.canvas.clientWidth >= 480;
      if (axisTitle && roomy) valueAxis.title = { display: true, text: axisTitle, color: t.axis, font: { family: t.font, size: 11 }, padding: { bottom: 4 } };
      if (tooltipLabel) {
        base.plugins.tooltip.callbacks.label = (ctx) => {
          const text = tooltipLabel(ctx.datasetIndex, ctx.dataIndex, horizontal ? ctx.parsed.x : ctx.parsed.y);
          return text === null || text === undefined ? null : ` ${text}`;
        };
      }
      chart.options = { ...base, scales };
    };
    const shell = { data: { labels: [], datasets: [] }, options: {}, canvas };
    paint(shell);
    return { config: { type, data: shell.data, options: shell.options }, paint, set: (next) => { current = { ...current, ...next }; } };
  });
  describe(canvas, input.label, input.labels, input.series || []);
  return handle;
}

/** Line chart for change over time. `labels` in 'YYYY-MM' form are shown as 'Oct 2026'. */
export function lineChart(canvas, { labels, series, label, format, axisTitle, tooltipLabel } = {}) {
  return cartesian('line', canvas, { labels, series, label, format, axisTitle, tooltipLabel }, (color, t) => ({
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    tension: 0.25,
    cubicInterpolationMode: 'monotone', // no overshoot: a smoothed line must not dip below zero or invent a peak
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHitRadius: 12,
    pointBackgroundColor: color,
    pointBorderColor: t.surface,
    pointHoverBorderWidth: 2,
    fill: false,
  }));
}

/** Bar chart. `stacked` stacks the series; `horizontal` puts categories on the y axis (use it for long names). */
export function barChart(canvas, { labels, series, stacked = false, horizontal = false, label, format, axisTitle, tooltipLabel } = {}) {
  return cartesian('bar', canvas, { labels, series, stacked, horizontal, label, format, axisTitle, tooltipLabel }, (color, t, o) => ({
    backgroundColor: color,
    hoverBackgroundColor: color,
    borderColor: t.surface,
    // stacked segments are separated by a hairline of the surface colour instead of an outline
    borderWidth: o.stacked ? (o.horizontal ? { left: 0, right: 2, top: 0, bottom: 0 } : { top: 2, bottom: 0, left: 0, right: 0 }) : 0,
    borderRadius: o.stacked ? 0 : 3,
    borderSkipped: o.stacked ? false : 'start',
    maxBarThickness: 28,
    categoryPercentage: 0.72,
    barPercentage: o.count > 1 && !o.stacked ? 0.9 : 0.82,
  }));
}

/** Doughnut for a small part-to-whole split (tiers, states, categories). `colors` overrides per-slice colour. */
export function doughnutChart(canvas, { labels, data, colors, label } = {}) {
  let current = { labels, data, colors };
  const handle = mount(canvas, () => {
    const paint = (chart) => {
      const t = theme();
      const names = current.labels || [];
      chart.data.labels = names;
      chart.data.datasets = [{
        data: current.data || [],
        backgroundColor: names.map((name, i) => pickColor(current.colors && current.colors[i], name, i)),
        borderColor: t.surface,
        borderWidth: 2,
        hoverOffset: 4,
      }];
      const base = baseOptions(t, { legend: true });
      base.interaction = { mode: 'nearest', intersect: true };
      base.plugins.legend.position = 'right';
      base.plugins.legend.align = 'center';
      base.plugins.tooltip.callbacks.label = (ctx) => {
        const total = ctx.dataset.data.reduce((a, b) => a + (Number(b) || 0), 0);
        return ` ${ctx.label}: ${fmt.num(ctx.parsed)} (${fmt.pct(ctx.parsed, total)})`;
      };
      chart.options = { ...base, cutout: '62%' };
      if (chart.canvas && chart.canvas.clientWidth && chart.canvas.clientWidth < 420) chart.options.plugins.legend.position = 'bottom';
    };
    const shell = { data: { labels: [], datasets: [] }, options: {}, canvas };
    paint(shell);
    return { config: { type: 'doughnut', data: shell.data, options: shell.options }, paint, set: (next) => { current = { ...current, ...next }; } };
  });
  describe(canvas, label, labels, (labels || []).map((l) => ({ label: l })));
  return handle;
}

/** Destroy every chart created through this module (rarely needed; pages normally return a cleanup function). */
export function destroyAll() {
  for (const entry of [...live]) { live.delete(entry); entry.chart.destroy(); }
}
