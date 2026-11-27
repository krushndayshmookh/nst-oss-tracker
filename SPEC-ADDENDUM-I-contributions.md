# SPEC addendum I: all contribution types (issues raised, reviews given, open and closed PRs)

Binding for every agent on branch `all-contributions`. Where this file names a collection, field, function, route,
query parameter or JSON key, use exactly that name. SPEC.md and the earlier addenda stay in force unless changed here.

## I0. Goal and scope
Today the portal stores pull requests only and its pages headline merged PRs. After this change it also tracks:
- issues a student raised (`kind: 'issue'`),
- pull requests of other people a student reviewed (`kind: 'review'`, one document per student per reviewed PR),
- and it shows open and closed-without-merge PRs next to merged ones everywhere a merged count is shown.

Out of scope for this change (do not build): issue or PR comments, discussions, direct commits, per-item admin overrides
for issues and reviews, any change to `src/scores.js`, `src/owner.js`, `src/programs.js`, `src/pastResults.js`,
`routes/owner.js` or the private dashboard, any change to k8s manifests or the image tag, any deploy.

The `prs` collection and every existing PR field, route and response key stay as they are. Everything here is additive.

## I1. Collection `contributions`
`_id`: issue = the issue url. review = `<pr url>#review-by-<students._id>`.
```
{ _id, kind: 'issue'|'review', url, number, title (whitespace-collapsed),
  author (= students._id), authorLogin,
  repo ('owner/name'), repoLc, owner, ownerLc, ownerType: 'Organization'|'User', stars,
  state, createdAt: Date, closedAt: Date|null, updatedAt: Date|null,
  campus, batch, active                      // denormalised from the student, same rules as prs
  category, tier, reason,                    // same classify() as a PR by this author on this repo, no per-item override
  // kind 'issue' only
  ghId?, stateReason: 'completed'|'not_planned'|'duplicate'|'reopened'|null, comments: number,
  // kind 'review' only
  prUrl, prAuthor (login), prState: 'open'|'merged'|'closed', reviewCount: number, lastReviewedAt: Date }
```
- issue: `state` = `'open'|'closed'`; `createdAt`/`closedAt`/`updatedAt` are the issue's; `url` = issue url.
  `stateReason` maps GitHub's COMPLETED / NOT_PLANNED / DUPLICATE / REOPENED; any other value is null.
  An issue that comes back under a new url with the same `ghId` (transferred, or its repo renamed) replaces the stored
  document of that student under the old url, on incremental runs too (see I3).
- review: `number` and `title` are the PR's; `url` = url of the student's latest submitted review (fallback: the PR url);
  `createdAt` = `submittedAt` of the student's FIRST submitted review on that PR (the date the review counts on);
  only the LATEST 50 reviews are listed, so above 50 it is the earliest listed one, and a stored `createdAt` is never
  moved later (`$min` on upsert);
  `lastReviewedAt` = `submittedAt` of the latest; `reviewCount` = number of submitted reviews by the student on that PR;
  `closedAt` = null; `updatedAt` = the PR's `updatedAt`;
  `state` = `'approved'|'changes_requested'|'commented'|'dismissed'` = the state of the student's latest review whose
  state is APPROVED, CHANGES_REQUESTED or DISMISSED, else `'commented'`. Reviews in state PENDING are ignored.
  A PR whose author is the student (compare lowercase with `student._id` and `student.username`) is skipped.
  A PR node with no submitted review by the student is skipped.
- Items in private repositories are never stored.
- A contribution counts in a date range by `createdAt` only.
- Repo and owner metadata of every fetched item is upserted into `repos` / `owners` exactly as for PRs (reuse
  `repoUpsertOp` / `ownerUpsertOp` from `src/ingest.js`), so classification and admin repo / org overrides apply.
  Repos with `stats.prs == 0` stay hidden from public lists (unchanged rule).

Indexes (in `ensureIndexes`): `{author:1, kind:1, createdAt:-1}`, `{kind:1, category:1, createdAt:-1}`, `{repoLc:1, kind:1}`,
`{ownerLc:1, kind:1}`, `{campus:1, batch:1}`, `{createdAt:1, kind:1}`.
`db.js`: add `'contributions'` to `COLLECTIONS` and `contributions: db.collection('contributions')` to `collections(db)`.
Agents other than A read the collection with `db.collection('contributions')` so their code does not depend on A's edit.

