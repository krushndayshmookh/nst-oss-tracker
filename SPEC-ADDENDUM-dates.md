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
