#!/bin/bash
# Second batch, after run.sh: shortened option descriptions, alone and with the cache-friendly layout.
set -u
cd "$(dirname "$0")"
# Run after run.sh has finished (an earlier wait loop here matched its own parent process and never ended).
restart() {
  sudo systemctl restart ollama
  for _ in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && return; sleep 1; done
}
parallel() {
  sudo sed -i "s/OLLAMA_NUM_PARALLEL=[0-9]*/OLLAMA_NUM_PARALLEL=$1/" /etc/systemd/system/ollama.service.d/override.conf
  sudo systemctl daemon-reload
}
bench() { local name=$1; shift; restart; echo "== $name $(date +%T)"; node bench.mjs replay.jsonl "results/$name.jsonl" "$@" || echo "FAILED $name"; }
parallel 1
bench short qwen3:4b current-short qwen
parallel 8
bench p8-restate-short qwen3:4b qfirst-restate-short qwen
parallel 1
restart
curl -fsS http://127.0.0.1:11434/api/generate -d '{"model":"qwen3:4b","prompt":"hi","stream":false,"options":{"num_predict":1}}' >/dev/null
echo "== done $(date +%T)"
