# NST Open Source Status

Public dashboard of open-source work (GitHub pull requests in every state, issues raised and reviews given) by
Newton School of Technology students, with a password-protected admin area. Production: <https://oss.nstsdc.org>.

- Node 22 (ESM), Express, MongoDB (official driver). No build step: `public/` is served as is.
- One container image serves the API and the frontend and also runs the scripts.
- `SPEC.md` is the design reference (schema, classification rules, API shapes). `DESIGN.md` covers the UI.

```
src/        server, config, db, classification, GitHub client, ingest, jobs, routes
scripts/    import_legacy.js  sync.js  backfill.js  reclassify.js
public/     static frontend (index.html = public site, admin.html = admin area)
k8s/        Kubernetes manifests (kustomize)
test/       node --test, runs against a real mongod
data/       students.csv + raw/<username>.json   (git-ignored, not in the image)
legacy/     the Python scripts that produced data/ (reference only)
```

## Configuration

All configuration is by environment variable. `.env.example` lists every variable with comments.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGODB_DB` | `oss_status` | database name |
| `ADMIN_PASSWORD` | unset | admin password. While unset, the admin API answers 503. In production it must be at least 16 characters and not a placeholder, or the admin area stays closed (503) |
| `OWNER_PASSWORD` | unset | second password of the private page "Krushn's dashboard" (see below). Not a placeholder, different from `ADMIN_PASSWORD`; while unset or weak the page answers 503 |
| `SESSION_SECRET` | random per process | signs the admin cookie (together with the password, so changing the password signs everyone out). In production: required, at least 32 characters |
| `GITHUB_TOKEN` | unset | needed by sync, backfill and "add student" validation. Public read access is enough |
| `GITHUB_API_URL` | `https://api.github.com` | optional API base (GraphQL at `<base>/graphql`); for GitHub Enterprise or a local fake server in tests |
| `NODE_ENV` | `development` | `production` makes the admin cookie `Secure` |
| `SYNC_CONCURRENCY` | `6` | students fetched in parallel by `scripts/sync.js` / `scripts/backfill.js`, and the first value of the scheduled fetch's own setting (afterwards that one is changed in Admin, Jobs, "Scheduled fetch", Settings) |
| `TRUST_PROXY` | `1` | number of reverse proxies in front of the app |
| `CLIENT_IP_HEADER` | unset | header with the visitor's address behind a CDN (`CF-Connecting-IP` on the cluster). Used as the key of the login and request limits; only believed when the TCP peer is a private address |
| `TZ_NAME` | `Asia/Kolkata` | time zone of every date range, chart bucket, the academic year and the nightly fetch time |
| `SCHEDULER` | on | `off` stops the in-app nightly fetch (for a second, read-only instance or local development) |
| `PUBLIC_CACHE_MS` | `60000` | how long identical public API answers are served from memory |
| `RATE_LIMIT_PER_MIN` / `EXPORT_LIMIT_PER_MIN` | `300` / `6` | per-visitor budgets for the public API and for CSV exports; `0` disables |
| `MAX_CONCURRENT_EXPORTS` | `2` | CSV exports running at the same time |

## Local development

Requirements: Node 22+, a MongoDB 7 or 8 on localhost (for example `docker run -d -p 27017:27017 mongo:7`).

```sh
npm install                       # also copies Chart.js to public/vendor/chart.umd.js
cp .env.example .env              # set ADMIN_PASSWORD (and GITHUB_TOKEN if you want to fetch)
node --env-file=.env src/server.js            # or: node --env-file=.env --watch src/server.js
```

Public site: <http://localhost:3000>. Admin area: <http://localhost:3000/admin>. Health: `/api/health`.

Tests: `npm test` (`node --test`). The tests start their own `mongod` on a random port with a temporary data
directory; set `MONGOD_BIN` if `mongod` is not on the `PATH`. GitHub is mocked, no token is needed.

## Scripts