Student document: new field `contribSyncedAt?: Date` (last error-free fetch of BOTH kinds). Admin-only, never public.

## I2. GitHub fetching (`src/github.js`)
Both functions have the contract of `fetchUserPRs` (same opts, same return shape `{ nodes, count, error, fatal, rateLimit }`,
never throw for GitHub-side failures, same paging, page shrinking, rate-limit handling and the `created:` year / month split
above 1000 results). Refactor `pageAll` / the search query so the node fields are a parameter; `fetchUserPRs` behaviour and
its existing tests must not change.
- `fetchUserIssues(username, {since?, ...opts})`: search query `author:<u> type:issue[ updated:>=YYYY-MM-DD]`.
  Node fields: `... on Issue{databaseId url number title state stateReason createdAt updatedAt closedAt
  author{login ... on User{databaseId}} comments{totalCount} repository{<the same repository fields as PR_FIELDS>}}`.
- `fetchUserReviews(username, {since?, ...opts})`: search query `reviewed-by:<u> type:pr -author:<u>[ updated:>=YYYY-MM-DD]`.
  Node fields: `... on PullRequest{databaseId url number title state createdAt updatedAt mergedAt closedAt author{login}
  reviews(last:50, author:"<u>"){totalCount nodes{state submittedAt url}} repository{<same repository fields>}}`
  (the latest 50 reviews, so the verdict and `lastReviewedAt` are right on long threads).
  `<u>` is validated by `isValidLogin` before it is put into the query text.
- Check both queries once against the real API (token in `.github-token`) before finalising; fix field names if GitHub rejects one.
Export both and add them to the default export.

## I3. Storing (`src/contributions.js`, new, agent A)
- `buildContributionDocs(student, kind, nodes)` -> `{ docs: [doc], repos: Map<repoLc, doc>, owners: Map<ownerLc, doc>, skippedPrivate }`
  (pure; no DB; applies every rule of I1; dedupes by `_id`).
  For kind issue it deletes the student's stored issues with the same `ghId` under another `_id`; for kind review it
  writes `createdAt` with `$min`.
- `upsertContributions(db, student, kind, nodes)` -> `{ contributions: n, added: n, repos: n }`. Upserts docs (`$set` of all
  fields), upserts repo / owner metadata (preserving overrides and stats), classifies with
  `classify({repo, ownerType, stars, isFork, repoOverride, ownerOverride, author}, ctx)` (no `prOverride`). `added` = documents
  that did not exist before. Does NOT touch aggregates.
- `pruneStaleContributions(db, student, kind, nodes)` -> `{ removed: n, skipped: '' | reason }`. After a COMPLETE full fetch of
  that kind: delete the student's stored docs of that kind that the fetch did not return. Guards as in `pruneStalePRs`:
  nothing removed when the fetch returned nothing, or when more than 20 and more than half would vanish (an issue
  fetched again under a new url with the same `ghId` counts as moved, not vanished).

`src/jobHandlers.js` (agent A): inside `processStudent`, after the PR part ended without error and the student was not
marked `not_found`, fetch both kinds:
- full fetch of a kind when the run is `full`, or the student has no `contribSyncedAt`; otherwise incremental with
  `since = contribSyncedAt - OVERLAP_DAYS`. So the first nightly run after release backfills every student by itself.
- full + complete (same completeness test as PRs) -> `pruneStaleContributions`.
- campus / batch / active come from the student as stored now, with the same "edited or removed while in flight" re-check
  the PR path has (apply to `contributions` what is applied to `prs`, including `deleteMany` on a removed student).
- both kinds error-free -> `$set: { contribSyncedAt: startedAt }`. An error in either kind: keep what was fetched, log
  `<id>: issues|reviews failed: <error>`, do NOT move `contribSyncedAt`, do NOT change the student's PR outcome
  (`ok` stays `ok`), add 1 to `summary.contribFailed`. A `fatal` error still aborts the run as today.
- After `MAX_CONSECUTIVE_FAILURES` (25) students in a row whose contribution fetch failed (reset by a student whose
  contribution fetch succeeded), the issue and review searches are skipped for the rest of the run; logged once as
  `issues and reviews skipped for the rest of this run after N consecutive failures`. PR syncing carries on;
  `contribSyncedAt` is not moved for skipped students, so the next run fetches them.
