import { config } from "../config.ts";

export type Provider = "typesafe" | "local" | "ollama" | "manual";
export type ProviderSettings = {
  provider: Provider;
  model: string;
  baseURL: string;
  apiKey: string;
  timeout: number;
  confidence: number;
  margin: number;
};

function numeric(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * Prefer hosted Jev when a key exists; otherwise a local Qwen model through Ollama.
 * local-jev (Jev wire format, true probabilities) is opt-in.
 */
export function providerSettings(): ProviderSettings {
  const requested = process.env.IAM_CLASSIFIER_PROVIDER?.trim() || "auto";
  if (!["auto", "typesafe", "local", "ollama", "manual"].includes(requested))
    throw new Error("Invalid IAM_CLASSIFIER_PROVIDER");
  const hostedKey = process.env.TYPESAFE_API_KEY?.trim() || "";
  const provider =
    requested === "auto" ? (hostedKey ? "typesafe" : "ollama") : (requested as Provider);
  if (provider === "ollama")
    return {
      provider,
      model: process.env.OLLAMA_MODEL?.trim() || "qwen3:4b",
      baseURL:
        process.env.OLLAMA_BASE_URL?.trim() ||
        process.env.LOCAL_LLM_BASE_URL?.trim() ||
        "http://127.0.0.1:11434",
      apiKey: "ollama",
      timeout: numeric("OLLAMA_TIMEOUT", 60, 1, 600) * 1000,
      confidence: config.confidence,
      margin: config.margin,
    };
  const local = provider === "local";
  return {
    provider,
    model: local
      ? process.env.LOCAL_JEV_MODEL?.trim() || "llm-qwen3.5-4b"
      : process.env.TYPESAFE_MODEL?.trim() || config.model,
    baseURL: local
      ? process.env.LOCAL_JEV_BASE_URL?.trim() || "http://127.0.0.1:8765"
      : process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai",
    apiKey: local ? process.env.LOCAL_JEV_API_KEY?.trim() || "local" : hostedKey,
    timeout: local ? numeric("LOCAL_JEV_TIMEOUT", 120, 1, 600) * 1000 : 15000,
    confidence: local
      ? numeric("LOCAL_JEV_CONFIDENCE", config.confidence, 0, 1)
      : config.confidence,
    margin: local ? numeric("LOCAL_JEV_MARGIN", config.margin, 0, 1) : config.margin,
  };
}

/** Probe the local model registry without loading weights or sending a classification request. */
export async function classifierStatus() {
  const settings = providerSettings();
  if (settings.provider === "manual")
    return { provider: "manual", classifier: "manual", model: null, available: false };
  if (settings.provider === "typesafe")
    return {
      provider: "typesafe",
      classifier: settings.apiKey ? "configured" : "unavailable",
      model: settings.model,
      available: Boolean(settings.apiKey),
    };
  const base = settings.baseURL.replace(/\/$/, "");
  const ollama = settings.provider === "ollama";
  try {
    const response = await fetch(ollama ? `${base}/api/tags` : `${base}/v1/models`, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    const body = (await response.json()) as { models?: { name?: string }[] };
    const available =
      response.ok &&
      Array.isArray(body.models) &&
      body.models.some((model) => model.name === settings.model);
    return {
      provider: settings.provider,
      classifier: available ? "ready" : "unavailable",
      model: settings.model,
      available,
    };
  } catch {
    return {
      provider: settings.provider,
      classifier: "unavailable",
      model: settings.model,
      available: false,
    };
  }
}