Every script reads `MONGODB_URI` / `MONGODB_DB` from the environment (add `--env-file=.env` locally) and records
its run in the `jobs` collection, so it shows up on the admin Jobs page with runner `cli`.

### Import the existing data: `scripts/import_legacy.js`

```sh
node scripts/import_legacy.js [--data <dir>] [--fetched-at <ISO date>]
```

- `--data` (default `./data`): directory with `students.csv` and `raw/<username-lowercase>.json`.
- `--fetched-at`: when the raw files were fetched from GitHub. It becomes every student's `lastSyncedAt`.
  Default: the latest PR timestamp in the dataset minus 3 days.
- No GitHub token needed. PRs in private repositories are skipped. Ends with a full classification and
  aggregate refresh.
- Idempotent and insert-only: a second run adds what is missing and changes nothing else. It never puts the file
  contents over overrides, admin edits or anything a later sync stored (PR state, stars, tiers), so it is safe to
  re-run at any time. The files are a starting point; GitHub is the source of truth afterwards.
- Measured on the current dataset (2,623 students, 49,210 PRs, 39 private PRs skipped): about 8 seconds.

### Daily fetch: the in-app scheduler, or `scripts/sync.js` by hand

The app starts the nightly fetch itself (02:30 IST by default). It is managed from Admin, Jobs, "Scheduled fetch":
time of day, optional weekly full refresh, pause (with an optional end date) and resume, fetch now, full refresh,
cancel the running fetch, and the results of the last 14 runs. `scripts/sync.js` remains for manual runs from a
terminal (below). How the scheduler behaves:

- It looks at the clock every 30 seconds, so a run starts up to 30 seconds after the set time. The time is in
  `TZ_NAME` (IST). One run per night; if another fetch is still queued or running at that moment, the nightly run
  waits for it and starts right after.
- The state lives in MongoDB (`settings` document `schedule`), not in the pod, so a restart loses nothing:
  - The app was down at the scheduled time (however many nights): one catch-up run starts when it boots.
  - The pod restarted in the middle of a fetch (deploy, node drain, crash): on boot that job is marked
    `error: interrupted`, and the scheduler starts it again once (`trigger: recovery`) with the same selection
    (full or incremental, campus, batch, users). Students the cut-off run had already finished are skipped, and
    everything it saved is kept. If the recovery run is cut off as well, nothing more starts by itself; the next
    nightly run picks up from each student's own last fetch time.
  - Neither happens while the schedule is paused or switched off.
- Pause stops the nightly run only; "Fetch now" still works. Pausing for days loses nothing, because each
  student's fetch window starts at that student's last successful fetch. On Resume (or when the pause end date
  passes) a nightly run that was missed meanwhile starts once, within 30 seconds.
- Cancel stops the running fetch between two students (within a few seconds, also when it is waiting for GitHub's
  rate limit). What was fetched until then stays and is counted; the run is listed as `cancelled`.
- Parallelism is the "Students fetched in parallel" setting of the schedule (1 to 16), used by scheduled runs and by
  "Fetch now" / "Full refresh".
- "Data updated ..." on the public pages is the finish time of the last run that ended `done`; a cancelled or
  failed run does not move it. While paused the footer adds "Updates are paused".

```sh
node scripts/sync.js [--users a,b] [--full] [--limit N] [--campus C] [--batch YYYY] [--concurrency N]
```

- Default: every active student. Students whose history is already loaded get an incremental fetch (PRs, issues
  and reviewed PRs updated since their last successful sync minus 2 days). Students still `pending` get their full history. Students
  whose account was not found are skipped until an admin re-runs their backfill.
- `--full`: re-read the whole history of the selected students.
- `--users`, `--campus`, `--batch`, `--limit`: restrict the run.
- A full fetch is also the clean-up: PRs stored under a URL GitHub no longer returns (repository renamed,
  transferred, deleted or made private, account renamed) are removed, and an admin decision on a moved PR or
  repository moves with it. Nothing is removed when GitHub returns nothing at all, or when more than half of a
  student's stored PRs would vanish: that is treated as a GitHub hiccup and logged.
