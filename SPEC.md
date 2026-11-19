# NST Open Source Status — SPEC (source of truth for all agents)

Public dashboard of open-source work by Newton School of Technology (NST) students, with a
password-protected admin area. Hosted at https://oss.nstsdc.org on a k3s cluster. MongoDB.

Agents work in parallel and cannot talk. Where this file names a function, field, route, element id or
CSS class, use exactly that name. Appendix A (API shapes) and section 7.1 (frontend contracts) are binding.

## 0. Ground rules
- Node 22, ESM (`"type":"module"`). Express 4/5, official `mongodb` driver (no mongoose), no TypeScript, **no frontend build step**.
- One container image serves API + static frontend, and also runs the scripts (CronJob uses the same image).
- App runs with `replicas: 1` (in-process job runner is allowed).
- Never expose `email`, `enrolmentNo`, `sources` or `notes` of students on any public endpoint or page. Admin-only.
- PRs in private repositories (`repository.isPrivate`) are never stored (skipped by import and ingest; the legacy data has 39).
- All data files are written by programs. No hand-typed data.
- Tests: `node --test`. A real mongod binary is at `/home/claude/tools/mongod` (v8). Tests start it on a random port with a temp dbpath
  (helper `test/helpers/mongo.js`), never mock Mongo. GitHub API is NOT reachable from this sandbox: mock `fetch` in tests.
- Existing data to import lives in `data/students.csv` and `data/raw/<username-lowercase>.json` (2,623 students, ~49k PRs).
  `legacy/` holds the Python scripts that produced them (`fetch_prs.py`, `build_csv.py`, `rules.json`) — port their logic, then they are reference only.
- Do not edit files outside your assigned ownership (section 10) except to fix an obvious bug that blocks you; say so in your report.
- No secrets in the repo. Config via env (section 8).

## 1. Layout
```
package.json  Dockerfile  .dockerignore  .env.example  README.md
src/server.js            express app factory + listen
src/config.js            env parsing
src/db.js                connect(), collections, ensureIndexes()
src/classify.js          pure classification + reclassifyAll(db)
src/rules.js             default rules + load/save rules doc
src/github.js            GraphQL client + fetchUserPRs(username, {since})
src/ingest.js            upsertPRs(db, student, prNodes), refreshAggregates(db)
src/jobs.js              in-process job runner (backfill / sync / reclassify) + job log
src/jobHandlers.js       backfill + sync handlers (fetch agent)
src/auth.js              admin password login, signed cookie, requireAdmin
src/routes/public.js     /api/* public
src/routes/admin.js      /api/admin/*
scripts/import_legacy.js data/students.csv + data/raw -> Mongo
scripts/sync.js          daily incremental fetch for all active students
scripts/backfill.js      full-history fetch for given usernames / all pending
scripts/reclassify.js    recompute categories + aggregates
public/                  static SPA (index.html, admin.html, css/, js/, vendor/)
k8s/                     manifests
test/
```
`server.js` exports `createApp({db, config})` (no listen; used by tests) and listens only when run as main. It serves `public/` statically,
`GET /admin` → `public/admin.html`, and unknown `/api/*` → 404 JSON.

## 2. Collections
`students` — `_id` = lowercase username at the time the student was added (stable key; never changes, also after a GitHub rename)
```
{ _id, username, githubId?, name, nameSource:'sheet'|'github profile'|'', campus:'ADYPU'|'RU'|'SVYASA'|'SMRU'|'Unknown',
  batch: 2023..2026|null, email?, enrolmentNo?, sources:[string], notes:string, active:true,
  backfill:{status:'pending'|'running'|'done'|'error', at, error?}, lastSyncedAt?, loginCheckedAt?, addedAt, addedBy:'import'|'admin',
  stats:{ totalPrs, mergedPrs, osPrs, osMerged, osOpen, osMajorMerged, osRepos, osOrgs, byCategory:{<cat>:n}, firstPrAt, lastPrAt, lastOsMergedAt } }
```
Real data: 336 students have `name:''` (UI falls back to username), 37 have no batch (`batch:null`), 5 have campus `Unknown`, no SMRU rows yet.
`stats` always exists with zeros / nulls (set on insert), `byCategory` always has all six keys.
`year` is derived, never stored: academic year starts 1 July; `year = (AY start year) - batch + 1` → "1st year".."4th year", >4 → "alumni",
`batch:null` (or batch in the future) → "Unknown". Helpers in `src/classify.js`: `yearLabel(batch, now=new Date())` and the inverse
`batchesForYear(label, now)` → `{batch: n}` | `{batch: null}` | `{batch: {$lt: n}}` (alumni) used for the `year` filter. In Nov 2026: batch 2026 → 1st year.

