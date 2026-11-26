#!/bin/bash
# Stop any running batch, keep every other turn of the replay set, and run both batches in sequence.
cd ~/bench
for pid in $(pgrep -f "^bash run"; pgrep -f "^node bench.mjs"); do kill "$pid"; done
[ -f replay-full.jsonl ] || mv replay.jsonl replay-full.jsonl
node -e '
const fs = require("fs");
const rows = fs.readFileSync("replay-full.jsonl", "utf8").trim().split("\n").map(JSON.parse);
fs.writeFileSync("replay.jsonl", rows.filter((r) => r.turn % 2 === 0).map((r) => JSON.stringify(r)).join("\n") + "\n");'
wc -l replay.jsonl
rm -rf results
nohup bash -c "bash run.sh > run.log 2>&1; bash run2.sh > run2.log 2>&1" < /dev/null > /dev/null 2>&1 &
