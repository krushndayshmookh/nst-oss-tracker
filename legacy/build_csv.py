#!/usr/bin/env python3
"""Turn data/raw/*.json into CSVs and classify every PR with the rules in config/rules.json.

Outputs (data/out/):
  prs.csv        one row per PR, with category
  repos.csv      one row per repository (for reviewing the classification)
  orgs.csv       one row per repo owner
  students.csv   one row per student
  campus.csv     campus x year summary
Categories (first match wins):
  own_repo        repo owned by the PR author
  nst_internal    NST org / course / club repo (rules: nst_orgs, nst_owner_keywords)
  peer_repo       repo owned by another NST student, or mostly NST-only personal repo
  practice        beginner / event / practice repo (rules: practice_repos, practice_keywords)
  low_signal      public repo below min_stars_credible, or a fork
  open_source     everything else: tier major / established / emerging by stars
"""
import csv, glob, json, os, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'out'); os.makedirs(OUT, exist_ok=True)
R = json.load(open(os.path.join(ROOT, 'config', 'rules.json')))
low = lambda xs: {x.lower() for x in xs}
NST_ORGS, PRACTICE, EXC_ORG, EXC_REPO, INC_REPO = low(R['nst_orgs']), low(R['practice_repos']), low(R['exclude_orgs']), low(R['exclude_repos']), low(R['include_repos'])
students = {r['github_username'].lower(): r for r in csv.DictReader(open(os.path.join(ROOT, 'data', 'students.csv')))}

def tier(stars):
    for name in ('major', 'established', 'emerging'):
        if stars >= R['tiers'][name]: return name
    return ''

def nst_owner(owner):
    # short keywords (nst, smru) must be a whole word of the owner name; longer ones may be a substring
    import re
    toks = re.split(r'[^a-z0-9]+', owner)
    return any((k in toks) if len(k) <= 4 else (k in owner) for k in R['nst_owner_keywords'])

def classify(author, repo):
    full, owner, name = repo['nameWithOwner'].lower(), repo['owner']['login'].lower(), repo['nameWithOwner'].split('/')[1].lower()
    stars = repo['stargazerCount']
    if full in INC_REPO: return 'open_source', 'include_repos override'
    if full in EXC_REPO or owner in EXC_ORG: return 'low_signal', 'excluded in rules.json'
    if owner == author: return 'own_repo', 'author owns repo'
    if owner in NST_ORGS or nst_owner(owner): return 'nst_internal', 'NST org/keyword'
    if owner in students: return 'peer_repo', 'owner is an NST student'
    if full in PRACTICE or any(k in name or k in owner for k in R['practice_keywords']): return 'practice', 'practice/event repo'
    if repo['isFork']: return 'low_signal', 'repo is a fork'
    if stars < R['min_stars_credible']: return 'low_signal', 'under %d stars' % R['min_stars_credible']
    return 'open_source', tier(stars)

rows, status = [], []
for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'raw', '*.json'))):
    d = json.load(open(f)); u = d['user']; s = students.get(u.lower(), {})
    status.append((u, d['count'], len(d['prs']), d['error']))
    seen = set()
    for p in d['prs']:
        if not p or p['url'] in seen: continue
        seen.add(p['url']); repo = p['repository']
        cat, why = classify(u.lower(), repo)
        state = 'merged' if p['mergedAt'] else ('open' if p['state'] == 'OPEN' else 'closed')
        rows.append(dict(campus=s.get('campus', ''), year=s.get('year', ''), student_name=s.get('name', ''), github_username=u,
            pr_url=p['url'], repo=repo['nameWithOwner'], owner=repo['owner']['login'], owner_type=repo['owner']['__typename'],
            title=' '.join((p['title'] or '').split()), state=state, is_draft=p['isDraft'], created_at=p['createdAt'], merged_at=p['mergedAt'] or '',
            closed_at=p['closedAt'] or '', additions=p['additions'], deletions=p['deletions'], changed_files=p['changedFiles'],
            comments=p['comments']['totalCount'], reviews=p['reviews']['totalCount'], repo_stars=repo['stargazerCount'], repo_forks=repo['forkCount'],
            repo_is_fork=repo['isFork'], repo_archived=repo['isArchived'], repo_language=(repo['primaryLanguage'] or {}).get('name', ''),
            repo_license=(repo['licenseInfo'] or {}).get('spdxId', ''), category=cat, category_reason=why))

def write(name, rws, cols=None):
    cols = cols or (list(rws[0].keys()) if rws else [])
    with open(os.path.join(OUT, name), 'w', newline='') as fh:
        w = csv.DictWriter(fh, cols); w.writeheader(); w.writerows(rws)

rows.sort(key=lambda r: (r['campus'], r['year'], r['github_username'].lower(), r['created_at']))
write('prs.csv', rows)