- Students whose GitHub id is not known yet (every imported student at first) are looked up once a week until it is:
  a login that no longer exists is flagged "GitHub user not found" (Admin, Students, Missing data) instead of
  silently returning no PRs forever.
- Campus, batch and active state are read again right before each student's PRs are written, so an edit or a
  deactivation made in the admin area during a long run is never undone by that run.
- Requires `GITHUB_TOKEN`. Exit code 1 only on total failure (no token, database unreachable, or every student
  failed), 2 on bad arguments. A failed student keeps its old `lastSyncedAt`, so the next run retries the same window.

### Contribution types

Three kinds of work are stored for every tracked student:

- Pull requests the student opened, in every state: open, merged and closed without merge (collection `prs`).
- Issues the student raised (collection `contributions`, `kind: 'issue'`).
- Reviews the student gave on pull requests of other people, one document per student per reviewed pull request
  (collection `contributions`, `kind: 'review'`). The verdict is the student's latest approval, change request or
  dismissal, else "commented". Pending reviews and reviews on the student's own pull requests are not counted.

Items in private repositories are never stored. Issues and reviews are classified like a pull request by the same
student to the same repository, so repo and organisation overrides apply to them too; there are no per-item
overrides for them. An item counts in a date range by the date it was opened (issues) or first reviewed (reviews).
Comments, discussions and direct commits are not counted.

Each student is fetched with three GitHub searches: pull requests, issues and reviewed pull requests. Issues and
reviews are fetched after the pull requests, with their own fetch time (`contribSyncedAt`, admin only). A student
without that time gets the full history of both, so the first nightly run after this release backfills issues and
reviews for every student by itself; later runs are incremental. A failed issue or review search is logged, counted
in the run summary ("contribution fetches failed") and retried in full or from the old window by the next run; it
does not mark the student's pull request fetch as failed. After 25 students in a row whose issue or review search
failed, those searches are skipped for the rest of the run (logged once, counted as "skipped" in the summary); pull
requests are still fetched, and the skipped students are fetched again by the next run.

The GitHub request budget is about three times larger than before: three searches per student per night instead of
one, and more on the backfill night for students with long histories. A full nightly run over every student may
therefore wait once for GitHub's hourly rate limit; the run continues by itself when the limit resets.

### Old work of new students: `scripts/backfill.js`

```sh
node scripts/backfill.js --users a,b     # full history of these tracked students
node scripts/backfill.js --pending       # every active student whose backfill is pending (the default)
```

Requires `GITHUB_TOKEN`. Normally you do not run this by hand: adding a student in the admin area queues the
backfill inside the app.

### Recompute categories: `scripts/reclassify.js`

```sh
node scripts/reclassify.js
```

Recomputes category, tier and reason of every PR and repo with the current rules, then all aggregates. No flags.
The admin area does this automatically after a rules change.

## Admin guide

Open `/admin` (link in the footer of the public site) and enter the admin password. The session lasts 12 hours.
Ten wrong passwords within 15 minutes lock the login for that visitor's address only (the address Cloudflare
reports in `CF-Connecting-IP`); other admins are not affected. When wrong passwords arrive from many addresses
(more than 30 in 15 minutes in total), every login is answered about 1.5 seconds slower instead of being blocked.
Changing `ADMIN_PASSWORD` and restarting the app signs every admin out.

Everything outside `/admin` is public and read-only. Student email, enrolment number, sources and notes are
visible only in the admin area.

