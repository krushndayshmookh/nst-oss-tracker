#!/bin/bash
# Run the fetch in N parallel shards (default 8). Logs: data/fetch_<k>.log
cd "$(dirname "$0")/.." && N=${1:-8}
pkill -f scripts/fetch_prs.py; sleep 1
for k in $(seq 0 $((N-1))); do nohup /usr/bin/python3 scripts/fetch_prs.py $k $N > data/fetch_$k.log 2>&1 < /dev/null & done