def agg(key, extra):
    g = collections.OrderedDict()
    for r in rows:
        k = key(r)
        a = g.setdefault(k, dict(extra(r), prs=0, merged=0, open=0, closed=0, students=set(), campuses=set(), first_pr=r['created_at'], last_pr=r['created_at']))
        a['prs'] += 1; a[r['state']] += 1; a['students'].add(r['github_username'].lower()); a['campuses'].add(r['campus'])
        a['first_pr'] = min(a['first_pr'], r['created_at']); a['last_pr'] = max(a['last_pr'], r['created_at'])
    out = []
    for a in g.values():
        a['campuses'] = '; '.join(sorted(c for c in a['campuses'] if c)); a['students'] = len(a['students']); out.append(a)
    return sorted(out, key=lambda a: -a['prs'])

write('repos.csv', agg(lambda r: r['repo'].lower(), lambda r: dict(repo=r['repo'], owner=r['owner'], owner_type=r['owner_type'], stars=r['repo_stars'], forks=r['repo_forks'], language=r['repo_language'], category=r['category'], category_reason=r['category_reason'])))
orgs = collections.OrderedDict()
for r in rows:
    o = orgs.setdefault(r['owner'].lower(), dict(owner=r['owner'], owner_type=r['owner_type'], repos=set(), max_repo_stars=0, prs=0, merged=0, open_source_prs=0, open_source_merged=0, students=set(), categories=collections.Counter()))
    o['repos'].add(r['repo']); o['max_repo_stars'] = max(o['max_repo_stars'], r['repo_stars']); o['prs'] += 1; o['merged'] += r['state'] == 'merged'
    o['open_source_prs'] += r['category'] == 'open_source'; o['open_source_merged'] += r['category'] == 'open_source' and r['state'] == 'merged'
    o['students'].add(r['github_username'].lower()); o['categories'][r['category']] += 1
for o in orgs.values():
    o['repos'] = len(o['repos']); o['students'] = len(o['students']); o['categories'] = '; '.join('%s:%d' % kv for kv in o['categories'].most_common())
write('orgs.csv', sorted(orgs.values(), key=lambda o: (-o['open_source_prs'], -o['prs'])))

CATS = ['open_source', 'practice', 'nst_internal', 'peer_repo', 'own_repo', 'low_signal']
by = collections.defaultdict(list)
for r in rows: by[r['github_username'].lower()].append(r)
st_rows = []
fetched = {u.lower(): (c, n, e) for u, c, n, e in status}
for k, s in students.items():
    pr = by.get(k, []); osr = [r for r in pr if r['category'] == 'open_source']
    d = dict(campus=s['campus'], year=s['year'], name=s['name'], github_username=s['github_username'], fetched=k in fetched, fetch_error=fetched.get(k, (0, 0, ''))[2],
        total_prs=len(pr), total_merged=sum(r['state'] == 'merged' for r in pr))
    for c in CATS: d[c + '_prs'] = sum(r['category'] == c for r in pr)
    d.update(open_source_merged=sum(r['state'] == 'merged' for r in osr), open_source_open=sum(r['state'] == 'open' for r in osr),
        open_source_major_merged=sum(r['state'] == 'merged' and r['category_reason'] == 'major' for r in osr),
        open_source_repos=len({r['repo'] for r in osr}), open_source_orgs=len({r['owner'] for r in osr}),
        top_open_source_repos='; '.join(k for k, _ in collections.Counter(r['repo'] for r in osr if r['state'] == 'merged').most_common(5)),
        first_pr=min((r['created_at'] for r in pr), default=''), last_pr=max((r['created_at'] for r in pr), default=''))
    st_rows.append(d)
st_rows.sort(key=lambda d: (-d['open_source_merged'], -d['open_source_prs'], -d['total_prs']))
write('students.csv', st_rows)

cg = collections.OrderedDict()
for d in sorted(st_rows, key=lambda d: (d['campus'], d['year'])):
    c = cg.setdefault((d['campus'], d['year']), collections.Counter())
    c['students_with_github'] += 1; c['students_with_any_pr'] += d['total_prs'] > 0; c['students_with_open_source_pr'] += d['open_source_prs'] > 0
    c['students_with_open_source_merged'] += d['open_source_merged'] > 0; c['students_with_major_merged'] += d['open_source_major_merged'] > 0
    c['total_prs'] += d['total_prs']; c['open_source_prs'] += d['open_source_prs']; c['open_source_merged'] += d['open_source_merged']
    for cat in CATS: c[cat + '_prs'] += d[cat + '_prs']
cols = ['campus', 'year', 'students_with_github', 'students_with_any_pr', 'students_with_open_source_pr', 'students_with_open_source_merged', 'students_with_major_merged', 'total_prs', 'open_source_prs', 'open_source_merged'] + [c + '_prs' for c in CATS if c != 'open_source']
write('campus.csv', [dict(dict.fromkeys(cols, 0), campus=k[0], year=k[1], **v) for k, v in cg.items()], cols)
write('fetch_status.csv', [dict(github_username=u, github_count=c, fetched=n, error=e) for u, c, n, e in status])
print('students fetched', len(status), 'prs', len(rows), dict(collections.Counter(r['category'] for r in rows)))
print('errors', sum(1 for s in status if s[3]), 'short', sum(1 for s in status if s[2] < min(s[1], 1000)))
