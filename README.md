# IAMPARIS Assistant

An IAMPARIS assistant in which a System One classifier selects supplied options; application code decides what happens and renders the answer. No generative model writes replies or invents filters.

It is built with React, Hono, TypeSafe's Jev SDK and local SQLite persistence: a dark conversation/sidebar/decision-inspector layout, constrained decisions, confirmation cards, expiring buttons, deterministic tool presentation, and a focused HTTP adapter for the IAMPARIS API.

## Run

Node 24+ and pnpm 11 are required.

```powershell
git clone https://github.com/i2amparis/iamparis-assistant.git
cd iamparis-assistant
pnpm install
Copy-Item .env.example .env
# Classifier: local Qwen through Ollama (default), or set TYPESAFE_API_KEY for hosted Jev.
winget install Ollama.Ollama
ollama pull qwen3:4b
pnpm dev
```

Web: http://127.0.0.1:5174. API: http://127.0.0.1:8788. The IAMPARIS frontend (i2amparis-frontend, Ask AI panel) calls the API from http://localhost:5173. No other API key is needed for public IAMPARIS data.

**Classifier.** Without a TypeSafe key the server asks a local Qwen model through Ollama (`OLLAMA_MODEL`, default `qwen3:4b`), strictly as a classifier: options are lettered, the reply is pre-filled up to "Answer:", and Ollama's next-token probabilities form a distribution over the options and "none". The same confidence (0.72) and margin (0.15) policy as Jev then applies. Each question is a separate short request of about 30–60 ms once the model is loaded; the first request after Ollama starts loads the model (tens of seconds). At most 25 ranked candidates reach Qwen per question. Without any classifier, exact wording matches and stated defaults still answer most data requests.

To serve the built app from one port:

```powershell
pnpm build
pnpm start
```

Open http://127.0.0.1:8788. Conversations and decision traces survive restarts in `data/conversations.db`. The server binds to loopback and rejects external Host/Origin values. It is a local, single-user app. Internet deployment requires real authentication, per-user conversation ownership and deployment-specific origin policy.

## What it does

