// Activity: when students contribute. GET /activity (SPEC addendum A3).
// The page answers, in this order: how much, what stands out, the trend (month, week), the calendar (day),
// the weekly rhythm (weekday), the daily rhythm (hour, weekday × hour) and how the campuses compare.

import { api, ApiError } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, statCard, card, table, calendarHeatmap, heatGrid, fmt } from '../lib/ui.js';
import { lineChart, barChart } from '../lib/charts.js';
import {
  getMeta, hasRanges, hasContributions, rangeParams, rangeControl, rangeLine, rangeIsOpen, link, categoryOptions, opts, clean, WEEKDAYS, put,
} from './common.js';

// metric → { noun, verb } (SPEC addendum I adds issues and reviews, counted by the date they were raised / first given)
const METRICS = {
  opened: { noun: 'pull requests', one: 'pull request', word: 'opened' },
  merged: { noun: 'pull requests', one: 'pull request', word: 'merged' },
  issues: { noun: 'issues', one: 'issue', word: 'raised' },
  reviews: { noun: 'reviews', one: 'review', word: 'given' },
};
import { scaleOf, scaleToggle, campusMonthSeries, unknownToggle } from './campus-common.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PARTS = [
  { label: 'Night', hours: '00:00 to 05:59', from: 0, to: 6 },
  { label: 'Morning', hours: '06:00 to 11:59', from: 6, to: 12 },
  { label: 'Afternoon', hours: '12:00 to 17:59', from: 12, to: 18 },
  { label: 'Evening', hours: '18:00 to 23:59', from: 18, to: 24 },
];
const hh = (n) => `${String(((n % 24) + 24) % 24).padStart(2, '0')}:00`;
const day = (iso) => fmt.range(iso, iso).split(' – ')[0];
const dayName = (iso) => DAY_NAMES[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7];
const sum = (list) => list.reduce((a, b) => a + b, 0);

