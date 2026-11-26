// Summarise captured prompts and write a replay set: whole turns (consecutive prompts that share a
// message), deduplicated, sampled evenly to about `target` prompts.
//   node summarise.mjs prompts.jsonl replay.jsonl [target=200]
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, target = "200"] = process.argv.slice(2);
const rows = readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const message = (p) => p.split("\n\nQuestion:")[0];
const question = (p) => p.split("\nQuestion: ")[1].split("\n")[0];
const options = (p) => (p.match(/\n[A-Y]: /g) ?? []).length;
const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];

const turns = [];
for (const row of rows) {
  if (!turns.length || message(turns.at(-1)[0].prompt) !== message(row.prompt)) turns.push([]);
  turns.at(-1).push(row);
}
const seen = new Set();
const unique = turns.filter((t) => {
  const key = t.map((r) => r.prompt).join("\u0000");
  return seen.has(key) ? false : (seen.add(key), true);
});
const tokens = rows.map((r) => r.prompt_eval_count ?? 0);
const counts = {};
for (const r of rows) counts[question(r.prompt)] = (counts[question(r.prompt)] ?? 0) + 1;
console.log({
  prompts: rows.length,
  uniquePrompts: new Set(rows.map((r) => r.prompt)).size,
  turns: turns.length,
  uniqueTurns: unique.length,
  questionsPerTurn: { median: pct(turns.map((t) => t.length), 0.5), max: Math.max(...turns.map((t) => t.length)) },
  tokens: { median: pct(tokens, 0.5), p90: pct(tokens, 0.9), max: Math.max(...tokens) },
  options: { median: pct(rows.map((r) => options(r.prompt)), 0.5), max: Math.max(...rows.map((r) => options(r.prompt))) },
});
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12));

const perTurn = rows.length / turns.length;
const step = Math.max(1, Math.round(unique.length / (Number(target) / perTurn)));
const picked = unique.filter((_, i) => i % step === 0);
writeFileSync(
  output,
  picked.flatMap((t, turn) => t.map((r) => JSON.stringify({ turn, prompt: r.prompt }))).join("\n") + "\n",
);
console.log(`replay set: ${picked.length} turns, ${picked.flat().length} prompts -> ${output}`);
