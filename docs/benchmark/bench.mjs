// Benchmark: old iam-data-chatbot (production) vs new iamparis-assistant (local, Qwen 3 4B via Ollama).
import { writeFileSync } from "node:fs";

const OLD = "https://chat.iamparis.eu/query";
const NEW = "http://127.0.0.1:8788/api";
const conversations = [
  ["electricity generation for EU in 2050", "only solar", "same for Germany", "what about 2040?"],
  ["How much power will the EU get from wind in 2050?", "only GCAM"],
  ["Compare CO2 emissions in Europe in 2050"],
  ["Where can I find the model catalogue?"],
  ["where can I compare models side by side?"],
  ["What is a baseline scenario?"],
  ["What does net zero mean?"],
  ["energy in buildings for EU", "1"],
  ["tell me about GCAM", "who developed it?"],
];
const rounds = Number(process.argv[2] ?? 2);
const ms = (t) => Math.round(performance.now() - t);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function rtt() {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await fetch("https://chat.iamparis.eu/", { method: "HEAD" }).catch(() => {});
    times.push(ms(t));
  }
  return median(times.slice(1));
}

async function oldTurn(query, session_id) {
  const t = performance.now();
  const r = await (await fetch(OLD, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, session_id }) })).json();
  return {
    ms: ms(t),
    session_id: r.session_id,
    route: `${r.route?.agent}/${r.route?.source}`,
    extraction: r.entities?.extraction_method,
    variable: r.entities?.variable,
    region: r.entities?.region,
    clarification: Boolean(r.clarification && Object.keys(r.clarification).length),
    answer: String(r.answer ?? "").replace(/\s+/g, " ").slice(0, 220),
  };
}

const session = crypto.randomUUID();
const headers = { "Content-Type": "application/json", "X-IAMPARIS-Session": session };
async function newTurn(id, text) {
  const t = performance.now();
  const c = await (await fetch(`${NEW}/conversations/${id}/turn`, { method: "POST", headers, body: JSON.stringify({ text, context: { path: "/" } }) })).json();
  const elapsed = ms(t);
  const r = c.messages.at(-1).reply;
  const model = r.trace.filter((d) => d.source === "ollama");
  return {
    ms: elapsed,
    kind: r.kind,
    filters: r.filters,
    classifierCalls: model.filter((d) => d.tokens).length,
    inputTokens: model.reduce((n, d) => n + (d.tokens?.input ?? 0), 0),
    outputTokens: model.reduce((n, d) => n + (d.tokens?.output ?? 0), 0),
    wordingMatches: r.trace.filter((d) => d.source === "match").length,
    actions: (r.actions ?? []).map((a) => `${a.type}:${a.path ?? a.label}`),
    answer: `${r.title ? r.title + " — " : ""}${r.text}`.replace(/\s+/g, " ").slice(0, 220),
  };
}

// Warm both: Ollama loads the model on first use.
const warm = await (await fetch(`${NEW}/conversations`, { method: "POST", headers, body: "{}" })).json();
await newTurn(warm.id, "CO2 emissions in the world");
await oldTurn("hello").catch(() => {});

const results = { rttMs: await rtt(), when: new Date().toISOString(), rounds: [] };
for (let round = 0; round < rounds; round++) {
  const rows = [];
  for (const turns of conversations) {
    let sid;
    const conv = await (await fetch(`${NEW}/conversations`, { method: "POST", headers, body: "{}" })).json();
    for (const text of turns) {
      const o = await oldTurn(text, sid);
      sid = o.session_id;
      const n = await newTurn(conv.id, text);
      rows.push({ text, old: o, new: n });
    }
  }
  results.rounds.push(rows);
}
writeFileSync(new URL("./bench-results.json", import.meta.url), JSON.stringify(results, null, 2));

console.log(`network round trip to chat.iamparis.eu: ${results.rttMs} ms`);
const last = results.rounds.at(-1);
for (const [i, row] of last.entries()) {
  const oldMs = median(results.rounds.map((r) => r[i].old.ms));
  const newMs = median(results.rounds.map((r) => r[i].new.ms));
  console.log(`\n# ${row.text}`);
  console.log(`  OLD ${oldMs}ms [${row.old.route}, ${row.old.extraction ?? "-"}] ${row.old.answer}`);
  console.log(`  NEW ${newMs}ms [${row.new.kind}, ${row.new.classifierCalls} calls, ${row.new.inputTokens}→${row.new.outputTokens} tok, ${row.new.wordingMatches} matches] ${row.new.answer} ${row.new.actions.join(" ")}`);
}
const all = results.rounds.flat();
console.log(`\nmedian per turn: OLD ${median(all.map((r) => r.old.ms))} ms, NEW ${median(all.map((r) => r.new.ms))} ms`);
console.log(`NEW totals per round: ${last.reduce((n, r) => n + r.new.classifierCalls, 0)} classifier calls, ${last.reduce((n, r) => n + r.new.inputTokens, 0)} input / ${last.reduce((n, r) => n + r.new.outputTokens, 0)} output tokens over ${last.length} turns`);