/** Plain-language findings from the response; each is a list of nodes. Nothing is said about too few pull requests. */
function findings({ total, dowVals, hourVals, byMonth, byWeek, totals, metric, word, open, noun = 'pull requests', val = (r) => (r ? r[metric] || 0 : 0) }) {
  const out = [];
  if (total < 20) return out;

  // weekly rhythm
  const top = dowVals.indexOf(Math.max(...dowVals));
  const low = dowVals.indexOf(Math.min(...dowVals));
  const weekend = dowVals[5] + dowVals[6];
  const weekdayAvg = sum(dowVals.slice(0, 5)) / 5;
  const weekendAvg = weekend / 2;
  const ratio = weekdayAvg ? weekendAvg / weekdayAvg : 0;
  const weekendText = ratio >= 0.9 && ratio <= 1.1 ? 'about as busy as a weekday'
    : ratio > 1.1 ? `${Math.round((ratio - 1) * 100)}% busier than a weekday`
      : `${Math.round((1 - ratio) * 100)}% quieter than a weekday`;
  out.push([h('b', null, `${DAY_NAMES[top]} is the busiest day`), ` (${fmt.pct(dowVals[top], total)} of ${noun} ${word}), ${DAY_NAMES[low]} the quietest (${fmt.pct(dowVals[low], total)}). `,
    `A weekend day is ${weekendText}; ${fmt.pct(weekend, total)} of the work lands on Saturday or Sunday.`]);

  // daily rhythm: best 3-hour window (wrapping midnight) + the late-night share
  let best = 0;
  let bestSum = -1;
  for (let i = 0; i < 24; i++) {
    const s3 = hourVals[i] + hourVals[(i + 1) % 24] + hourVals[(i + 2) % 24];
    if (s3 > bestSum) { bestSum = s3; best = i; }
  }
  const late = hourVals[22] + hourVals[23] + hourVals[0] + hourVals[1] + hourVals[2];
  const quietStart = [...Array(24).keys()].reduce((q, i) => {
    const s4 = hourVals[i] + hourVals[(i + 1) % 24] + hourVals[(i + 2) % 24] + hourVals[(i + 3) % 24];
    return s4 < q.s ? { s: s4, i } : q;
  }, { s: Infinity, i: 0 });
  out.push([h('b', null, `The busiest three hours are ${hh(best)} to ${hh(best + 3)}`), ` (${fmt.pct(bestSum, total)}). `,
    `${fmt.pct(late, total)} of ${noun} are ${word} late at night, between 22:00 and 03:00; `,
    `the quietest stretch is ${hh(quietStart.i)} to ${hh(quietStart.i + 4)}.`]);

  // trend: compare the last two complete months
  const complete = open ? byMonth.slice(0, -1) : byMonth;
  if (complete.length >= 2) {
    const a = complete[complete.length - 1];
    const b = complete[complete.length - 2];
    const va = val(a);
    const vb = val(b);
    if (vb > 0) {
      const change = Math.round(((va - vb) / vb) * 100);
      out.push([h('b', null, `${fmt.month(a.month)}: ${fmt.num(va)} ${word}`),
        change === 0 ? `, the same as ${fmt.month(b.month)}. ` : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on ${fmt.month(b.month)} (${fmt.num(vb)}). `,
        a.activeStudents !== undefined ? `${fmt.num(a.activeStudents)} students were active that month${b.activeStudents !== undefined ? `, against ${fmt.num(b.activeStudents)} the month before` : ''}.` : null]);
    }
  }

  // steadiness: how many weeks carry the work, and how concentrated it is among students
  const allWeeks = byWeek.map(val);
  const weeks = allWeeks.slice(Math.max(0, allWeeks.findIndex((v) => v > 0))); // from the first week with any work
  if (weeks.length >= 4 && totals.activeStudents) {
    const mid = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
    const quiet = mid(weeks) === 0; // long, sparse ranges: describe the weeks that had any work
    const median = quiet ? mid(weeks.filter((v) => v > 0)) : mid(weeks);
    out.push([h('b', null, `A typical ${quiet ? 'active ' : ''}week sees ${fmt.num(median)} ${noun} ${word}`),
      `; the busiest saw ${fmt.num(Math.max(...weeks))}. `,
      `${fmt.num(totals.activeStudents)} students were active in the period, ${(total / totals.activeStudents).toFixed(1)} ${noun} ${word} each on average.`]);
  }
  return out;
}

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const contrib = hasContributions(meta);
  const metric = q.metric === 'merged' ? 'merged' : contrib && (q.metric === 'issues' || q.metric === 'reviews') ? q.metric : 'opened';
  const kindMetric = metric === 'issues' || metric === 'reviews';
  const filters = clean({ campus: q.campus, year: q.year, category: q.category, author: q.author, repo: q.repo, owner: q.owner, ...rangeParams(q, meta) });
  let a;
  try {
    // A server without date ranges (no presets in /api/meta) has no /api/activity either: do not ask for it.
    if (!hasRanges(meta)) throw new ApiError(404, 'not_found', 'activity analytics are not available');
    a = await api.get('/activity', { ...filters, metric });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    put(el,
      pageHead({ title: 'When students contribute' }),
      h('div', { class: 'notice notice-warn' }, 'Activity analytics are not available on this server yet. ',
        h('a', { href: link('/', {}, ctx) }, 'Back to the overview')));
    return undefined;
  }
  const charts = [];
  const { word, noun, one } = METRICS[metric];
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const Word = cap(word);
  const Noun = cap(noun);
  // issue / review rows keep the response shape: the count is under the metric's own key, else under `opened`
  const val = (row) => (row ? Number(row[metric] ?? (kindMetric ? row.opened : 0)) || 0 : 0);
  const scope = [q.author && `by ${q.author}`, q.repo && `to ${q.repo}`, q.owner && `to projects of ${q.owner}`].filter(Boolean).join(', ');
  const what = q.category === 'all' ? `${noun} of every category`
    : q.category ? `${noun} in the category “${(categoryOptions().find((o) => o.value === q.category) || {}).label || q.category}”`
      : `open-source ${noun}`;
  const tzNote = a.tz === 'Asia/Kolkata' || !a.tz ? 'India Standard Time' : a.tz;
  const open = rangeIsOpen(a.range);

  put(el,
    pageHead({
      title: 'When students contribute',
      range: rangeLine(a.range),
      lede: [`When ${what} by tracked students are ${kindMetric ? word : 'opened and merged'}: by month, week, day, day of the week and hour. `,
        `All dates and hours are in ${tzNote}.`],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses), allLabel: 'All campuses' },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years), allLabel: 'All years' },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions() },
        {
          name: 'metric', label: contrib ? 'Count' : 'Count pull requests', type: 'select',
          options: contrib
            ? [{ value: '', label: 'Pull requests opened' }, { value: 'merged', label: 'Pull requests merged' }, { value: 'issues', label: 'Issues raised' }, { value: 'reviews', label: 'Reviews given' }]
            : [{ value: '', label: 'When opened' }, { value: 'merged', label: 'When merged' }],
        },
      ],
      values: q,
      onChange: (v) => setQuery(v),
    }),
    scope ? h('div', { class: 'notice' }, `Showing ${noun} ${scope}. `,
      h('button', { type: 'button', class: 'btn btn-link', name: 'scope-clear', onClick: () => setQuery({ author: '', repo: '', owner: '' }) }, 'Show everyone')) : null,
    metric === 'merged' ? h('div', { class: 'notice' },
      'Merge times show when maintainers accepted the work, not when students did it. Choose “When opened” to see when students work.') : null,
  );

  const busy = a.busiest || {};
  const totals = a.totals || {};
  const total = val(totals);
  const byMonth = a.byMonth || [];
  const byWeek = a.byWeek || [];
  const byDate = Array.isArray(a.byDate) ? a.byDate : [];
  const dow = new Map((a.byWeekday || []).map((d) => [d.dow, d]));
  const hours = new Map((a.byHour || []).map((d) => [d.hour, d]));
  const dowVals = WEEKDAYS.map((_, i) => val(dow.get(i + 1)));
  const hourVals = Array.from({ length: 24 }, (_, i) => val(hours.get(i)));

  put(el, h('div', { class: 'cards' },
    statCard({ key: true, label: `${Noun} ${word}`, value: total, sub: kindMetric ? null : metric === 'opened' ? `${fmt.num(totals.merged)} merged in the period` : `${fmt.num(totals.opened)} opened in the period` }),
    statCard({ label: 'Active students', value: totals.activeStudents, sub: kindMetric ? `${word} at least one ${one}` : 'opened or merged at least one' }),
    statCard({ label: 'Busiest day', value: busy.day && busy.day.count ? busy.day.count : null, sub: busy.day && busy.day.count ? `${dayName(busy.day.date)} ${day(busy.day.date)}` : null }),
    statCard({ label: 'Busiest week', value: busy.week && busy.week.count ? busy.week.count : null, sub: busy.week && busy.week.count ? `week of Monday ${day(busy.week.weekStart)}` : null }),
    statCard({ label: 'Busiest month', value: busy.month && busy.month.count ? busy.month.count : null, sub: busy.month && busy.month.count ? fmt.month(busy.month.month) : null })));

  if (!total) {
    put(el, card({}, h('p', { class: 'muted' }, `No ${what} were ${word} in this period with these filters. Try a longer range or another category.`)));
    return undefined;
  }

  // ── what stands out + parts of the day ──
  const found = findings({ total, dowVals, hourVals, byMonth, byWeek, totals, metric, word, open, noun, val });
  const partRows = PARTS.map((p) => ({ ...p, value: sum(hourVals.slice(p.from, p.to)) }));
  const partMax = Math.max(...partRows.map((p) => p.value), 1);
  const partsOfDay = h('div', null,
    h('h3', { class: 'mini-title' }, `Share ${word} by part of the day`),
    h('dl', { class: 'sharebars' }, partRows.map((p) => [
      h('dt', null, p.label, h('small', null, p.hours)),
      h('dd', { class: 'track', 'aria-hidden': 'true' }, h('span', { style: { width: `${(p.value / partMax) * 100}%` } })),
      h('dd', { class: 'val' }, fmt.pct(p.value, total), h('small', null, fmt.num(p.value))),
    ])));
  put(el, card({ title: 'What stands out' },
    h('div', { class: 'split' },
      found.length ? h('ul', { class: 'findings' }, found.map((f) => h('li', null, f)))
        : h('p', { class: 'muted' }, `Too few ${noun} in this period to describe a pattern.`),
      partsOfDay)));

  // ── month and week ──
  const monthCanvas = h('canvas');
  const weekCanvas = h('canvas');
  const incomplete = open ? 'The latest bar is still filling up.' : null;
  put(el, h('div', { class: 'grid grid-2' },
    card({ title: 'By month', note: kindMetric ? Word : 'Opened and merged' }, h('div', { class: 'chart-box' }, monthCanvas),
      incomplete ? h('p', { class: 'card-note' }, incomplete) : null),
    card({ title: 'By week', note: `${Word}, weeks start on Monday` }, h('div', { class: 'chart-box' }, weekCanvas),
      incomplete ? h('p', { class: 'card-note' }, incomplete) : null)));

  // ── day by day ──
  const topDays = [...byDate].sort((x, y) => val(y) - val(x)).slice(0, 5).filter((d) => val(d) > 0);
  const activeDays = byDate.filter((d) => val(d) > 0).length;
  put(el, card({ title: 'Day by day', note: byDate.length ? `${Noun} ${word} on ${fmt.num(activeDays)} of ${fmt.num(byDate.length)} days` : null },
    byDate.length
      ? h('div', { class: 'split' },
        calendarHeatmap(byDate.map((d) => ({ date: d.date, value: val(d) })), { unit: `${noun} ${word}` }),
        h('div', null,
          h('h3', { class: 'mini-title' }, 'Busiest days'),
          table({
            compact: true, sticky: false, caption: 'Busiest days', rows: topDays,
            columns: [
              { key: 'date', label: 'Day', render: (d) => `${dayName(d.date).slice(0, 3)} ${day(d.date)}` },
              { key: metric, label: Word, num: true, render: (d) => fmt.num(val(d)) },
            ],
          })))
      : h('p', { class: 'muted' }, 'This range is too long for a day-by-day calendar. ',
        h('button', { type: 'button', class: 'btn btn-link', name: 'calendar-12m', onClick: () => setQuery({ from: '', to: '', range: '12m' }) }, 'Show the last 12 months'))));

  // ── weekday and hour ──
  const dowCanvas = h('canvas');
  const hourCanvas = h('canvas');
  put(el, h('div', { class: 'grid grid-2' },
    card({ title: 'By day of the week', note: Word }, h('div', { class: 'chart-box chart-box-sm' }, dowCanvas)),
    card({ title: 'By hour of the day', note: `${Word}, hour starting` }, h('div', { class: 'chart-box chart-box-sm' }, hourCanvas))));

  const cells = new Map((a.heatmap || []).map((c) => [`${c.dow}-${c.hour}`, c]));
  put(el, card({ title: 'Day of the week by hour', note: `${Noun} ${word}; each square is one hour of one weekday` },
    heatGrid({
      rows: WEEKDAYS,
      cols: Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? String(i).padStart(2, '0') : '')),
      value: (r, c) => val(cells.get(`${r + 1}-${c}`)),
      unit: `${noun} ${word}`,
      cellTitle: (r, c, v) => `${fmt.num(v)} ${word} on ${DAY_NAMES[r]}s between ${hh(c)} and ${hh(c + 1)}`,
    })));

  // ── campuses ──
  // Campuses differ a lot in size, so the default is a rate on the tracked students of each campus (SPEC addendum D).
  const months = byMonth.map((m) => m.month);
  const scale = scaleOf(q);
  const campusCanvas = h('canvas');
  const cm = campusMonthSeries(a, { scale, metric: kindMetric ? 'opened' : metric, word, noun, unknown: q.unknown === '1' });
  const showCampuses = Boolean(cm) && cm.names.length > 1 && !q.campus;
  if (showCampuses) {
    const campusTotals = new Map();
    for (const r of a.byCampusMonth || []) campusTotals.set(r.campus, (campusTotals.get(r.campus) || 0) + val(r));
    put(el, card({ title: 'Campuses by month', note: scaleToggle(ctx, 'campus', { labels: { share: 'Share of students active' } }) },
      h('p', { class: 'chart-unit' }, cm.unit),
      h('div', { class: 'chart-box' }, campusCanvas),
      h('p', { class: 'card-note' },
        cm.mode === 'raw'
          ? ['Raw counts are not adjusted for the size of a campus. In the period: ',
            cm.names.map((c) => `${c.campus} ${fmt.num(campusTotals.get(c.campus) || 0)}`).join(' · '), '. ']
          : cm.mode === 'share'
            ? (kindMetric ? `A student is active in a month when they ${word} ${metric === 'issues' ? 'an issue' : 'a review'} of the selected category in it. ` : 'A student is active in a month when they opened or merged a pull request of the selected category in it. ')
            : 'Counts divided by the tracked students of each campus, times 100. ',
        cm.mode === 'raw' ? null : 'The number after a campus is its tracked students',
        cm.mode !== 'raw' && (q.year || q.batch) ? ' under the filters above' : null,
        cm.mode === 'raw' ? null : '. ',
        cm.names.some((c) => c.smallCohort) ? 'Dashed lines are small cohorts, whose rates swing widely. ' : null,
        h('a', { href: link('/campuses', {}, ctx) }, 'Compare the campuses')),
      unknownToggle(ctx, a.cohorts)));
  }

  charts.push(barChart(monthCanvas, {
    labels: months,
    series: kindMetric ? [{ label: Word, data: byMonth.map(val), color: 1 }] : [
      { label: 'Opened', data: byMonth.map((m) => m.opened), color: 1 },
      { label: 'Merged', data: byMonth.map((m) => m.merged), color: 'merged' },
    ],
    label: kindMetric ? `${Noun} ${word} per month` : 'Pull requests opened and merged per month',
  }));
  charts.push(barChart(weekCanvas, {
    labels: byWeek.map((w) => (byWeek.length > 60 ? day(w.weekStart).replace(/^\d+ /, '') : day(w.weekStart).replace(/ \d{4}$/, ''))),
    series: [{ label: Word, data: byWeek.map(val), color: metric === 'merged' ? 'merged' : 1 }],
    label: `${Noun} ${word} per week`,
  }));
  charts.push(barChart(dowCanvas, {
    labels: WEEKDAYS, series: [{ label: Word, data: dowVals, color: metric === 'merged' ? 'merged' : 1 }],
    label: `${Noun} ${word} by day of the week`,
  }));
  charts.push(barChart(hourCanvas, {
    labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    series: [{ label: Word, data: hourVals, color: metric === 'merged' ? 'merged' : 1 }],
    label: `${Noun} ${word} by hour of the day`,
  }));
  if (showCampuses) charts.push(months.length <= 6 ? barChart(campusCanvas, cm.input) : lineChart(campusCanvas, cm.input));
  return () => charts.forEach((c) => c.destroy());
}
