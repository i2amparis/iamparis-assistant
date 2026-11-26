// Drive every persona conversation in personas.json through a running assistant and record, per
// turn, what the assistant did: the reply kind, the filters it chose, the options it offered, the
// studies, tools, page or definition it led to, and who made each decision (classifier, curated
// phrase or exact wording, a rule in code, or the user's click).
//
//   node docs/persona-study/run-personas.mjs <label> [--api http://127.0.0.1:8797/api]
//                                            [--origin http://127.0.0.1:5174] [--only id,id]
//                                            [--set personas|heldout]
//
// Writes results/<label>.json (raw, every reply field that matters) and prints a one-line summary
// per turn. Turns whose text starts with "#" click the offered option with that number instead of
// typing ("#1" = first option). Read-only against the IAMPARIS API.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const api = flag("--api", "http://127.0.0.1:8797/api");
const origin = flag("--origin", "http://127.0.0.1:5174");
const only = flag("--only", "").split(",").filter(Boolean);
const set = flag("--set", "personas");
const label = args[0] ?? "run";
const { personas } = JSON.parse(readFileSync(new URL(`./${set}.json`, import.meta.url), "utf8"));
const headers = {
  "Content-Type": "application/json",
  "X-IAMPARIS-Session": crypto.randomUUID(),
  Origin: origin,
};

async function post(path, body) {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

/** Who decided what in this turn, from the reply's trace. */
function decisions(trace = []) {
  return trace.map((d) => ({
    subject: d.subject,
    source: d.source,
    outcome: d.outcome,
    choice: d.choice,
    top: d.probabilities
      ? Object.entries(d.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([id, p]) => `${id}:${Math.round(p * 100)}`)
      : undefined,
    none: d.noneProbability === undefined ? undefined : Math.round(d.noneProbability * 100),
  }));
}

/** How the turn was settled: answered outright, answered with assumptions, or asked. */
function mode(reply) {
  if (reply.kind === "ask") return "asked";
  if (reply.kind === "review") return "asked";
  if (reply.kind === "error" || reply.kind === "help") return reply.kind;
  const assumed = reply.kind === "result" ? (reply.state?.draft?.assumed ?? []) : [];
  const guessed = (reply.trace ?? []).some(
    (d) => d.source === "classifier" && d.outcome === "accepted",
  );
  return assumed.length
    ? "answered+assumed"
    : guessed
      ? "answered (classifier)"
      : "answered (rules)";
}

function summarise(reply) {
  return {
    kind: reply.kind,
    mode: mode(reply),
    text: reply.text,
    title: reply.title,
    filters: reply.plan?.filters ?? reply.filters,
    years: reply.plan?.years ? [reply.plan.years[0], reply.plan.years.at(-1)] : undefined,
    series: reply.plan?.rows?.length,
    assumed: reply.state?.draft?.assumed,
    selection: reply.selection?.map((f) => `${f.key}=${f.values.map((v) => v.id).join("+")}`),
    studies: reply.studies?.map((s) => s.title),
    tools: reply.apps?.map((a) => a.title),
    url: reply.url,
    actions: reply.actions?.map((a) => a.path ?? a.type),
    options: reply.options?.map((o) => o.label),
    featured: reply.featured,
    pending: reply.state?.pending,
    decisions: decisions(reply.trace),
    ms: reply.ms,
  };
}

const out = { label, set, api, started: new Date().toISOString(), personas: [] };
for (const persona of personas) {
  if (only.length && !only.includes(persona.id)) continue;
  console.log(`\n## ${persona.id}: ${persona.who}`);
  const record = { id: persona.id, who: persona.who, turns: [] };
  const { id } = await post("/conversations", {});
  let last;
  for (const turn of persona.turns) {
    const click = /^#(\d+)$/.exec(turn.text);
    const body = click
      ? { option: last.options[Number(click[1]) - 1].id, token: last.token }
      : { text: turn.text, context: { path: turn.path ?? "/" } };
    const started = performance.now();
    let reply;
    try {
      reply = (await post(`/conversations/${id}/turn`, body)).messages.at(-1).reply;
    } catch (error) {
      reply = { kind: "error", text: String(error) };
    }
    last = reply;
    const summary = {
      said: click ? `[clicked ${click[1]}: ${body.option}]` : turn.text,
      want: turn.want,
      ...summarise(reply),
      wall: Math.round(performance.now() - started),
    };
    record.turns.push(summary);
    const what =
      summary.filters && summary.kind === "result"
        ? Object.entries(summary.filters)
            .map(([k, v]) => `${k}=${v.length > 3 ? `${v.length} values` : v.join("+")}`)
            .join(" ")
        : (summary.selection?.join(" ") ??
          summary.tools?.slice(0, 3).join(" · ") ??
          summary.title ??
          summary.options?.slice(0, 4).join(" | ") ??
          "");
    console.log(`> ${summary.said}\n  ${summary.kind} [${summary.mode}] ${what}`);
    if (summary.kind !== "result") console.log(`  "${(reply.text ?? "").slice(0, 160)}"`);
  }
  out.personas.push(record);
}
out.finished = new Date().toISOString();
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(`./results/${label}.json`, import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`\nSaved results/${label}.json`);
