import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Decision, Option } from "../shared/types.ts";
import { providerSettings, type ProviderSettings } from "./provider.ts";

export type Question = { question: string; options: Option[] };
/**
 * Ask several choice questions about one state in a single Jev request: the
 * state is sent (and paid for) once however many questions there are.
 */
export type Choose = (
  questions: Record<string, Question>,
  state: string,
) => Promise<Record<string, Decision>>;

type Answer = { choice?: string; probabilities?: Record<string, number>; confidence?: number };

/** Accept a choice only from a complete, valid distribution with a confident, separated winner. */
function read(
  trace: Decision,
  options: Option[],
  answer: Answer | undefined,
  settings: { confidence: number; margin: number },
) {
  const keys = [...options.map((_, index) => `o${index}`), "none"];
  const probabilities = answer?.probabilities ?? {};
  const entries = Object.entries(probabilities);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(probabilities, key)) ||
    entries.some(([, p]) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > 0.02
  ) {
    trace.error = "Jev returned an invalid decision for this question.";
    return;
  }
  for (const [index, option] of options.entries())
    trace.probabilities[option.id] = probabilities[`o${index}`];
  trace.noneProbability = probabilities.none;
  if (
    typeof answer!.confidence === "number" &&
    Number.isFinite(answer!.confidence) &&
    answer!.confidence >= 0 &&
    answer!.confidence <= 1
  )
    trace.confidence = answer!.confidence;
  const key = answer!.choice;
  const selected = options.find((_, index) => key === `o${index}`);
  const winner = key ? probabilities[key] : undefined;
  const runner = Math.max(0, ...entries.filter(([id]) => id !== key).map(([, p]) => p));
  if (
    selected &&
    typeof winner === "number" &&
    winner >= settings.confidence &&
    winner - runner >= settings.margin
  )
    trace.choice = selected.id;
}

const ollamaInstructions =
  "You classify one user message for the IAMPARIS climate-data assistant. Answer with the single letter of the option that best answers the question, or Z when no option fits or the message does not say. Never pick a value the message does not support.";
/** Single-token answer keys, so one generated token carries the whole probability distribution. */
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";

/**
 * Ask a local Qwen model through Ollama as a classifier: the
 * options are lettered, the reply is pre-filled up to "Answer:", and the probabilities Ollama
 * reports for the next token form the distribution over options and "none". The same confidence
 * and margin policy as Jev then applies. One short request per question; the shared message
 * prefix stays in Ollama's cache. Uses Qwen's chat template with thinking turned off.
 */
async function askOllama(
  settings: ProviderSettings,
  questions: Record<string, Question>,
  keys: string[],
  state: string,
  traces: Record<string, Decision>,
) {
  for (const key of keys) {
    const options = questions[key].options.slice(0, letters.length);
    const listing = options
      .map((o, i) => `${letters[i]}: ${o.label}${o.detail ? ` — ${o.detail}` : ""}`)
      .join("\n");
    const prompt = [
      `<|im_start|>system\n${ollamaInstructions}<|im_end|>`,
      `<|im_start|>user\nMessage: ${state}\n\nQuestion: ${questions[key].question}\n${listing}`,
      "Z: None fits, or the message does not say<|im_end|>",
      "<|im_start|>assistant\n<think>\n\n</think>\n\nAnswer:",
    ].join("\n");
    const response = await fetch(`${settings.baseURL.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(settings.timeout),
      redirect: "error",
      body: JSON.stringify({
        model: settings.model,
        raw: true,
        stream: false,
        prompt,
        logprobs: true,
        top_logprobs: 20,
        options: { temperature: 0, num_predict: 1 },
      }),
    });
    if (!response.ok) throw new Error("Ollama request failed");
    const body = (await response.json()) as {
      model?: string;
      logprobs?: { top_logprobs?: { token: string; logprob: number }[] }[];
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const mass: Record<string, number> = {};
    for (const { token, logprob } of body.logprobs?.[0]?.top_logprobs ?? []) {
      const index = letters.indexOf(token.trim());
      const id =
        token.trim() === "Z"
          ? "none"
          : token.trim().length === 1 && index >= 0 && index < options.length
            ? `o${index}`
            : undefined;
      if (id) mass[id] = (mass[id] ?? 0) + Math.exp(logprob);
    }
    const total = Object.values(mass).reduce((sum, p) => sum + p, 0);
    const trace = traces[key];
    trace.options = options;
    trace.model = body.model ?? settings.model;
    trace.tokens = { input: body.prompt_eval_count ?? 0, output: body.eval_count ?? 0 };
    if (total < 0.5) {
      trace.error = "The local model did not answer with one of the options.";
      continue;
    }
    const probabilities = Object.fromEntries(
      [...options.map((_, i) => `o${i}`), "none"].map((id) => [id, (mass[id] ?? 0) / total]),
    );
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    read(trace, options, { choice, probabilities }, settings);
  }
}

/** Use the same validation for hosted Jev, local-jev and Ollama; each question gets a decision. */
export const choose: Choose = async (questions, state) => {
  const started = performance.now();
  const keys = Object.keys(questions);
  const traces: Record<string, Decision> = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        question: questions[key].question,
        options: questions[key].options,
        probabilities: {},
        ms: 0,
        source: "jev",
      } satisfies Decision,
    ]),
  );
  const fail = (message: string) => keys.forEach((key) => (traces[key].error ??= message));
  let provider = "typesafe";
  try {
    const settings = providerSettings();
    provider = settings.provider;
    for (const key of keys) {
      traces[key].source =
        provider === "typesafe" ? "jev" : provider === "ollama" ? "ollama" : "local-jev";
      traces[key].model = settings.model;
    }
    const asked = keys.filter((key) => questions[key].options.length);
    if (settings.provider === "manual" || !settings.apiKey || !asked.length) {
      fail("Automatic decisions are disabled or not configured.");
      return traces;
    }
    if (settings.provider === "ollama") {
      await askOllama(settings, questions, asked, state, traces);
      return traces;
    }
    const client = new TypeSafeClient({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      defaultModel: settings.model,
      timeout: settings.timeout,
      retry: { maxRetries: 0 },
    });
    const { data: response, response: http } = await client
      .systemOne({
        model: settings.model,
        state,
        questions: Object.fromEntries(
          asked.map((key) => {
            const criteria: Record<string, string> = Object.fromEntries(
              questions[key].options.map((option, index) => [
                `o${index}`,
                `${option.label}${option.detail ? ` — ${option.detail}` : ""}`,
              ]),
            );
            criteria.none = "None fits, or the user has not specified this";
            return [key, { type: "choice", instructions: questions[key].question, criteria }];
          }),
        ),
      })
      .withResponse();
    if (http.headers.get("x-local-jev-truncated") === "true") {
      fail("The local model could not read the complete request.");
      return traces;
    }
    for (const key of asked) {
      traces[key].model = response.model;
      read(
        traces[key],
        questions[key].options,
        response.answers[key] as unknown as Answer | undefined,
        settings,
      );
    }
  } catch {
    fail(
      provider === "ollama"
        ? "Ollama is unavailable or returned an invalid decision. Start Ollama with the configured model."
        : provider === "local"
          ? "Local Qwen is unavailable or returned an invalid decision."
          : "Jev is unavailable or returned an invalid decision.",
    );
  } finally {
    const ms = Math.round(performance.now() - started);
    for (const key of keys) traces[key].ms = ms;
  }
  return traces;
};
