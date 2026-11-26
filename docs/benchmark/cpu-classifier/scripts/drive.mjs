// Send the curation conversations (once) and the labelled eval queries (each on its own) to an
// assistant API, so a capture proxy in front of its Ollama records realistic classifier prompts.
//   node drive.mjs <iamparis-chat dir> <iam-data-chatbot dir> [api=http://127.0.0.1:8799/api]
import { readFileSync } from "node:fs";

const [chat, chatbot, api = "http://127.0.0.1:8799/api"] = process.argv.slice(2);
const headers = {
  "Content-Type": "application/json",
  "X-IAMPARIS-Session": crypto.randomUUID(),
  Origin: "http://127.0.0.1:5174",
};
const post = async (path, body) => {
  const r = await fetch(api + path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};
async function conversation(texts) {
  const { id } = await post("/conversations", {});
  for (const text of texts) await post(`/conversations/${id}/turn`, { text, context: { path: "/" } });
}

const { cases } = JSON.parse(readFileSync(`${chat}/scripts/curation-cases.json`, "utf8"));
for (const { turns } of cases) await conversation(turns.map((t) => t.text));
console.log(`curation: ${cases.length} conversations`);

// Same CSV files and filter as scripts/eval.mjs.
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
const queries = ["eval_queries.csv", "eval_natural_queries.csv", "eval_holdout_queries.csv"]
  .flatMap((file) => parseCsv(readFileSync(`${chatbot}/${file}`, "utf8")))
  .filter((c) => c.expected_route && c.query && !/^(\d+|yes|no|ok)$/i.test(c.query.trim()) && !/^(same|only|and |what about|compare with)\b/i.test(c.query.trim()))
  .map((c) => c.query);
for (const q of queries) await conversation([q]);
console.log(`eval: ${queries.length} queries`);