| Task | Where |
| --- | --- |
| Add a student and fetch their old work | Students: add one (GitHub username or profile URL, campus, batch). A backfill job for the full history starts automatically |
| Add many students, or fill in details of existing ones | Students, "Add or update many": paste or upload CSV with the columns of `students.csv`. Only `github_username` is required. New students are added (one backfill job covers them); students already tracked are updated from the columns that have a value. "Download CSV" gives the current filtered list in the same format |
| Find students with missing data | Students: the "Missing data" chips (no batch, no campus, no name, no e-mail, no enrolment number, name not from the sheet, GitHub account not confirmed, GitHub user not found) |
| Edit, deactivate, re-fetch a student | Students: edit a row, deactivate (hides the student and their PRs from the public site, nothing is deleted), or re-run the backfill |
| Mark a PR as not open source (or force it to count) | PRs: search, then mark or unmark |
| Mark a repo or an organisation as not a valuable contribution | Review: one click per repo or owner: include, exclude, or (owners) "NST internal", with a note |
| Undo any of those | Overrides: list of all current overrides |
| Change thresholds and keyword lists | Rules: star thresholds, NST orgs and keywords, practice repos and keywords, always-allowed orgs. Saving queues a reclassify job |
| See, start, pause or cancel fetch runs | Jobs, "Scheduled fetch": next run, Fetch now, Full refresh, Pause / Resume, Settings (time, weekly full refresh), Cancel running fetch, recent runs. Below it: status and log of every job, sync selected students, reclassify |
| Change the academic year | Rules, "Academic year": label, first and last day. It is the default date range of every public page and moves on by itself each 1 July. A year that starts after the current one ends is a new year (the old one stays as an earlier range); any other edit corrects the current year. Earlier ranges can be removed there |

The note typed with a decision is private: the public site shows that an admin decision exists, never its reason.

Overrides on PRs, repos and owners apply immediately. "Valuable contribution" means category `open_source`;
the headline numbers are merged open-source PRs and students with at least one of them. The About page of the
public site explains the classification with the current rules.

## Private page: "Krushn's dashboard" (program readiness)

A link in the admin top bar, visible to every admin, opens a page that only its owner can read: it **always asks for a
second password** (`OWNER_PASSWORD`), which unlocks it for 2 hours in that browser ("Lock" closes it at once). Without
that password an admin session gets `401` from every `/api/owner/*` route; nothing of it appears in the public site,
the admin pages, the exports or the job list.

What it shows: for each active student and each program (GSoC, Outreachy, LFX Mentorship, Processing Foundation,
Summer of Bitcoin, MLH Fellowship, plus "other major projects" as a general signal) a **readiness score** from 0 to 100
with a band (Strong / Possible / Early / No signal), the reasons behind it, blockers, evidence PRs and a suggested next
step. It is a transparent heuristic over public pull requests (depth in one organisation, substance, sustained weeks,
recency, maintainer interaction, breadth, track record), **not a probability of selection**, and it says so. Weights,
band thresholds, contribution windows and organisation lists are editable on the page (Settings). It never infers
eligibility, gender or any other protected attribute; eligibility notes are shown as text to check with the student.

