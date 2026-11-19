#!/usr/bin/env python3
"""Fetch every pull request authored by each NST student (GitHub GraphQL search).

Same query the git-go-pr tool used (search: author:<user> type:pr), but through
GraphQL so that merge state and repository details come back in the same call.
Token: `gh auth token` (or GITHUB_TOKEN). Resumable: raw results are kept in
data/raw/<username>.json and skipped on re-run.
Usage: python3 scripts/fetch_prs.py [shard total]   e.g. 8 parallel runs: 0 8 ... 7 8
                  (then scripts/build_csv.py)
"""
import csv, json, os, subprocess, sys, time, urllib.request, urllib.error
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw'); os.makedirs(RAW, exist_ok=True)
os.environ['PATH'] += ':/opt/homebrew/bin:/usr/local/bin'
TOKEN = os.environ.get('GITHUB_TOKEN') or subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True).stdout.strip()
BATCH = 2
PAGE = 50   # GitHub answers 502 when a query is too heavy, so pages are kept small and shrink on failure
FIELDS = """issueCount pageInfo{hasNextPage endCursor}
 nodes{... on PullRequest{url number title state isDraft createdAt mergedAt closedAt additions deletions changedFiles
  comments{totalCount} reviews{totalCount}
  repository{nameWithOwner isFork isArchived isPrivate stargazerCount forkCount description createdAt
   owner{login __typename} primaryLanguage{name} licenseInfo{spdxId}}}}"""

def gql(query, attempts=8):
    body = json.dumps({'query': query}).encode()
    for attempt in range(attempts):
        req = urllib.request.Request('https://api.github.com/graphql', body,
            {'Authorization': 'bearer ' + TOKEN, 'User-Agent': 'nst-oss-status'})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.load(r)
            if d.get('data') is None and d.get('errors'):
                msg = json.dumps(d['errors'])[:200]
                if 'rate limit' in msg.lower() or 'timeout' in msg.lower() or 'went wrong' in msg.lower():
                    print('  retry:', msg, flush=True); time.sleep(30 * (attempt + 1)); continue
            return d
        except urllib.error.HTTPError as e:
            wait = int(e.headers.get('Retry-After') or 0) or (4 * (attempt + 1) if e.code in (502, 504) else 30 * (attempt + 1))
            print('  http', e.code, 'sleep', wait, flush=True); time.sleep(wait)
        except Exception as e:
            print('  err', e, flush=True); time.sleep(15 * (attempt + 1))
    return {'data': None, 'errors': [{'message': 'gave up'}]}

def search(q, after=None, first=None):
    a = ', after: "%s"' % after if after else ''
    return 'search(query: "%s", type: ISSUE, first: %d%s){%s}' % (q, first or PAGE, a, FIELDS)

def page_all(q):
    """All results for one search query (GitHub caps a search at 1000)."""
    nodes, after, count = [], None, 0
    while True:
        for first in (PAGE, 20, 8, 3):
            d = gql('{s: %s rateLimit{remaining}}' % search(q, after, first), attempts=3)
            s = (d.get('data') or {}).get('s')
            if s: break
        if not s: return nodes, count, json.dumps(d.get('errors'))[:200]
        count = s['issueCount']; nodes += [n for n in s['nodes'] if n]
        if not s['pageInfo']['hasNextPage']: return nodes, count, ''
        after = s['pageInfo']['endCursor']; time.sleep(0.3)

def fetch_user(u, first=None):
    q = 'author:%s type:pr' % u
    if first and not first['pageInfo']['hasNextPage']:
        return {'user': u, 'count': first['issueCount'], 'prs': [n for n in first['nodes'] if n], 'error': ''}
    nodes, count, err = page_all(q)
    if count > 1000:  # split by year to get past the 1000-result cap
        nodes = []
        for y in range(2015, 2028):
            n, c, e = page_all('%s created:%d-01-01..%d-12-31' % (q, y, y)); nodes += n; err = err or e
    return {'user': u, 'count': count, 'prs': nodes, 'error': err}

def main():
    users = [r['github_username'] for r in csv.DictReader(open(os.path.join(ROOT, 'data', 'students.csv')))]
    k, n = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (0, 1)  # shard k of n, for parallel runs
    users = [u for i, u in enumerate(users) if i % n == k]
    todo = [u for u in users if not os.path.exists(os.path.join(RAW, u.lower() + '.json'))]
    print(len(users), 'students,', len(todo), 'to fetch', flush=True)
    for i in range(0, len(todo), BATCH):
        b = todo[i:i + BATCH]
        d = gql('{' + ' '.join('u%d: %s' % (j, search('author:%s type:pr' % u)) for j, u in enumerate(b)) + ' rateLimit{remaining resetAt}}', attempts=2)
        data = d.get('data') or {}
        for j, u in enumerate(b):
            first = data.get('u%d' % j)
            res = fetch_user(u, first) if first else fetch_user(u)
            json.dump(res, open(os.path.join(RAW, u.lower() + '.json'), 'w'))
        rl = (data.get('rateLimit') or {})
        print(i + len(b), '/', len(todo), 'rate', rl.get('remaining'), flush=True)
        if rl.get('remaining') is not None and rl['remaining'] < 100: time.sleep(600)
        time.sleep(0.3)
    print('DONE', flush=True)
main()
