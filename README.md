# NST Open Source Status

Public dashboard of open-source work (GitHub pull requests) by Newton School of Technology students, with a
password-protected admin area. Production: <https://oss.nstsdc.org>.

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
| `ADMIN_PASSWORD` | unset | admin password. While unset, the admin API answers 503 |
| `SESSION_SECRET` | random per process | signs the admin cookie. Set it, or sessions end at every restart |
| `GITHUB_TOKEN` | unset | needed by sync, backfill and "add student" validation. Public read access is enough |
| `NODE_ENV` | `development` | `production` makes the admin cookie `Secure` |
| `SYNC_CONCURRENCY` | `6` | students fetched in parallel |
| `TRUST_PROXY` | `1` | number of reverse proxies in front of the app |

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
- Idempotent: a second run adds nothing and keeps overrides and admin edits.
- Measured on the current dataset (2,623 students, 49,210 PRs, 39 private PRs skipped): about 8 seconds.

### Daily fetch: `scripts/sync.js`

```sh
node scripts/sync.js [--users a,b] [--full] [--limit N] [--campus C] [--batch YYYY] [--concurrency N]
```

- Default: every active student. Students whose history is already loaded get an incremental fetch (PRs updated
  since their last successful sync minus 2 days). Students still `pending` get their full history. Students
  whose account was not found are skipped until an admin re-runs their backfill.
- `--full`: re-read the whole history of the selected students.
- `--users`, `--campus`, `--batch`, `--limit`: restrict the run.
- Requires `GITHUB_TOKEN`. Exit code 1 only on total failure (no token, database unreachable, or every student
  failed), 2 on bad arguments. A failed student keeps its old `lastSyncedAt`, so the next run retries the same window.

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
Ten wrong passwords within 15 minutes lock the login for that IP address (see "Operational notes" for what
"IP address" means behind Cloudflare).

Everything outside `/admin` is public and read-only. Student email, enrolment number, sources and notes are
visible only in the admin area.

| Task | Where |
| --- | --- |
| Add a student and fetch their old work | Students: add one (GitHub username or profile URL, campus, batch). A backfill job for the full history starts automatically |
| Add many students | Students: paste or upload CSV with the columns of `students.csv`. Only `github_username` is required. One backfill job covers all added students |
| Edit, deactivate, re-fetch a student | Students: edit a row, deactivate (hides the student and their PRs from the public site, nothing is deleted), or re-run the backfill |
| Mark a PR as not open source (or force it to count) | PRs: search, then mark or unmark |
| Mark a repo or an organisation as not a valuable contribution | Review: one click per repo or owner: include, exclude, or (owners) "NST internal", with a note |
| Undo any of those | Overrides: list of all current overrides |
| Change thresholds and keyword lists | Rules: star thresholds, NST orgs and keywords, practice repos and keywords, always-allowed orgs. Saving queues a reclassify job |
| See or start fetch runs | Jobs: status and log of every job, run a sync or a reclassify now |

Overrides on PRs, repos and owners apply immediately. "Valuable contribution" means category `open_source`;
the headline numbers are merged open-source PRs and students with at least one of them. The About page of the
public site explains the classification with the current rules.

## Deploy runbook (Kubernetes)

Cluster facts the manifests assume: k3s, Traefik ingress class `traefik`, storage class `longhorn`, linux/amd64
nodes, TLS terminated by Cloudflare, `*.nstsdc.org` already resolving to the cluster, a container registry at
`registry.nstsdc.org:5000`.

What `kubectl apply -k k8s/` creates in namespace `oss-status`:

| File | Objects |
| --- | --- |
| `00-namespace.yaml` | Namespace |
| `10-mongo.yaml` | StatefulSet `mongo` (mongo:7, 5Gi Longhorn volume), headless Service `mongo`, NetworkPolicy allowing port 27017 only from pods of this namespace |
| `20-app.yaml` | Deployment `oss-status` (1 replica, Recreate), Service `oss-status` (80 to 3000) |
| `30-ingress.yaml` | Ingress for `oss.nstsdc.org` |
| `40-cronjob-sync.yaml` | CronJob `oss-status-sync`, daily 21:00 UTC (02:30 IST), `node scripts/sync.js` |
| `secret.example.yaml` | not applied. Documents the keys of the Secret |
| `50-job-import.yaml.example` | not applied. Optional one-off import Job |

### 1. Build and push the image

```sh
TAG=1.0.0                                   # use a new tag for every release
docker build --platform linux/amd64 -t registry.nstsdc.org:5000/oss-status:$TAG .
docker push registry.nstsdc.org:5000/oss-status:$TAG
```

`--platform linux/amd64` matters when building on an Apple Silicon Mac. The image contains `src/`, `scripts/`,
`public/` and production dependencies only; `data/`, `legacy/` and `test/` are excluded by `.dockerignore`.

Set the same tag in `k8s/kustomization.yaml` (`images: newTag`). It is the only place: the Deployment and the
CronJob both take it from there. Do not reuse a tag for a different build: the pods use
`imagePullPolicy: IfNotPresent`, so a node that already has the tag will not pull again.

