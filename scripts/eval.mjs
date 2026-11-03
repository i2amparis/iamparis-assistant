// Score the old (production) and new (local) assistants on iam-data-chatbot's labelled queries.
//
//   node scripts/eval.mjs [path/to/iam-data-chatbot] [--new-only]
//
// Each query is sent on its own (no follow-up context). Scored: the route (data / site or
// concept / model), and the variable and region where the test set names them. Results go to
// docs/benchmark/eval-results.json.
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "../iam-data-chatbot";
const newOnly = process.argv.includes("--new-only");
const files = ["eval_queries.csv", "eval_natural_queries.csv", "eval_holdout_queries.csv"];

function parseCsv(text) {
  const rows = [];
  let field = "", row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((h, i) => [h, values[i] ?? ""])));
}

const cases = files.flatMap((file) =>
  parseCsv(readFileSync(`${source}/${file}`, "utf8")).map((r) => ({ file, ...r })),
).filter((c) => c.expected_route && c.query && !/^(\d+|yes|no|ok)$/i.test(c.query.trim()) && !/^(same|only|and |what about|compare with)\b/i.test(c.query.trim()));

const family = { data_query: "data", data_plotting: "data", general_qa: "site", model_explanation: "model" };
const sameRegion = (a, b) => a && b && a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The production API rate-limits: pace requests, retry on 429, and report failures separately. */
async function oldBot(query) {
  let response, t;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt ? 5000 * attempt : 1200);
    t = performance.now();
    response = await fetch("https://chat.iamparis.eu/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    if (response.status !== 429 && response.status < 500) break;
  }
  if (!response.ok) return { route: "error", status: response.status };
  const r = await response.json();
  if (!r.route && !r.answer) return { route: "error", status: response.status };
  const agent = r.route?.agent ?? "";
  return {
    ms: Math.round(performance.now() - t),
    route: agent.startsWith("data") ? "data" : agent === "model_explanation" ? "model" : agent ? "site" : "none",
    variable: r.entities?.variable,
    region: r.entities?.region,
  };
}

const session = crypto.randomUUID();
const headers = { "Content-Type": "application/json", "X-IAMPARIS-Session": session };
async function newBot(query) {
  const conv = await (await fetch("http://127.0.0.1:8788/api/conversations", { method: "POST", headers, body: "{}" })).json();
  const t = performance.now();
  const c = await (await fetch(`http://127.0.0.1:8788/api/conversations/${conv.id}/turn`, { method: "POST", headers, body: JSON.stringify({ text: query, context: { path: "/" } }) })).json();
  const ms = Math.round(performance.now() - t);
  const reply = c.messages.at(-1).reply;
  const route = c.draft || ["result", "review"].includes(reply.kind) || reply.filters ? "data"
    : reply.source === "IAMPARIS model registry" || c.pending?.kind === "model" ? "model"
    : ["navigation", "answer"].includes(reply.kind) || ["navigation", "answer"].includes(c.pending?.kind) ? "site"
    : "none";
  return { ms, route, variable: c.draft?.filters?.variable?.[0], region: c.draft?.filters?.region?.[0], kind: reply.kind };
}

const results = [];
for (const c of cases) {
  const expected = family[c.expected_route];
  const row = { query: c.query, expected, variable: c.expected_variable || undefined, region: c.expected_region || undefined };
  row.new = await newBot(c.query);
  if (!newOnly) row.old = await oldBot(c.query).catch(() => ({ route: "error" }));
  results.push(row);
}

function score(key) {
  const rows = results.filter((r) => r[key] && r[key].route !== "error");
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : "-");
  const withVar = rows.filter((r) => r.variable && r.expected === "data");
  const withRegion = rows.filter((r) => r.region && r.expected === "data");
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return {
    route: pct(rows.filter((r) => r[key].route === r.expected).length, rows.length),
    variable: pct(withVar.filter((r) => r[key].variable === r.variable).length, withVar.length),
    region: pct(withRegion.filter((r) => sameRegion(r[key].region, r.region)).length, withRegion.length),
    medianMs: med(rows.map((r) => r[key].ms).filter(Boolean)),
    failedRequests: results.filter((r) => r[key]?.route === "error").length,
  };
}
const summary = { queries: results.length, new: score("new"), ...(newOnly ? {} : { old: score("old") }) };
writeFileSync(new URL("../docs/benchmark/eval-results.json", import.meta.url), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
const misses = results.filter((r) => r.new.route !== r.expected || (r.variable && r.expected === "data" && r.new.variable !== r.variable));
console.log(`\nnew-bot misses (${misses.length}):`);
for (const m of misses.slice(0, 40)) console.log(`- ${m.query} | want ${m.expected}${m.variable ? " " + m.variable : ""} | got ${m.new.route} ${m.new.variable ?? ""} (${m.new.kind})`);