- Summary (also in `emptySummary`): `issues`, `issuesNew`, `reviews`, `reviewsNew`, `contribFailed`, `contribSkipped`
  (students whose contribution searches were skipped this way) (all numbers).
  The "done:" log line names the issue and review numbers.
The injected `opts.github` of tests may lack the two new functions: treat a missing function as "skip that kind" so the
existing fetch / schedule / jobs tests keep passing unchanged.

## I4. Derived data (agent B)
`src/classify.js` `reclassify(db, { prFilter, repoFilter, contribFilter, ctx })`:
- `contribFilter` omitted: `{}` when `prFilter` is `{}` (full recompute), otherwise skip contributions.
- `contribFilter` given (object): recompute category / tier / reason / stars of the matching contributions the same way
  as PRs (repo doc, repo override, owner override, author); `null` skips.
- Result gains `contributions`, `contributionsChanged`.
- Call sites that must pass it: admin repo override (`{repoLc}`), admin owner override (`{ownerLc}`), the star-drift
  branch of `upsertPRs` (`{repoLc: {$in: drifted}}`), `pruneStalePRs` repo moves (`{repoLc: {$in: repoIds}}`). Agent A adds
  it to the rename branch in `jobHandlers.js` (`{ownerLc: {$in: ids}}`).

`src/ingest.js` stats (all-time, `active:true` only). New keys are always present (0 / null):
- Student stats add: `osClosed` (open-source PRs in state closed), `totalIssues`, `osIssues`, `totalReviews`, `osReviews`,
  `osContributions` (= `osPrs + osIssues + osReviews`), `lastActivityAt` (max of PR `createdAt`, issue `createdAt`,
  review `lastReviewedAt`; null when none).
- Repo stats add: `issues`, `reviews`.
- Owner stats add: `issues`, `reviews`, `osIssues`, `osReviews`.
- `students` counts of repos and owners keep meaning "students with a PR" (unchanged).
- `emptyStudentStats()`, `emptyRepoStats()`, `emptyOwnerStats()` carry the new keys. `refreshAggregates(db)` fills them.
  Index for sorting: students `{'stats.osContributions': -1}` (agent A adds it in `db.js`).

`src/routes/admin.js`:
- `PATCH /students/:username` rewrites `campus` / `batch` / `active` on that student's contributions too;
  `DELETE ...?purge=1` deletes them; `prsRemoved` unchanged, response adds `contributionsRemoved`.
- Repo and owner override responses: `affected` adds `contributions`.
- Anything else in admin.js that updates or deletes `prs` by author gets the same statement for `contributions`.
- `PUT /rules` -> reclassify job already runs `reclassifyAll`, which now covers contributions.

## I5. Public API (agent C). All additive; existing keys keep their meaning.
Shared objects:
```jsonc
// Stats (student): existing keys plus
{ "osClosed": 1, "totalIssues": 7, "osIssues": 3, "totalReviews": 5, "osReviews": 2, "osContributions": 17, "lastActivityAt": "2026-11-20T10:00:00.000Z" }
// Repo.stats plus   { "issues": 4, "reviews": 2 }
// Org.stats plus    { "issues": 9, "reviews": 3, "osIssues": 9, "osReviews": 3 }
// Monthly plus      { "osIssues": 12, "osReviews": 4 }        // by createdAt month, same time zone rules as osOpened
// Contribution
{ "kind": "review", "url": "https://github.com/apache/airflow/pull/123#pullrequestreview-1", "number": 123, "title": "Fix scheduler race",
  "author": "AarushKarva", "authorName": "Aarush Anand Karva", "repo": "apache/airflow", "owner": "apache", "ownerType": "Organization",
  "stars": 38000, "state": "approved", "stateReason": null, "createdAt": "…", "closedAt": null, "comments": null,
  "prUrl": "https://github.com/apache/airflow/pull/123", "prAuthor": "someone", "prState": "merged", "reviewCount": 2, "lastReviewedAt": "…",
  "campus": "ADYPU", "batch": 2026, "year": "1st year", "category": "open_source", "tier": "major", "reason": "major" }
// for kind "issue": prUrl, prAuthor, prState, reviewCount, lastReviewedAt are null; stateReason and comments are set
```
With a date range, the ranged student / repo / org stats carry the same new keys, counted over contributions whose
`createdAt` is in the range (`osClosed`: open-source PRs opened in the range that are closed now; `lastActivityAt`: latest
in-range date). Implement in `src/ranged.js`: `contribGroupStats(db, { by, range, match })` -> `Map<id, { issues, osIssues,
reviews, osReviews, lastAt }>` and let `studentStats` / `repoStats` / `ownerStats` take it as an optional second argument
(missing -> zeros), so current callers and tests keep working.

