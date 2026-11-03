import { z } from "zod";
import { config } from "../config.ts";
import type { Dimension, Filters, ModelProfile, ResultRow } from "../shared/types.ts";
import { canonicalUnit } from "./curation.ts";

export interface Results {
  distinct(dimension: Dimension, filters: Filters): Promise<string[]>;
  rows(filters: Filters): Promise<ResultRow[]>;
  /** The IAMPARIS model registry; optional so data-only adapters and tests can omit it. */
  models?(): Promise<ModelProfile[]>;
}
const modelSchema = z.object({
  id: z.union([z.number(), z.string()]),
  modelName: z.string(),
  long_name: z.string().nullish(),
  institute: z.string().nullish(),
  model_type: z.string().nullish(),
  description: z.string().nullish(),
});
const rowSchema = z.object({
  modelName: z.string(),
  scenario: z.string(),
  region: z.string(),
  variable: z.string(),
  unit: z.string(),
  workspace_code: z.string().nullable().optional(),
  years: z.record(z.string(), z.number().finite().nullable()),
});

/** Read bounded JSON from the configured results service; redirects are refused. */
async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${config.resultsUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.apiTimeout),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error(
      "The IAMPARIS results service is unavailable. Your selections have been kept; try again.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > config.maxResponseBytes) {
      await reader.cancel();
      throw new Error("This query is too large. Choose a narrower study or variable.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Build a live API adapter; distinct values are cached for five minutes per filter combination. */
export function liveResults(): Results {
  const cache = new Map<string, { expires: number; values: string[] }>();
  let registry: { expires: number; models: ModelProfile[] } | undefined;
  return {
    /** Model profiles from the CMS, cached for an hour; the URL is fixed configuration. */
    async models() {
      if (registry && registry.expires > Date.now()) return registry.models;
      const url = `${config.modelsUrl}?limit=-1&filter[status][_eq]=active&fields=id,modelName,long_name,institute,model_type,description`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.apiTimeout),
        redirect: "error",
      });
      if (!response.ok) throw new Error("The model registry is unavailable. Try again shortly.");
      const data = z
        .object({ data: z.array(modelSchema).max(2000) })
        .parse(await response.json()).data;
      const models = data.map((m) => ({
        id: String(m.id),
        name: m.modelName,
        longName: m.long_name || undefined,
        institute: m.institute || undefined,
        type: m.model_type || undefined,
        description: m.description?.slice(0, 3000) || undefined,
      }));
      registry = { expires: Date.now() + 3600000, models };
      return models;
    },
    async distinct(column, filters) {
      const body = { ...filters, column };
      const key = JSON.stringify(body);
      const saved = cache.get(key);
      if (saved && saved.expires > Date.now()) return saved.values;
      const parsed = z
        .object({ data: z.array(z.union([z.string(), z.number(), z.null()])) })
        .parse(await post("/results/distinct", body));
      const values = [
        ...new Set(parsed.data.filter((v) => v !== null && String(v).trim() !== "").map(String)),
      ].sort();
      if (cache.size >= 500) cache.clear();
      cache.set(key, { expires: Date.now() + 300000, values });
      return values;
    },
    async rows(filters) {
      const payload = await post("/results/", filters);
      const rows = z.object({ data: z.array(rowSchema).max(1000) }).parse(payload).data;
      return rows.map((row) => ({
        ...row,
        unit: canonicalUnit(row.unit),
        workspace_code: row.workspace_code ?? undefined,
      }));
    },
  };
}