`prs` — `_id` = PR url
```
{ _id, url, number, title, author (= students._id), authorLogin, repo ('owner/name'), repoLc, owner, ownerLc, ownerType:'Organization'|'User',
  state:'open'|'merged'|'closed', isDraft, createdAt:Date, mergedAt:Date|null, closedAt:Date|null, updatedAt:Date|null,
  additions, deletions, changedFiles, comments, reviews, stars (repo stars at last ingest),
  campus, batch, active (denormalised from student; rewritten when an admin edits/deactivates the student),
  category, tier:'major'|'established'|'emerging'|null, reason, override:null|'open_source'|'not_open_source', overrideNote?, overrideAt? }
```
`state` = `merged` if `mergedAt` else `open` if GraphQL state `OPEN` else `closed`. `title` whitespace-collapsed.
`repos` — `_id` = lowercase 'owner/name'
```
{ _id, name ('owner/name'), owner, ownerLc, ownerType, stars, forks, isFork, isArchived, language, license, description,
  override:null|'include'|'exclude', overrideNote?, overrideAt?, category, tier, reason,
  stats:{ prs, merged, open, closed, students, campuses:[...], firstPrAt, lastPrAt } }
```
`owners` — `_id` = lowercase login
```
{ _id, login, type, override:null|'include'|'exclude'|'nst_internal', overrideNote?, overrideAt?,
  stats:{ repos, prs, merged, osPrs, osMerged, students, maxStars, byCategory } }
```
`settings` — `{ _id:'rules', ...rules, updatedAt }`
`jobs` — `{ _id (string, random hex), type:'backfill'|'sync'|'reclassify'|'import', runner:'app'|'cli', status:'queued'|'running'|'done'|'error', params, createdAt, startedAt, finishedAt, progress:{done,total}, summary?:object, log:[last 200 lines], error? }`

All aggregates (`students.stats`, `repos.stats`, `owners.stats`) and all public endpoints count only PRs with `active:true` and only
students with `active:true`. Repos/owners whose `stats.prs` is 0 are hidden from public lists.

Indexes: prs {author:1,createdAt:-1}, {repoLc:1}, {ownerLc:1}, {category:1,state:1,createdAt:-1}, {campus:1,batch:1}, {createdAt:-1}; students {campus:1,batch:1}, {'stats.osMerged':-1}; repos {ownerLc:1}, {'stats.prs':-1}.

## 3. Classification (src/classify.js, pure function + bulk recompute)
Categories: `open_source`, `practice`, `nst_internal`, `peer_repo`, `own_repo`, `low_signal`.
All matching is case-insensitive (compare lowercased). Order (first match wins) for a PR by `author` on `repo`:
1. PR `override` set → `open_source` (tier by stars, reason 'admin: marked open source') or `low_signal` (reason 'admin: marked not open source').
2. repo `override` include → open_source ('admin: repo included'); exclude → low_signal (reason 'admin: repo excluded').
3. owner `override` include → open_source ('admin: org included'); exclude → low_signal ('admin: org excluded'); nst_internal → nst_internal ('admin: org marked NST internal').
4. owner == author (student `_id` or current `username`) → `own_repo`.
5. owner in `rules.nstOrgs` or matches `rules.nstOwnerKeywords` (keywords of length ≤4 must equal a whole token of the owner split on non-alphanumerics; longer may be substrings) → `nst_internal`.
6. owner is a tracked student (any doc in `students`, active or not, by `_id` or `username`) → `peer_repo`.
7. repo in `rules.practiceRepos`, or the repo *name* (part after `/`) or the owner login contains any of `rules.practiceKeywords` → `practice`.
8. repo isFork → `low_signal` ('repo is a fork').
9. owner in `rules.allowOrgs` → `open_source` regardless of stars.
10. ownerType 'User' and stars < `rules.minStarsUserRepo` (default 200) → `low_signal` ('personal repo under N stars').
11. stars < `rules.minStarsOrgRepo` (default 50) → `low_signal` ('under N stars').
12. else `open_source`.
Tier (open_source only, otherwise `null`): stars ≥ `tiers.major` (1000) major; ≥ `tiers.established` (200) established; else emerging (also below 50 when
forced open by an override or `allowOrgs`). For open_source the `reason` is the tier name unless an override set it.
The **repo-level** `repos.category/tier/reason` is the same function with no author and no PR override (steps 2–12, skipping 4); so a student's personal
repo is `peer_repo` at repo level while the owner's own PRs to it are `own_repo`.
Rules doc: `{ tiers:{major:1000, established:200}, minStarsUserRepo:200, minStarsOrgRepo:50, nstOrgs:[], nstOwnerKeywords:[], practiceRepos:[], practiceKeywords:[], allowOrgs:['c2siorg'] }`.
Defaults for the four lists come from `legacy/rules.json`. Legacy `min_stars_credible`, `tiers.emerging`, `exclude_orgs`, `exclude_repos`, `include_repos`
are dropped (replaced by the two thresholds and by `repos`/`owners` overrides; the three lists are empty in the legacy file).
`reclassifyAll(db)` recomputes category/tier/reason for every PR and repo (bulkWrite, efficient: load repos/owners/students/rules into memory once), then `refreshAggregates(db)` recomputes `students.stats`, `repos.stats`, `owners.stats` with aggregation pipelines.
Admin changes: PR / repo / owner overrides are applied **synchronously** inside the request (reclassify only the PRs + repos touched, then
`refreshAggregates(db)`; must finish in a few seconds on the full dataset) so the UI can refetch immediately. `PUT /rules` queues a `reclassify` job.
"Valuable contribution" = category `open_source`. Headline metric everywhere = **merged open-source PRs** and **students with ≥1 merged open-source PR**.

## 4. GitHub fetching (src/github.js, src/ingest.js)
- GraphQL `search(query:"author:<u> type:pr [updated:>=YYYY-MM-DD]", type: ISSUE)` exactly as in `legacy/fetch_prs.py` (same fields, plus `updatedAt`, and `author{login ... on User{databaseId}}`).
  Keep its hard-won behaviour: page size 50 shrinking to 20/8/3 on 502/504, short backoff, Retry-After, rateLimit check (sleep until reset when remaining < 100), split by `created:` year when issueCount > 1000 (3 students in the legacy data exceed 1000).