Routes:
- `GET /api/contributions?kind=issue|review` (`kind` default `issue`; other values 400). Filters as `/api/prs`:
  `author`, `repo`, `owner`, `campus`, `year`, `batch`, `category` (default `open_source`, `all` allowed), `tier`,
  `state` (issue: `open|closed`; review: `approved|changes_requested|commented|dismissed`; a value of the other kind -> 400),
  `q` (title + repo), `from` / `to` / `range` on `createdAt`. Sort: `createdAt` (default) | `stars` | `lastReviewedAt`.
  -> `{ "range": Range, "kind": "issue", "items": [Contribution], "total": 0, "page": 1, "limit": 25 }`.
- `GET /api/export/contributions.csv?kind=…&filters` header row:
  `kind,url,author,author_name,campus,batch,year,repo,owner,owner_type,stars,title,state,state_reason,created_at,closed_at,pr_url,pr_author,pr_state,review_count,last_reviewed_at,category,tier,reason`
  (same export limits as `prs.csv`).
- `GET /api/export/students.csv`: append at the END of the header: `os_closed_prs,total_issues,os_issues,total_reviews,os_reviews,os_contributions`.
- `GET /api/meta`: add `"kinds": ["pr","issue","review"]`, `"features": { "contributions": true }`, `counts.issues`, `counts.reviews` (active only).
- `GET /api/overview`: add
  `"contributions": { "osPrsOpen": 0, "osPrsMerged": 0, "osPrsClosed": 0, "osIssues": 0, "osIssuesOpen": 0, "osIssuesClosed": 0, "osReviews": 0, "osApprovals": 0, "osChangesRequested": 0, "totalIssues": 0, "totalReviews": 0 }`
  (`osPrsOpen` / `osPrsClosed`: open-source PRs opened in the range by current state; `osPrsMerged` = `prs.osMerged`; issue
  and review numbers by `createdAt` in the range, cohort filters applied), and in `students`:
  `"withOsIssue"`, `"withOsReview"`, `"withOsContribution"` (at least one open-source PR, issue or review in the range).
  `monthly` items carry `osIssues`, `osReviews`.
- `GET /api/students`: `sort` also accepts `osOpen`, `osIssues`, `osReviews`, `osContributions`; new filter `hasContribution=1`
  (`stats.osContributions > 0`, ranged: computed). Items carry the new stats keys.
- `GET /api/students/:username`: add `"issues": { items, total, page, limit }` and `"reviews": { … }` (first page, 25, every
  category, newest first, range applied). `monthly` carries the new keys. Further pages: `/api/contributions?author=…&category=all`.
- `GET /api/repos`, `/api/repos/:owner/:name`, `/api/orgs`, `/api/orgs/:login`: stats carry the new keys (ranged too).
  `/api/repos/:owner/:name` and `/api/orgs/:login` answer for a repo / owner with `stats.prs > 0` OR `stats.issues > 0`
  OR `stats.reviews > 0` (contribution rows link to the project page); the list endpoints keep `stats.prs > 0`.
- `GET /api/activity`: `metric` also accepts `issues` and `reviews` (same response shape, counted over `contributions` of
  that kind by `createdAt`; all other filters unchanged).
- `GET /api/campuses` and `/api/campuses/:campus`: every block in `rows`, `totals`, `total` (and `years`, `overall`) adds
  `osOpen`, `osIssues`, `osReviews`, `withOsIssue`, `withOsReview`. No per-100 rates or deltas needed for them.
- The response cache key list `KNOWN_PARAMS` gains `kind` and `hasContribution`. Private student fields stay private:
  a Contribution carries only the keys listed above.

Admin jobs: summary objects simply pass the new numbers of I3 through (no route change).

