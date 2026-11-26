import { readFileSync } from "node:fs";

/**
 * Light spelling repair for hurried typing ("co2 emisions in germny", "solar capasity"), before
 * any rule or classifier reads the message. Conservative on purpose:
 *
 * - A word is left alone when it appears anywhere in the assistant's own data (variable
 *   definitions, tool and study descriptions, glossary, page catalogue): about ten thousand
 *   English and domain words, so ordinary English is never "corrected".
 * - A word is replaced only by an anchor: a place name or a domain term that routing depends on
 *   (emissions, capacity, budget…), and only when exactly one anchor is that close: one edit for
 *   words of five to seven letters, two for longer ones. Shorter words are never changed.
 *
 * The user's message is stored as typed; the inspector shows each replacement.
 */

const read = (name: string) =>
  readFileSync(new URL(`../../../../data/${name}.json`, import.meta.url), "utf8");
const wordsOf = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];

/** Every word the assistant's data uses: never corrected. */
const known = new Set(
  [
    "variables",
    "apps",
    "studies",
    "glossary",
    "links",
    "workspaces",
    "curation",
    "regions",
  ].flatMap((name) => wordsOf(read(name))),
);

const isoNames = new Intl.DisplayNames(["en"], { type: "region" });
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const countries = [...letters].flatMap((a) =>
  [...letters].flatMap((b) => {
    try {
      const name = isoNames.of(a + b);
      return name && name !== a + b ? [name] : [];
    } catch {
      return [];
    }
  }),
);
const regionNames = Object.values(
  (JSON.parse(read("regions")) as { names: Record<string, string> }).names,
);
const glossary = (
  JSON.parse(read("glossary")) as { terms: { term: string; aliases: string[] }[] }
).terms.flatMap((t) => [t.term, ...t.aliases]);
const variables = Object.keys(
  (JSON.parse(read("variables")) as { variables: Record<string, unknown> }).variables,
);
/** Words of requests that routing and matching depend on. */
const domain =
  "emissions emission electricity capacity generation consumption production demand supply energy " +
  "renewable renewables hydrogen biomass nuclear carbon dioxide greenhouse methane budget scenario " +
  "scenarios projection projections pathway pathways temperature population investment investments " +
  "transport transportation industry industrial buildings agriculture forestry forest forests " +
  "assessment integrated model models compare comparison study studies policies policy " +
  "current pledges baseline reference warming climate global europe european world " +
  "definition explain documentation application library dashboard interactive";
/** English words one edit from an anchor that the data happens not to use. */
const english = new Set(
  "would words worlds mission missions police polices tower lower powder poker polar sonar prize pride prime grade trace carton modal motel steal steer steep later wafer sturdy ethane germane trance franc chins indie grease tirade flows below allow belong".split(
    " ",
  ),
);

const anchors = [
  ...new Set(
    [...countries, ...regionNames, ...glossary, ...variables, domain]
      .flatMap(wordsOf)
      .filter((w) => w.length >= 5),
  ),
];

/** Edit distance with adjacent transpositions, stopping early once it exceeds `limit`. */
function distance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, previous2[j - 2] + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    [previous2, previous] = [previous, row];
  }
  return previous[b.length];
}

const cache = new Map<string, string | undefined>();
/** The anchor a misspelled word stands for, if exactly one is close enough. */
function repair(word: string): string | undefined {
  if (cache.has(word)) return cache.get(word);
  let found: string | undefined;
  if (word.length >= 5 && !known.has(word) && !english.has(word)) {
    const limit = word.length >= 8 ? 2 : 1;
    let best = limit + 1;
    let tie = false;
    for (const anchor of anchors) {
      const d = distance(word, anchor, limit);
      if (d < best) [found, best, tie] = [anchor, d, false];
      else if (d === best && anchor !== found) tie = true;
    }
    if (tie || best > limit) found = undefined;
  }
  cache.set(word, found);
  return found;
}

/** The message with misspelled anchor words replaced, and the replacements made. */
export function correctSpelling(text: string): { text: string; fixes: [string, string][] } {
  const fixes: [string, string][] = [];
  const fixed = text.replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    const anchor = repair(lower);
    if (!anchor) return word;
    fixes.push([word, anchor]);
    return /^[A-Z]/.test(word) ? anchor[0].toUpperCase() + anchor.slice(1) : anchor;
  });
  return { text: fixed, fixes };
}
