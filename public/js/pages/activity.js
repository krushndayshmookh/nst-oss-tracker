// Activity: when students contribute. GET /activity (SPEC addendum A3).

import { api, ApiError } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, statCard, card, calendarHeatmap, heatGrid, fmt } from '../lib/ui.js';
import { lineChart, barChart } from '../lib/charts.js';
import { getMeta, rangeParams, rangeControl, rangeSentence, link, categoryOptions, opts, clean, WEEKDAYS } from './common.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const metric = q.metric === 'merged' ? 'merged' : 'opened';
  const filters = clean({ campus: q.campus, year: q.year, category: q.category, author: q.author, repo: q.repo, owner: q.owner, ...rangeParams(q, meta) });
  let a;
  try {
    a = await api.get('/activity', { ...filters, metric });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    el.append(
      pageHead({ title: 'When students contribute' }),
      h('div', { class: 'notice notice-warn' }, 'Activity analytics are not available on this server yet. ',
        h('a', { href: link('/', {}, ctx) }, 'Back to the overview')));
    return undefined;
  }
  const charts = [];
  const word = metric === 'merged' ? 'merged' : 'opened';
  const val = (row) => (row ? row[metric] || 0 : 0);
  const scope = [q.author && `by ${q.author}`, q.repo && `to ${q.repo}`, q.owner && `to projects of ${q.owner}`].filter(Boolean).join(', ');

  el.append(
    pageHead({
      title: 'When students contribute',
      lede: [rangeSentence(a.range), ' ', a.tz === 'Asia/Kolkata' || !a.tz ? 'Times are India Standard Time.' : `Times are in ${a.tz}.`],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses) },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years) },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions() },
        { name: 'metric', label: 'Count', type: 'select', options: [{ value: '', label: 'Opened' }, { value: 'merged', label: 'Merged' }] },
      ],
      values: q,
      onChange: (v) => setQuery(v),
    }),
    scope ? h('div', { class: 'notice' }, `Showing pull requests ${scope}. `,
      h('button', { type: 'button', class: 'btn btn-link', onClick: () => setQuery({ author: '', repo: '', owner: '' }) }, 'Show everyone')) : null,
  );

  const busy = a.busiest || {};
  const totals = a.totals || {};
  el.append(h('div', { class: 'cards' },
    statCard({ key: true, label: `Pull requests ${word}`, value: totals[metric], sub: metric === 'opened' ? `${fmt.num(totals.merged)} merged` : `${fmt.num(totals.opened)} opened` }),
    statCard({ label: 'Active students', value: totals.activeStudents }),
    statCard({ label: 'Busiest day', value: busy.day ? busy.day.count : null, sub: busy.day ? fmt.range(busy.day.date, busy.day.date).split(' – ')[0] : null }),
    statCard({ label: 'Busiest week', value: busy.week ? busy.week.count : null, sub: busy.week ? `week of ${fmt.range(busy.week.weekStart, busy.week.weekStart).split(' – ')[0]}` : null }),
    statCard({ label: 'Busiest month', value: busy.month ? busy.month.count : null, sub: busy.month ? fmt.month(busy.month.month) : null })));

  const byMonth = a.byMonth || [];
  const monthCanvas = h('canvas');
  el.append(card({ title: 'Pull requests by month' }, h('div', { class: 'chart-box' }, monthCanvas)));

  el.append(card({ title: 'Day by day', note: `Pull requests ${word}` },
    Array.isArray(a.byDate) && a.byDate.length
      ? calendarHeatmap(a.byDate.map((d) => ({ date: d.date, value: val(d) })), { unit: `pull requests ${word}` })
      : h('p', { class: 'muted' }, a.truncated ? 'The range is too long for a day-by-day view. Choose a shorter range.' : 'No days in this range.')));

  const dow = new Map((a.byWeekday || []).map((d) => [d.dow, d]));
  const hours = new Map((a.byHour || []).map((d) => [d.hour, d]));
  const dowCanvas = h('canvas');
  const hourCanvas = h('canvas');
  el.append(h('div', { class: 'grid grid-2' },
    card({ title: 'By day of week' }, h('div', { class: 'chart-box chart-box-sm' }, dowCanvas)),
    card({ title: 'By hour of day' }, h('div', { class: 'chart-box chart-box-sm' }, hourCanvas))));

  const cells = new Map((a.heatmap || []).map((c) => [`${c.dow}-${c.hour}`, c]));
  el.append(card({ title: 'Day of week by hour', note: `Pull requests ${word}` },
    heatGrid({
      rows: WEEKDAYS,
      cols: Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? String(i).padStart(2, '0') : '')),
      value: (r, c) => val(cells.get(`${r + 1}-${c}`)),
      unit: `pull requests ${word}`,
      cellTitle: (r, c, v) => `${fmt.num(v)} ${word}, ${DAY_NAMES[r]} ${String(c).padStart(2, '0')}:00 to ${String(c).padStart(2, '0')}:59`,
    })));

  const campusRows = a.byCampusMonth || [];
  const campusNames = [...new Set(campusRows.map((r) => r.campus))].filter((c) => c !== 'Unknown').sort().slice(0, 5);
  const months = byMonth.map((m) => m.month);
  const campusCanvas = h('canvas');
  if (campusNames.length > 1 && months.length) {
    el.append(card({ title: 'Campuses by month', note: `Pull requests ${word}` }, h('div', { class: 'chart-box' }, campusCanvas)));
  }

  charts.push(barChart(monthCanvas, {
    labels: months,
    series: [
      { label: 'Opened', data: byMonth.map((m) => m.opened), color: 1 },
      { label: 'Merged', data: byMonth.map((m) => m.merged), color: 'merged' },
    ],
    label: 'Pull requests opened and merged per month',
  }));
  charts.push(barChart(dowCanvas, {
    labels: WEEKDAYS, series: [{ label: metric === 'merged' ? 'Merged' : 'Opened', data: WEEKDAYS.map((_, i) => val(dow.get(i + 1))), color: 1 }],
    label: `Pull requests ${word} by day of the week`,
  }));
  charts.push(barChart(hourCanvas, {
    labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    series: [{ label: metric === 'merged' ? 'Merged' : 'Opened', data: Array.from({ length: 24 }, (_, i) => val(hours.get(i))), color: 1 }],
    label: `Pull requests ${word} by hour of the day`,
  }));
  if (campusNames.length > 1 && months.length) {
    const at = new Map(campusRows.map((r) => [`${r.campus}|${r.month}`, r]));
    charts.push(lineChart(campusCanvas, {
      labels: months,
      series: campusNames.map((c, i) => ({ label: c, color: i + 1, data: months.map((m) => val(at.get(`${c}|${m}`))) })),
      label: `Pull requests ${word} per month by campus`,
    }));
  }
  return () => charts.forEach((c) => c.destroy());
}
