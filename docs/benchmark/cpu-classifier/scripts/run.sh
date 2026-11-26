#!/bin/bash
# Run every benchmark configuration on the VM, restarting Ollama before each so no prompt cache
# carries over. Phase 2 raises OLLAMA_NUM_PARALLEL so each question kind can keep its own cache slot.
#   nohup bash run.sh > run.log 2>&1 &
set -u
cd "$(dirname "$0")"
mkdir -p results

restart() {
  sudo systemctl restart ollama
  for _ in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && return; sleep 1; done
}
parallel() {
  sudo sed -i "s/OLLAMA_NUM_PARALLEL=[0-9]*/OLLAMA_NUM_PARALLEL=$1/" /etc/systemd/system/ollama.service.d/override.conf
  sudo systemctl daemon-reload
}
bench() { # name model layout family [threads]
  local name=$1; shift
  restart
  echo "== $name $(date +%T)"
  node bench.mjs replay.jsonl "results/$name.jsonl" "$@" || echo "FAILED $name"
}

LFM=$(ollama list | awk '/^lfm2.5:8b-a1b/{print $1; exit}')
[ -n "$LFM" ] || LFM=$(ollama list | awk '/LFM2-8B-A1B/{print $1; exit}')

parallel 1
bench base qwen3:4b current qwen
bench threads8 qwen3:4b current qwen 8
bench threads12 qwen3:4b current qwen 12
bench q4_0 hf.co/unsloth/Qwen3-4B-GGUF:Q4_0 current qwen
bench qwen35-4b qwen3.5:4b current qwen
bench qwen35-2b qwen3.5:2b current qwen
bench granite-tiny granite4:tiny-h current granite
[ -n "$LFM" ] && bench lfm2-8b-a1b "$LFM" current lfm

parallel 8
bench p8-current qwen3:4b current qwen
bench p8-qfirst qwen3:4b qfirst qwen
bench p8-restate qwen3:4b qfirst-restate qwen

# Leave Ollama as it was found: one slot, qwen3:4b loaded.
parallel 1
restart
curl -fsS http://127.0.0.1:11434/api/generate -d '{"model":"qwen3:4b","prompt":"hi","stream":false,"options":{"num_predict":1}}' >/dev/null
echo "== done $(date +%T)"