- Module contracts (binding; `opts.fetch` defaults to global `fetch`, `opts.token` to `GITHUB_TOKEN`, `opts.sleep` injectable so tests do not wait):
  - `github.fetchUserPRs(username, {since?: Date, ...opts})` → `{ nodes: [rawPRNode], count, error: '' | string }`. Never throws for GitHub-side failures; `error` non-empty means the result may be partial.
  - `github.getUser(login, opts)` → `{ login, id, name } | null` (REST `GET /users/:login`, null on 404). `github.getUserById(id, opts)` → same (REST `GET /user/:id`).
  - `ingest.upsertPRs(db, student, nodes)` → `{ prs: n, repos: n }`. Upserts `prs` (preserve `override*`; skip private repos; dedupe by url), upserts `repos`/`owners`
    metadata (stars etc., preserve overrides), classifies with current rules, and sets `student.githubId` from `node.author.databaseId` when missing.
    Does NOT touch aggregates. Tolerates nodes without `updatedAt` / `author` (legacy raw files).
  - `ingest.refreshAggregates(db)` → void.
  - `jobHandlers.backfill(db, {users?: [string], pending?: bool}, ctx)` and `jobHandlers.sync(db, {users?, full?, limit?}, ctx)` → summary object
    `{ students, ok, failed, prs, renamed, notFound }`; `ctx = { log(line), progress(done, total) }`. Both end with `refreshAggregates`.
  - `jobs.js` (foundation) loads handlers lazily (`await import('./jobHandlers.js')` when a backfill/sync job starts) and exports
    `enqueue(db, type, params)` → job doc (runner 'app'), `runInline(db, type, params)` → finished job doc (runner 'cli'; used by all `scripts/*`,
    logs to stdout as well), `startRunner(db)`. `routes/admin.js` loads `github.js` lazily too, so the server boots if a file is missing.
- Per-student fetch rules (shared by sync and backfill): record `startedAt` before fetching; on `error === ''` set `lastSyncedAt = startedAt` and
  `backfill = {status:'done', at}` ; on error leave `lastSyncedAt` untouched (a full fetch sets `backfill.status='error'` with the message) and continue with the next student.
  A full fetch that returns 0 PRs checks `getUser(username)`: if 404 → `backfill = {status:'error', error:'not_found'}`.
- Rename handling: a GraphQL search for a login that no longer exists silently returns 0, and incremental searches return 0 for most students anyway, so
  do NOT check on every empty result. For students with `githubId`, at most once per 7 days (`loginCheckedAt`) and whenever a full fetch hits `not_found`,
  resolve the current login via `getUserById`; if it changed, set `username` to the new login (keep `_id`, append a note), then full-fetch. Unknown/deleted users must not crash a run.
- `scripts/sync.js`: all `active` students. `backfill.status=='done'` → incremental with `since = lastSyncedAt - 2 days` (3 days back if missing);
  `pending` → full fetch; `error` with `not_found` → skipped (admin re-backfills); other `error` → full fetch retried. Concurrency `SYNC_CONCURRENCY` (default 6).
  Ends with `refreshAggregates`. Writes a `jobs` doc via `runInline`. Exit code non-zero only on total failure (every student failed, or DB unreachable). Flags: `--users a,b`, `--full`, `--limit N`.
  Budget: ~2,600 search calls per day against a 5,000-point/hour GraphQL limit — fine; aliasing 2 users per request as in legacy is optional.
- `scripts/backfill.js [--users a,b | --pending]`: full history.
- `scripts/import_legacy.js [--data <dir>=./data] [--fetched-at <ISO>]`: reads `<dir>/students.csv` (columns: campus,year,batch,name,github_username,github_profile,email,enrolment_no,name_source,sources,notes;
  `year` and `github_profile` are ignored, `batch ''` → null, `sources` split on `; `, campus outside the enum → 'Unknown') and `<dir>/raw/*.json`
  (`{user,count,prs:[nodes],error}`; nodes lack `updatedAt`/`author` — tolerate). Idempotent (re-run safe, preserves overrides and admin edits to existing students).
  Marks students `backfill.status='done'`, `addedBy:'import'`. `lastSyncedAt` = `--fetched-at`, default (latest PR timestamp in the whole dataset) − 3 days: file mtimes are
  copy times, not fetch times, so they must not be used. Then reclassify + aggregates. Must import the full dataset in well under 5 minutes.

## 5. Public API (JSON, no auth, read-only, `Cache-Control: public, max-age=60`)
Exact response shapes: Appendix A. Conventions for every endpoint (public and admin):
- No `_id` in responses; keys are `username`, `url`, `name` (repo), `login`, `id` (job). Dates are ISO-8601 strings or `null`. Counts are numbers, never missing.
- Errors: HTTP status + `{ "error": { "code": "bad_request"|"unauthorized"|"forbidden"|"not_found"|"conflict"|"rate_limited"|"unavailable"|"internal", "message": "…" } }`.
  Unknown query params are ignored; invalid values of known params → 400.
- List responses: `{ items, total, page, limit }`. `page` 1-based, `limit` default 25, max 100. `order` = `asc`|`desc` (default `desc`, `asc` for `name`).
- `:username`, `:login`, `:owner/:name`, `author`, `repo`, `owner` are matched case-insensitively.

