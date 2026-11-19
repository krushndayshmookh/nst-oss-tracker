# SPEC addendum A — date ranges, academic year, activity analytics

Requirement from Krushn (19 Nov 2026): every statistic must be viewable for a date range. The range that matters by
default is the current academic year (1 Jul 2026 – 30 Jun 2027); next year the default moves. We also want to see *when*
students work: by month, week, date, day of week, time of day.

## A1. Academic year (AY)
- `settings` doc `{ _id:'academicYear', current:{ label:'2026-27', start:'2026-07-01', end:'2027-06-30' }, history:[…same shape] }`.
  Seeded on first boot. Admin can edit (Rules page → "Academic year" section): changing `current` pushes the old one to `history`.
- Timezone for ALL date bucketing and range boundaries: `Asia/Kolkata` (config `TZ_NAME`, default Asia/Kolkata). A range
  `from=2026-07-01&to=2027-06-30` means 2026-07-01T00:00 IST inclusive to 2027-07-01T00:00 IST exclusive.
- `GET /api/meta` adds `academicYear:{current, history}`, `tz`, and `presets`: [{key:'ay', label:'AY 2026-27', from, to}, previous AYs,
  {key:'30d'}, {key:'90d'}, {key:'12m'}, {key:'all'}].

## A2. Range semantics (one definition, used everywhere)
- A PR is **opened in range** if `createdAt` ∈ range; **merged in range** if `mergedAt` ∈ range.
- For a range, a student's numbers are: `opened` (created in range), `merged` (merged in range, regardless of when opened),
  same for the open-source subset (`osOpened`, `osMerged`, `osMajorMerged`), `osRepos`/`osOrgs` (distinct, among PRs opened or merged in range).
- "Students with ≥1 merged open-source PR" for a range = students with `osMerged ≥ 1` in that range.
- Every public endpoint that returns counts or lists accepts `from` and `to` (YYYY-MM-DD, both optional). **If neither is given the
  server applies the current AY** and echoes `range:{from,to,label,preset}` in the response. `range=all` gives all-time.
- Precomputed `stats` on students/repos/owners stay as all-time values (used for `range=all` and admin review); ranged numbers are
  computed with aggregation pipelines over `prs` (add indexes `{mergedAt:1, category:1}`, `{createdAt:1, category:1}`, `{author:1, mergedAt:1}`).
  Budget: any ranged endpoint < 700 ms on the full dataset; cache identical queries in memory for 60 s (invalidate on any admin write / job end).
- Student `year` label stays "as of today"; when the selected range lies in a past AY, the UI shows the batch (e.g. "Batch 2024") next to it.
- Sorting/filters on lists (students, repos, orgs) operate on the ranged numbers when a range is active.

## A3. Activity analytics
`GET /api/activity?from&to&campus&year&batch&category(default open_source; all allowed)&author&repo&owner&metric=opened|merged`
→ `{ range, tz, totals:{opened, merged, activeStudents},
     byMonth:[{month:'2026-07', opened, merged, activeStudents}],
     byWeek:[{weekStart:'2026-07-06', opened, merged}],
     byDate:[{date:'2026-07-01', opened, merged}]            // every day in range, zero-filled (cap 800 days; else omit with `truncated:true`)
     byWeekday:[{dow:1..7 (Mon=1), opened, merged}],
     byHour:[{hour:0..23, opened, merged}],
     heatmap:[{dow, hour, opened, merged}],                  // 7×24, IST
     byCampusMonth:[{campus, month, opened, merged}],
     busiest:{ day:{date,count}, week:{weekStart,count}, month:{month,count} } }`
Uses `$dateTrunc` / `$dateToParts` with `timezone`. The same endpoint powers per-student (`author=`), per-repo and per-org activity.
`/api/overview` `monthly` is replaced by this endpoint's `byMonth` for the active range (zero-filled).

## A4. UI
- Global **date-range control** in the header of every public page: preset chips (AY 2026-27 default, previous AY, Last 30 days, Last 90 days,
  Last 12 months, All time) + custom from/to date inputs. Stored in the URL query (`?from=&to=` or `?range=all`) so links are shareable and
  survive navigation; default (no params) = current AY. Every page shows the active range in its heading ("AY 2026-27 · 1 Jul 2026 – 30 Jun 2027").
- New public page **Activity** (nav item): monthly bars (opened vs merged), GitHub-style calendar heatmap by date, day-of-week bars,
  hour-of-day bars, day×hour heatmap, campus-by-month comparison, "busiest day/week/month" callouts; filters campus / year / category / metric.
