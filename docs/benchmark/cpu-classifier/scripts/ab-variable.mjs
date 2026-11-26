// Ask the live variable question with full descriptions and with several shortening rules.
//   node ab-variable.mjs /tmp/diag.json "<message>"
import { readFileSync } from "node:fs";

const [file, message] = process.argv.slice(2);
const found = [];
(function walk(o) {
  if (o && typeof o === "object") {
    if (typeof o.question === "string" && o.question.startsWith("Which variable") && Array.isArray(o.options)) found.push(o);
    Object.values(o).forEach(walk);
  }
})(JSON.parse(readFileSync(file, "utf8")));
const { question, options } = found[0];
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";
const brief = (detail) => {
  const cut = detail.slice(40).search(/ \(|; |, (including|reporting|such as|for instance)\b/);
  const kept = cut < 0 ? detail : detail.slice(0, 40 + cut);
  return kept.length > 120 ? kept.slice(0, kept.lastIndexOf(" ", 120)) : kept;
};
const system = "You classify one user message for the IAMPARIS climate-data assistant. Answer with the single letter of the option that best answers the question, or Z when no option fits or the message does not say. Never pick a value the message does not support.";
for (const [name, fmt] of [["full", (d) => d], ["short", brief], ["ipcc", (d) => d.split(" (IPCC")[0]], ["cap160", (d) => d.length > 160 ? d.slice(0, d.lastIndexOf(" ", 160)) : d], ["cap200", (d) => d.length > 200 ? d.slice(0, d.lastIndexOf(" ", 200)) : d]]) {
  const listing = options.slice(0, 25).map((o, i) => `${letters[i]}: ${o.label}${o.detail ? ` — ${fmt(o.detail)}` : ""}`).join("\n");
  const prompt = [
    `<|im_start|>system\n${system}<|im_end|>`,
    `<|im_start|>user\nMessage: ${message}\n\nQuestion: ${question}\n${listing}`,
    "Z: None fits, or the message does not say<|im_end|>",
    "<|im_start|>assistant\n<think>\n\n</think>\n\nAnswer:",
  ].join("\n");
  const r = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    body: JSON.stringify({ model: "qwen3:4b", raw: true, stream: false, prompt, logprobs: true, top_logprobs: 20, options: { temperature: 0, num_predict: 1 } }),
  }).then((x) => x.json());
  const mass = {};
  for (const { token, logprob } of r.logprobs[0].top_logprobs) {
    const t = token.trim();
    if (t.length === 1 && (t === "Z" || letters.indexOf(t) < options.length) && letters.includes(t) || t === "Z") mass[t] = (mass[t] ?? 0) + Math.exp(logprob);
  }
  const total = Object.values(mass).reduce((s, x) => s + x, 0);
  const top = Object.entries(mass).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k === "Z" ? "none" : options[letters.indexOf(k)].label} ${(100 * v / total).toFixed(0)}%`);
  console.log(name.padEnd(6), `${r.prompt_eval_count} tokens`, top.join(", "));
}