Common query params where meaningful: `campus`, `year` ('1st year'…'4th year','alumni','Unknown'), `batch`, `category` (default `open_source` for PR/repo/org lists; `all` allowed), `state`, `tier`, `q` (case-insensitive substring search), `from`, `to` (ISO dates on createdAt, inclusive), `sort`, `order`, `page`, `limit`.
- `GET /api/health` → `{ok:true}` (also checks db ping; 503 if it fails; `no-store`)
- `GET /api/meta` → filter vocabularies, last sync, counts, rules summary.
- `GET /api/overview?campus&year` → headline numbers: students tracked, with any PR, with OS PR, with OS merged, with major merged; PR totals by category and by state; OS merged by tier; top 10 repos, top 10 orgs, top 10 students (by OS merged); `monthly` for the last 24 calendar months incl. the current one, oldest first, zero-filled (`osOpened`/`allOpened` by createdAt month, `osMerged` by mergedAt month, UTC).
- `GET /api/campuses` → rows per campus × year (same columns as legacy campus.csv) + per-campus totals + grand total.
- `GET /api/students` (sort: osMerged (default)|osPrs|totalPrs|name|lastPrAt; filters `campus`, `year`, `batch`, `q` on name+username, `hasOs=1` → `stats.osPrs>0`) → public student fields + stats.
- `GET /api/students/:username` → profile, stats, monthly timeline, repos contributed to (with counts), and recent PRs (first page, all categories). Inactive/unknown → 404.
- `GET /api/prs` → PR rows (filters incl. `author`, `repo`, `owner`, `campus`, `year`, `batch`, `category`, `state`, `tier`, `q` on title+repo, `from`, `to`; sort: createdAt (default)|mergedAt|stars|additions).
- `GET /api/repos` (filters `category` on the repo-level category, `tier`, `owner`, `q`; sort: prs (default)|merged|students|stars) and `GET /api/repos/:owner/:name` (repo + students + PRs first page).
- `GET /api/orgs` (filters `category` — default `open_source` means `stats.osPrs>0`, `all` = every owner; `q`; sort: osMerged (default)|osPrs|prs|students) and `GET /api/orgs/:login` (owner + repos + students).
- `GET /api/export/students.csv`, `/api/export/prs.csv?…filters` (same filters as the list endpoints, no paging) → CSV streams (public fields only, `Content-Disposition: attachment`).
Public student fields: username, name, campus, batch, year, stats. Nothing else.

## 6. Admin API (`/api/admin/*`, all require admin cookie except login/me; all responses `Cache-Control: no-store`)
- `POST /api/admin/login {password}` → sets httpOnly, SameSite=Lax, Secure-in-production, `Path=/` cookie `oss_admin` (HMAC-signed with `SESSION_SECRET`, 12h expiry). Constant-time compare against `ADMIN_PASSWORD`. Rate limit: 10 failed attempts / 15 min per IP (in-memory) → 429. Wrong password → 401. `POST /logout`, `GET /me` (always 200).
  If `ADMIN_PASSWORD` is unset every admin route except `/me` returns 503 `unavailable`. Missing/expired cookie → 401 `unauthorized`.
