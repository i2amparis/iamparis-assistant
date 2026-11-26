# Classifier on CPU: settings and models (EOSC VM, 26 November 2026)

**Question.** The assistant's classifier (`qwen3:4b` through Ollama) runs on a CPU-only EOSC VM. Which setting or model makes it faster without changing its decisions?

**Answer.** Ollama's default threads and quantization are already the fastest. No other small model was both faster and close to today's decisions. The best candidate, **shorter option descriptions in the classifier prompt**, cut total classifier time on the VM by 19% and the slowest turns by 36%, with 93 of 95 sampled decisions unchanged. But once deployed it **failed one of the 40 curation turns**: "emissions in the USA under current policies" dropped from 99% to 65% for `Emissions|CO2`, so the assistant asked instead of answering. Gentler cuts did not fix it (see [Live check after deploying](#live-check-after-deploying)). The [Results](#results) section has the details.

A short write-up of this benchmark for sharing is in Claude Docs, *Classifier on CPU: benchmark on the EOSC VM* (https://claude.ai/artifact/UzRyMuEPbP6Ff3NnnqZpQt, private until shared).

## Setup

| | |
|---|---|
| Machine | EOSC EU Node VM `iamparis-assistant` (PSNC eu-1): 16 vCPU AMD EPYC-Rome (AVX2, no AVX-512), 62 GiB RAM, no GPU |
| Software | Ubuntu 22.04.5, Ollama 0.40.13, Node 24.22.3 |
| Assistant code | `main` at `8f071fd` (the same commit is deployed on the VM) |
| Ollama service | loopback only, `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_CONTEXT_LENGTH=4096`, `OLLAMA_NUM_PARALLEL=1` (8 in the configurations marked p8) |
| Full record | [`results/environment.txt`](results/environment.txt): CPU flags, memory, model digests |

## Method

How the classifier works (`apps/server/src/jev/client.ts`): for each open question in a turn, it sends Ollama one raw prompt containing the user's message, the question, lettered options and `Z: None fits`. It reads the probabilities of the **first generated token** (top 20 logprobs) and accepts the leading option only if it has at least **72%** and leads the runner-up by at least **15 points**. Otherwise it makes no decision and the assistant asks the user. A turn asks about 5 questions, one after another.

1. **Capture real prompts.** A pass-through proxy ([`scripts/capture-proxy.mjs`](scripts/capture-proxy.mjs)) sat between a local copy of the assistant and Ollama. It recorded every classifier prompt for the 28 conversations of `scripts/curation-cases.json` and the 231 labelled queries used by `scripts/eval.mjs` ([`scripts/drive.mjs`](scripts/drive.mjs)). That gives **1,031 prompts in 217 turns** ([`data/captured-prompts.jsonl`](data/captured-prompts.jsonl)). The replay rebuilds all 1,031 byte for byte.
2. **Replay set.** [`scripts/summarise.mjs`](scripts/summarise.mjs) removed duplicate turns and kept every 5th unique turn: 42 turns and 199 prompts ([`data/replay-199.jsonl`](data/replay-199.jsonl)). On the VM that would take about 10 minutes per configuration (more than 2 hours for all 13), so the run uses every other turn of it: **21 turns, 95 prompts** ([`data/replay-95.jsonl`](data/replay-95.jsonl)). Each turn's prompts stay in their original order, so Ollama's prompt cache behaves as it does in production.
3. **Replay on the VM.** [`scripts/bench.mjs`](scripts/bench.mjs) sends each prompt exactly as the server does: raw mode, temperature 0, one token, top 20 logprobs. It records the answer, the probability, the decision under the 72% / 15-point rule, the wall time and Ollama's prompt token count and duration. [`scripts/run.sh`](scripts/run.sh) and [`scripts/run2.sh`](scripts/run2.sh) run every configuration, with Ollama **restarted before each one**, so no cache carries over. The model is loaded before timing starts.
4. **Compare.** [`scripts/compare.mjs`](scripts/compare.mjs) compares each configuration with the baseline, prompt by prompt.

### Configurations

| Name | What changes from the baseline | Idea tested |
|---|---|---|
| `base` | nothing: `qwen3:4b` (Q4_K_M), current prompt, 16 threads (Ollama's default) | reference |
| `threads8`, `threads12` | `num_thread` 8 / 12 | fewer threads can be faster on shared vCPUs |
| `q4_0` | the same model as `Q4_0` (`hf.co/unsloth/Qwen3-4B-GGUF:Q4_0`) | Q4_0 has fast AVX2 prompt kernels in llama.cpp |
| `qwen35-4b`, `qwen35-2b` | Qwen3.5 4B / 2B, same prompt | newer small models (Qwen3.5-4B scored higher than Qwen3-4B on JevBench in `local-jev`) |
| `granite-tiny` | IBM Granite 4.0 H-Tiny (7B total, about 1B active), Granite chat format | mixture of experts built for edge devices |
| `lfm2-8b-a1b` | Liquid LFM2-8B-A1B (8B total, about 1.5B active), ChatML | model built for CPUs |
| `short` | option descriptions cut at their first clause after 40 characters (a parenthesis, a semicolon, or ", including / reporting / such as / for instance"); labels unchanged | the variable question is about a third of all prompt tokens because of long IPCC descriptions |
| `p8-current` | `OLLAMA_NUM_PARALLEL=8`, current prompt | more cache slots alone |
| `p8-qfirst` | 8 slots; question and options **before** the message | the fixed part of each question stays cached in its own slot, so only the message is processed |
| `p8-restate` | as `p8-qfirst`, plus "Answer the question above for this message." after the message | keeps the question close to the answer (a question-first layout made the model abstain more in an earlier test) |
| `p8-restate-short` | `p8-restate` with shortened descriptions | both together |

The Granite and LFM2 prompts use each model's own chat tokens (checked against `ollama show --template`). Qwen models get the same prompt as production, including the empty `<think>` block that turns thinking off.

### Measures

- **Turn s:** the sum of the wall times of one turn's prompts, which is the classifier's share of a turn. Reported as median and 90th percentile over the 21 turns.
- **Prompt tok/s:** prompt tokens divided by Ollama's prompt evaluation time. Processing the prompt is almost all of the work, since each call generates one token.
- **Same decision:** prompts where the configuration reaches the same decision as the baseline, counting "no decision" as a decision.
- **Same top answer:** the same leading option before the 72% / 15-point rule.
- **Conflicts:** both decide, on different options. This is the harmful kind of disagreement, because the assistant would act on a different value.
- **Newly decided / no longer decided:** the configuration decides where the baseline did not, or the reverse.

The baseline is the reference, **not ground truth**: agreement measures how close a configuration stays to today's behaviour. A conflict can be either model's mistake. Configurations that look good get a second check with the curation test (`scripts/curation-check.mjs`, 40 turns with expected answers).

## Caveats

- One run per configuration with 95 prompts (21 turns). Timing differences under about 10% are within noise. The VM's vCPUs are shared with other tenants.
- The prompts come from test conversations, not real user traffic.
- Generation speed is irrelevant here, because each call generates one token. Results for chat-style use of the same models would differ.

## Run log

- 10:28 UTC: first start on the 199-prompt set, stopped after 26 prompts to halve the run time. Those 26 results were discarded.
- Before the run, the shortening rule was tightened twice. Cutting at every comma turned "Kyoto gases, including CO2, CH4, N2O and F-gases" into "…including CO2", and cutting at " — " dropped the sector from "…to the atmosphere — Electricity".
- 10:30 UTC: restarted on the 95-prompt set with [`scripts/restart-bench.sh`](scripts/restart-bench.sh). The logs are in `results/`.
- 11:27 UTC: `run.sh` finished (11 configurations). `run2.sh` never started: its "wait for run.sh" loop (`pgrep -f "bash run.sh"`) matched its own parent shell, whose command line contained that text.
- 12:10 UTC: removed the loop and started `run2.sh` directly (`short`, `p8-restate-short`). Nothing else changed. The waiting process had made no requests to Ollama.

## Reproduce

```bash
# On the VM, with the models pulled (see results/environment.txt):
scp scripts/{bench.mjs,run.sh,run2.sh} data/replay-95.jsonl ubuntu@<vm>:bench/
ssh ubuntu@<vm> 'cd bench && mv replay-95.jsonl replay.jsonl && nohup bash -c "bash run.sh > run.log 2>&1; bash run2.sh > run2.log 2>&1" &'
# Afterwards:
scp -r ubuntu@<vm>:bench/results results/raw
node scripts/compare.mjs results/raw results/summary.json
```

To capture a new prompt set, start the assistant with `OLLAMA_BASE_URL=http://127.0.0.1:11435`, run `node scripts/capture-proxy.mjs out.jsonl 11435`, then `node scripts/drive.mjs <iamparis-chat> <iam-data-chatbot> http://127.0.0.1:<port>/api`.

## Results

All 13 configurations ran on the VM on 26 November 2026, 10:30–12:17 UTC. The table comes from [`results/summary.md`](results/summary.md) (numbers in [`results/summary.json`](results/summary.json), raw per-prompt results in [`results/raw/`](results/raw/), logs in `results/run*.log`). "Turn s" is the classifier's time per turn. "Decided" counts prompts that passed the 72% / 15-point rule; the baseline decided 23 of 95, and most of the rest were correctly "none".

| Config | Turn s (median) | Turn s (p90) | Total s | Prompt tok/s | Same decision | Conflicts | Decided | Newly / no longer decided |
|---|---|---|---|---|---|---|---|---|
| **base** (`qwen3:4b`, 16 threads) | **11.4** | **23.2** | **289** | 136 | — | — | 23 | — |
| threads8 | 22.0 | 45.9 | 558 | 70 | 95/95 | 0 | 23 | 0 / 0 |
| threads12 | 15.5 | 31.9 | 391 | 100 | 95/95 | 0 | 23 | 0 / 0 |
| q4_0 | 13.5 | 28.4 | 350 | 112 | 80/95 | 2 | 30 | 10 / 3 |
| qwen35-4b | 15.3 | 27.3 | 366 | 108 | 81/95 | 1 | 16 | 3 / 10 |
| qwen35-2b | 9.9 | 16.5 | 219 | 180 | 77/95 | 0 | 19 | 7 / 11 |
| granite-tiny | 9.1 | 16.3 | 225 | 175 | 71/95 | 0 | 29 | 15 / 9 |
| lfm2-8b-a1b | 8.6 | 14.2 | 215 | 185 | 65/95 | 2 | 39 | 22 / 6 |
| **short** | **10.6** | **14.8** | **233** | 146 | **93/95** | **0** | 25 | 2 / 0 |
| p8-current | 11.6 | 23.3 | 289 | 137 | 95/95 | 0 | 23 | 0 / 0 |
| p8-qfirst | 8.1 | 20.7 | 202 | 196 | 80/95 | 1 | 13 | 2 / 12 |
| p8-restate | 8.7 | 21.3 | 212 | 191 | 76/95 | 1 | 7 | 1 / 17 |
| p8-restate-short | 8.1 | 13.8 | 171 | 206 | 75/95 | 1 | 6 | 1 / 18 |

Where the baseline's time goes:

| Question | Prompts | Share of time | Mean tokens | Mean s |
|---|---|---|---|---|
| Which variable… | 10 | 36% | 1,196 | 10.4 |
| Which study… | 19 | 18% | 383 | 2.8 |
| Which task… | 20 | 15% | 309 | 2.2 |
| Which region… | 12 | 7% | 266 | 1.8 |
| Which page… | 3 | 7% | 844 | 6.6 |
| Which scenario… | 12 | 6% | 241 | 1.5 |
| Which model… | 16 | 6% | 180 | 1.0 |

### What the results show

1. **Threads and quantization: keep Ollama's defaults.** Processing the prompt scales with cores: 136 tok/s at 16 threads, 100 at 12, 70 at 8. Q4_0 was slower than Q4_K_M on this CPU (112 tok/s) and changed 15 decisions.
2. **Other models: none is a clear win.** The fastest, LFM2-8B-A1B, Granite H-Tiny and Qwen3.5-2B, save 20–25% of total time but differ from today's decisions on 18–30 of 95 prompts. LFM2 and Granite decide much more often (39 and 29 against 23). Without ground truth that may be better recall or overconfidence, so judging them needs labelled data, not agreement. Qwen3.5-4B, despite its higher JevBench score, is slower on this CPU (108 tok/s) and decides less often.
3. **Shortened descriptions: faster, but they failed one curation turn once deployed (below).** The variable question takes 36% of the time because its options carry IPCC-category definitions. Shortening them brought it from 10.4 s to 5.6 s (722 tokens on average, from 1,196). 93/95 decisions were unchanged, with no conflicts; the 2 differences are new decisions. The same test on a GPU copy of the same model agrees (94/95, see below).
4. **Cache-friendly layout: faster, but changes behaviour.** With 8 slots and the fixed part first, Ollama does reuse its cache: the task question drops from 2.2 s to about 0.2 s after its first use. Total time fell by 30% (41% with shortened descriptions). But Qwen decided much less often (13, then 7 and 6 against 23), because with the message last it often starts a sentence ("Let…", "The…") instead of a letter. More slots alone (`p8-current`) change nothing.

### Follow-up on the layout (local GPU, same model)

To find out whether the layout's problem could be fixed, more variants ran on a local RTX 5070 Ti with the **identical model build** (`qwen3:4b`, digest `359d7dd4bcda`, Ollama 0.40.13). Agreement there is about model behaviour, not speed. Results are in [`results/summary-gpu-local.md`](results/summary-gpu-local.md) and [`results/gpu-local/`](results/gpu-local/). On the GPU, the baseline decided 24 of 95 (23 on the CPU).

| Variant | Same decision | Decided |
|---|---|---|
| current layout, shortened descriptions | 94/95 | 25 |
| question first, repeated after the message (`qrepeat`) | 80/95 | 10 |
| `qrepeat`, answer pre-filled with "Best option:" | 78/95 | 20 |
| options first, question after the message (`optfirst`) | 77/95 | 17 |

Changing the pre-fill brings the letters back: they get a median 91% of the probability, against 94% for the production prompt. But about one decision in five still differs, so moving the message changes what the model decides, not only how it answers. That is not adopted: it would need ground-truth labels (or the curation check with expected answers) to show the new decisions are as good.

`scripts/bench.mjs` gained these variants (`qrepeat`, `optfirst`, `qfirst-letter`), a `PREFILL` setting, an `OLLAMA_URL` setting and two extra output fields (`letters`, `raw`) after the VM run. The VM results were produced before that, so they lack those fields. The existing layouts are unchanged.

### Change made

- `apps/server/src/jev/client.ts`: `brief()` shortens each option's description in the **Ollama classifier prompt only**, using the same rule as the `short` configuration. Users, hosted Jev and local-jev still see full descriptions. A test is in `client.test.ts`.
- Checks before deploying: `pnpm test` 94/94. `scripts/curation-check.mjs` passed 40/40 turns over 2 runs, against a local server with the change, on local Ollama with a GPU (`qwen3:4b`).
- Committed as `9c20d58` on branch `classifier-short-descriptions`, then deployed to the VM.

### Live check after deploying

On the VM (CPU), the curation check passed **39/40** turns over 2 runs ([`results/live-check.txt`](results/live-check.txt)). It ran on the VM over SSH against the deployed assistant at `http://127.0.0.1:8788`. The VM's `.env` only accepts the origins in `ALLOWED_ORIGINS`, so the run used a copy of `curation-check.mjs` whose `Origin` header is `https://chat.iamparis.eu`, one of those values. That is a header value only: no request went to the chat.iamparis.eu domain, which still points to the previous chatbot. The failing turn, "emissions in the USA under current policies", ended in "Which variable do you mean?" instead of a result. The region and scenario were still decided.

The variable question was then asked directly on the VM with [`scripts/ab-variable.mjs`](scripts/ab-variable.mjs), using the live options:

| Descriptions | Prompt tokens | `Emissions|CO2` | None |
|---|---|---|---|
| full (before the change) | 1,278 | 99% | 1% |
| shortened (`brief`, deployed) | 788 | 65% | 33% |
| cut only at " (IPCC" | 831 | 56% | 41% |
| capped at 160 characters | 1,019 | 71% | 28% |
| capped at 200 characters | 1,089 | 46% | 51% |

The confidence is not monotonic in how much is cut: on this question, any change to the descriptions moves the model's confidence. The 95-prompt sample did not include this question.

**Why the GPU copy passed.** It is the same model file (digest `359d7dd4bcda`), the same Ollama version and the same prompt, but the arithmetic differs ([`results/cpu-vs-gpu.txt`](results/cpu-vs-gpu.txt), [`scripts/cpu-vs-gpu.mjs`](scripts/cpu-vs-gpu.mjs)). The CPU and the GPU run different matrix kernels: different rounding, and floating-point sums added in a different order. Tiny differences build up over the model's 36 layers.

- **Usually negligible:** on the 95 sampled prompts, the top probability differs by a median of 0.1 points between the VM and the GPU, and decisions match on 94/95 (95/95 with shorter descriptions).
- **Sometimes large:** a few prompts differ by about 20 points. This question is one of them. Shortened, it scores 65% on the VM's CPU and 97–98% on the GPU.
- **Even one machine varies slightly:** the identical full prompt gave 91% then 99% on the GPU. How much of the prompt Ollama reuses from the previous request changes how the rest is computed.

A decision near the 72% threshold can therefore flip between machines. **Lesson:** a prompt change needs the curation check on the target machine before deploying, not only on a local GPU copy.

### Next steps worth testing

- **Fewer variable candidates.** The variable question is still the largest cost after shortening. Offering fewer variables (a tighter shortlist before the classifier) would cut it further.
- **Labelled ground truth.** A few hundred prompts labelled by hand (or by a large model, then checked) would let the faster models and the cached layout be judged on accuracy rather than agreement.
- **A non-generative classifier as a fast first pass.** A model that scores the message against the options (GLiClass, a cross-encoder) answers in milliseconds on a CPU. Qwen would remain the fallback for uncertain cases.
