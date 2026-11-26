// Compare two result files prompt by prompt (e.g. the VM CPU run and the local GPU run of one configuration).
//   node cpu-vs-gpu.mjs <cpu.jsonl> <gpu.jsonl>
import { readFileSync } from "node:fs";
const load = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const [cpu, gpu] = process.argv.slice(2).map(load);
let sameTop = 0, sameDec = 0, diffs = [];
for (let i = 0; i < cpu.length; i++) {
  if (cpu[i].top === gpu[i].top) sameTop++;
  if (cpu[i].decision === gpu[i].decision) sameDec++;
  if (cpu[i].top === gpu[i].top) diffs.push(Math.abs(cpu[i].p - gpu[i].p));
  if (cpu[i].decision !== gpu[i].decision) console.log(`  differs: ${cpu[i].kind.slice(0, 30)}… CPU ${cpu[i].decision} (${cpu[i].top} ${Math.round(cpu[i].p * 100)}%)  GPU ${gpu[i].decision} (${gpu[i].top} ${Math.round(gpu[i].p * 100)}%)`);
}
diffs.sort((a, b) => a - b);
console.log(`same top answer ${sameTop}/${cpu.length}, same decision ${sameDec}/${cpu.length}; gap in top probability: median ${(100 * diffs[diffs.length >> 1]).toFixed(1)} points, max ${(100 * diffs.at(-1)).toFixed(1)} points`);
