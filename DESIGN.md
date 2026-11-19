# NST Open Source — design

Design system and page designs for https://oss.nstsdc.org. Read with `SPEC.md`: section 7.1 (frontend contracts)
and Appendix A (API shapes) are binding and this file never contradicts them. Everything named here exists in
`public/css/app.css` and `public/js/lib/`.

Contents: 1 audience · 2 principles · 3 information architecture · 4 how pages plug in · 5 tokens ·
6 data colour · 7 components (CSS classes) · 8 JS helpers (signatures) · 9 public pages · 10 admin pages ·
11 states · 12 mobile · 13 copy · 14 accessibility · 15 addendum support (date range, activity, schedule)

## 1. Audience and the job of the site

| Reader | Comes to | Needs |
|---|---|---|
| NST leadership | see whether students are landing real open-source work, by campus and year | headline counts they can quote, the trend, a CSV |
| Faculty and mentors | find who is contributing and where; spot students to encourage | sortable student table, per-student history, filters by campus / year |
| Students | see their own record, find projects peers got merged into | a profile page that is fair (every PR, every category), project and org lists |
| Public, recruiters, maintainers | check that the claim "NST students contribute to open source" holds up | links out to every PR on GitHub, the classification rules in plain words |
| Admins (behind the password) | keep the data honest: add students, mark repos / orgs / PRs, tune rules, run jobs | fast triage tables with one-click decisions and visible consequences |

The one number the site stands behind is **merged open-source pull requests**, and its companion
**students with at least one merged open-source PR**. Every page leads with those; everything else is context.

## 2. Principles

1. **A register, not a marketing page.** Dense tables, real numbers, links to the source. No hero art, no
   gradients, no shadows on content, no animation on load.
2. **Blackboard green and marigold.** A deep green masthead (`--mast-bg`) and one marigold accent (`--accent`),
   used only to mark *the current thing*: the current nav item, the active sort column, the active tab, the
   headline figure. Marigold never decorates.
3. **Figures in a ruled band.** Headline numbers sit in one bordered band divided by hairlines (`.cards`), like a
   row in a ledger, not as separate floating tiles. The first figure is the headline (`key: true`).
4. **One colour per thing, everywhere.** A category has the same colour in its badge swatch, the category-mix bar,
   and every chart. Same for tiers and PR states (section 6). Colour is never the only signal: categories carry a
   label, states a distinct glyph, tiers a pip count.
5. **Serif for names and numbers that matter, sans for data.** Page titles, card titles and stat values use
   `--font-display` (Charter / Cambria / Noto Serif, whichever the device has). All tables, forms and body copy use
   the system UI font with tabular numerals. No webfonts.
6. **Every view is a link.** Filters, sort and page live in the hash query; changing one re-renders in place
   without losing scroll position or the caret in the search box.

## 3. Information architecture

Public (`/`, `index.html`), nav order left to right:

```
Overview  #/                     headline band, funnel, trend, campus × year, tops
Students  #/students             ranked table  →  #/students/:username   profile
Projects  #/projects             repo table    →  #/projects/:owner/:name
Organisations  #/orgs            org table     →  #/orgs/:login
Pull requests  #/prs             PR explorer (every filter)
About     #/about                how classification works, live rules, data caveats
footer: How contributions are classified · Download CSV · Admin (→ /admin)
```

Admin (`/admin`, `admin.html`), nav shown after sign-in:

```
Students #/students (also #/)   Review #/review   Pull requests #/prs   Overrides #/overrides   Rules #/rules   Jobs #/jobs   [Sign out]
```

Cross-linking rule: a student name links to the profile here, with the GitHub handle as a secondary external
link; a repo name links to its page here, with an external GitHub link beside it; a PR title always links to GitHub
(there is no PR page). External links use `extLink()` / `ghLink()`, which add the `↗` marker and open a new tab.

## 4. How pages plug in

The shells are finished; page agents add **one module per page and one line per route**.

