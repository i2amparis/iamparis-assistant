import { readFileSync } from "node:fs";
import type { Dimension, Option } from "../shared/types.ts";
import { says } from "./catalog.ts";

type Curation = {
  generalStudies: string[];
  studies: Record<string, string[]>;
  headlineScenarios: Record<string, string[]>;
  scenarios: Record<string, { label: string; phrases?: string[] }>;
  variables: Record<string, string[]>;
  units: Record<string, string[]>;
};
const curation = JSON.parse(
  readFileSync(new URL("../../../../data/curation.json", import.meta.url), "utf8"),
) as Curation;
const entries = <T>(record: Record<string, T>) =>
  Object.entries(record).filter(([key]) => key !== "_comment");

const unitSpellings = new Map(
  entries(curation.units).flatMap(([unit, spellings]) => spellings.map((s) => [s, unit])),
);
/** One spelling per unit ("EJ/y" reads as "EJ/yr"), so equal units are not left out as different. */
export const canonicalUnit = (unit: string) => unitSpellings.get(unit) ?? unit;

/** The readable name of a scenario code ("PR_CurPol_CP" → "Current policies"), if curated. */
export const scenarioLabel = (scenario: string) => curation.scenarios[scenario]?.label;

/** Whether a study answers requests that do not name it. */
export const isGeneralStudy = (code: string) => curation.generalStudies.includes(code);

/** A specialised study is used only when the request names it. */
export function namesStudy(code: string, text: string) {
  return isGeneralStudy(code) || (curation.studies[code] ?? []).some((p) => says(text, p));
}

/** The study's headline scenarios that have data here, used when the user names none. */
export function headlineScenarios(study: string | undefined, available: string[]) {
  return (curation.headlineScenarios[study ?? ""] ?? []).filter((s) => available.includes(s));
}

function phrasesFor(dimension: Dimension, id: string): string[] {
  if (dimension === "workspace_code") return curation.studies[id] ?? [];
  if (dimension === "variable") return curation.variables[id] ?? [];
  if (dimension === "scenario") return curation.scenarios[id]?.phrases ?? [];
  return [];
}

/**
 * The offered option a curated phrase names outright: the longest phrase wins; on a tie, the
 * study's headline scenario, else nothing. No classifier call, so the same wording always gives
 * the same choice.
 */
export function curatedPick(
  dimension: Dimension,
  options: Option[],
  text: string,
  study?: string,
): Option | undefined {
  let best: Option[] = [];
  let length = 0;
  for (const option of options)
    for (const phrase of phrasesFor(dimension, option.id)) {
      if (!says(text, phrase)) continue;
      const size = phrase.split(/\s+/).length;
      if (size > length) [best, length] = [[option], size];
      else if (size === length && !best.includes(option)) best.push(option);
    }
  if (best.length === 1) return best[0];
  const headline = headlineScenarios(
    study,
    best.map((o) => o.id),
  );
  return headline.length === 1 ? best.find((o) => o.id === headline[0]) : undefined;
}
