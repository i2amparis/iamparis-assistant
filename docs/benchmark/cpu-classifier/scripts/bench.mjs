// Replay captured classifier prompts against Ollama and record each answer and its timing.
//   node bench.mjs <replay.jsonl> <out.jsonl> <model> [layout=current|qfirst|qfirst-restate, optionally + "-short"] [family=qwen|granite|lfm] [num_thread]
// Mirrors apps/server/src/jev/client.ts: one token, top 20 logprobs, the same 0.72 / 0.15 gate.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [input, out, model, layout = "current", family = "qwen", threads] = process.argv.slice(2);
const host = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";
const NONE = "Z: None fits, or the message does not say";

/** Split a captured Qwen prompt into its parts. */
function parts(prompt) {
  const system = prompt.split("<|im_start|>system\n")[1].split("<|im_end|>")[0];
  const user = prompt.split("<|im_start|>user\n")[1].split("<|im_end|>")[0];
  const cut = user.lastIndexOf("\n\nQuestion: ");
  const message = user.slice("Message: ".length, cut);
  const [question, ...listing] = user.slice(cut + "\n\nQuestion: ".length).split("\n");
  return { system, message, question, listing: listing.filter((l) => l !== NONE) };
}

/** "-short" layouts cut each option's description at its first clause after 40 characters. */
const short = layout.endsWith("-short");
const shape = layout.replace(/-short$/, "");
function shorten(line) {
  const at = line.indexOf(" — ");
  if (!short || at < 0) return line;
  const detail = line.slice(at + 3);
  const cut = detail.slice(40).search(/ \(|; |, (including|reporting|such as|for instance)\b/);
  const kept = cut < 0 ? detail : detail.slice(0, 40 + cut);
  return line.slice(0, at + 3) + (kept.length > 120 ? kept.slice(0, kept.lastIndexOf(" ", 120)) : kept);
}

function userText({ message, question, listing }) {
  const options = [...listing.map(shorten), NONE].join("\n");
  if (shape === "current") return `Message: ${message}\n\nQuestion: ${question}\n${options}`;
  if (shape === "qfirst") return `Question: ${question}\n${options}\n\nMessage: ${message}`;
  // Added after the first VM run: variants that keep the cacheable part first but end on a cue
  // for a letter, because qfirst / qfirst-restate often answered with a word instead.
  if (shape === "qrepeat")
    return `Question: ${question}\n${options}\n\nMessage: ${message}\n\nQuestion: ${question}`;
  if (shape === "optfirst") return `Options:\n${options}\n\nMessage: ${message}\n\nQuestion: ${question}`;
  if (shape === "qfirst-letter")
    return `Question: ${question}\n${options}\n\nMessage: ${message}\n\nReply with the single letter of the best option, or Z.`;
  // Fixed part first (cacheable), then the message, then the question again so it is fresh.
  return `Question: ${question}\n${options}\n\nMessage: ${message}\n\nAnswer the question above for this message.`;
}

function render(p) {
  const user = userText(p);
  if (family === "granite")
    return `<|start_of_role|>system<|end_of_role|>${p.system}<|end_of_text|>\n<|start_of_role|>user<|end_of_role|>${user}<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>Answer:`;
  if (family === "lfm")
    return `<|im_start|>system\n${p.system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\nAnswer:`;
  // PREFILL (added after the first VM run) replaces the production "Answer:" for Qwen.
  const prefill = process.env.PREFILL ?? "Answer:";
  return `<|im_start|>system\n${p.system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n${prefill}`;
}

const rows = readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l));
writeFileSync(out, "");
const options = { temperature: 0, num_predict: 1, ...(threads ? { num_thread: Number(threads) } : {}) };
const call = (prompt) =>
  fetch(`${host}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model, raw: true, stream: false, prompt, logprobs: true, top_logprobs: 20, options }),
  }).then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))));

await call("Hello"); // load the model before timing
for (const [i, row] of rows.entries()) {
  const p = parts(row.prompt);
  const started = performance.now();
  const body = await call(render(p));
  const ms = performance.now() - started;
  const mass = {};
  for (const { token, logprob } of body.logprobs?.[0]?.top_logprobs ?? []) {
    const t = token.trim();
    const index = letters.indexOf(t);
    const id = t === "Z" ? "Z" : t.length === 1 && index >= 0 && index < p.listing.length ? t : undefined;
    if (id) mass[id] = (mass[id] ?? 0) + Math.exp(logprob);
  }
  const total = Object.values(mass).reduce((s, x) => s + x, 0);
  const ranked = Object.entries(mass).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / (total || 1)]);
  const [top = ["?", 0], second = ["", 0]] = ranked;
  const decided = total >= 0.5 && top[0] !== "Z" && top[1] >= 0.72 && top[1] - second[1] >= 0.15;
  appendFileSync(
    out,
    JSON.stringify({
      i, turn: row.turn, kind: p.question.slice(0, 40),
      top: total >= 0.5 ? top[0] : "?", p: +top[1].toFixed(3), decision: decided ? top[0] : "-",
      ms: Math.round(ms),
      prompt_tokens: body.prompt_eval_count,
      prompt_ms: Math.round((body.prompt_eval_duration ?? 0) / 1e6),
      // Share of the top 20 tokens that are option letters, and the three likeliest raw tokens.
      letters: +total.toFixed(3),
      raw: (body.logprobs?.[0]?.top_logprobs ?? []).slice(0, 3).map((t) => [t.token, +Math.exp(t.logprob).toFixed(3)]),
    }) + "\n",
  );
}
console.log(`${model} ${layout} ${family} threads=${threads ?? "default"}: ${rows.length} prompts`);