- **Navigation:** selects from the existing curated link catalogue. URLs remain exact; entries with only a library landing page retain their search instructions.
- **Curated answers:** selects a glossary entry and returns its definition verbatim with attribution, only when the question names the term or an alias. Unsupported questions receive choices, never generated facts.
- **Model profiles:** "tell me about GCAM" returns the IAMPARIS model registry's own description, developer and type, with a link to the model page; "who developed it?" is answered from the same record.
- **Curated analysis:** the classifier answers every open question about a message (route and study; then variable, region, model and scenario, with options from `/results/distinct` for the study). Exact wording matches ("CO2 emissions", "Europe" → EU, "Germany" → DEU, "GCAM" → GCAM-PR 5.3) fill what it leaves open and keep the assistant useful without one. Code then decides: a single available value is taken; an unnamed study, region, model or scenario is assumed (the EU or world "headed" study, World/EU, all models, the study's headline scenarios or else all up to 8, at most 24 lines, models in a minority unit left out) and the reply says so once; the user is asked only when the variable is unclear or the vote is split, with the classifier's best guess first, four suggestions and search behind "Other…". A complete query runs immediately.
- **Curated policy (`data/curation.json`):** decides before the classifier, so the same wording always gives the same query. Each large study has _headline scenarios_, its scenario family with the widest model coverage (world: `PR_CurPol_CP`, `PR_NDC_CP`; EU: `PR_WWH_CP`, `PR_WWH_NDC`), shown when none is named instead of every variant. Scenarios have readable names ("Current policies (PR_CurPol_CP)") and phrases ("under current policies", "add NDC"). Everyday phrases name variables word matching misses ("CCS", "greenhouse gas", "transport emissions") and keep the detail they name. A specialised study (Transportation Transformation, Post-Glasgow…) is used only when the request names it; a model or scenario only when the request names it. Duplicate region codes (IND and "India") resolve to the one with data, a named region missing from the study moves to a study that has it, and unit spellings (`EJ/y`, `EJ/yr`) are merged. Edit the file when studies change, then run the check below.
- **Follow-ups:** a typed change on a result ("only solar", "only GCAM", "add NDC", "same for Germany", "2030 to 2050") is applied with the current value stated in each question, and new, unrelated requests are recognised. A region the current study lacks moves the query to a study that has it for the same variable, and the reply says so. A requested value without data anywhere leaves the query unchanged and says so; selections a change makes unavailable are dropped and resolved again. Buttons offer the same changes, and typing an option's number picks it.
- **Variable dictionary:** `data/variables.json` gives each published variable its IAMC definition (from `iam-data-chatbot/definitions`, templates expanded) or its nearest defined parent's, about 68% coverage. The descriptions are the option text the classifier judges and feed the candidate ranking. Detail the user did not ask for is dropped ("carbon emissions" → Emissions|CO2, not …|Energy). Rebuild with `python scripts/build_variable_dictionary.py ../iam-data-chatbot/definitions/variable`.
- **Years:** type a year, explicit year list, or bounded range. Ranges include published observation years only. No interpolation or zero-filling.
- **Validation and preview:** every run rechecks returned row scope, scenario coverage and unit consistency, then displays observations, offers to open them in GraphMaker, and exports data or a GraphMaker configuration.
- **Inspector:** view the questions, supplied options, probabilities, accepted selections and latency. Low confidence, close alternatives, missing keys and service failures fall back to searchable choices.

Examples: “Help me compare CO2 emissions in Europe in 2050”; “Where can I find the model catalogue?”; “What is a baseline scenario?” While choosing, select a button, type its exact label, or use natural language with Jev enabled. `cancel` / `start over` reset the draft. Changing years is supported at query review.

## Analysis integration

The existing platform has an in-memory `analysisHandoff` store, not a URL contract for importing filters. The **Open Analysis** link therefore opens the platform without silently claiming to prefill it. The downloadable JSON matches the inspected GraphMaker configuration. No existing frontend was edited.

`integration/analysis-import.ts` is a portable, validated import adapter. Copy it into the platform and call it from a file-input handler after the user downloads a configuration:

```ts
import { goto } from "$app/navigation";
import { analysisHandoff } from "$lib/stores/analysisHandoff";
import { parseAnalysisConfiguration } from "$lib/analysis-import";

async function importChatbotAnalysis(file: File) {
  const config = parseAnalysisConfiguration(await file.text());
  analysisHandoff.set(config);
  await goto("/analysis");
}
```

Catch validation errors in the importing UI and show them to the user. Revalidate availability at execution time; exported configurations are snapshots, not an authorization mechanism. This hook is supplied but not installed in the platform.

## Architecture

`apps/server/src/shared` → `config`, `jev`, `tools` → `turn` → `app`. The web imports shared types only. `turn/turn.ts` owns pending choices and policy; `turn/analysis.ts` owns validation/export; `tools/results.ts` owns bounded live requests and metadata caching. No tool result can specify a URL to fetch or an action to execute. User labels are rendered as plain React text. API turns are serialized per conversation and stored atomically.

The classifier sees at most 70 ranked candidates per question. Larger catalogues remain fully searchable in the manual picker. Broad or unusual phrasing may need a clarification; no semantic recall or accuracy claim has been established yet. A live Jev evaluation requires a configured key. Thresholds and limits live in `config.ts`.

## Content provenance

Copied independently from `iam-data-chatbot`: `config/glossary.json` → `data/glossary.json`; `config/workspace_catalog.json` → `data/workspaces.json`; `docs/iamparis_link_catalog.json` → `data/links.json`. The workspace snapshot records verification on 2026-09-17; links and definitions are curated snapshots, not freshly verified facts. Edit these standalone copies as content changes. Metadata and observations come live from `https://api.iamparis.eu`. The global workspace-distinct endpoint currently fails on null workspace values, so the app uses the curated study list and scopes subsequent API requests by workspace.

Jev's [official documentation](https://docs.typesafe.ai/introduction) describes the System One choice interface used here.

## Verification

```powershell
pnpm format
pnpm lint:fix
pnpm test
pnpm typecheck
pnpm build
# Optional live, read-only IAMPARIS query; no Jev key needed:
pnpm --filter @iamparis/server exec tsx ../../scripts/live-smoke.ts
# Optional live consistency check against a running server (pnpm dev):
node scripts/curation-check.mjs
```

`scripts/curation-check.mjs` sends every conversation in `scripts/curation-cases.json` to the running assistant twice and checks each reply's kind, study, variable, region, model and scenario, and that both runs agree. On 2026-10-30 all 29 turns passed with a median of about 0.3 s. Add a case whenever a query is fixed, so it stays fixed.

Unit tests require no API keys or network. They cover invalid model selections, probability gates, manual continuation, stale buttons, API failures, dependent filters, comparisons, year handling, unit compatibility, persistence/API boundaries, and import validation. The live smoke script checks EU CO2 emissions in 2050 for GCAM-PR 5.3 / PR_WWH_CP in eu-headed.

Current scope: English, one variable/region/model per draft, multiple scenarios, public results, curated glossary and navigation. No model-profile generation, background autonomous browsing, platform account changes, or automatic publication is implemented.