## I6. Frontend (agent D). Vanilla modules, existing helpers, existing look. No new dependency.
Every new read of a new key uses a fallback (`?? 0`, `|| []`): pages must render against an API without this addendum.
New UI is shown only when `meta.features?.contributions` is true.
- Nav: the link to `#/prs` is labelled `Contributions`. The page gets tabs `Pull requests | Issues | Reviews`
  (hash query `kind`, empty = pull requests). Issues and Reviews tabs call `/api/contributions`, same filter bar minus
  tier where it makes no sense, state options per kind, CSV button -> `/export/contributions.csv`. The PR tab keeps its
  behaviour; its state filter stays (open / merged / closed).
- Overview: a section "Open-source contributions" with stat cards: Merged PRs, Open PRs, Closed without merge, Issues raised,
  Reviews given, Students with any contribution (`students.withOsContribution`). The monthly chart gains two series
  (Issues raised, Reviews given).
- Students list: new sortable columns Open PRs (`osOpen`), Issues (`osIssues`), Reviews (`osReviews`); "Last PR" becomes
  "Last activity" (`lastActivityAt`, fallback `lastPrAt`). Default sort stays `osMerged`.
- Student profile: stat cards add "Issues raised" (`osIssues`, sub: total) and "Reviews given" (`osReviews`, sub: total), and
  the open-source PR card's sub line shows open and closed-without-merge. The list card at the bottom becomes tabs
  `Pull requests | Issues | Reviews` (hash query `tab`), the PR tab with state chips All / Open / Merged / Closed (hash query
  `state`, passed to `/api/prs`). The monthly chart gains the two series.
- Project and organisation pages: show issues and reviews counts beside the PR counts, each linking to the Contributions
  page filtered by `repo` / `owner` and `kind`. A project without PRs shows one PR card (0), no PR tables, a short note.
- Campus pages: add Open PRs, Issues, Reviews columns to the campus x year table.
- Activity page: metric choices add "Issues raised" and "Reviews given".
- About page: a short paragraph on what is counted (PRs in every state, issues raised, reviews given on other people's PRs;
  comments and direct commits are not counted).
- Admin, Jobs and Scheduled fetch run summaries: show issues and reviews numbers when present.
- Shared helpers go in `public/js/pages/common.js` or `public/js/lib/ui.js` (`contributionTable(items, ctx, opts)`,
  labels `KIND_LABELS`, `REVIEW_STATE_LABELS`). Never `innerHTML` with API data.
- Copy rules: plain sentences, British spelling as in the existing pages, no em dashes.

## I7. Ownership (edit only your files; use targeted edits, never rewrite a whole existing file)
- A: `src/github.js`, `src/contributions.js` (new), `src/jobHandlers.js`, `src/db.js`, `test/helpers/github.js`, new `test/contrib-fetch.test.js`.
- B: `src/classify.js`, `src/ingest.js`, `src/routes/admin.js`, new `test/contrib-derive.test.js`.
- C: `src/ranged.js`, `src/routes/public.js`, `src/routes/common.js`, `src/campuses.js`, `src/csv.js`, new `test/contrib-api.test.js`.
- D: everything under `public/`, `DESIGN.md`, new `test/contrib-ui.test.js`.
- Nobody in the build phase edits existing test files, `README.md`, `SPEC*.md`, `package.json`, `k8s/`, `scripts/`. An existing
  test that fails only because of an intended contract change of this addendum is reported, not edited; the integration
  agent updates it. Nobody runs `git add`, `git commit`, `git stash`, `git checkout` or any other git write in the build phase.

## I8. Environment
- Repo on the Mac: `/Users/krushn/Studio/education-system/oss-status`, branch `all-contributions` (already checked out,
  `npm ci` done). Run node, tests, docker, git and gh on the Mac through Desktop Commander `start_process`, with
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH` first.
- Tests need a mongod: `MONGOD_BIN=$PWD/.tmp/mongod-docker.sh node --test test/<file>.test.js` (the wrapper runs the local
  `mongo:8.0` Docker image). Whole suite: `MONGOD_BIN=$PWD/.tmp/mongod-docker.sh node --test`.
- Baseline on `main` (27 Nov 2026): 167 tests, 162 pass, 3 skipped, 2 fail. The 2 failures predate this work and are not
  yours to fix: "scheduler recovery: same selection as the cut-off run..." (`test/schedule.test.js`) and "k8s manifests:
  MongoDB needs credentials..." . Full output: `.tmp/baseline-test.log`.
- GitHub is mocked in tests (see `test/helpers/github.js`). A real token for manual checks: file `.github-token`
  (never print it, never commit it, never put it in a file that is not git-ignored).