- Overview: headline cards and the campus×year table respect the range; add a compact activity strip (monthly + weekday) linking to Activity.
- Student profile, repo page, org page: ranged numbers + a calendar heatmap and weekday chart for that entity.
- CSV exports respect the range.
- Admin Rules page: "Academic year" editor (label, start, end) with validation (start < end, ≤ 400 days).

## A5. Tests
Range boundaries in IST (a PR merged 30 Jun 2027 23:50 IST counts in AY 2026-27; 1 Jul 2027 00:10 IST does not), PR opened before the
range and merged inside it, zero-filling, weekday/hour bucketing in IST vs UTC, default-range behaviour when AY changes, cache invalidation.

# SPEC addendum B — admin "missing data" filter (Krushn, 19 Nov 2026)
- `GET /api/admin/students` accepts `missing=` (comma list, OR-combined; `missing=any` = any of them):
  `batch` (null), `campus` ('Unknown' or empty), `name` (empty), `email` (empty), `enrolmentNo` (empty),
  `nameUnofficial` (nameSource != 'sheet'), `githubId` (never resolved), `unresolved` (GitHub account not found on last fetch).
  Response adds `missingCounts:{batch, campus, name, email, enrolmentNo, nameUnofficial, githubId, unresolved, any}` (independent of the active filter).
- Each student row in the admin list carries `missing:[...]` so the UI can show what is absent.
- Admin Students page: a "Missing data" filter group (chips with counts, e.g. "No batch · 33") separate from the normal campus/year/search filters;
  rows show small badges for each missing field; **inline editing** of name, campus, batch, email, enrolment number directly in the table
  (save per row via `PATCH /api/admin/students/:username`, optimistic UI, toast on error) so a filtered list can be filled quickly;
  CSV export of the current filtered admin list, and bulk CSV upload updates existing students (matched on username) instead of failing on duplicates.
- Fetchers set `unresolvedSince` on a student when GitHub no longer finds the account and clear it when it resolves.
- Tests: each `missing` value, `missing=any`, counts, inline PATCH validation (batch 2015–2035 or null; campus in enum).

# SPEC addendum C — manage the scheduled fetch from the admin UI (Krushn, 19 Nov 2026)
Scheduling moves INTO the app (replicas: 1, in-process runner already exists). The k8s CronJob `40-cronjob-sync.yaml` is removed
(keep the file as `40-cronjob-sync.yaml.disabled` with a comment; README explains). `scripts/sync.js` stays for manual/CLI runs.
- `settings` doc `{ _id:'schedule', enabled:true, paused:false, pausedUntil:null, pauseNote:'', dailyAt:'02:30' (IST, TZ_NAME),
  fullRefreshDay:null|0-6 (optional weekly full refresh), concurrency:6, lastRunAt, lastRunJobId, lastRunStatus, nextRunAt }`.
- Scheduler (src/scheduler.js): ticks every 30 s; when `now >= nextRunAt` and not paused and no sync job queued/running, enqueues a
  `sync` job (`trigger:'schedule'`) and computes the next `nextRunAt`. On boot: if the last scheduled run was missed by > 1 h and not paused,
  run once (catch-up), never more than once. `pausedUntil` auto-resumes. All state persisted so restarts are safe.
- Job runner additions: cooperative **cancel** (`POST /api/admin/jobs/:id/cancel` sets `cancelRequested`; sync/backfill loops check between
  students and stop cleanly with status `cancelled`, keeping what was already saved); a sync job records per-run summary
  `{studentsChecked, studentsFailed, prsNew, prsUpdated, newMerged, rateLimitRemaining, durationMs}`; the incremental `since` window is derived
  from each student's own `lastSyncedAt`, so pausing for days loses nothing.
- Admin API: `GET /api/admin/schedule` (settings + `running` job if any + last 14 runs summary), `PUT /api/admin/schedule` (dailyAt, enabled,
  fullRefreshDay, concurrency; validated), `POST /api/admin/schedule/pause {until?, note?}`, `POST /api/admin/schedule/resume`,
  `POST /api/admin/jobs/sync {full?:bool, users?:[...], campus?, batch?}` (trigger now: incremental by default; `full:true` = full refresh of
  history for the selected students or everyone), `POST /api/admin/jobs/:id/cancel`. Triggering while a sync is running returns 409 with the running job id.
