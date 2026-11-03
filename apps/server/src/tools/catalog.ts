import { readFileSync } from "node:fs";
import type { Option } from "../shared/types.ts";
type Workspace = { code: string; title: string; explorer_url: string; explainer_url: string };
type Link = {
  id: string;
  title: string;
  url: string;
  keywords: string[];
  fallback_instruction: string;
  category: string;
};
type Term = { term: string; aliases: string[]; definition: string; source: string };
function read(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../../data/${name}.json`, import.meta.url), "utf8"),
  );
}
export const workspaces = (read("workspaces") as { workspaces: Workspace[] }).workspaces;
export const links = (read("links") as Link[]).filter((link) => {
  try {
    const url = new URL(link.url);
    return url.protocol === "https:" && url.hostname === "iamparis.eu";
  } catch {
    return false;
  }
});
export const terms = (read("glossary") as { terms: Term[] }).terms;
const regionNames = (read("regions") as { names: Record<string, string> }).names;
const variableDictionary = (
  read("variables") as { variables: Record<string, { description?: string }> }
).variables;
/** The IAMC definition of a variable ("Net electricity generation from wind power"), if any. */
export const variableDescription = (name: string) =>
  variableDictionary[name]?.description || undefined;
const isoNames = new Intl.DisplayNames(["en"], { type: "region" });
/** A readable name for a region code (DEU → Germany, DE → Germany), or undefined if it is one. */
/** Named region codes from every study, for requests that leave the current study's regions. */
export const knownRegions: Option[] = Object.entries(regionNames).map(([code, name]) => ({
  id: code,
  label: code,
  detail: name,
}));
export function regionName(code: string): string | undefined {
  if (regionNames[code]) return regionNames[code];
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  try {
    const name = isoNames.of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}
export const workspaceOptions: Option[] = workspaces.map((w) => ({
  id: w.code,
  label: w.title,
  detail: w.code,
}));
export const linkOptions: Option[] = links.map((l) => ({
  id: l.id,
  label: l.title,
  detail: [l.category, ...(l.keywords ?? [])].join(" "),
}));
export const answerOptions: Option[] = terms.map((t, i) => ({
  id: `term${i}`,
  label: t.term,
  detail: t.aliases.join(", "),
}));

/** Extra search phrases per option id: link keywords and glossary aliases. */
export const optionPhrases = new Map<string, string[]>([
  ...links.map((l) => [l.id, l.keywords ?? []] as [string, string[]]),
  ...terms.map((t, i) => [`term${i}`, [t.term, ...t.aliases]] as [string, string[]]),
]);

const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const aliases: [RegExp, string][] = [
  [/\beurope(an union)?\b|\beuropean\b/, "eu"],
  [/\b(global|worldwide)\b/, "world"],
  [/\b(united states|u\.s\.a?\.?)\b/, "usa"],
  // IAMC naming: power is electricity; generation is secondary energy; consumption is final energy.
  [/\bpower\b/, "electricity"],
  [/\bcarbon\b/, "co2"],
  [/\b(greenhouse gas(es)?|ghg)\b/, "ghg kyoto gases"],
  [/\b(electricity|power) generation\b/, "secondary energy electricity"],
  [/\b(energy|electricity) (consumption|demand|use)\b/, "final energy"],
];
/** Codes people type in lower case and that are not common words. */
const lowercaseCodes = new Set(["EU", "USA", "UK", "CO2"]);
/** Whether the text mentions a word, after plural and alias normalisation ("Europe" → "eu"). */
export const mentions = (text: string, word: string) => words(text).has(stem(word));
function words(text: string) {
  const lower = text
    .toLowerCase()
    .replace(/carbon dioxide/g, "co2")
    .replace(/photovoltaic/g, "solar pv");
  const found = new Set((lower.match(/[a-z0-9]+/g) ?? []).map(stem));
  for (const [pattern, alias] of aliases)
    if (pattern.test(lower)) for (const word of alias.split(" ")) found.add(stem(word));
  return found;
}

/** Whether every word of a phrase appears in the text, after the same normalisation. */
export function says(text: string, phrase: string) {
  const said = words(text);
  const needed = (phrase.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
  return needed.length > 0 && needed.every((w) => said.has(w));
}

/**
 * The option whose every label (or phrase) word appears in the text, preferring the most specific
 * match: "CO2 emissions" matches Emissions|CO2, not Emissions|CO2|Energy. A label beats a keyword
 * of the same length. Ties are ambiguous and return nothing. Costs no classifier call, and keeps
 * the assistant useful without one.
 */
export function matchOption(options: Option[], text: string): Option | undefined {
  const said = words(text);
  const literal = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best: Option | undefined;
  let size = 0;
  let tie = false;
  for (const option of options)
    for (const [index, phrase] of [
      option.label,
      ...(optionPhrases.get(option.id) ?? []),
      ...(option.detail ? [option.detail] : []),
    ].entries()) {
      const needed = [...new Set((phrase.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem))];
      if (!needed.length || needed.some((w) => !said.has(w))) continue;
      // Short codes (CAN, ITA, PER, NO) are also English words: match them only as written in
      // capitals, or through an alias ("Europe" → EU), or by their name in `detail`.
      if (
        /^[A-Z0-9]{2,5}$/.test(phrase) &&
        !lowercaseCodes.has(phrase) &&
        !new RegExp(`\\b${phrase}\\b`).test(text) &&
        literal.has(phrase.toLowerCase())
      )
        continue;
      const score = needed.length + (index === 0 ? 0.5 : 0);
      if (score > size) [best, size, tie] = [option, score, false];
      else if (score === size && best?.id !== option.id) tie = true;
    }
  return tie ? undefined : best;
}

const commonWords = new Set(
  "the and for with from what does mean about tell are how who which this that scenario scenarios model models emission emissions energy".split(
    " ",
  ),
);
/**
 * Whether the text names the option: shares a distinctive word with its label, phrases or
 * detail. A guard for curated answers, so a confident classifier cannot attach a definition to
 * a question about something else ("tell me about GCAM" is not about IAM PARIS).
 */
const pageStopWords = new Set([
  ...commonWords,
  ..."result study studie eu iam pari policy question open data page application app service team project".split(
    " ",
  ),
]);
const pageWords =
  /\b(results?|stud(y|ies)|application|app|data ?stor(y|ies)|policy questions|contact|service|team)\b/i;
/**
 * A catalogued page named outright ("steel relocation EU results", "open the Aqueduct
 * application"): page words plus at least two distinctive words shared with the page's title or
 * keywords, or its whole one-word title. No classifier call.
 */
export function namedPage(text: string): Option | undefined {
  if (!pageWords.test(text)) return undefined;
  const said = words(text);
  let best: Option | undefined;
  let bestScore = 0;
  for (const option of linkOptions) {
    const phrases = [option.label, ...(optionPhrases.get(option.id) ?? [])];
    const distinctive = new Set(
      phrases.flatMap((p) => (p.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem)),
    );
    const shared = [...distinctive].filter(
      (w) => w.length > 2 && !pageStopWords.has(w) && said.has(w),
    ).length;
    const title = (option.label.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
    const whole = title.length === 1 && said.has(title[0]);
    const score = shared >= 2 ? shared : whole ? 1.5 : 0;
    if (score > bestScore) [best, bestScore] = [option, score];
  }
  return best;
}

export function mentionsOption(option: Option, text: string): boolean {
  const said = words(text);
  const phrases = [option.label, ...(optionPhrases.get(option.id) ?? []), option.detail ?? ""];
  return phrases.some((phrase) =>
    (phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .map(stem)
      .some((w) => w.length > 2 && !commonWords.has(w) && said.has(w)),
  );
}

/** Rank canonical options by word overlap, retaining every option for the manual picker. */
export function rankOptions(options: Option[], text: string): Option[] {
  const normalized = text
    .toLowerCase()
    .replace(/carbon dioxide/g, "co2")
    .replace(/photovoltaic/g, "solar pv");
  const stop = new Set(
    "help me compare in the for a an and or to of is where what can user selected study variable region model scenario headed please show build analysis".split(
      " ",
    ),
  );
  const tokens = [...words(text)].filter((t) => t.length > 1 && !stop.has(t));
  function score(o: Option) {
    const label = words(`${o.label} ${o.detail ?? ""}`);
    return (
      tokens.reduce((n, t) => n + (label.has(t) ? 2 : 0), 0) +
      (normalized.includes(o.label.toLowerCase()) ? 10 : 0) -
      o.label.split("|").length * 0.01
    );
  }
  return [...options].sort((a, b) => score(b) - score(a) || a.label.localeCompare(b.label));
}