| Piece | Where |
| --- | --- |
| Scores (private collection `program_scores`) | recomputed by a `scores` job after every fetch, backfill, reclassify or import, after every settings change, and when the page finds them older than the data |
| Program settings | `settings` document `programs`, seeded on first boot from `config/programs.seed.json` and never overwritten afterwards |
| GSoC organisation list | `scripts/fetch_program_orgs.js --year 2026 --apply` fetches the list of that year from the GSoC archive, maps each organisation to its GitHub login(s) (hand-checked aliases in `config/program-org-aliases.json`, then github.com links in the organisation's own entry, then its name against organisations already in the data) and replaces the program's list. `--file <saved.json>` maps a saved list, `--write-seed` also rewrites the seed. Organisations it cannot map (many do not work on GitHub) are listed and can be mapped by hand on the page |
| Other programs' organisation lists | **starter lists** in the seed (marked as such on the page): a small hand-picked set, not the current roster. Review them each round |
| Notes and flags (Shortlist / Watch / Not applying) | private collection `owner_notes` |
| Past outcomes (calibration) | optional upload on the page: CSV `username,program,year,org,selected`. With outcomes the page also shows, per band, how many past applicants were selected. `node scripts/convert_gsoc_mentees.js GSoC_Mentees.xlsx --year 2025 > outcomes.csv` converts NST's tracking workbook ("Proposals" tab). Keep such files out of the repository: they are stored only in the private collection `program_outcomes` |

Setting it up: add `OWNER_PASSWORD` to the Secret (`k8s/secret.example.yaml` shows how) and restart the app. To change
who can open the page, change that password. A database backup contains the private collections; treat it accordingly.

## Deploy runbook (Kubernetes)

Cluster facts the manifests assume: k3s, Traefik ingress class `traefik`, storage class `longhorn`, linux/amd64
nodes, TLS terminated by Cloudflare, `*.nstsdc.org` already resolving to the cluster, a container registry at
`registry.nstsdc.org:5000`.

What `kubectl apply -k k8s/` creates in namespace `oss-status`:

| File | Objects |
| --- | --- |
| `00-namespace.yaml` | Namespace |
| `10-mongo.yaml` | StatefulSet `mongo` (pinned `mongo:7.0.x`, authentication on, 5Gi Longhorn volume), ConfigMap `mongo-init` (creates the app user on first start), headless Service `mongo`, NetworkPolicy admitting only pods labelled `oss-status/mongo-client: "true"` |
| `20-app.yaml` | Deployment `oss-status` (1 replica, Recreate), Service `oss-status` (80 to 3000), NetworkPolicy limiting the app's egress to MongoDB, DNS and HTTPS on the internet |
| `30-ingress.yaml` | Ingress for `oss.nstsdc.org` |
| `40-cronjob-sync.yaml.disabled` | not applied. The old nightly CronJob; the fetch is scheduled inside the app now |
| `secret.example.yaml` | not applied. Documents the keys of the two Secrets |
| `50-job-import.yaml.example` | not applied. Optional one-off import Job |

### 1. Build and push the image

```sh
TAG=1.0.0                                   # use a new tag for every release
docker build --platform linux/amd64 -t registry.nstsdc.org:5000/oss-status:$TAG .
docker push registry.nstsdc.org:5000/oss-status:$TAG
```

`--platform linux/amd64` matters when building on an Apple Silicon Mac. The image contains `src/`, `scripts/`,
`public/` and production dependencies only; `data/`, `legacy/` and `test/` are excluded by `.dockerignore`.

Set the same tag in `k8s/kustomization.yaml` (`images: newTag`). It is the only place the Deployment takes it from. Do not reuse a tag for a different build: the pods use
`imagePullPolicy: IfNotPresent`, so a node that already has the tag will not pull again.

### 2. Create the namespace and the two Secrets

```sh
kubectl apply -f k8s/00-namespace.yaml
MONGO_APP_PASSWORD="$(openssl rand -hex 24)"          # hex: safe inside a connection string
kubectl -n oss-status create secret generic oss-status-mongo \
  --from-literal=MONGO_ROOT_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=MONGO_APP_PASSWORD="$MONGO_APP_PASSWORD"
ADMIN_PASSWORD="$(openssl rand -base64 24)"; echo "admin password: $ADMIN_PASSWORD"   # store it in the password manager
OWNER_PASSWORD="$(openssl rand -base64 24)"; echo "private page password: $OWNER_PASSWORD"   # for the owner of "Krushn's dashboard" only
kubectl -n oss-status create secret generic oss-status-secrets \
  --from-literal=ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --from-literal=OWNER_PASSWORD="$OWNER_PASSWORD" \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GITHUB_TOKEN='<github token>' \
  --from-literal=MONGODB_URI="mongodb://oss_status:${MONGO_APP_PASSWORD}@mongo:27017/oss_status?authSource=oss_status"
```

- `oss-status-mongo` is read by the database pod only: the password of MongoDB user `root` (maintenance, backups)
  and of user `oss_status` (readWrite on the `oss_status` database, nothing else). Both users are created on the
  first start of an empty volume.
- `oss-status-secrets` is the app's environment. The app connects as `oss_status`.
- The admin password is the only thing between the internet and the admin tools: keep it long and random. In
  production the admin area answers 503 while `ADMIN_PASSWORD` is shorter than 16 characters, `SESSION_SECRET` is
  shorter than 32, or either is still a placeholder such as `CHANGE-ME`.

The Secrets are never stored in the repo. Without them the pods stay in `CreateContainerConfigError`.
To change a value later, recreate the Secret and run `kubectl -n oss-status rollout restart deploy/oss-status`.

### 3. Apply

```sh
kubectl kustomize k8s/ | less               # optional: review the rendered manifests
kubectl apply -k k8s/
kubectl -n oss-status rollout status statefulset/mongo
kubectl -n oss-status rollout status deploy/oss-status
kubectl -n oss-status get pods,svc,ingress,networkpolicy,pvc
```

Check: `curl https://oss.nstsdc.org/api/health` returns `{"ok":true}`. The site is empty until the first import.

Confirm that the network policies are enforced (they are with k3s's built-in controller; they are not if k3s runs
with `--disable-network-policy` or a CNI without policy support). From another namespace the database must be
unreachable, and even when reachable it must ask for credentials:

```sh
kubectl -n default run np-test --rm -it --restart=Never --image=mongo:7.0.28 -- \
  mongosh --quiet --host mongo.oss-status.svc --serverSelectionTimeoutMS 5000 --eval 'db.getSiblingDB("oss_status").students.countDocuments()'
# expected: a server selection timeout (policy enforced). "requires authentication" means the policy is NOT enforced
# and only the password protects the data: fix the CNI / k3s flags.
```

### 4. First import

The image does not contain `data/`. Recommended: run the importer from a checkout on an admin machine against
a port-forward of the database.

```sh
# terminal 1
kubectl -n oss-status port-forward svc/mongo 27017:27017

# terminal 2, in a checkout that has data/students.csv and data/raw/
npm ci
APP_PW=$(kubectl -n oss-status get secret oss-status-mongo -o jsonpath='{.data.MONGO_APP_PASSWORD}' | base64 -d)
MONGODB_URI="mongodb://oss_status:${APP_PW}@localhost:27017/oss_status?authSource=oss_status&directConnection=true" \
  MONGODB_DB=oss_status node scripts/import_legacy.js
```

If a local MongoDB already uses port 27017, forward to another port (`27018:27017`) and use that in `MONGODB_URI`.

Alternative without a local Node: copy the data into the app pod and import there (`/tmp` is a writable
scratch volume, emptied when the pod restarts).

```sh
POD=$(kubectl -n oss-status get pod -l app.kubernetes.io/name=oss-status -o name | head -1)
kubectl -n oss-status cp data ${POD#pod/}:/tmp/data
kubectl -n oss-status exec $POD -- node scripts/import_legacy.js --data /tmp/data
kubectl -n oss-status exec $POD -- rm -rf /tmp/data
```

A third option, a one-off Job that reads the data from a volume or a derived image, is described in
`k8s/50-job-import.yaml.example`.

Afterwards `https://oss.nstsdc.org` shows the numbers, and the first nightly fetch (02:30 IST) brings the data up to
date. To fetch right away: Admin, Jobs, "Fetch now". The very first fetch also looks up every imported student's
GitHub id (about 2,600 extra REST requests, once).

### 5. Releasing a new version

Build and push with a new tag, change `newTag` in `k8s/kustomization.yaml`, `kubectl apply -k k8s/`.
The Deployment uses strategy Recreate (one replica, in-process job runner), so there are a few seconds of
downtime. A job that was running inside the app is marked `interrupted`; queued jobs resume after the restart, and
a fetch that was cut off is started again once by the scheduler (see "Daily fetch"). To avoid that, release when no
fetch is running, or press "Cancel running fetch" first.
Roll back with `kubectl -n oss-status rollout undo deploy/oss-status` (and set the tag back in the file).

### Operations

```sh
kubectl -n oss-status logs deploy/oss-status --tail=100            # app log
kubectl -n oss-status exec deploy/oss-status -- node scripts/sync.js --limit 50       # a manual fetch from a terminal
kubectl -n oss-status exec deploy/oss-status -- node scripts/backfill.js --pending    # run any script in the app pod
kubectl -n oss-status exec deploy/oss-status -- node scripts/reclassify.js
```

Backup and restore (the `mongo:7` image includes `mongodump` / `mongorestore`):

```sh
kubectl -n oss-status exec mongo-0 -- sh -c 'mongodump -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db oss_status --archive --gzip' > oss_status-$(date +%F).archive.gz
kubectl -n oss-status exec -i mongo-0 -- sh -c 'mongorestore -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' < oss_status-<date>.archive.gz
```

The dump contains student emails and enrolment numbers: keep it private.

### Operational notes

- MongoDB requires credentials and is reachable only from pods labelled `oss-status/mongo-client: "true"` in this
  namespace (the app, the import Job). Never add an Ingress or NodePort for it. `kubectl port-forward` plus the
  app user's password is the intended admin path.
- `mongo:7` needs a CPU with AVX. If the pod crashes with "Illegal instruction", the node CPU lacks it.
- The app must stay at one replica: the job runner, the scheduler, the rate limits and the response cache are in-process.
- Visitor address: Cloudflare puts the visitor's address in `CF-Connecting-IP` and overwrites whatever a client
  sends. The app uses it (`CLIENT_IP_HEADER`) as the key of the login limit and of the request budgets, but only
  when the TCP peer is a private address, that is the ingress. This holds as long as the origin only accepts traffic
  from Cloudflare (a Cloudflare Tunnel, or a firewall that admits Cloudflare's ranges only); if the origin can be
  reached directly, a client could send its own `CF-Connecting-IP` and so choose its bucket. A Cloudflare
  rate-limit rule on `POST /api/admin/login` is a cheap extra layer.
- Public API limits: 300 requests per minute per visitor, 6 CSV exports per minute per visitor, 2 exports at a
  time, searches of at most 100 characters, 15 to 20 second database time limits. Identical queries are answered
  from memory for 60 seconds; an admin write or the end of a job drops that cache. A restart clears all counters.
- The app sends `Content-Security-Policy` (own scripts only), `X-Frame-Options: DENY` and, in production, HSTS.
- The nightly fetch makes roughly one GitHub search request per active student (about 2,600), well inside the
  GraphQL limit of 5,000 points per hour. Only one sync runs at a time: starting a second one answers 409, and the
  scheduler waits for a running one to finish.
- If the CronJob of an earlier version was applied, delete it, or every student is fetched twice a night:
  `kubectl -n oss-status delete cronjob oss-status-sync`.
- Date ranges: every public page takes `?from=&to=` (days in IST) or `?range=<preset>`; without them the current
  academic year applies. Opened = created in the range, merged = merged in the range (whenever it was opened).

### Enabling MongoDB authentication on existing data

The users are created automatically only on the first start of an empty volume. If the database was first started
by an earlier version of these manifests (no authentication), create the users once before applying this version:

```sh
kubectl -n oss-status create secret generic oss-status-mongo ...        # step 2 above
ROOT_PW=$(kubectl -n oss-status get secret oss-status-mongo -o jsonpath='{.data.MONGO_ROOT_PASSWORD}' | base64 -d)
APP_PW=$(kubectl -n oss-status get secret oss-status-mongo -o jsonpath='{.data.MONGO_APP_PASSWORD}' | base64 -d)
kubectl -n oss-status exec mongo-0 -- mongosh --quiet --eval "
  db.getSiblingDB('admin').createUser({user:'root', pwd:'$ROOT_PW', roles:['root']});
  db.getSiblingDB('oss_status').createUser({user:'oss_status', pwd:'$APP_PW', roles:[{role:'readWrite', db:'oss_status'}]});"
# add MONGODB_URI to oss-status-secrets (step 2), then:
kubectl apply -k k8s/          # restarts mongo with --auth and the app with the credentials
```
