// Compare every benchmark configuration with the baseline (results/raw/base.jsonl).
//   node compare.mjs <raw results dir> [summary.json]
// Prints a Markdown table, a per-question-kind breakdown of the baseline, and optionally writes
// the numbers as JSON. The baseline is the reference answer, not ground truth.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const [dir = "results/raw", json] = process.argv.slice(2);
const load = (f) =>
  readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];
const order = [
  "base", "threads8", "threads12", "q4_0", "qwen35-4b", "qwen35-2b", "granite-tiny",
  "lfm2-8b-a1b", "short", "p8-current", "p8-qfirst", "p8-restate", "p8-restate-short",
];
const rank = (f) => { const i = order.indexOf(f.replace(/\.jsonl$/, "")); return i < 0 ? 99 : i; };
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort((a, b) => rank(a) - rank(b));
const base = load("base.jsonl");

const summary = [];
for (const f of files) {
  const rows = load(f);
  const n = Math.min(rows.length, base.length);
  const turns = {};
  for (const r of rows) turns[r.turn] = (turns[r.turn] ?? 0) + r.ms;
  const t = Object.values(turns).map((ms) => ms / 1000);
  let sameDecision = 0, sameTop = 0, decided = 0, conflict = 0, gained = 0, lost = 0;
  for (let i = 0; i < n; i++) {
    const a = rows[i].decision, b = base[i].decision;
    if (a === b) sameDecision++;
    if (rows[i].top === base[i].top) sameTop++;
    if (a !== "-") decided++;
    if (a !== "-" && b !== "-" && a !== b) conflict++;
    if (a !== "-" && b === "-") gained++;
    if (a === "-" && b !== "-") lost++;
  }
  const evalMs = rows.reduce((s, r) => s + r.prompt_ms, 0);
  summary.push({
    config: f.replace(/\.jsonl$/, ""),
    prompts: rows.length,
    complete: rows.length === base.length,
    turnSecondsMedian: +pct(t, 0.5).toFixed(1),
    turnSecondsP90: +pct(t, 0.9).toFixed(1),
    totalSeconds: +(rows.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(0),
    promptMsMedian: pct(rows.map((r) => r.ms), 0.5),
    promptTokensPerSecond: evalMs ? Math.round(rows.reduce((s, r) => s + r.prompt_tokens, 0) / (evalMs / 1000)) : null,
    sameDecision, sameTop, compared: n, decided, conflict, gained, lost,
  });
}

console.log("| Config | Prompts | Turn s (median) | Turn s (p90) | Total s | Prompt tok/s | Same decision | Same top answer | Decided | Conflicts | Newly decided | No longer decided |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of summary)
  console.log(`| ${s.config}${s.complete ? "" : " (partial)"} | ${s.prompts} | ${s.turnSecondsMedian} | ${s.turnSecondsP90} | ${s.totalSeconds} | ${s.promptTokensPerSecond ?? "–"} | ${s.sameDecision}/${s.compared} | ${s.sameTop}/${s.compared} | ${s.decided} | ${s.conflict} | ${s.gained} | ${s.lost} |`);

// Where the baseline's time goes, by question kind.
const kinds = {};
for (const r of base) {
  const k = (kinds[r.kind] ??= { prompts: 0, ms: 0, tokens: 0 });
  k.prompts++; k.ms += r.ms; k.tokens += r.prompt_tokens;
}
const all = base.reduce((s, r) => s + r.ms, 0);
console.log("\n| Question (baseline) | Prompts | Share of time | Mean tokens | Mean s |\n|---|---|---|---|---|");
for (const [kind, k] of Object.entries(kinds).sort((a, b) => b[1].ms - a[1].ms))
  console.log(`| ${kind}… | ${k.prompts} | ${Math.round((100 * k.ms) / all)}% | ${Math.round(k.tokens / k.prompts)} | ${(k.ms / k.prompts / 1000).toFixed(1)} |`);

if (json) writeFileSync(json, JSON.stringify({ summary, kinds }, null, 2) + "\n");