`public/index.html` loads, in order: `/vendor/chart.umd.js` (global `Chart`), `/js/lib/shell.js` (footer "Data
updated …"), then `/js/app.js`. `public/admin.html` loads `/js/lib/shell.js` (wires **Sign out**) and
`/js/admin/main.js`. Per SPEC 7.1 the two entry files belong to the public-ui and admin-ui agents. They look like this:

```js
// public/js/app.js
import { startRouter } from './lib/router.js';

startRouter([
  { path: '/',                       page: () => import('./pages/overview.js') },
  { path: '/students',               page: () => import('./pages/students.js') },
  { path: '/students/:username',     page: () => import('./pages/student.js') },
  { path: '/projects',               page: () => import('./pages/projects.js') },
  { path: '/projects/:owner/:name',  page: () => import('./pages/repo.js') },
  { path: '/orgs',                   page: () => import('./pages/orgs.js') },
  { path: '/orgs/:login',            page: () => import('./pages/org.js') },
  { path: '/prs',                    page: () => import('./pages/prs.js') },
  { path: '/about',                  page: () => import('./pages/about.js') },
], document.getElementById('app'));
```

```js
// public/js/pages/students.js — the shape of every page module
import { api } from '../lib/api.js';
import { setQuery, href } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination } from '../lib/ui.js';

export default async function (el, ctx) {           // el: an empty <div class="page">; ctx: { params, query, path }
  const data = await api.get('/students', ctx.query);  // throw → the router shows errorBox with "Try again"
  el.append(
    pageHead({ title: 'Students', lede: '…' }),
    filterBar({ fields: [...], values: ctx.query, onChange: (v) => setQuery({ ...v, page: '' }) }),
    table({ columns: [...], rows: data.items, sort: ctx.query.sort || 'osMerged', order: ctx.query.order || 'desc',
            onSort: (sort, order) => setQuery({ sort, order, page: '' }) }),
    pagination({ ...data, onPage: (page) => setQuery({ page }) }),
  );
  // return () => chart.destroy();                   // optional cleanup, run before the next page renders
}
```

Admin entry: same, plus the sign-in gate through `onNavigate`:

```js
// public/js/admin/main.js
const router = startRouter(routes, app, {
  onNavigate: async () => {
    const me = await api.get('/admin/me');
    document.getElementById('admin-nav').hidden = !me.admin;
    if (!me.admin) { renderLogin(app, me, () => router.refresh()); return false; }   // false: router leaves #app to you
  },
});
```

What the router does for you: appends `ui.loading()` under the page while it resolves; shows `ui.errorBox(err)` if
the page throws; sets `aria-current="page"` on the matching `a[data-nav]` (prefix match, so `/students/x` lights
"Students"); sets `document.title` from the page's `<h1>`; scrolls to top on a path change; on a **query-only**
change keeps the old view on screen (dimmed, `aria-busy`) until the new one is ready, keeps scroll position, and
puts focus back in the control with the same `name` (so search-as-you-type works). A page that resolves after the
user has moved on is discarded.

## 5. Tokens (`:root` in `app.css`)

Dark values apply under `@media (prefers-color-scheme: dark)`. There is no manual theme toggle.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f3f6f4` | `#0f1614` | page |
| `--surface` | `#ffffff` | `#17201e` | cards, tables, inputs |
| `--surface-2` | `#eaf0ed` | `#1e2a27` | table head, sunken areas, hover |
| `--surface-3` | `#dfe7e3` | `#283632` | pressed, skeleton |
| `--ink` | `#15211e` | `#e4ebe7` | text |
| `--ink-2` | `#44524e` | `#b3bfba` | secondary text, labels |
| `--ink-3` | `#5d6a65` | `#8c9a94` | muted text (`.muted`) |
| `--rule` / `--rule-strong` | `#d3dbd7` / `#a9b5af` | `#2b3935` / `#44554f` | hairlines / control borders |
| `--brand` | `#0b5d4d` | `#5fcab0` | primary buttons, bars |
| `--brand-soft` | `#e1f0eb` | `#173730` | active filter, selected toggle |
| `--on-brand` | `#ffffff` | `#06241d` | text on `--brand` |
| `--accent` / `--accent-soft` | `#c47f00` / `#fbf0d6` | `#e0a528` / `#3a2f12` | "current" marker only |
| `--link` | `#0b5d4d` | `#74d4bc` | links |
| `--focus` | `#2f6fd0` | `#7fb0f5` | focus ring |
| `--mast-bg` / `--mast-ink` / `--mast-mark` | `#0b5d4d` / `#fff` / `#f2b632` | `#12201c` / `#e4ebe7` / `#e0a528` | masthead |
| `--ok` `--warn` `--danger` `--info` (+ `-soft`) | green / amber / red / blue | lighter steps | status text and chips |

Type: `--font-body` (system UI), `--font-display` (Charter, Bitstream Charter, Sitka Text, Cambria, Noto Serif,
Georgia), `--font-mono` (job logs and the textarea only).

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 12px | chart ticks, fine print |
| `--fs-sm` | 13px | labels, table headers, badges, sub-lines |
| `--fs-data` | 14px | tables, inputs, buttons |
| `--fs-body` | 15px / 1.5 | body |
| `--fs-md` | 17px | card titles (`h2` in `.card`) |
| `--fs-lg` | 20px | section `h2` |
| `--fs-2xl` | 30px (26 mobile) | `h1`, stat values |
| `--fs-3xl` | 38px (32 mobile) | the headline stat value |

Space: `--s-1`…`--s-7` = 4, 8, 12, 16, 24, 32, 48px. Radius: `--radius` 6px (panels, controls),
`--radius-sm` 3px (chips, small buttons). Page: `--page-max` 1240px, `--gutter` 24px (16 on phones).

## 6. Data colour

All values were checked with a palette validator (lightness band, chroma, colour-blind separation of neighbours,
3:1 against the surface) in both modes. Do not hand-pick other chart colours.

| Thing | Token | Light | Dark |
|---|---|---|---|
| Open source | `--cat-open_source` | `#0a8f72` | `#22a587` |
| Practice repo | `--cat-practice` | `#c47f00` | `#bf8210` |
| NST internal | `--cat-nst_internal` | `#2f6fd0` | `#4b8be6` |
| Peer repo | `--cat-peer_repo` | `#d4588f` | `#d9659b` |
| Own repo | `--cat-own_repo` | `#6a55c9` | `#8f7fe6` |
| Low signal | `--cat-low_signal` | `#9aa39f` | `#5f6a66` (neutral on purpose: it is the "does not count" bucket) |
| Tier major / established / emerging | `--tier-*` | `#0b5d4d` / `#2f9c84` / `#6fbfaa` | `#a5e0d0` / `#3fae95` / `#1f7a67` (one hue, ordered) |
| State open / merged / closed | `--state-*` | `#0a8f72` / `#6a55c9` / `#b4483c` | `#22a587` / `#8f7fe6` / `#d9584f` |
| Unnamed series 1–5, other | `--chart-1`…`--chart-5`, `--chart-other` | same hues as the five categories, grey | |

Always list categories in this fixed order: open source, practice, NST internal, peer repo, own repo, low signal
(`CATEGORIES` in `ui.js`). Open/closed red–green is a known weak pair for colour-blind readers, which is why
`stateBadge` draws a different glyph per state and charts of state must keep their legend.

`charts.js` assigns colour by **name**: a series or slice labelled with a category key or label (`open_source`,
"Open source"), a tier ("Major"), or a state ("Merged") gets that entity's colour automatically. Anything else gets
`--chart-1`… in order. Override with `color:` on a series (`'open_source'`, `2`, `'--state-merged'`, or a CSS colour).

## 7. Components — CSS classes

Classes the helpers emit are listed with the helper in section 8. These are the ones you write by hand.

Layout
- `.page-head` — title block with bottom rule; first child holds `h1` + `p.lede`, optional `.toolbar` on the right. Use `pageHead()`.
- `.crumbs` — breadcrumb line above the `h1` (in `pageHead({ crumbs })`).
- `.grid` — auto-fit columns, min 340px, 16px gap. Modifiers: `.grid-2`, `.grid-3` (fixed columns, one column below 900px), `.grid-main` (2fr + 1fr). `.span-all` on a child spans the row.
- `.stack` — vertical rhythm (16px) between children. Children of the page root already get 24px.
- `.card` — bordered panel, 16px padding; `h2` inside is 17px. `.card-head` = title left, `.muted` note right. `.card-note` = fine print under content. `.card-flush` = no padding, for a table (and its pagination) that should touch the edges. Use `card()`.
- `.cards` — the ruled figure band; children are `statCard()`s.
- `.section-head` — an `h2` with something on the right, outside a card.
- `.toolbar` — wrapping row of buttons / controls, bottom-aligned; `.spacer` pushes what follows to the right.
- `.tabs` + `.tab` — underline tabs; active = `aria-selected="true"`, `aria-current="page"` or `.is-active`; `.count` inside for a number. Use `tabs()`.
- `.facts` — `<dl>` in two columns for profile facts (campus, batch, first PR…).
- `.prose` — 72ch text column for About. `.rule-steps` — numbered rule list (`<ol>`; the classification order *is* a sequence).

Text
- `.muted`, `.num` (tabular, right-aligned, nowrap), `.nowrap`, `.sr-only`, `.ext` (adds `↗`), `.sub` (second line inside a table cell), `.cell-clip` (ellipsis at 30ch).

Buttons and forms
- `.btn`, `.btn-primary` (one per view: the main action), `.btn-danger` (outline red; add `.btn-primary` for a filled destructive confirm), `.btn-sm`, `.btn-link`, `.btn-group` (tight row), `.btn.is-on` (the currently applied choice in a toggle group, e.g. the active override).
- `.form` (single column, max 560px), `.form-grid` (auto-fit columns), `.form-row` (label above control; put `.hint` or `.field-error` after the control), `.form-row-inline` (checkbox + label on a line), `.form-actions`.
- Inputs, selects and textareas are styled by element; no class needed. Set `aria-invalid="true"` for the error border.
- `.chips` + `.chip` — removable values (rules lists): `<li class="chip">text<button aria-label="Remove text">×</button></li>`.

Data
- `table.data` inside `.table-wrap` (from `table()`). Row classes via `rowClass`: `total` (grand total), `subtotal`, `group` (heavier top rule at the start of a group). `.table-compact` on the wrapper tightens rows.
- `.badge` family (from the helpers); `.swatch` (10px colour square); `.legend` (inline key list).
- `.mix` (category-mix bar), `.barcell` (number + bar), `.funnel` — from `categoryBar()`, `barCell()`, `funnel()`.
- `.chart-box` — positioned box that sizes a chart canvas: 280px high; `.chart-box-sm` 200px, `.chart-box-lg` 360px. Always wrap the canvas: `h('div', { class: 'chart-box' }, canvas)`.
- `.progress` — `<div class="progress"><span style="width:40%"></span></div>` for job progress.
- `.log` — monospace scroll box for job logs (`<pre class="log">`).

Feedback
- `.loading`, `.empty` (+ `.empty-box`), `.error-box`, `.not-found` — from the helpers.
- `.notice`, `.notice-warn`, `.notice-ok` — inline message bar (e.g. "Admin password is not configured").
- `.login` — centred 380px column for the sign-in card.
- `dialog.dialog`, `.toasts` / `.toast` — from `modal()` / `toast()`.

## 8. JS helpers — exact signatures

### `lib/api.js`
```js
import { api, ApiError } from './lib/api.js';
api.get(path, params?)      // GET /api{path}?…  → parsed JSON
api.post(path, body?)       // POST JSON
api.put(path, body?)  api.patch(path, body?)  api.del(path, params?)
api.url(path, params?)      // '/api/export/prs.csv?campus=RU' for <a href> downloads
```
`path` is relative to `/api`. Params that are `''`, `null` or `undefined` are dropped; booleans become `1`/`0`.
Non-GET requests send JSON with `X-Requested-With: oss-admin`; all requests use `credentials: 'same-origin'`.
Non-2xx throws `ApiError` with `.status`, `.code` (the API's `error.code`), `.message`. A failed connection throws
`ApiError(0, 'network', …)`. An optional last argument `{ signal }` aborts.

### `lib/router.js`
```js
startRouter(routes, el, { onNavigate? })  // → { refresh }
navigate(path, query?, { replace? })
setQuery(patch, { replace? })             // merge into the current hash query; '' / null removes a key; re-renders
href(path, query?)                        // → '#/students?campus=RU'
refresh()                                 // re-run the current route in place (after a mutation)
currentRoute()                            // → { path, query }
```
`routes = [{ path: '/students/:username', page }]` where `page` is the page function or `() => import('…')`.
`ctx = { params, query, path }`; params are URI-decoded; query values are strings. Unknown hash → built-in
not-found view. `onNavigate(ctx)` runs first; return `false` to keep the router from rendering.

### `lib/ui.js`
```js
h(tag, attrs?, ...children) → Element     // alias: el
```
`attrs`: `class` (string or array, falsy entries dropped), `dataset`, `style` (object; `--custom` props work),
`onClick` / `onInput` / … handlers, booleans, anything else as an attribute; `null` / `false` attributes are skipped.
Children: nodes, strings, numbers, arrays; `null` / `false` skipped. Strings always become text nodes.

```js
table({ columns, rows, sort?, order?, onSort?, empty?, caption?, rowClass?, sticky? = true, compact? }) → .table-wrap
  // columns: [{ key, label, num?, sortable?, render?(row, i) → Node|string, wrap?, title?, width?, class?, sortKey? }]
  // alias: dataTable
pagination({ page, limit, total, onPage(page) }) → nav.pagination
filterBar({ fields, values, onChange(values), clear? = true }) → form.filters
  // fields: [{ name, label, type: 'select'|'search'|'date'|'checkbox', options?: [string | {value,label}], placeholder?, allLabel? }]
statCard({ label, value, sub?, key?, href?, title? }) → .stat
badge(text, kind? = 'neutral')            // 'neutral' | 'ok' | 'warn' | 'danger' | 'info'
stateBadge(state, label?)                 // PR: open|merged|closed|draft · job: queued|running|done|error|cancelled · backfill: pending|…
categoryBadge(category, tier?)            // swatch + label; with tier adds pips + tier name
tierBadge(tier, { label? = true })
overrideBadge(override, note?)            // dashed chip: "Marked not open source", "Excluded", …
loading(text?)  errorBox(err, { retry? })  empty(text, action?)
toast(message, kind? = 'ok')              // 'ok' | 'error'
confirmDialog(message, { confirmLabel?, cancelLabel?, danger?, title?, input?: { label, value?, placeholder?, required? } })
  // → Promise<false | true | string>   (string when `input` is given; false on cancel / Esc)
modal({ title, body, actions?: [{ label, kind?: 'primary'|'danger', onClick?(close) }], wide?, onClose? }) → { close(), el }
fmt.num(n)  fmt.compact(n)  fmt.pct(a, b)  fmt.date(iso)  fmt.datetime(iso)  fmt.month('YYYY-MM')  fmt.rel(iso)  fmt.range(from, to)
CATEGORIES  CATEGORY_LABELS  CATEGORY_HELP  TIERS  TIER_LABELS  STATE_LABELS
ghUrl(pathOrLogin) → 'https://github.com/…'    ghLink(pathOrLogin, text?)    extLink(text, url)
// layout conveniences
pageHead({ title, lede?, crumbs?: [{ label, href? }], actions?: Node[] }) → header.page-head
card({ title?, note?, flush?, class? }, ...children) → section.card
tabs([{ label, href? | value?, count?, active? }], { onSelect?(value) }) → .tabs
// small visualisations
funnel([{ label, value }, …]) → ol.funnel          // bars scaled to the first step, share of the first step beside each
categoryBar(byCategory, { legend?, large? })       // 100% bar of the six categories; legend adds labelled counts
barCell(value, max) → number + in-cell bar
// date range + heatmaps (section 15)
rangeBar({ presets, query, onChange(patch), defaultKey? = 'ay' }) → .rangebar
calendarHeatmap([{ date: 'YYYY-MM-DD', value }], { unit?, label? }) → .calendar
heatGrid({ rows, cols, value(r, c), unit?, label?, cellTitle?(r, c, v) }) → .heatgrid
```
Notes that save time:
- `table`: without `render`, a cell shows `row[key]` (dot paths work: `'stats.osMerged'`); `num` cells are formatted
  with `fmt.num` and right-aligned; empty values show `—`. Cells are one line and clip at 44ch; give long-text
  columns `wrap: true`. `sortable` + `onSort` makes the header a button: a new column starts `desc` when `num`,
  else `asc`; the active column flips. If the API sort name differs from `key`, set `sortKey`
  (`{ key: 'stats.osMerged', sortKey: 'osMerged', … }`) and pass `sort: ctx.query.sort`.
- `filterBar.onChange` receives **all** fields (cleared ones as `''`), so `setQuery({ ...values, page: '' })` is the
  whole handler. Search is debounced 300 ms and fires at once on Enter. Selects get an "All" option automatically.
- `fmt.num` uses Indian digit grouping (`1,20,000`), matching how the audience reads large numbers; `fmt.compact`
  gives `38K` for star counts. `fmt.pct(a, b)` returns `—` when `b` is 0.
- Student name fallback (336 students have no name): `student.name || student.username`.

### `lib/charts.js`
```js
lineChart(canvas, { labels, series: [{ label, data, color? }], label? })
barChart(canvas, { labels, series, stacked?, horizontal?, label? })
doughnutChart(canvas, { labels, data, colors?, label? })
// each → { destroy(), update(nextData), chart }
chartColor(spec)   // resolve a token to the current CSS colour
```
`label` is the accessible description of the chart. `'YYYY-MM'` labels are shown as `Oct 2026`. Charts re-read
their colours when the OS colour scheme changes. A legend appears only when there is more than one series. If the
`Chart` global is missing the canvas is replaced by a one-line note and the page keeps working. Return a cleanup
that calls `destroy()` on every chart the page made.

## 9. Public pages

Every page starts with `pageHead()`. Charts sit beside or above the table that holds the same figures, so no
chart is the only way to read a number.

### Overview `#/` — `GET /overview?campus&year`, `GET /campuses`, `GET /meta`
```
page-head   Open-source work by NST students            [Download CSV]
            one sentence: N students tracked across K campuses; headline counts merged PRs to established projects
filters     Campus ▾   Year ▾                                         (from meta.campuses / meta.years)
.cards      [key] Merged open-source PRs | Students with a merged PR | In major projects | Projects | Students tracked
.grid-main  ┌ Open-source pull requests by month (line, 24 mo) ┐ ┌ From tracked to merged (funnel) ┐
.grid       ┌ Merged by project tier (doughnut) ┐ ┌ All PRs by category (categoryBar + legend) ┐ ┌ PR outcome (doughnut: merged/open/closed) ┐
card-flush  Campus × year table
.grid-3     Top projects | Top organisations | Top students   (10 rows each, compact tables, "See all" link in card-head)
```
- Stat cards: `prs.osMerged` (`key: true`, sub "of {prs.osPrs} opened"); `students.withOsMerged` (sub
  "{pct of tracked} of tracked"); `students.withMajorMerged` (label "Students merged into a major project", sub
  "{rules.tiers.major}+ stars"); `prs.osMergedByTier.major` may replace "Projects" if no repo count is to hand;
  `students.tracked`.
- **Monthly line** — series "Opened" (`osOpened`, colour `1`) and "Merged" (`osMerged`, colour `'merged'`). Shows
  whether activity is growing and how much of it lands. Do not plot `allOpened` on the same axis (it is roughly 10×
  larger and would flatten the open-source lines); mention the all-PR total in the card note instead.
- **Funnel** — tracked → with any PR → with an open-source PR → with a merged open-source PR → merged into a major
  project (`overview.students`). This is the honest shape of the data: most tracked students have not yet landed
  open-source work, and the funnel says so without commentary.
- **Tier doughnut** — `osMergedByTier`, labels from `TIER_LABELS` (auto-coloured). Shows where merged work lands.
- **Category bar** — `prs.byCategory` with `legend: true, large: true`. Explains why "all PRs" is so much larger
  than the headline. Link "How categories work" → `#/about`.
- **Campus × year table** (`/campuses`): columns Campus · Year · Students (num) · With any PR (num) · With
  open-source PR (num) · With merged (num) · Merged into major (num) · Merged open-source PRs (num) · Open-source PRs (num) ·
  All PRs (num) · Mix (`categoryBar(row.byCategory)`). Rows grouped by campus (`rowClass` → `group` on the first row
  of each campus), then that campus's `totals` row as `subtotal`, and `total` last as `total`. Not sortable (the grouping is the order).
  The table is not affected by the filter bar; say so in the card note when a filter is active.
- Top tables: project (link + `tierBadge(tier, { label: false })`), merged (num, `barCell` scaled to the first row), students (num).
  Orgs: login, merged (`barCell`), students. Students: name (+ `.sub` campus · year as plain text), merged (`barCell`).

### Students `#/students` — `GET /students`
Filters: Search (`q`, "Name or GitHub username") · Campus · Year · Batch · checkbox "With open-source PRs" (`hasOs`).
Toolbar in the page head: `Download CSV` → `api.url('/export/students.csv')`.
Columns: Student (name → profile; `.sub` = `ghLink(username)`) [sort `name`] · Campus · Year · Merged open-source (num,
`barCell`, sort `osMerged`, default desc) · Open-source PRs (num, sort `osPrs`) · Major merged (num) · Projects
(`stats.osRepos`, num) · All PRs (num, sort `totalPrs`) · Mix (`categoryBar(stats.byCategory)`) · Last PR
(`fmt.rel`, title = `fmt.date`, sort `lastPrAt`). 25 per page.

### Student profile `#/students/:username` — `GET /students/:username`, more PRs via `GET /prs?author=…&category=all`
```
page-head   crumbs: Students /        {name || username}                 [GitHub profile ↗]
            lede: campus, year, batch as a sentence ("RU, 2nd year, batch 2025")
.cards      [key] Merged open-source PRs | Open-source PRs (sub "N open") | Merged into major projects | Projects (sub "in N orgs") | All PRs
.grid-main  ┌ Pull requests by month (bar: Opened / Merged, open source) ┐ ┌ What the PRs are (categoryBar legend large + .facts: first PR, last PR, last merged) ┐
card-flush  Projects contributed to — table: Project · Category (categoryBadge + tier) · Stars · PRs · Merged · Last PR
card-flush  Pull requests — tabs: Open source | All (count) ; table + pagination
```
PR table columns (shared with the PR explorer, minus Student): Pull request (title → GitHub, `wrap: true`, `.sub` =
`repo#number`) · Project (→ repo page) · State (`stateBadge`; draft PRs show `stateBadge('draft')`) · Category
(`categoryBadge(category, tier)`; `overrideBadge` if `override`) · Opened (`fmt.date`) · Merged (`fmt.date`) ·
Changes (`+additions −deletions`, num). The category tab lives in the hash query (`?cat=all`); page 2 onward comes
from `/api/prs`.

### Projects `#/projects` — `GET /repos`
Filters: Search · Category (default Open source; option "All categories" = `all`) · Tier. Columns: Project (→ repo
page; `.sub` description clipped) · Tier (`tierBadge`) · Stars (num, `fmt.compact`, sort `stars`) · Language ·
Students (num, sort `students`) · PRs (num, sort `prs`, default) · Merged (num, sort `merged`, `barCell`) · Campuses
(joined text) · Last PR. When the category filter is not open source, show a Category column instead of Tier.

### Repo page `#/projects/:owner/:name` — `GET /repos/:owner/:name`
Head: crumbs Projects / · title `owner/name` · action `View on GitHub ↗` · lede = description. Under the head one
line: `categoryBadge(category, tier)`, stars, language, licence, `badge('Fork')` / `badge('Archived', 'warn')`,
and the reason in plain words when not open source ("Not counted: under 50 stars").
`.cards`: Merged PRs (key) | PRs | Students | Open | Stars. Then two flush cards: Students (name, campus, year, PRs,
merged) and Pull requests (PR table with a Student column instead of Project). Owner link → `#/orgs/:login`.

### Organisations `#/orgs` — `GET /orgs`
Filters: Search · Category ("Open source" default / "All owners"). Columns: Organisation (→ org page, `.sub` =
"User" for personal accounts) · Merged open-source (num, `barCell`, sort `osMerged`) · Open-source PRs (num, sort
`osPrs`) · Students (num, sort `students`) · Projects (`stats.repos`, num) · Top project stars (`maxStars`,
compact) · All PRs (num, sort `prs`).

### Org page `#/orgs/:login` — `GET /orgs/:login`
Head: crumbs Organisations / · title login · `View on GitHub ↗`. `.cards`: Merged open-source PRs (key) | Open-source
PRs | Students | Projects. `categoryBar(stats.byCategory, { legend: true })` when more than one category is present.
Flush cards: Projects (repo table) and Students (name, campus, year, PRs, merged).

### Pull requests `#/prs` — `GET /prs`
Filters: Search (`q`, "Title or project") · Category (Open source default, All) · State · Tier · Campus · Year ·
From · To. `author`, `repo`, `owner` arrive from links elsewhere and show as a `.notice` line above the table
("Showing PRs by octocat. Show everyone") rather than as inputs. Toolbar: `Download CSV` →
`api.url('/export/prs.csv', currentFilters)`. Columns: Pull request (wrap; `.sub` `repo#number`) · Student (→
profile) · Project (→ repo; stars compact in `.sub`) · State · Category · Opened (sort `createdAt`, default) ·
Merged (sort `mergedAt`) · Changes (sort `additions`). 25 per page; count from `pagination`.

### About `#/about` — `GET /meta`
`.prose` column. Sections: What this site counts (the headline metric in two sentences) · The six categories (a
table: `categoryBadge`, `CATEGORY_HELP` text, live count from an overview call) · How a pull request is classified
(`.rule-steps`, the order from SPEC section 3 in plain words, with the **live** thresholds from
`meta.rulesSummary`: tier stars, user-repo and org-repo minimums) · Current lists (NST organisations, practice
repositories and keywords, always-counted organisations, as `.chips` without remove buttons) · Where the data
comes from (GitHub public PR search per tracked username, refreshed daily; `meta.lastSyncAt` via `fmt.datetime`;
private repositories are never stored) · Corrections (who to ask; classification can be overridden by admins and
overrides are marked on the PR).

## 10. Admin pages

Admin uses the same components, denser: `.btn-sm` in rows, `table-compact`, and **one `.btn-primary` per view**.
Every mutation ends with a toast naming what changed and its reach, in the API's own numbers:
"Excluded some-org/tutorial. 37 pull requests no longer count." Then `refresh()` (keeps scroll and filters).

### Sign in (shown in `#app` while `me.admin` is false)
`.login` > `.card`: `h1` "Admin sign in", one password field (`autocomplete="current-password"`), `Sign in`
(primary). Wrong password: `.field-error` "That password is not right." 429: "Too many attempts. Try again in 15
minutes." `me.configured === false`: replace the form with `.notice.notice-warn` "Admin access is not set up on
this server. Set ADMIN_PASSWORD and restart." `#admin-nav` stays `hidden` until signed in.

### Students `#/students` — `GET /admin/students`
Head actions: `Add student` (primary) · `Add many`. Filters: Search (name, username, email, enrolment no.) · Campus
· Year · Batch · Status (Active / Inactive) · Backfill (Pending / Running / Done / Failed).
Columns: Student (name, `.sub` username ↗) · Campus · Batch · Email · Enrolment no. · Backfill (`stateBadge(status)`;
error text as `title`; `not_found` reads "GitHub user not found") · Last synced (`fmt.rel`) · Merged open-source
(num, sort `osMerged`) · Added (`fmt.date`, sort `addedAt`) · actions: `Edit` · `Fetch history` · `Deactivate`
(danger) or `Reactivate`. Inactive rows render `.muted` with `badge('Inactive')`.
- Add student: `modal` with `.form`: GitHub username or profile URL (required) · Name · Campus (select) · Batch
  (select) · Email · Enrolment no. Confirm `Add student`. On 409 show the field error "Already tracked" with a
  `Reactivate` action if inactive. Success toast: "Added octocat. Fetching their pull requests now." linking to Jobs.
- Add many: `modal({ wide: true })`: textarea for pasted CSV + file input, a hint listing the accepted columns
  (`github_username` required), then the per-row result table (Row · Username · Result as `badge` ok / neutral /
  danger · Error) and the counts line "12 added, 3 already tracked, 1 invalid".
- Edit: `modal` with name, campus, batch, email, enrolment no., notes (textarea), active (checkbox). `Save changes`.
- Deactivate: `confirmDialog('Deactivate {name}? Their pull requests stop counting on the public site. You can reactivate them later.', { confirmLabel: 'Deactivate', danger: true })`.
  Purge is a second, separate action inside Edit: confirm requires typing the username (`input: { label, required }`).

### Review `#/review` — `GET /admin/review/repos`, `GET /admin/review/owners`
`tabs`: Repositories | Owners (hash query `?tab=owners`).
Repositories filters: Search · Category (All default) · Minimum PRs · Decision (Any / Decided / Undecided). Columns:
Repository (↗, `.sub` description) · Stars (num, sort) · PRs (num, sort, default) · Students (num, sort) · Merged
(num, sort) · Currently (`categoryBadge` + reason as `.sub`; `overrideBadge(ownerOverride)` when the owner decides
it) · Decision: `.btn-group` of `.btn-sm` `Include` · `Exclude` (danger), the applied one has `.is-on`, plus `Clear`
when an override exists.
Owners columns: Owner (↗, type) · Repos (num) · PRs (num) · Open-source PRs (num) · Students (num) · Top stars ·
Decision: `Include` · `Exclude` · `NST internal` · `Clear`.
Each decision opens `confirmDialog` with `input: { label: 'Note (optional)' }` and a message that states the reach
before it happens ("Exclude some-org? All 9 of its repositories will stop counting."). After the call, toast with
`affected` counts and `refresh()`.

### Pull requests `#/prs` — public `GET /prs?category=all&…`
Same filter bar as the public explorer plus `author`, `repo` as search fields. Columns: Pull request · Student ·
Project · State · Category (+ `overrideBadge`, note as title) · Decision: `Open source` · `Not open source` · `Clear`
(same toggle pattern, note dialog).

### Overrides `#/overrides` — `GET /admin/overrides`
Three flush cards (Pull requests, Repositories, Owners), each a compact table: what · decision (`overrideBadge`) ·
note (`wrap: true`) · when (`fmt.rel(overrideAt)`) · `Undo` (`.btn-sm`). Undo posts `override: null`, toasts
"Cleared the decision on …", refreshes. Empty: "No decisions yet. Make them in Review or Pull requests."

### Rules `#/rules` — `GET /admin/rules`, `PUT /admin/rules`
`.form-grid` of four number fields with hints (Major tier, stars · Established tier, stars · Minimum stars, personal
repos · Minimum stars, organisation repos), then five list editors (NST organisations, NST owner keywords, Practice
repositories, Practice keywords, Always-counted organisations), each a `.chips` list with remove buttons and an
"Add" input. `.form-actions`: `Save rules` (primary) · `Discard changes`. Save confirms first: "Save rules and
reclassify every pull request? This takes about a minute." Validation errors from the API show in a `.notice-warn`
above the actions. Success toast links to the queued job.

### Jobs `#/jobs` — `GET /admin/jobs`, `GET /admin/jobs/:id`
Head actions: `Sync now` (primary) · `Reclassify`. Filters: Type · Status. Columns: Started (`fmt.datetime`) · Type ·
Runs on (`runner`: "App" / "Scheduled") · Status (`stateBadge`) · Progress (`.progress` + "1,200 / 2,623") · Result
(summary as "2,620 ok, 3 failed, 412 PRs") · Duration · `View log`. `View log` opens `modal({ wide: true })` with
`.facts` and `<pre class="log">`. While any job is queued or running, poll every 5 s with `refresh()`; stop
polling in the page cleanup.

## 11. States

| State | Where | What to show |
|---|---|---|
| Loading a page | router | `loading()` under the page (skeleton bars; screen readers hear "Loading…") |
| Reloading after a filter / sort / page change | router | previous view stays, dimmed; nothing else |
| Loading inside a page (a tab, a log) | page | `loading()` in that region only |
| Empty table | `table({ empty })` | one sentence in the table body. Lists: "No students match these filters." Fresh install: "No data yet. An admin needs to import or add students." |
| Empty region | `empty(text, action?)` | dashed box, one sentence, optional button |
| Page failed | router | `errorBox(err, { retry })`: title by error code, the API message, "Try again" |
| Unknown student / repo / org | page throws the `ApiError` | error box titled "Not found" with the API message |
| Unknown route | router | "Page not found" with a button to the start page |
| Action failed | page | `toast(err.message, 'error')`; field-level problems go in `.field-error` next to the field |
| Action succeeded | page | `toast('…')` naming the object and the effect |
| Chart library missing | `charts.js` | one-line note in the chart box |

## 12. Mobile (works from 360px)

- Below 900px the nav drops to its own row under the brand and scrolls sideways; the current item scrolls into
  view. No hamburger: six links fit a thumb swipe and stay visible.
- Below 640px: gutters 16px; `.grid-*` collapse to one column; the `.cards` band wraps two figures per row;
  filters stack two per row with search full width; inputs are 16px so iOS does not zoom; buttons are 38px tall.
- Tables never squeeze: they scroll sideways inside `.table-wrap`, and the first column stays pinned (max 46vw,
  ellipsis) so the row keeps its name. Put the identifying column first. Pass `sticky: false` for tables whose
  first column is not an identifier.
- Charts are 240px tall; the doughnut legend moves below the ring.
- Dialogs take the full width minus 16px margins; toasts span the bottom.
- Nothing on the page itself scrolls sideways. Checked at 375px and 1280px in light and dark.

## 13. Copy

- Sentence case everywhere. No all-caps labels. Numbers use `fmt.num`.
- Say "pull request" in headings and first mentions, "PR" in column heads and tight spots. "Open source" as a
  noun phrase, "open-source" before a noun. "Project" for a repository in public pages, "repository" in admin.
- Category names come from `CATEGORY_LABELS` only. Never show raw keys (`low_signal`) or raw reasons; reasons from
  the API are already short phrases and may be shown after "Not counted:".
- Buttons say what happens: "Add student", "Save rules", "Exclude", "Fetch history", "Sign out". The toast repeats
  the verb in the past tense.
- Do not rank or shame: tables are "ranked by merged open-source pull requests", never "leaderboard", and
  low-signal work is described as "not counted", never as bad.
- Never show email, enrolment number, sources or notes outside the admin area.

## 14. Accessibility

- Tables: real `<table>` with `scope="col"`, a caption (visually hidden unless `captionVisible`), sortable headers
  as buttons with `aria-sort`; the scroll wrapper is focusable so keyboard users can scroll it.
- All controls have labels (`filterBar` and `.form-row` wire `for` / `id`). Focus ring: 2px `--focus` on every
  interactive element. Skip link to `#app` in both shells.
- Dialogs use native `<dialog>`: focus trapped, Esc closes, focus returns to the opener. Destructive confirms
  start on Cancel.
- Toasts are a polite live region; error toasts are `role="alert"` and stay 8 s.
- Charts have `role="img"` and an `aria-label`; pass `label` to describe the finding, and keep the figures in a
  table or stat band near every chart.
- `prefers-reduced-motion` turns off the skeleton pulse and chart animation. `forced-colors` keeps data swatches.
- Text contrast: `--ink` and `--ink-2` exceed 7:1 in both modes; `--ink-3` and the status chips are at least 4.5:1 on the surfaces they sit on.

## 15. Addendum support (`SPEC-ADDENDUM-dates.md`)

The addendum arrived after the page designs above were written. The design system covers it with three helpers
and one token (`--heat`, a single-hue ramp of the brand green in five steps, `.heat-0`…`.heat-4`). The page
designs in sections 9 and 10 stay valid; these are the changes.

**Date range (A4).** `rangeBar()` goes directly under the `pageHead` of every public page, above the filter bar:

```js
rangeBar({ presets: meta.presets, query: ctx.query, onChange: (patch) => setQuery({ ...patch, page: '' }) })
```
Preset buttons (the active one has `.is-on` / `aria-pressed`), then From / to date inputs, then the resolved range
in words. No params = the default preset (current academic year); other presets set `?range=<key>`; custom dates
set `?from=&to=` and clear `range`. To carry the range across pages, build links with
`href(path, { from: ctx.query.from, to: ctx.query.to, range: ctx.query.range })`. The masthead nav links are
static, so the entry file should rewrite their `href`s in `onNavigate` to append the current range. Put the active
range in the page lede as a sentence ("Academic year 2026-27, 1 Jul 2026 to 30 Jun 2027"): use
`fmt.range(range.from, range.to)` on the `range` object the API echoes.

**Activity page (`#/activity`, nav item between Pull requests and About — add
`<a data-nav href="#/activity">Activity</a>` to `index.html` when the page exists).**
```
page-head   When students contribute                  lede: range sentence, time zone note ("Times are India Standard Time")
rangeBar
filters     Campus ▾  Year ▾  Category ▾  Count ▾ (Opened / Merged)
.cards      Busiest day | Busiest week | Busiest month | Active students        (value = count, sub = the date)
card        Pull requests by month — barChart, series Opened + Merged
card        Day by day — calendarHeatmap(byDate → { date, value: d[metric] })
.grid-2     ┌ By day of week — barChart, 7 bars ┐ ┌ By hour of day — barChart, 24 bars ┐
card        Day of week × hour — heatGrid, rows Mon…Sun, cols 0…23 (label every third hour)
card        Campuses by month — lineChart, one series per campus (max 5; colours by slot order, legend on)
```
Single-series bar charts take `color: 1`. The two heatmaps use the same ramp and each prints a Fewer–More key;
every cell has a `title` with the exact count, and the monthly / weekday / hourly charts beside them carry the
same totals in readable form.

**Overview, profile, repo and org pages.** Headline cards and tables use the ranged numbers. Add one card
"Activity in this period" with `calendarHeatmap` and a small weekday `barChart` (`.chart-box-sm`), and a link
"See all activity" → `#/activity` with the current filters.

**Admin: missing data (B).** Above the Students filter bar, a row of `.btn.btn-sm` toggles, one per
`missingCounts` key with its count in a `.count`-style span ("No batch 33"), `.is-on` when active, stored as
`?missing=batch,email`. Rows show `badge('No email', 'warn')` for each entry in `row.missing`. Inline editing: the
cell shows the value as a `.btn-link`; activating it swaps in the input or select, Enter or blur saves, Esc cancels;
on failure restore the old value and `toast(err.message, 'error')`.

**Admin: scheduled fetch (C).** A card at the top of Jobs: status line with `stateBadge` (`running`, `done`,
`cancelled`, or `badge('Paused', 'warn')`), next run via `fmt.datetime`, then a `.toolbar`: `Fetch now` (primary),
`Full refresh` (confirm: "Re-read every student's whole history? This takes much longer than a daily fetch."),
`Pause` (dialog: until date + note), `Resume`, `Cancel running job` (danger). Running job: `.progress` +
"1,200 / 2,623 students" + `.log` tail. Recent runs: compact table. Daily time and weekly full-refresh day: a
`.form-grid` with `Save schedule`. The public footer's "Data updated …" line is filled by `lib/shell.js` from
`meta.lastSyncAt`; a "updates paused" note needs a field in `/api/meta` that the addendum does not name, so it is
not wired.