- Admin UI, Jobs page → "Scheduled fetch" panel: status line (Active / Paused until … / Disabled; next run time in IST; last run result),
  buttons **Fetch now**, **Full refresh** (confirm dialog stating it re-reads every student's whole history and roughly how long it takes),
  **Pause** (optional until-date + note), **Resume**, **Cancel running job**; edit daily time and optional weekly full-refresh day;
  live progress of the running job (students done / total, log tail); table of recent runs with their summaries.
- Public `/api/meta.lastSyncAt` = finish time of the last successful sync; public footer shows "Data updated <relative time>" and a
  subtle "updates paused" note when paused.
- Tests: schedule fires once at the right IST time (fake clock), not while paused, auto-resume at `pausedUntil`, catch-up on boot once,
  409 on concurrent trigger, cancel mid-run keeps saved data and marks `cancelled`, restart during a run marks it interrupted and the next tick recovers.

# SPEC addendum D — per-student scaling for campus comparisons (Krushn, 19 Nov 2026)
Campuses differ a lot in size (RU ~1,500 tracked students, SMRU ~50), so raw side-by-side counts mislead.
- Denominator = number of ACTIVE tracked students in the group (same campus/year/batch filters as the numerator), returned by the API
  so the UI never hard-codes it: `/api/activity` adds `cohorts:[{campus, students}]` and each `byCampusMonth` row adds
  `per100Opened`, `per100Merged` (count / students × 100, 1 decimal) and `activeStudents` + `activePct` (distinct students with ≥1 PR of the
  selected category that month / students × 100). `/api/campuses` rows add `osMergedPer100`, `osPrsPer100`, `withOsMergedPct`, `withAnyPrPct`.
- Activity page "Campuses by month": a toggle **Per 100 students (default) | Share of students active | Raw counts**; the chart title and
  axis state the unit; tooltip shows both the rate and the raw count with the cohort size ("RU · 12.4 per 100 · 187 PRs · 1,504 students").
  Legend labels carry cohort size ("RU (1,504)"). Small cohorts (< 30 students) get a "small cohort" marker because rates swing widely.
- Same toggle on every other side-by-side campus comparison: the overview campus × year table gets rate columns
  ("% with merged OS PR", "merged OS PRs per 100 students") next to the raw ones and sorts by the rate by default; any campus bar/line chart
  defaults to per-100.
- Year-wise comparisons within a campus use the same per-100 logic (cohort = that campus-year).
- About page: one paragraph explaining the denominator (students with a known GitHub username, not full batch strength).
- Tests: rates equal count/students×100 for a fixture; zero-student cohort yields null, not Infinity/NaN; filters change the denominator.

# SPEC addendum E — small admin fixes (Krushn, 19 Nov 2026)
- Review queues (repos AND owners): the button for the state a row is already in is disabled and greyed (`aria-disabled`, tooltip
  "Already included"/"Already excluded"/"Already NST internal"). This reflects the EFFECTIVE state: an explicit override, or (for a repo with
  no override) its rule-based category — open_source ⇒ "Include" greyed; low_signal/practice/etc ⇒ "Exclude" greyed only when an explicit
  exclude override exists (a rule-based low-signal repo can still be explicitly excluded? No: grey "Exclude" only for explicit excludes;
  grey "Include" when explicitly included). Show a small "by rule" / "by admin" tag next to the category so the difference is visible, and a
  "Reset to rule" action when an explicit override exists. Buttons update immediately after a click (no reload). Same on the PR mark/unmark page.
- Missing-data chip "githubId": relabel "Not yet checked on GitHub"; keep "Account not found" (unresolved) as a separate chip.
- Review queues: clicking a repo or org row (or a "View" action) opens a detail drawer/panel WITHOUT leaving the queue (filters, page and
  scroll position preserved; closable with Esc; deep-linkable via `&open=<repo|owner>`): header with name, link to GitHub, stars, owner type,
  current category + by rule/by admin, the include/exclude/NST-internal/reset buttons; tabs **PRs** (title linked to GitHub, author, state,
  dates, lines changed, per-PR mark/unmark; filter by state; paginated) and **Students** (name, username, campus, year, PRs / merged in this
  repo-or-org, link to public profile); for an org also a **Repos** tab (each with its own include/exclude). Numbers respect an all-time view
  by default with a toggle to the current academic year. Uses existing endpoints (`/api/prs?repo=|owner=&category=all`, `/api/repos/:o/:n`,
  `/api/orgs/:login`) with admin fields where needed. Keyboard: j/k or arrows move between rows, Enter opens, i/e apply include/exclude.
- PR classification buttons (admin PR page, and the PRs tab of the review detail panel): same greying rule as repos/orgs. A PR explicitly
  marked "not open source" has its "Not open source" button disabled+greyed ("Already marked not open source"); one explicitly marked
  "open source" has that button greyed; "Reset to rule" appears only when an explicit mark exists. Show "by rule"/"by admin" (and, when the
  PR's category comes from its repo/org decision, "via repo"/"via org" with a link to that row). Buttons update immediately after a click.
- "Mix" bars (students list, and anywhere the stacked category bar appears: profiles, repos, orgs, admin lists): hovering or keyboard-focusing
  the bar (and tapping it on touch screens) opens a popover with the breakdown for the ACTIVE date range: one row per category with its colour
  swatch, label, count and share ("Open source · 12 · 40%"), merged count for open source, and the total; categories with 0 omitted; ordered
  as in the bar. The bar gets `tabindex=0`, `role="img"` with an `aria-label` carrying the same text, and the popover is positioned to stay
  inside the viewport (flips above/below; on 375px it becomes a small sheet). Implement once as a shared helper in public/js/lib/ui.js
  (`mixBar(byCategory, {merged})`) and use it everywhere instead of per-page copies. Also add a compact legend for the bar colours above
  any table that shows a Mix column.

# SPEC addendum F — public "Campuses" tab (Krushn, 19 Nov 2026)
New nav item **Campuses** (`#/campuses`) and a campus page (`#/campuses/:campus`). Respects the global date range. Rates use addendum D
(per 100 tracked students; cohort sizes always shown; small-cohort marker < 30).
- `#/campuses` comparison page:
  1. Scorecard row: one card per campus (ADYPU, RU, SVYASA, SMRU): tracked students, % with a merged OS PR, merged OS PRs per 100 students,
     merged in major projects, change vs the previous equal-length period (▲/▼).
  2. Comparison table campus × year (rows grouped by campus, subtotal per campus): students, with any PR, with OS PR, with merged OS PR (+%),
     OS PRs, merged OS PRs (+ per 100), major merged; sortable; raw/rate toggle; CSV export.
  3. Charts (each with the Per 100 | Share active | Raw toggle): monthly merged OS PRs by campus (lines); participation funnel per campus
     (tracked → any PR → OS PR → merged OS → major merged, as % of tracked); tier mix per campus (major/established/emerging, 100% stacked);
     category mix per campus (100% stacked, shows how much work is own-repo / internal vs real OS); year-wise bars within each campus.
  4. Distribution: per campus, how concentrated the work is — share of merged OS PRs from the top 10% of students, median merged OS PRs
     among contributors, count of students with 1 / 2-4 / 5-9 / 10+ merged OS PRs.
  5. Top 5 orgs and top 5 repos per campus (side by side), and orgs shared by ≥2 campuses.
- `#/campuses/:campus` page: the same blocks for one campus plus year-wise breakdown, activity strip (monthly + weekday + calendar heatmap),
  top 20 students, top repos/orgs, link to the students list filtered to that campus. Linked from every campus name across the site.
- API: `GET /api/campuses` (extended: rows + per-campus totals + rates + previous-period deltas + distribution buckets + tier/category mix),
  `GET /api/campuses/:campus` (profile blocks above). Same range/caching/latency rules as addendum A (≤ 700 ms cold).
- 'Unknown' campus is listed last and excluded from charts by default (toggle to include).
- Tests: subtotals equal sums of rows; campus totals equal overview totals for the same range; rates/denominators; delta vs previous period;
  distribution buckets sum to contributors.

# SPEC addendum G — "Krushn's dashboard": private program-readiness scores (Krushn, 19 Nov 2026)
Goal of the whole product: know how many students, and who, stand a real chance of selection in GSoC and other prestigious open-source
programs (Outreachy, LFX Mentorship, Processing Foundation fellowships, Summer of Bitcoin, MLH Fellowship, …).

## G1. Access
- Link "Krushn's dashboard" in the admin top bar (visible to any logged-in admin). Opening it ALWAYS asks for a second password
  (`OWNER_PASSWORD`, separate secret, ≥ 16 chars; 503 if unset). Separate httpOnly cookie `oss_owner` (HMAC, 2 h expiry, path /api/owner),
  requires a valid admin session too; same rate limiting / constant-time compare / CSRF header as admin login; explicit "Lock" button.
- All data under `/api/owner/*`; nothing from this addendum is reachable with only the admin cookie or publicly; responses `no-store`;
  never cached in the shared public cache; scores are never written into public collections' public fields or exports.
- Frontend code for the page is a separate module loaded only after unlock (`public/js/owner/*`); it contains no data.

## G2. Programs (config, editable on the private page; stored in `settings` `_id:'programs'`)
Each program: `{ key, name, enabled, orgs:[logins], repos:[owner/name], orgSource?:'gsoc-<year>'|'manual', window:{from,to} (contribution
period that matters, e.g. GSoC 2027: 2026-09-01 → 2027-04-08), weights:{…}, notes, eligibilityNote }`.
Seeded programs: `gsoc` (GSoC 2027), `outreachy`, `lfx` (LFX Mentorship), `processing` (Processing Foundation: processing/*, p5.js),
`sob` (Summer of Bitcoin), `mlh` (MLH Fellowship), plus `other-major` (any major-tier open-source project) as a general signal.
- Org lists: `scripts/fetch_program_orgs.js` pulls the GSoC organisation list for a year from the public GSoC API and maps each org to its
  GitHub org login(s) (from the org's source/website links; unmatched ones listed for manual mapping); other programs start from a curated
  seed list in `config/programs.seed.json` that the owner can edit in the UI. A collection `program_orgs` keeps `{program, year, name, logins, url}`.

## G3. Score (transparent heuristic, NOT a calibrated probability — say so on the page)
Per student × program, computed from PRs in the program's orgs/repos (category open_source or allow-listed), inside the program window and
before it, into features, each 0..1, then a weighted sum mapped to 0–100 and a band (Strong / Possible / Early / No signal):
- depth: merged PRs in the student's BEST single program org (saturating, e.g. 1→.25, 3→.6, 6→.85, 10+→1) — selection is per org, so
  concentration in one org matters more than spread;
- substance: share of merged PRs that are non-trivial (additions+deletions ≥ 30 and changedFiles ≥ 2, excluding docs/typo-only by title
  heuristics) and median size;
- sustained: distinct active weeks in that org in the window, and tenure (first→last PR span);
- recency: activity in the last 45 days (decays);
- engagement: review rounds/comments on their PRs (maintainer interaction), merge ratio;
- breadth (small weight): other program orgs touched;
- track record: merged PRs in major-tier projects overall.
Output per student×program: `{score, band, bestOrg, features:{…}, evidence:[top PR urls], blockers:[e.g. "no merged PR in a GSoC org",
"all activity older than 90 days", "only docs-size PRs"], nextStep}`. Weights and band thresholds are editable; every score shows its
breakdown ("why"). An overall `prestigeScore` = max over enabled prestigious programs.
- Calibration: optional upload of past outcomes (`{username, program, year, org, selected}`), e.g. NST's GSoC 2025/2026 results; the page then
  shows, per band, how many past applicants were selected, and can display an estimated selection rate per band ("of 14 past students in
  band Strong, 5 were selected"). Until outcomes exist the page labels numbers "readiness score", never "probability".
- Eligibility caveats shown, never inferred: Outreachy has applicant eligibility criteria the data cannot see; GSoC requires 18+ and
  open-source-beginner status. The app must not infer gender or any protected attribute.

## G4. Page
- Summary: per program, counts by band, by campus and year (with per-100 rates), trend vs 30 days ago; "students with a real chance" =
  band Strong or Possible in ≥ 1 prestigious program.
- Table: student, campus, year, best program, score per program (heat cells), best org, last activity, blockers; filters campus/year/
  program/band/org; search; sort by any score; CSV export (private).
- Student drawer: score breakdown per program, evidence PRs, timeline in the program window, next-step suggestion, free-text private note
  and a manual flag (Shortlist / Watch / Not applying) stored in a private collection `owner_notes`.
- Org view: for each program org, which NST students are active there (so mentors can avoid 10 students crowding one org).
- Settings: programs, org lists, windows, weights, thresholds, outcome upload, recompute.
- Scores recompute after each sync and on settings change (job type `scores`), stored in private collection `program_scores`.

## G5. Tests
Access (no owner cookie ⇒ 401 even with admin cookie; public/admin endpoints never include scores), scoring features on fixtures,
window boundaries in IST, band thresholds, recompute idempotent, org mapping, CSV private.

# API shapes (D, F) — written by CAMPUS-BACKEND, binding for the UI
Implemented in `src/campuses.js`, `src/ranged.js` (`activity`), `src/routes/public.js`; tests in `test/campuses.test.js`.
The examples are real answers of the full import (2,800 students) for AY 2026-27 on 19 Nov 2026, shortened.

Conventions used by every number below:
- **Rate** = `count / students × 100`, rounded to 1 decimal. `students` = ACTIVE tracked students of that group (the cohort).
  **A cohort of 0 students gives `null`** for every rate (never 0, Infinity or NaN): render "–".
- `…Pct` = share of the cohort's students (0–100); `…Per100` = PRs per 100 students of the cohort (can exceed 100).
- `smallCohort: true` when `0 < students < 30` (`smallCohortBelow` is echoed so the UI never hard-codes 30). An empty cohort is not "small".
- Campus order everywhere: `ADYPU, RU, SVYASA, SMRU, Unknown` (Unknown last; the UI hides it from charts by default).
- Counts follow addendum A2 (opened = createdAt in range, merged = mergedAt in range). Same `from` / `to` / `range` params, same 60 s cache,
  no other query parameters on the two campus endpoints.

## GET /api/activity (addendum D additions; everything else unchanged)
New top-level `cohorts` and `smallCohortBelow`; every `byCampusMonth` row gains `students, per100Opened, per100Merged, activeStudents, activePct`.
- The denominator follows the `campus` / `year` / `batch` filters of the request (not `author` / `repo` / `owner` / `category`):
  `?year=1st year` → cohort = first-year students of each campus; `?campus=RU` → one cohort.
- `activeStudents` = distinct students of that campus with ≥1 PR opened or merged that month in the selected category (same definition as
  `byMonth[].activeStudents`; the campus values of a month add up to it). `activePct` = that / `students` × 100.
- `byCampusMonth` stays sparse (only campus-months with ≥1 event: zero-fill against `byMonth[].month`), sorted by campus (order above), then month.
- `cohorts` lists every campus with ≥1 active student under the filters, plus any campus that appears in `byCampusMonth` (then `students: 0`
  and `null` rates on its rows).
```json
{ "range": {"from":"2026-07-01","to":"2027-06-30","label":"AY 2026-27","preset":"ay"}, "tz":"Asia/Kolkata", "metric":"opened",
  "totals": {"opened":3124,"merged":1652,"activeStudents":281},
  "byMonth": [{"month":"2026-10","opened":870,"merged":401,"activeStudents":172}],
  "byWeek": [], "byWeekday": [], "byHour": [], "heatmap": [],
  "byCampusMonth": [
    {"campus":"ADYPU","month":"2026-10","opened":157,"merged":60,"students":1002,"per100Opened":15.7,"per100Merged":6,"activeStudents":35,"activePct":3.5},
    {"campus":"RU","month":"2026-10","opened":559,"merged":287,"students":1504,"per100Opened":37.2,"per100Merged":19.1,"activeStudents":93,"activePct":6.2},
    {"campus":"SVYASA","month":"2026-10","opened":152,"merged":54,"students":240,"per100Opened":63.3,"per100Merged":22.5,"activeStudents":42,"activePct":17.5},
    {"campus":"SMRU","month":"2026-10","opened":1,"merged":0,"students":49,"per100Opened":2,"per100Merged":0,"activeStudents":1,"activePct":2},
    {"campus":"Unknown","month":"2026-10","opened":1,"merged":0,"students":5,"per100Opened":20,"per100Merged":0,"activeStudents":1,"activePct":20} ],
  "cohorts": [ {"campus":"ADYPU","students":1002,"smallCohort":false}, {"campus":"RU","students":1504,"smallCohort":false},
               {"campus":"SVYASA","students":240,"smallCohort":false}, {"campus":"SMRU","students":49,"smallCohort":false},
               {"campus":"Unknown","students":5,"smallCohort":true} ],
  "smallCohortBelow": 30,
  "busiest": {"day":null,"week":null,"month":null}, "byDate": [] }
```

## GET /api/campuses
`{ range, previousRange, smallCohortBelow, campuses, rows, totals, total, sharedOrgs }` (about 34 kB for the full dataset).
- `rows`: one **stat block** + `distribution` per campus × year (only groups with ≥1 student), sorted by campus, then year (1st … 4th, alumni, Unknown).
- `totals`: one stat block per campus that has ≥1 student (`year:"All"`) **with the extras** `funnel, distribution, previous, delta, topOrgs, topRepos`.
  Subtotal invariant: every count of `totals[campus]` (and each `byCategory` / `tierMix` cell) = the sum of that campus's `rows`; every count of `total` = the sum of `totals`.
- `total`: the same shape for all campuses together (`campus:"All"`, includes Unknown). It equals `/api/overview` for the same range; a
  `totals` entry equals `/api/overview?campus=<campus>`.
- `campuses`: the scorecard list with cohort sizes: ADYPU, RU, SVYASA, SMRU always (`students: 0` when a campus has no tracked student yet: it
  then has NO entry in `totals` / `rows`, show "no tracked students"), Unknown only when it has students.
- `previousRange`: the equal-length period right before the range, used for `previous` / `delta`. A range that ends in the future is cut at
  today first (AY 2026-27 on 19 Nov 2026 = 1 Jul – 19 Nov = 142 days, compared with the 142 days before 1 Jul). `null` for `range=all` and for a
  range without `from`; `previous` and `delta` are then `null` too. The previous period is measured on TODAY's roster (there is no historical one).
- `sharedOrgs`: owners with open-source PRs (opened or merged in range) from students of ≥2 campuses (Unknown is not counted as a campus),
  by `osMerged` desc then `osPrs`, max 50.
```json
{ "range": {"from":"2026-07-01","to":"2027-06-30","label":"AY 2026-27","preset":"ay"},
  "previousRange": {"from":"2026-02-09","to":"2026-06-30","days":142},
  "smallCohortBelow": 30,
  "campuses": [ {"campus":"ADYPU","students":1002,"smallCohort":false}, {"campus":"RU","students":1504,"smallCohort":false},
                {"campus":"SVYASA","students":240,"smallCohort":false}, {"campus":"SMRU","students":49,"smallCohort":false},
                {"campus":"Unknown","students":5,"smallCohort":true} ],
  "rows": [ {
    "campus":"RU", "year":"2nd year", "batch":2025,
    "students":575, "withAnyPr":241, "withOsPr":45, "withOsMerged":30, "withMajorMerged":23,
    "totalPrs":3380, "osPrs":580, "osMerged":345, "osMajorMerged":142,
    "byCategory": {"open_source":580,"practice":1,"nst_internal":141,"peer_repo":813,"own_repo":984,"low_signal":861},
    "smallCohort":false,
    "withAnyPrPct":41.9, "withOsPrPct":7.8, "withOsMergedPct":5.2, "withMajorMergedPct":4,
    "totalPrsPer100":587.8, "osPrsPer100":100.9, "osMergedPer100":60, "osMajorMergedPer100":24.7,
    "tierMix": { "opened": {"major":297,"established":185,"emerging":98}, "merged": {"major":142,"established":130,"emerging":73} },
    "distribution": { "contributors":30, "buckets": {"1":8,"2-4":4,"5-9":9,"10+":9}, "median":5.5, "max":79,
                      "top10PctStudents":3, "top10PctMerged":154, "top10PctShare":44.6 }
  } ],
  "totals": [ {
    "campus":"RU", "year":"All", "batch":null, "students":1504, "…":"every stat-block field shown above",
    "funnel": [ {"key":"tracked","label":"Tracked students","count":1504,"pct":100},
                {"key":"anyPr","label":"Any PR","count":778,"pct":51.7},
                {"key":"osPr","label":"Open-source PR","count":159,"pct":10.6},
                {"key":"osMerged","label":"Merged open-source PR","count":114,"pct":7.6},
                {"key":"majorMerged","label":"Merged in a major project","count":89,"pct":5.9} ],
    "distribution": { "contributors":114, "buckets": {"1":30,"2-4":27,"5-9":27,"10+":30}, "median":4.5, "max":79,
                      "top10PctStudents":12, "top10PctMerged":571, "top10PctShare":51.4 },
    "previous": { "students":1504, "withAnyPr":662, "withOsPr":113, "withOsMerged":67, "withMajorMerged":52,
                  "totalPrs":6455, "osPrs":1015, "osMerged":547, "osMajorMerged":216,
                  "withOsMergedPct":4.5, "osPrsPer100":67.5, "osMergedPer100":36.4, "osMajorMergedPer100":14.4 },
    "delta": { "osMerged":564, "osMergedPct":103.1, "osPrs":1027, "osMajorMerged":361, "withOsMerged":47,
               "withOsMergedPct":3.1, "osMergedPer100":37.5 },
    "topOrgs":  [ {"login":"apache","osPrs":239,"osMerged":169,"students":16}, {"login":"sugarlabs","osPrs":135,"osMerged":99,"students":10} ],
    "topRepos": [ {"name":"sugarlabs/musicblocks","stars":930,"tier":"established","osPrs":133,"osMerged":98,"students":8} ]
  } ],
  "total": { "campus":"All", "year":"All", "batch":null, "…":"same shape as a totals entry" },
  "sharedOrgs": [ {"login":"apache","campuses":3,"osPrs":266,"osMerged":188,"students":20,
                   "byCampus": [ {"campus":"ADYPU","osPrs":25,"osMerged":19,"students":3}, {"campus":"RU","osPrs":239,"osMerged":169,"students":16},
                                 {"campus":"SVYASA","osPrs":2,"osMerged":0,"students":1} ]} ]
}
```
Field notes:
- Stat-block counts: `students` (cohort), `withAnyPr` / `withOsPr` / `withOsMerged` / `withMajorMerged` (students), `totalPrs` / `osPrs`
  (opened in range), `osMerged` / `osMajorMerged` (merged in range; "major" = tier major). Scorecard = `students`, `withOsMergedPct`,
  `osMergedPer100`, `osMajorMerged`, `delta`.
- `byCategory` IS the category mix (PRs opened in range per category; sums to `totalPrs`). `tierMix.merged` sums to `osMerged`, `tierMix.opened` to `osPrs`.
- `funnel[].pct` = % of tracked (null for an empty cohort); the steps are nested (each is a subset of the one before).
- `distribution`: `contributors` = students with ≥1 merged OS PR in range (= `withOsMerged`); `buckets` (keys `"1"`, `"2-4"`, `"5-9"`, `"10+"`) sum
  to `contributors`; `median` = median merged OS PRs among contributors (null when there are none; can end in .5); `top10PctStudents` =
  ceil(10 % of contributors), at least 1; `top10PctShare` = % of the group's merged OS PRs that came from them (null when there are none).
- `delta` = current − previous: plain differences (`withOsMergedPct` and `osMergedPer100` in points). `delta.osMergedPct` is the RELATIVE
  change of `osMerged` in % (null when the previous value is 0). ▲ when > 0, ▼ when < 0, nothing when 0 or null.
- `topOrgs` / `topRepos`: by `osMerged` desc, then `osPrs`; 5 each here (10 on the campus page). `students` = distinct students of that
  campus (of all campuses in `total`). Only owners / repos with open-source PRs in range.
- Monthly lines per campus: `/api/activity?category=open_source` → `byCampusMonth` (`per100Merged` | `activePct` | `merged` for the three toggle states).
- Year-wise bars within a campus: the `rows` of that campus (cohort = that campus-year).

## GET /api/campuses/:campus
`:campus` is one of ADYPU, RU, SVYASA, SMRU, Unknown (case-insensitive; the answer carries the canonical spelling); anything else → 404
`not_found`. A campus of the list without students answers 200 with zeros, `null` rates and empty lists.
```json
{ "range": {"from":"2026-07-01","to":"2027-06-30","label":"AY 2026-27","preset":"ay"},
  "previousRange": {"from":"2026-02-09","to":"2026-06-30","days":142}, "smallCohortBelow": 30,
  "campus": "RU",
  "totals":  { "…":"the totals entry of /api/campuses for this campus: stat block + funnel, distribution, previous, delta (topOrgs / topRepos are top-level here)" },
  "overall": { "…":"plain stat block of all campuses together (campus:\"All\"), for 'vs all campuses' comparisons" },
  "years":   [ { "…":"the rows of /api/campuses for this campus (stat block + distribution; cohort = that campus-year)" } ],
  "monthly": [ {"month":"2026-07","osOpened":305,"osMerged":156,"allOpened":1766,"osOpenedPer100":20.3,"osMergedPer100":10.4} ],
  "topStudents": [ {"username":"alice","name":"Alice","campus":"RU","batch":2025,"year":"2nd year",
                    "stats":{"totalPrs":157,"mergedPrs":91,"osPrs":103,"osMerged":79,"osOpen":16,"osMajorMerged":48,"osRepos":16,"osOrgs":11,
                             "byCategory":{"open_source":103,"practice":0,"nst_internal":0,"peer_repo":7,"own_repo":17,"low_signal":30},
                             "firstPrAt":"2026-07-01T17:36:50.000Z","lastPrAt":"2026-11-15T12:21:41.000Z","lastOsMergedAt":"2026-11-19T11:47:49.000Z"}} ],
  "topRepos": [ {"name":"sugarlabs/musicblocks","stars":930,"tier":"established","osPrs":133,"osMerged":98,"students":8} ],
  "topOrgs":  [ {"login":"apache","osPrs":239,"osMerged":169,"students":16} ],
  "sharedOrgs": [ {"login":"apache","campuses":3,"osPrs":266,"osMerged":188,"students":20,"byCampus":[{"campus":"ADYPU","osPrs":25,"osMerged":19,"students":3}]} ] }
```
- `topStudents`: up to 20 students with ≥1 merged OS PR in range, by `osMerged` desc then `osPrs` (the public student shape with ranged `stats`).
- `topRepos` / `topOrgs`: up to 10 each. `sharedOrgs`: the entries of `/api/campuses.sharedOrgs` that include this campus (totals over all campuses + `byCampus`).
- `monthly`: zero-filled months of the range up to today (same rules as `/api/overview.monthly`), with per-100 rates on this campus's cohort.
- Activity strip (monthly + weekday + calendar heatmap): `/api/activity?campus=<campus>` (existing endpoint; `byMonth`, `byWeekday`, `byDate`).
- Students list filtered to the campus: `/api/students?campus=<campus>` (existing).