### 2. Create the namespace and the Secret

```sh
kubectl apply -f k8s/00-namespace.yaml
kubectl -n oss-status create secret generic oss-status-secrets \
  --from-literal=ADMIN_PASSWORD='<password for /admin>' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GITHUB_TOKEN='<github token>'
```

The Secret is never stored in the repo. Without it the app pod stays in `CreateContainerConfigError`.
To change a value later, recreate the Secret and run `kubectl -n oss-status rollout restart deploy/oss-status`.

### 3. Apply

```sh
kubectl kustomize k8s/ | less               # optional: review the rendered manifests
kubectl apply -k k8s/
kubectl -n oss-status rollout status statefulset/mongo
kubectl -n oss-status rollout status deploy/oss-status
kubectl -n oss-status get pods,svc,ingress,cronjob,pvc
```

Check: `curl https://oss.nstsdc.org/api/health` returns `{"ok":true}`. The site is empty until the first import.

### 4. First import

The image does not contain `data/`. Recommended: run the importer from a checkout on an admin machine against
a port-forward of the database.

```sh
# terminal 1
kubectl -n oss-status port-forward svc/mongo 27017:27017

# terminal 2, in a checkout that has data/students.csv and data/raw/
npm ci
MONGODB_URI=mongodb://localhost:27017 MONGODB_DB=oss_status node scripts/import_legacy.js
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

Afterwards `https://oss.nstsdc.org` shows the numbers, and the first nightly sync brings the data up to date.
To fetch right away:

```sh
kubectl -n oss-status create job --from=cronjob/oss-status-sync sync-manual-$(date +%s)
kubectl -n oss-status logs -f -l app.kubernetes.io/name=oss-status-sync --tail=50
```

### 5. Releasing a new version

Build and push with a new tag, change `newTag` in `k8s/kustomization.yaml`, `kubectl apply -k k8s/`.
The Deployment uses strategy Recreate (one replica, in-process job runner), so there are a few seconds of
downtime. A job that was running inside the app is marked `interrupted`; queued jobs resume after the restart.
Roll back with `kubectl -n oss-status rollout undo deploy/oss-status` (and set the tag back in the file).

### Operations

```sh
kubectl -n oss-status logs deploy/oss-status --tail=100            # app log
kubectl -n oss-status get cronjob,jobs                             # nightly sync runs
kubectl -n oss-status patch cronjob oss-status-sync -p '{"spec":{"suspend":true}}'    # pause the nightly sync (false resumes)
kubectl -n oss-status exec deploy/oss-status -- node scripts/backfill.js --pending    # run any script in the app pod
kubectl -n oss-status exec deploy/oss-status -- node scripts/reclassify.js
```

Backup and restore (the `mongo:7` image includes `mongodump` / `mongorestore`):

```sh
kubectl -n oss-status exec mongo-0 -- mongodump --db oss_status --archive --gzip > oss_status-$(date +%F).archive.gz
kubectl -n oss-status exec -i mongo-0 -- mongorestore --archive --gzip --drop < oss_status-<date>.archive.gz
```

The dump contains student emails and enrolment numbers: keep it private.

### Operational notes

- MongoDB runs without authentication. It is protected by not being exposed: headless ClusterIP Service plus a
  NetworkPolicy that admits only pods of the `oss-status` namespace. Never add an Ingress or NodePort for it.
  Anyone with `kubectl port-forward` rights in the namespace can reach it; that is the intended admin path.
- `mongo:7` needs a CPU with AVX. If the pod crashes with "Illegal instruction", the node CPU lacks it.
- The app must stay at one replica: the job runner and the login rate limit are in-process.
- Login rate limit and client IP: with `TRUST_PROXY=1` the app trusts one proxy (Traefik). If Traefik itself sits
  behind a Cloudflare Tunnel and is not configured to trust the tunnel's forwarded headers, every visitor appears
  to come from the tunnel's address and the limit of 10 failed logins per 15 minutes applies to everyone together.
  That still blocks password guessing, but a guessing attempt can lock admins out for up to 15 minutes.
  A restart of the app clears the counter.
- The nightly sync makes roughly one GitHub search request per active student (about 2,600), well inside the
  GraphQL limit of 5,000 points per hour. The CronJob is killed after 3 hours (`activeDeadlineSeconds`), is not
  retried the same night, and never overlaps itself (`concurrencyPolicy: Forbid`). It may overlap a job started
  from the admin area; all writes are idempotent upserts, so that is safe.
- Scheduling: `SPEC-ADDENDUM-dates.md` (addendum C) plans to move the daily fetch into the app, managed from the
  admin Jobs page. At the time of writing the app has no scheduler, so the CronJob is what runs the daily fetch.
  Once the in-app scheduler ships, remove `40-cronjob-sync.yaml` from `k8s/kustomization.yaml`, rename the file to
  `40-cronjob-sync.yaml.disabled` and run `kubectl -n oss-status delete cronjob oss-status-sync`, otherwise the
  fetch runs twice a night (harmless, but wasteful).
