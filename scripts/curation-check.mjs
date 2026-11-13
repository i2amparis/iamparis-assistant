// Live consistency check: send every conversation in curation-cases.json to a running assistant
// several times, compare each reply with its expected kind and filters, and flag replies that
// differ between runs. Read-only against the IAMPARIS API. Exit code 1 on any failure.
//
//   node scripts/curation-check.mjs [rounds=2] [--api http://127.0.0.1:8788/api]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = args.indexOf("--api");
const api = at >= 0 ? args.splice(at, 2)[1] : "http://127.0.0.1:8788/api";
const rounds = Number(args[0] ?? 2);
const { cases } = JSON.parse(
  readFileSync(new URL("./curation-cases.json", import.meta.url), "utf8"),
);
// Data-query filters, and the facets of a study search ("region" is a field of both).
const fields = ["workspace_code", "variable", "region", "modelName", "scenario", "sector", "tag"];
const headers = {
  "Content-Type": "application/json",
  "X-IAMPARIS-Session": crypto.randomUUID(),
  Origin: "http://127.0.0.1:5174",
};

async function post(path, body) {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/** One run of a conversation: the reply to each turn, reduced to what is compared. */
async function run(turns) {
  const { id } = await post("/conversations", {});
  const replies = [];
  for (const turn of turns) {
    const started = performance.now();
    const reply = (
      await post(`/conversations/${id}/turn`, { text: turn.text, context: { path: "/" } })
    ).messages.at(-1).reply;
    replies.push({
      ms: Math.round(performance.now() - started),
      kind: reply.kind,
      filters:
        reply.plan?.filters ??
        reply.filters ??
        Object.fromEntries(
          (reply.selection ?? []).map((facet) => [facet.key, facet.values.map((v) => v.id)]),
        ),
      series: reply.plan?.rows.length,
      text: reply.text,
    });
  }
  return replies;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
let failures = 0;
const times = [];
for (const { turns } of cases) {
  const runs = [];
  for (let round = 0; round < rounds; round++) runs.push(await run(turns));
  turns.forEach((turn, i) => {
    const replies = runs.map((r) => r[i]);
    const [first] = replies;
    times.push(...replies.map((r) => r.ms));
    const problems = [];
    if (first.kind !== turn.kind) problems.push(`kind ${first.kind}, expected ${turn.kind}`);
    for (const f of fields)
      if (turn[f] && !same(first.filters[f], turn[f]))
        problems.push(
          `${f} ${JSON.stringify(first.filters[f])}, expected ${JSON.stringify(turn[f])}`,
        );
    if (
      replies.some(
        (r) =>
          r.kind !== first.kind || !same(r.filters, first.filters) || r.series !== first.series,
      )
    )
      problems.push("differs between runs");
    failures += problems.length ? 1 : 0;
    const shown = fields
      .filter((f) => first.filters[f])
      .map((f) =>
        first.filters[f].length > 3
          ? `${first.filters[f].length} ${f}`
          : first.filters[f].join(", "),
      )
      .join(" · ");
    console.log(`${problems.length ? "✗" : "✓"} ${i ? "  → " : ""}${turn.text}`);
    console.log(`    ${first.kind}${first.series ? ` (${first.series} series)` : ""} ${shown}`);
    for (const p of problems) console.log(`    ! ${p}`);
    if (problems.length) console.log(`    ${first.text.slice(0, 240)}`);
  });
}
const total = cases.reduce((n, c) => n + c.turns.length, 0);
times.sort((a, b) => a - b);
console.log(
  `\n${total - failures}/${total} turns as expected over ${rounds} runs; median ${times[Math.floor(times.length / 2)]} ms.`,
);
process.exit(failures ? 1 : 0);