- All state-changing admin routes (POST/PUT/PATCH/DELETE, including login) require header `X-Requested-With: oss-admin` (simple CSRF guard; else 403) and JSON bodies.
- Students: `GET /students` (all fields incl. email/enrolment; filters `campus`, `year`, `batch`, `q` (name, username, email, enrolmentNo), `active=1|0`, `backfill=<status>`; sort: addedAt (default)|name|username|osMerged),
  `POST /students` `{username, name?, campus, batch, email?, enrolmentNo?}` (username may be a login or a github.com profile URL; validated against `github.getUser` when a token is present — 400 if GitHub says 404; stores canonical login + githubId, fills empty name from the GitHub profile with `nameSource:'github profile'`; 409 `conflict` if the student exists (reactivate with PATCH `active:true`); sets backfill pending and queues a backfill job for that user),
  `POST /students/bulk` `{csv}` or `{rows:[…]}` (same column names as students.csv; only `github_username` required; no per-row GitHub validation — the backfill marks unknown logins `not_found`; returns per-row result; queues one backfill job for all added users),
  `PATCH /students/:username` (any of `name, campus, batch, email, enrolmentNo, notes, active`; rewrites denormalised `campus/batch/active` on that student's PRs and refreshes aggregates),
  `DELETE /students/:username` (soft: `active:false`; `?purge=1` deletes the student doc and their PRs), `POST /students/:username/backfill`.
- Overrides: `POST /prs/override {url, override:'open_source'|'not_open_source'|null, note}`, `POST /repos/override {repo, override:'include'|'exclude'|null, note}`, `POST /owners/override {login, override:'include'|'exclude'|'nst_internal'|null, note}`. Synchronous (section 3); each returns the affected counts. Unknown url/repo/login → 404. `GET /overrides` lists all current overrides (prs, repos, owners).
- PR search for marking: admin UI uses the public `GET /api/prs?category=all&…` (rows carry `override`).
- Review queues: `GET /review/repos?category&minPrs&q&override=any|none&sort` (repos with stats + current category/reason, for bulk triage; default `category=all`, sort prs|students|stars|merged), `GET /review/owners?q&override&sort` (sort prs|osPrs|students|repos).
- Rules: `GET /rules`, `PUT /rules` (full document, validated: numbers ≥ 0, `tiers.major > tiers.established`, lists of trimmed non-empty strings; triggers reclassify job).
- Jobs: `GET /jobs` (newest first, without `log`), `GET /jobs/:id` (with `log`), `POST /jobs/sync {users?,full?}`, `POST /jobs/reclassify`.
Only one `runner:'app'` job runs at a time; others queue (in-process, state persisted in `jobs`; on boot, `runner:'app'` jobs left `running` are marked `error: interrupted` and
`queued` ones are resumed). `runner:'cli'` jobs (CronJob, scripts) are not managed by the app; they may overlap an app job — all writes are idempotent upserts, so this is safe.

## 7. Frontend (public/, no build)
Vanilla ES modules, hash router, fetch API. Charts: Chart.js vendored at `public/vendor/chart.umd.js` (copy from `node_modules/chart.js/dist/chart.umd.js` in a `postinstall`/`npm run vendor` script owned by the foundation agent's package.json; the page must work offline from CDNs).
Public pages (`index.html`): Overview (headline cards, campus×year table, monthly chart, tier/category charts, top repos/orgs/students), Students (filter/sort/search table, CSV export), Student profile, Projects (repos), Repo page, Organisations, Org page, PR explorer, About (how classification works, from `/api/meta` rules summary).
Admin (`admin.html`, separate bundle, link in footer): login; Students (add one, bulk CSV paste/upload, edit, deactivate, re-backfill, backfill status); Review (repos and owners tables with one-click include/exclude/NST-internal + note, filter by category, search); PR search with mark/unmark; Overrides list (undo); Rules editor (thresholds, lists); Jobs (status, log tail, run sync/reclassify).
Design: see `DESIGN.md` (written by the design agent) and shared `public/css/app.css`. Responsive (works at 360px), light + dark via `prefers-color-scheme`, accessible tables, no external fonts/CDNs.
Filters, sort and page live in the hash query (`#/students?campus=RU&page=2`) so views are linkable. Every PR/repo/org/student name links out to GitHub and/or to its page here.

### 7.1 Frontend contracts (binding for design, public-ui and admin-ui agents)
Shells (design agent): `index.html` contains `<header>` with nav links `<a data-nav href="#/…">`, `<main id="app"></main>`, a footer with a link to `/admin`, then
`<script src="/vendor/chart.umd.js"></script>` (global `Chart`) and `<script type="module" src="/js/app.js"></script>`. `admin.html` contains `<nav id="admin-nav" hidden>` (same `data-nav` links),
`<main id="app"></main>` and `<script type="module" src="/js/admin/main.js"></script>`. `public/js/app.js` (public-ui agent) and `public/js/admin/main.js` (admin-ui agent)
are the entry points: they import the libs, define the route table and call `startRouter`. The design agent does not create those two files.
Routes — public: `/` `/students` `/students/:username` `/projects` `/projects/:owner/:name` `/orgs` `/orgs/:login` `/prs` `/about`;
admin: `/` (→ students) `/students` `/review` `/prs` `/overrides` `/rules` `/jobs` (login form shown in `#app` while `GET /me` says `admin:false`).
Page modules: `public/js/pages/<name>.js` and `public/js/admin/<name>.js` each `export default async function (el, ctx)`; may return a cleanup function.

`public/js/lib/` exports (design agent implements exactly these; UI agents rely only on these):
- `api.js`: `api.get(path, params?)`, `api.post(path, body?)`, `api.put`, `api.patch`, `api.del(path, params?)` → parsed JSON; `path` is relative to `/api` (e.g. `api.get('/students', {campus:'RU'})`);
  empty/null/undefined params are dropped; non-GET sends JSON + `X-Requested-With: oss-admin`, `credentials:'same-origin'`. Non-2xx throws `ApiError` (`.status`, `.code`, `.message`). `api.url(path, params?)` → URL string (CSV links).
- `router.js`: `startRouter(routes, el, {onNavigate?})` with `routes = [{ path:'/students/:username', page: fn | () => import('…') }]` (unknown hash → built-in not-found view);
  `ctx = { params, query (plain object of strings), path }`; `navigate(path, query?)`; `setQuery(patch)` (merges into the current hash query, removes empty values, re-renders); `href(path, query?)` → `'#/…'`.
  The router marks the matching `a[data-nav]` with `aria-current="page"`, shows `ui.loading()` while a page resolves and `ui.errorBox(err)` if it throws.
- `ui.js`: `h(tag, attrs?, ...children)` → Element (`attrs`: `class`, `dataset`, `on<Event>` handlers, others as attributes; children strings are text nodes — never innerHTML with API data);
  `table({columns:[{key, label, num?, sortable?, render?(row) → Node|string}], rows, sort?, order?, onSort?(key, order), empty?})` → Element (scrollable wrapper);
  `pagination({page, limit, total, onPage(page)})`; `filterBar({fields:[{name, label, type:'select'|'search'|'date'|'checkbox', options?:[{value,label}|string]}], values, onChange(values)})` (debounced search);
  `statCard({label, value, sub?})`; `badge(text, kind?)`; `stateBadge(state)`; `categoryBadge(category, tier?)`; `loading()`; `errorBox(err)`; `empty(text)`;
  `toast(message, kind?:'ok'|'error')`; `confirmDialog(message, {confirmLabel?, danger?, input?:{label}})` → Promise<false | true | string>; `modal({title, body:Node, actions?})` → `{close()}`;
  `fmt = { num(n), pct(a, b), date(iso), month('YYYY-MM'), rel(iso) }`; `CATEGORY_LABELS`, `TIER_LABELS`, `ghUrl(pathOrLogin)`.
- `charts.js`: `lineChart(canvas, {labels, series:[{label, data}]})`, `barChart(canvas, {labels, series, stacked?, horizontal?})`, `doughnutChart(canvas, {labels, data})` → `{destroy()}`; theme-aware colours.
CSS classes available from `app.css` (besides what the helpers emit): `.page-head`, `.grid`, `.cards`, `.card`, `.toolbar`, `.btn`, `.btn-primary`, `.btn-danger`, `.btn-sm`, `.form-row`, `.muted`, `.num`, `.chart-box`, `.tabs`, `.tab`, `.log`.

## 8. Env
`PORT` (3000), `MONGODB_URI` (mongodb://localhost:27017), `MONGODB_DB` (oss_status), `ADMIN_PASSWORD` (required in production; admin API returns 503 if unset), `SESSION_SECRET` (required in production; random per-process value in dev), `GITHUB_TOKEN`, `NODE_ENV`, `SYNC_CONCURRENCY` (6), `TRUST_PROXY` (1).

## 9. Kubernetes (k8s/) — cluster facts
k3s v1.36, Traefik ingress (`ingressClassName: traefik`, plain HTTP inside; TLS terminated by Cloudflare — `*.nstsdc.org` already resolves, so only an Ingress with host `oss.nstsdc.org` is needed), storage class `longhorn`, nodes are linux/amd64.
Namespace `oss-status`. Files: `00-namespace.yaml`, `10-mongo.yaml` (StatefulSet mongo:7, 1 replica, 5Gi longhorn PVC, headless Service `mongo`, resource limits, no auth exposure outside the namespace: a NetworkPolicy allowing port 27017 only from pods in this namespace), `20-app.yaml` (Deployment `oss-status` replicas 1, strategy Recreate, envFrom secret `oss-status-secrets`, plain env `MONGODB_URI=mongodb://mongo:27017`, `MONGODB_DB=oss_status`, `NODE_ENV=production`, `TRUST_PROXY=1`, readiness/liveness `/api/health`, Service port 80→3000), `30-ingress.yaml`, `40-cronjob-sync.yaml` (daily 21:00 UTC = 02:30 IST, `node scripts/sync.js`, same image, same env + secret, `concurrencyPolicy: Forbid`, `activeDeadlineSeconds: 10800`), `secret.example.yaml` (never applied; documents keys `ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN`), `kustomization.yaml` with an `images:` entry so the image tag can be set in one place. Image name placeholder: `registry.nstsdc.org:5000/oss-status`.
`Dockerfile`: node:22-alpine, `npm ci --omit=dev`, non-root, `CMD ["node","src/server.js"]`, includes `scripts/` and `public/` (with vendored Chart.js — so `chart.js` is a runtime dependency or the vendored file is committed) but not `data/`, `legacy/`, `test/`.
`README.md`: local dev, import, daily sync, admin guide, deploy runbook (build, push, secrets, apply, first import). The image does not contain `data/`, so the first import is either
`kubectl -n oss-status port-forward svc/mongo 27017` + `node scripts/import_legacy.js` from a checkout, or `kubectl cp data <app-pod>:/tmp/data` + `kubectl exec … node scripts/import_legacy.js --data /tmp/data`.

## 10. Ownership
- foundation agent: package.json, src/config.js, db.js, rules.js, classify.js, ingest.js (upsert + aggregates), auth.js, jobs.js, routes/public.js, routes/admin.js, server.js, scripts/import_legacy.js, scripts/reclassify.js, test/helpers, tests for these.
- design agent: DESIGN.md, public/css/app.css, public/index.html + public/admin.html shells (nav, layout, empty mount points), public/js/lib/ (api.js fetch helper, router.js, ui.js table/pagination/format helpers, charts.js theme wrapper).
- fetch agent: src/github.js, scripts/sync.js, scripts/backfill.js, the job handlers that call them (`src/jobHandlers.js`), tests with mocked fetch.
- public-ui agent: public/js/app.js, public/js/pages/* for public pages.
- admin-ui agent: public/js/admin/* (entry `main.js`).
- deploy agent: Dockerfile, .dockerignore, k8s/*, .env.example, README.md.

## Appendix A — API shapes (one example per endpoint; field names and nesting are binding, values illustrative)
Shared objects, referenced below by name:
```jsonc
// Stats (student)
{ "totalPrs": 41, "mergedPrs": 30, "osPrs": 12, "osMerged": 9, "osOpen": 2, "osMajorMerged": 4, "osRepos": 5, "osOrgs": 4,
  "byCategory": { "open_source": 12, "practice": 3, "nst_internal": 6, "peer_repo": 8, "own_repo": 10, "low_signal": 2 },
  "firstPrAt": "2024-09-02T10:11:12.000Z", "lastPrAt": "2026-11-14T08:06:41.000Z", "lastOsMergedAt": "2026-11-01T09:00:00.000Z" }
// Student (public)
{ "username": "AarushKarva", "name": "Aarush Anand Karva", "campus": "ADYPU", "batch": 2026, "year": "1st year", "stats": Stats }
// AdminStudent = Student plus
{ "githubId": 1234567, "nameSource": "sheet", "email": "a@example.org", "enrolmentNo": "E26B07F1018", "sources": ["OSS tracker"], "notes": "",
  "active": true, "backfill": { "status": "done", "at": "2026-11-19T13:00:00.000Z", "error": null },
  "lastSyncedAt": "2026-11-19T21:00:05.000Z", "addedAt": "2026-11-19T13:00:00.000Z", "addedBy": "import" }
// PR
{ "url": "https://github.com/apache/airflow/pull/123", "number": 123, "title": "Fix scheduler race", "author": "AarushKarva", "authorName": "Aarush Anand Karva",
  "repo": "apache/airflow", "owner": "apache", "ownerType": "Organization", "stars": 38000, "state": "merged", "isDraft": false,
  "createdAt": "2026-10-01T10:00:00.000Z", "mergedAt": "2026-10-03T10:00:00.000Z", "closedAt": "2026-10-03T10:00:00.000Z",
  "additions": 40, "deletions": 5, "changedFiles": 3, "comments": 2, "reviews": 1, "campus": "ADYPU", "batch": 2026, "year": "1st year",
  "category": "open_source", "tier": "major", "reason": "major", "override": null, "overrideNote": null }
// Repo
{ "name": "apache/airflow", "owner": "apache", "ownerType": "Organization", "stars": 38000, "forks": 14000, "language": "Python", "license": "Apache-2.0",
  "description": "…", "isFork": false, "isArchived": false, "category": "open_source", "tier": "major", "reason": "major", "override": null, "overrideNote": null,
  "stats": { "prs": 14, "merged": 9, "open": 3, "closed": 2, "students": 6, "campuses": ["ADYPU", "RU"], "firstPrAt": "…", "lastPrAt": "…" } }
// Org
{ "login": "apache", "type": "Organization", "override": null, "overrideNote": null,
  "stats": { "repos": 3, "prs": 20, "merged": 12, "osPrs": 20, "osMerged": 12, "students": 8, "maxStars": 38000, "byCategory": { "open_source": 20 } } }
// Monthly
{ "month": "2026-10", "osOpened": 120, "osMerged": 80, "allOpened": 900 }
// Job (list form; GET /jobs/:id adds "log": ["line", …])
{ "id": "a1b2c3d4e5f6", "type": "sync", "runner": "cli", "status": "done", "params": { "full": false }, "createdAt": "…", "startedAt": "…", "finishedAt": "…",
  "progress": { "done": 2623, "total": 2623 }, "summary": { "students": 2623, "ok": 2620, "failed": 3, "prs": 412, "renamed": 1, "notFound": 2 }, "error": null }
// Rules
{ "tiers": { "major": 1000, "established": 200 }, "minStarsUserRepo": 200, "minStarsOrgRepo": 50,
  "nstOrgs": ["nst-sdc"], "nstOwnerKeywords": ["nst", "newton"], "practiceRepos": ["firstcontributions/first-contributions"],
  "practiceKeywords": ["hacktoberfest"], "allowOrgs": ["c2siorg"], "updatedAt": "2026-11-19T13:00:00.000Z" }
// CampusRow
{ "campus": "RU", "year": "2nd year", "batch": 2025, "students": 600, "withAnyPr": 420, "withOsPr": 90, "withOsMerged": 55, "withMajorMerged": 12,
  "totalPrs": 9000, "osPrs": 700, "osMerged": 400,
  "byCategory": { "open_source": 700, "practice": 300, "nst_internal": 2500, "peer_repo": 3000, "own_repo": 2000, "low_signal": 500 } }
```
Public:
```jsonc
// GET /api/health
{ "ok": true }
// GET /api/meta
{ "campuses": ["ADYPU", "RU", "SVYASA", "Unknown"],            // distinct values present among active students
  "years": ["1st year", "2nd year", "3rd year", "4th year", "Unknown"], "batches": [2026, 2025, 2024, 2023],
  "categories": ["open_source", "practice", "nst_internal", "peer_repo", "own_repo", "low_signal"], "tiers": ["major", "established", "emerging"],
  "lastSyncAt": "2026-11-19T21:40:00.000Z",                    // finishedAt of the latest done sync/import job, else max students.lastSyncedAt, else null
  "counts": { "students": 2623, "prs": 49210 },
  "rulesSummary": Rules }                                      // the full Rules object (it holds nothing private)
// GET /api/overview?campus=RU&year=2nd%20year
{ "filters": { "campus": "RU", "year": "2nd year" },
  "students": { "tracked": 600, "withAnyPr": 420, "withOsPr": 90, "withOsMerged": 55, "withMajorMerged": 12 },
  "prs": { "total": 9000, "merged": 6500, "osPrs": 700, "osMerged": 400, "osOpen": 120,
           "byCategory": { "open_source": 700, "practice": 300, "nst_internal": 2500, "peer_repo": 3000, "own_repo": 2000, "low_signal": 500 },
           "byState": { "open": 1200, "merged": 6500, "closed": 1300 },
           "osMergedByTier": { "major": 150, "established": 100, "emerging": 150 } },
  "topRepos":    [ { "name": "apache/airflow", "stars": 38000, "tier": "major", "osPrs": 14, "osMerged": 9, "students": 6 } ],   // computed over the filtered PRs, by osMerged desc
  "topOrgs":     [ { "login": "apache", "osPrs": 20, "osMerged": 12, "students": 8 } ],
  "topStudents": [ Student ],
  "monthly": [ Monthly ] }                                     // 24 items
// GET /api/campuses
{ "rows": [ CampusRow ],                                        // sorted by campus, then year
  "totals": [ CampusRow with "year": "All", "batch": null ],   // one per campus
  "total": CampusRow with "campus": "All", "year": "All", "batch": null }
// GET /api/students?campus=RU&sort=osMerged&page=1&limit=25
{ "items": [ Student ], "total": 1411, "page": 1, "limit": 25 }
// GET /api/students/:username
{ "student": Student, "monthly": [ Monthly ],                  // 24 items, this student only
  "repos": [ { "name": "apache/airflow", "stars": 38000, "category": "open_source", "tier": "major", "prs": 4, "merged": 3, "lastPrAt": "…" } ],  // all categories, by prs desc, max 100
  "prs": { "items": [ PR ], "total": 41, "page": 1, "limit": 25 } }   // category=all, newest first; further pages via /api/prs?author=…&category=all
// GET /api/prs?category=open_source&state=merged&author=&repo=&owner=&q=
{ "items": [ PR ], "total": 3812, "page": 1, "limit": 25 }
// GET /api/repos?category=open_source&sort=prs
{ "items": [ Repo ], "total": 640, "page": 1, "limit": 25 }
// GET /api/repos/:owner/:name
{ "repo": Repo, "owner": Org,
  "students": [ { ...Student, "prs": 4, "merged": 3 } ],        // counts in this repo, by merged desc, max 100
  "prs": { "items": [ PR ], "total": 14, "page": 1, "limit": 25 } }   // category=all; further pages via /api/prs?repo=…&category=all
// GET /api/orgs?sort=osMerged
{ "items": [ Org ], "total": 310, "page": 1, "limit": 25 }
// GET /api/orgs/:login
{ "org": Org, "repos": [ Repo ],                                // by stats.prs desc, max 100
  "students": [ { ...Student, "prs": 6, "merged": 4 } ] }       // counts in this org, by merged desc, max 100
// GET /api/export/students.csv   header row:
// username,name,campus,batch,year,total_prs,merged_prs,os_prs,os_merged,os_open,os_major_merged,os_repos,os_orgs,practice_prs,nst_internal_prs,peer_repo_prs,own_repo_prs,low_signal_prs,first_pr_at,last_pr_at
// GET /api/export/prs.csv        header row:
// url,author,author_name,campus,batch,year,repo,owner,owner_type,stars,title,state,is_draft,created_at,merged_at,closed_at,additions,deletions,changed_files,category,tier,reason
// any error
{ "error": { "code": "not_found", "message": "student not found" } }
```
Admin (prefix `/api/admin`):
```jsonc
// POST /login {"password":"…"}            → 200 + Set-Cookie
{ "ok": true }
// POST /logout
{ "ok": true }
// GET /me                                  (always 200; configured=false when ADMIN_PASSWORD is unset)
{ "admin": true, "configured": true }
// GET /students?q=&campus=&active=1&backfill=pending
{ "items": [ AdminStudent ], "total": 2623, "page": 1, "limit": 25 }
// POST /students {"username":"octocat","name":"","campus":"RU","batch":2026,"email":"","enrolmentNo":""}   → 201
{ "student": AdminStudent, "job": { "id": "a1b2c3d4e5f6" } }
// POST /students/bulk {"csv":"campus,batch,name,github_username\nRU,2026,A B,octocat\n"}   or {"rows":[{"github_username":"octocat","campus":"RU","batch":"2026"}]}
{ "results": [ { "row": 1, "username": "octocat", "status": "added", "error": null },
               { "row": 2, "username": "dup", "status": "exists", "error": null },
               { "row": 3, "username": "", "status": "invalid", "error": "github_username required" } ],
  "added": 1, "exists": 1, "invalid": 1, "job": { "id": "a1b2c3d4e5f6" } }        // job null when added = 0
// PATCH /students/:username {"campus":"ADYPU","batch":2025,"active":true}
{ "student": AdminStudent }
// DELETE /students/:username[?purge=1]
{ "ok": true, "purged": false, "prsRemoved": 0 }
// POST /students/:username/backfill
{ "job": { "id": "a1b2c3d4e5f6" } }
// POST /prs/override {"url":"https://github.com/o/r/pull/1","override":"not_open_source","note":"docs typo spam"}
{ "ok": true, "pr": PR, "affected": { "prs": 1 } }
// POST /repos/override {"repo":"o/r","override":"exclude","note":"tutorial repo"}
{ "ok": true, "repo": Repo, "affected": { "prs": 37, "repos": 1 } }
// POST /owners/override {"login":"some-org","override":"nst_internal","note":"club org"}
{ "ok": true, "org": Org, "affected": { "prs": 120, "repos": 9 } }
// GET /overrides
{ "prs":    [ { ...PR,   "overrideAt": "2026-11-19T13:00:00.000Z" } ],
  "repos":  [ { ...Repo, "overrideAt": "…" } ],
  "owners": [ { ...Org,  "overrideAt": "…" } ] }               // each newest first, not paged
// GET /review/repos?category=low_signal&minPrs=3&q=&override=none&sort=prs
{ "items": [ { ...Repo, "ownerOverride": null } ], "total": 900, "page": 1, "limit": 25 }
// GET /review/owners?q=&override=any&sort=prs
{ "items": [ Org ], "total": 5200, "page": 1, "limit": 25 }
// GET /rules
{ "rules": Rules }
// PUT /rules  (body = Rules without updatedAt)
{ "rules": Rules, "job": { "id": "a1b2c3d4e5f6" } }
// GET /jobs?type=&status=
{ "items": [ Job ], "total": 12, "page": 1, "limit": 25 }
// GET /jobs/:id
{ "job": { ...Job, "log": ["12:00:01 fetched octocat: 3 prs"] } }
// POST /jobs/sync {"users":["octocat"],"full":false}   |   POST /jobs/reclassify {}        → 202
{ "job": { "id": "a1b2c3d4e5f6" } }
```
