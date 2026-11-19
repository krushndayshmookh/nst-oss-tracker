
## API shapes (G) — `/api/owner/*` (owner-backend agent; binding for the owner UI)
(An identical copy of this section lives in `SPEC-ADDENDUM-G-api.md`, because several agents append to this file at the same time.)
Conventions: same as SPEC section 5/6 (no `_id`, ISO dates, `{error:{code,message}}`). Every response is `Cache-Control: no-store`.
State-changing requests need `X-Requested-With: oss-admin` (else 403). Auth failures: **401 `unauthorized`** with
`error.reason` = `"admin"` (no valid admin session: send the user to the admin login), `"owner"` (admin ok, page locked or the 2 h
unlock expired: show the password prompt) or `"password"` (wrong password on unlock). 429 `rate_limited` after 10 wrong passwords
in 15 min (per visitor). 503 `unavailable` while `OWNER_PASSWORD` is unset / shorter than 16 chars / a placeholder / equal to `ADMIN_PASSWORD`.
Only `/me`, `/unlock`, `/lock` work without the owner cookie. The cookie `oss_owner` is httpOnly, SameSite=Strict, `Path=/api/owner`, 2 h.
Program keys (defaults; the owner can add more): `gsoc`, `outreachy`, `lfx`, `processing`, `sob`, `mlh`, `other-major`.
Bands: `strong` | `possible` | `early` | `none` (labels Strong / Possible / Early / No signal).
Feature keys: `depth`, `substance`, `sustained`, `recency`, `engagement`, `breadth`, `trackRecord`.
Scores are a readiness heuristic 0–100: label them "readiness score". `labelMode` is `"readiness"` until calibration outcomes exist for
a program, then `"calibrated"` (the UI may then ALSO show the per-band past selection rate; the score itself is still never a probability).
```jsonc
// GET /me                      (always 200, no data; the admin top bar uses it to decide whether to prompt)
{ "admin": true, "configured": true, "unlocked": false, "expiresAt": null, "title": "Krushn's dashboard" }
// POST /unlock {"password":"…"}        → 200 + Set-Cookie oss_owner   (401 reason "password" | "admin", 429, 503)
{ "ok": true, "expiresAt": "2026-11-19T14:30:00.000Z" }
// POST /lock                           → clears the cookie (works even when already locked)
{ "ok": true }

// Shared objects
// ProgramScoreBrief (table cells)
{ "score": 71, "band": "strong", "bestOrg": "zulip", "prevScore": 64, "delta": 7, "prevBand": "strong",
  "mergedInBestOrg": 7, "prs": 12, "merged": 9, "lastActivityAt": "2026-11-14T08:06:41.000Z", "blockers": [] }
// Feature (detail only). points = share of the 0–100 score this feature contributes (value × weight × 100 / sum of weights)
{ "value": 0.85, "weight": 0.3, "points": 25.5, "explain": "6 merged PRs in zulip (best single org)",
  "detail": { "mergedInBestOrg": 6, "mergedInWindow": 5, "mergedBeforeWindow": 2, "weighted": 6 } }
//   detail per feature: depth {mergedInBestOrg, mergedInWindow, mergedBeforeWindow, weighted}; substance {merged, nonTrivial, share, medianLines};
//   sustained {activeWeeks, tenureDays}; recency {daysSinceLast, lastActivityAt}; engagement {interactionsPerPr, merged, decided, mergeRatio};
//   breadth {otherOrgs}; trackRecord {majorMerged}
// ProgramScore (detail) = ProgramScoreBrief plus
{ "features": { "depth": Feature, "substance": Feature, "sustained": Feature, "recency": Feature, "engagement": Feature,
                "breadth": Feature, "trackRecord": Feature },
  "orgs": [ { "login": "zulip", "prs": 10, "merged": 7, "open": 2, "closed": 1, "lastActivityAt": "…" } ],     // program orgs touched, best first
  "evidence": [ { "url": "https://github.com/zulip/zulip/pull/123", "title": "Fix narrow race", "repo": "zulip/zulip", "state": "merged",
                  "createdAt": "…", "mergedAt": "…", "additions": 140, "deletions": 22, "changedFiles": 5, "nonTrivial": true } ],   // max 5
  "nextStep": "Get a first PR merged in zulip: pick a small, well-scoped issue, respond to review quickly and finish it.",
  "timeline": [ { "weekStart": "2026-09-07", "opened": 2, "merged": 1 } ] }   // every week of the program window up to today, zero-filled (IST weeks, Monday start)
// ScoreRow (one student)
{ "username": "octocat", "name": "Octo Cat", "campus": "RU", "batch": 2025, "year": "2nd year",
  "prestigeScore": 71, "bestProgram": "gsoc", "bestBand": "strong", "bestOrg": "zulip", "realChance": true,   // bestProgram null (bestBand "none") when no prestigious program has a signal
  "lastActivityAt": "2026-11-14T08:06:41.000Z",        // last open-source PR activity (opened or merged), any org
  "flag": "shortlist",                                 // null | "shortlist" | "watch" | "not_applying"
  "hasNote": true,
  "blockers": [],                                      // blockers of bestProgram
  "programs": { "gsoc": ProgramScoreBrief, "outreachy": ProgramScoreBrief, "lfx": ProgramScoreBrief, "processing": ProgramScoreBrief,
                "sob": ProgramScoreBrief, "mlh": ProgramScoreBrief, "other-major": ProgramScoreBrief } }   // enabled programs only
// BandCounts
{ "strong": 4, "possible": 21, "early": 160, "none": 2615 }
// Program (settings)
{ "key": "gsoc", "name": "GSoC 2027", "enabled": true, "prestigious": true,
  "match": "orgs",                     // "orgs" (PRs in orgs/repos below) | "major" (any major-tier open-source project) | "open_source" (any open-source PR)
  "orgs": ["zulip", "sugarlabs"], "repos": ["processing/p5.js"], "orgSource": "gsoc-2025",   // orgSource: "gsoc-<year>" | "manual"
  "includeLowStar": true,              // also count PRs that are low_signal ONLY because of the star thresholds (small repos of a program org)
  "window": { "from": "2026-09-01", "to": "2027-04-08" }, "preWindowWeight": 0.5,
  "weights": { "depth": 0.3, "substance": 0.2, "sustained": 0.15, "recency": 0.1, "engagement": 0.1, "breadth": 0.05, "trackRecord": 0.1 },
  "notes": "", "eligibilityNote": "GSoC requires contributors to be 18 or older and new or beginner contributors to open source. …",
  "starter": false }                   // true = org list is an unverified starter list (show a warning until the owner reviews it)
// JobRef
{ "id": "a1b2c3d4e5f6", "type": "scores", "status": "queued", "createdAt": "…", "startedAt": null, "finishedAt": null,
  "progress": { "done": 0, "total": 0 }, "summary": null, "error": null }

// Freshness: scores are recomputed by a `scores` job after every sync / backfill / reclassify / import and after every settings change.
// GET /summary and GET /status also check: if anything changed since `computedAt` (an admin override, a new fetch, never computed) they
// queue a recompute themselves and answer `stale: true` with the `job`; poll GET /status until `job` is null, then reload (≈ 2 s on the full data).
// GET /summary?campus=&year=&batch=
{ "computedAt": "2026-11-19T12:00:05.000Z", "asOf": "2026-11-19", "trendDays": 30, "stale": false, "job": null,     // job: JobRef of a queued/running scores job
  "filters": { "campus": null, "year": null, "batch": null },
  "students": 2800,                                             // active tracked students in the filter (denominator)
  "realChance": { "count": 25, "per100": 0.9, "prevCount": 19, "delta": 6, "strong": 4, "possible": 21 },   // Strong or Possible in ≥1 enabled program with prestigious:true (strong = Strong in ≥1; possible = the rest)
  "bands": { "strong": 60, "possible": 35, "early": 10 },
  "programs": [ { "key": "gsoc", "name": "GSoC 2027", "prestigious": true, "window": { "from": "2026-09-01", "to": "2027-04-08" },
      "match": "orgs", "labelMode": "readiness", "starter": false, "orgs": 184, "eligibilityNote": "…",
      "counts": BandCounts, "prevCounts": BandCounts,           // prev = the same computation as of trendDays ago
      "delta": { "strong": 1, "possible": 4, "early": 12, "none": -17 },
      "avgScoreWithSignal": 23.4, "activeOrgs": 41,             // avg score of students not in "none" (null when nobody); program orgs with ≥1 NST PR
      "byCampus": [ { "campus": "RU", "students": 1504, "counts": BandCounts, "realChance": 14, "per100": 0.9, "smallCohort": false } ],   // realChance here = strong + possible in THIS program
      "byYear":   [ { "year": "2nd year", "batch": 2025, "students": 900, "counts": BandCounts, "realChance": 11, "per100": 1.2, "smallCohort": false } ],
      "byCampusYear": [ { "campus": "RU", "year": "2nd year", "batch": 2025, "students": 600, "counts": BandCounts, "realChance": 9, "per100": 1.5, "smallCohort": false } ],
      "calibration": null } ],                                  // or Calibration (see GET /outcomes)
  "byCampus": [ { "campus": "RU", "students": 1504, "realChance": 14, "per100": 0.9, "strong": 2, "possible": 12, "smallCohort": false } ],   // prestigious programs combined; 'Unknown' last; smallCohort = fewer than 30 students
  "byYear":   [ { "year": "2nd year", "batch": 2025, "students": 900, "realChance": 11, "per100": 1.2, "strong": 2, "possible": 9, "smallCohort": false } ],   // newest batch first
  "flags": { "shortlist": 6, "watch": 11, "not_applying": 2 },
  "disclaimer": "Readiness score: a transparent heuristic computed from public GitHub pull requests … It is not a probability of selection: …" }

// GET /students?campus=&year=&batch=&program=gsoc&band=strong,possible&org=zulip&flag=shortlist&realChance=1&q=&sort=gsoc&order=desc&page=1&limit=25
//   program: which program `band` / `org` / default sort refer to (default: best program per student → band filter uses bestBand, sort uses prestigeScore)
//   sort: prestigeScore (default) | <program key> | delta (of `program`, or of prestige) | name | campus | batch | lastActivityAt
//   band: comma list; org: a program-org login the student has PRs in; flag: shortlist|watch|not_applying|none; q: name / username substring; limit ≤ 100
{ "items": [ ScoreRow ], "total": 181, "page": 1, "limit": 25,
  "programs": [ { "key": "gsoc", "name": "GSoC 2027", "prestigious": true } ],           // column order for the heat cells (enabled programs)
  "computedAt": "2026-11-19T12:00:05.000Z" }

// GET /students/:username                       (404 for unknown or inactive students)
{ "student": { ...ScoreRow, "programs": { "gsoc": ProgramScore, "…": ProgramScore } },
  "note": { "note": "Met on 12 Nov, wants zulip.", "flag": "shortlist", "updatedAt": "2026-11-12T10:00:00.000Z" },   // note "" / flag null / updatedAt null when none
  "outcomes": [ Outcome ],                                      // past outcomes uploaded for this student
  "computedAt": "…" }

// PUT /students/:username/note {"note":"free text (≤ 5000 chars)","flag":"shortlist"|"watch"|"not_applying"|null}     (either field may be omitted: it is then kept)
{ "note": { "note": "…", "flag": "watch", "updatedAt": "…" } }

// GET /orgs?program=gsoc&campus=&minStudents=1&q=&sort=students|merged|prs|login&order=&page=&limit=    (limit default 50, max 200)
{ "program": "gsoc", "items": [ { "login": "zulip", "name": "Zulip", "url": "https://github.com/zulip",
      "students": 12, "prs": 80, "merged": 41, "open": 20, "strongOrPossible": 3, "bestOrgFor": 9, "crowded": true,   // bestOrgFor: students whose best org this is; crowded: bestOrgFor ≥ crowdedAt; strongOrPossible: of those, how many are Strong/Possible
      "campuses": { "RU": 8, "ADYPU": 4 },
      "people": [ { "username": "octocat", "name": "Octo Cat", "campus": "RU", "year": "2nd year", "prs": 12, "merged": 7,
                    "score": 71, "band": "strong", "isBestOrg": true, "lastActivityAt": "…" } ] } ],          // by merged desc, max 50 per org
  "total": 41, "page": 1, "limit": 50, "crowdedAt": 5, "computedAt": "…" }

// GET /programs
{ "programs": [ Program ], "bands": { "strong": 60, "possible": 35, "early": 10 }, "trendDays": 30, "crowdedAt": 5,
  "featureKeys": ["depth", "substance", "sustained", "recency", "engagement", "breadth", "trackRecord"],
  "featureHelp": { "depth": "Merged PRs in the student's best single program org (1 → 0.25, 3 → 0.6, 6 → 0.85, 10+ → 1). …", "…": "…" },
  "defaults": { "weights": { "depth": 0.3, "…": 0 }, "bands": { "strong": 60, "possible": 35, "early": 10 } },
  "updatedAt": "…", "computedAt": "…", "job": null }
// PUT /programs  body { "programs": [ Program ], "bands": {…}, "trendDays": 30, "crowdedAt": 5 }  (full document; validated → 400 with the first problem)
//   keys unique, [a-z0-9-]{2,24}; 1–20 programs; weights 0–100 and not all 0; 100 ≥ strong > possible > early ≥ 1; window.from < window.to;
//   trendDays 7–180; crowdedAt 2–100; orgs are GitHub logins (a github.com URL or @login is accepted), repos owner/name.
//   Saves and queues a `scores` recompute.                                              → 200
{ "programs": [ Program ], "bands": {…}, "trendDays": 30, "crowdedAt": 5, "updatedAt": "…", "job": JobRef }

// GET /program-orgs?program=gsoc&year=2025&mapped=0|1&q=           (the provenance table behind a program's org list; not paged; year defaults to the newest)
{ "program": "gsoc", "year": 2025, "years": [2025],
  "items": [ { "id": "gsoc:2025:zulip", "program": "gsoc", "year": 2025, "slug": "zulip", "name": "Zulip", "url": "https://zulip.com",
               "ideasUrl": "https://…", "logins": ["zulip"],
               "mappedBy": "link",       // "alias" (hand-checked, config/program-org-aliases.json) | "link" (a github.com link in the org's GSoC entry) | "name" (its name equals an organisation in our data) | "manual" (set on this page) | null (unmapped)
               "confidence": "high",     // "high" | "medium" | null
               "nstPrs": 80, "nstStudents": 12 } ],          // all-time PRs / students in those logins (any category)
  "total": 185, "mapped": 165, "unmapped": 20 }                // counts for the whole program-year, independent of mapped= / q=
// PUT /program-orgs/:id {"logins":["zulip","zulip-archive"]}        ([] unmaps; also adds/removes these logins in the program's `orgs` and queues a recompute; 404 unknown id)
{ "item": { …as above, "mappedBy": "manual" }, "job": JobRef }

// Outcome
{ "username": "octocat", "program": "gsoc", "year": 2025, "org": "zulip", "selected": true, "matched": true }   // matched: username is a tracked student
// Calibration (per program; absent / null when there are no outcomes for it)
{ "outcomes": 34, "matched": 30, "selected": 6, "years": [2025],
  "byBand": { "strong": { "applicants": 5, "selected": 3, "rate": 0.6, "smallSample": true },     // band = the score recomputed as of that year's window end
              "possible": { "applicants": 9, "selected": 2, "rate": 0.22, "smallSample": true },  // rate null when applicants = 0; smallSample when applicants < 10
              "early": { "applicants": 10, "selected": 1, "rate": 0.1, "smallSample": false },
              "none": { "applicants": 6, "selected": 0, "rate": 0, "smallSample": true } },
  "note": "Bands for past applicants are recomputed as of each year's application deadline with today's org list and weights." }
// GET /outcomes?program=&year=
{ "items": [ Outcome ], "total": 34, "calibration": { "gsoc": Calibration } }      // calibration is refreshed by the scores job that every upload / delete queues
// POST /outcomes {"csv":"username,program,year,org,selected\noctocat,gsoc,2025,zulip,yes\n","replace":false}   or {"rows":[{…}],"replace":true}     (body ≤ 2 MB, ≤ 5000 rows)
//   selected: yes/no/true/false/1/0; program must be a known key; year 2015–2035; username may be a github.com URL. Upserts on (username, program, year).
//   replace:true first deletes all outcomes of the program+year pairs present in the upload.
//   scripts/convert_gsoc_mentees.js turns NST's GSoC_Mentees.xlsx ("Proposals" tab) into this CSV.
{ "results": [ { "row": 1, "username": "octocat", "status": "saved", "error": null }, { "row": 2, "username": "", "status": "invalid", "error": "username required" } ],
  "saved": 1, "invalid": 1, "unmatched": 0, "job": JobRef }        // job null when nothing was saved
// DELETE /outcomes?program=gsoc&year=2025      (both optional: no params = delete all)
{ "ok": true, "deleted": 34, "job": JobRef }

// POST /recompute {}                           → 202   (409 `conflict` with error.jobId when a scores job is already queued/running)
{ "job": JobRef }
// GET /status
{ "computedAt": "…", "stale": false, "students": 2800, "job": null, "last": JobRef }      // last: the most recent finished scores job; its summary is only { students, programs, durationMs } (the job is visible on the admin Jobs page, so it carries no results)

// GET /export/students.csv?…same filters and sort as GET /students (no paging)      → text/csv, attachment "program-readiness.csv", no-store. Header:
// username,name,campus,batch,year,prestige_score,best_program,best_band,best_org,real_chance,flag,last_activity_at,
// <key>_score,<key>_band,<key>_best_org,<key>_delta   (repeated per enabled program; "-" in a key becomes "_"),blockers
```
