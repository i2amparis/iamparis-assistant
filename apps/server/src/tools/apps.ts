import { readFileSync } from "node:fs";
import {
  appFacetKeys,
  type AppCard,
  type AppFacet,
  type AppSelection,
  type Option,
} from "../shared/types.ts";
import { says } from "./catalog.ts";

/**
 * The Application Library (https://iamparis.eu/application_library), for the assistant.
 *
 * `data/apps.json` is a snapshot of every tool the library lists (built by
 * scripts/build_app_catalogue.mjs from the CMS collection behind the page). The functions here
 * find a tool by its name, rank the tools against what someone describes, and apply the page's
 * type chips. Each tool has its own library page, /application_library/<id>, so a reply can send
 * people straight to it.
 */
export type App = {
  id: number;
  title: string;
  description: string;
  path: string;
  link?: string;
  type: string[];
  topic: string[];
  audiences: string[];
  scales: string[];
  geographies: string[];
  creator?: string;
  year?: string;
  project?: string;
  catalogued_by?: string;
};
type Catalogue = { generated_on: string; facets: Record<AppFacet, string[]>; apps: App[] };
type Phrases = { apps: { type: Record<string, string[]> } };

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../data/${name}.json`, import.meta.url), "utf8"));
const catalogue = read("apps") as Catalogue;
const typePhrases = (read("curation") as Phrases).apps.type;

export const apps = catalogue.apps;
export const appsSnapshot = catalogue.generated_on;
export const appFacetNames: Record<AppFacet, string> = { type: "type", topic: "topic" };
export const libraryPath = "/application_library";

/** Words in order: lower case, singular, one spelling ("Visualisations" → visualization). */
function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/isation/g, "ization")
      .match(/[a-z0-9]+/g) ?? []
  ).map((word) =>
    word.length > 4 && word.endsWith("ies")
      ? `${word.slice(0, -3)}y`
      : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
  );
}
/** Long words are compared by their first six letters, so "finance" finds "financial". */
const stemOf = (word: string) => (word.length > 6 ? word.slice(0, 6) : word);

/**
 * What a tool is called: its title, the title without its bracketed part, the bracketed part
 * ("GFW"), and what stands before a dash or colon ("pyam – Analysis and Visualization").
 */
function namesOf(title: string): string[] {
  const plain = title.replace(/\([^)]*\)/g, " ");
  return [
    ...new Set(
      [
        title,
        plain,
        plain.split(/\s[-–]\s|:\s/)[0],
        ...[...title.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]),
      ]
        .map((name) => name.replace(/\s+/g, " ").trim())
        .filter((name) => tokens(name).length),
    ),
  ];
}
const names = new Map(apps.map((app) => [app.id, namesOf(app.title)]));
/** Names made only of these are everyday wording ("power for all"): they count as written. */
const everyday = new Set("power for all rise shortfall energy data info".split(" "));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tools the text names outright: every word of one of its names, in order. Short abbreviations
 * (IEA) and names that are everyday words (POWER, RISE) must be written as the library writes
 * them. A name inside a longer one that also matched is dropped ("METEOR" in "METEOR Explorer").
 */
export function namedApps(text: string): { app: App; phrase: string }[] {
  const said = tokens(text);
  const found: { app: App; phrase: string; start: number; length: number }[] = [];
  for (const app of apps) {
    let best: (typeof found)[number] | undefined;
    for (const name of names.get(app.id)!) {
      const wanted = tokens(name);
      const asWritten =
        wanted.every((word) => everyday.has(word)) || (wanted.length === 1 && wanted[0].length < 4);
      if (asWritten && !new RegExp(`(^|[^\\w])${escaped(name)}($|[^\\w])`).test(text)) continue;
      const start = said.findIndex((_, i) => wanted.every((word, j) => said[i + j] === word));
      if (start >= 0 && wanted.length > (best?.length ?? 0))
        best = { app, phrase: name, start, length: wanted.length };
    }
    if (best) found.push(best);
  }
  return found
    .filter(
      (a) =>
        !found.some(
          (b) =>
            b.length > a.length && b.start <= a.start && b.start + b.length >= a.start + a.length,
        ),
    )
    .map(({ app, phrase }) => ({ app, phrase }));
}

/**
 * Types the text names: a label of several words ("interactive maps") or a curated phrase from
 * data/curation.json ("map", "game"). One-word labels such as Analysis and Report are everyday
 * words, so they filter only when chosen.
 */
export function namedAppTypes(text: string): { id: string; phrase: string }[] {
  const found: { id: string; phrase: string }[] = [];
  for (const type of catalogue.facets.type) {
    const hit = [...(type.includes(" ") ? [type] : []), ...(typePhrases[type] ?? [])]
      .filter((phrase) => says(text, phrase))
      .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)[0];
    if (hit) found.push({ id: type, phrase: hit });
  }
  return found;
}

/** Whether a tool passes the selection: OR within a facet, AND between facets. */
export function matchesApp(app: App, selection: AppSelection, ignore?: AppFacet) {
  return appFacetKeys.every((key) => {
    const chosen = selection[key];
    if (key === ignore || !chosen?.length) return true;
    return app[key].some((value) => chosen.includes(value));
  });
}

/** A facet's values as choices, each with the number of tools it would show. */
export function appFacetOptions(key: AppFacet, selection: AppSelection = {}): Option[] {
  const counted = apps.filter((app) => matchesApp(app, selection, key));
  return catalogue.facets[key]
    .map((value) => ({ value, count: counted.filter((app) => app[key].includes(value)).length }))
    .filter(({ count }) => count > 0)
    .map(({ value, count }) => ({
      id: `${key}:${value}`,
      label: value,
      detail: `${count} ${count === 1 ? "tool" : "tools"}`,
    }));
}

/** Where a word may be found in a tool's entry, and how much finding it there says. */
const fields = (app: App): [string, number][] => [
  [app.title, 3],
  [[...app.type, ...app.topic, app.project ?? ""].join(" "), 2.5],
  [[app.creator ?? "", app.catalogued_by ?? ""].join(" "), 2],
  [[...app.audiences, ...app.scales, ...app.geographies].join(" "), 1.2],
  [app.description, 1],
];
const index = apps.map((app) => {
  const weights = new Map<string, number>();
  for (const [text, weight] of fields(app))
    for (const word of tokens(text))
      weights.set(stemOf(word), Math.max(weight, weights.get(stemOf(word)) ?? 0));
  return { app, weights };
});
const frequency = new Map<string, number>();
for (const { weights } of index)
  for (const stem of weights.keys()) frequency.set(stem, (frequency.get(stem) ?? 0) + 1);
/** A word found in few entries says more than one found in most ("aqueduct" against "climate"). */
const rarity = (stem: string) => Math.log(1 + apps.length / (frequency.get(stem) ?? apps.length));

/** Words that ask for a tool rather than describe it. */
const ignored = new Set(
  "a an the and or of for to in on at by with from about into is are was be there any some i me my we our us you your it its this that these those do does did can could would should will want need like looking look find finding search show give get see use using used open go take where which what who how please help tell know let list have has had got also just only more most good best new free online available listed exist tool app application library platform website site web software resource iamparis iam pari one something anything thing".split(
    " ",
  ),
);

/** The words a chosen type is named by: its filter already says them ("maps", "a game"). */
const typeWords = (selection: AppSelection) =>
  new Set(
    (selection.type ?? []).flatMap((type) =>
      [type, ...(typePhrases[type] ?? [])].flatMap((phrase) => tokens(phrase).map(stemOf)),
    ),
  );

export type AppHit = { app: App; score: number; words: string[] };
/**
 * Tools ranked against a description. Every word that asks for nothing ("is there a tool for")
 * is dropped; each remaining word counts where it is found (title, then type and topic, then who
 * made it, then the description), weighted by how rare it is in the library, and a tool that
 * has only half the words scores half: "water risk" ranks the tool about both above one with
 * "water" in its title. Tools scoring under 40% of the best are left out. Words that name a
 * chosen type are left to its filter. Without usable words the selection alone decides, in
 * title order with tools from IAMPARIS network projects first, as the page lists them.
 */
export function searchApps(query: string, selection: AppSelection = {}) {
  const filtered = typeWords(selection);
  const wanted = [
    ...new Set(
      tokens(query).filter(
        (w) => !ignored.has(w) && !filtered.has(stemOf(w)) && (w.length > 1 || /\d/.test(w)),
      ),
    ),
  ];
  const words = wanted.filter((word) => frequency.has(stemOf(word)));
  const unknown = wanted.filter((word) => !frequency.has(stemOf(word)));
  const pool = index.filter(({ app }) => matchesApp(app, selection));
  if (!words.length) {
    const chosen = appFacetKeys.some((key) => selection[key]?.length);
    const hits: AppHit[] = chosen
      ? pool
          .map(({ app }) => ({ app, score: 0, words: [] }))
          .sort(
            (a, b) =>
              Number(Boolean(b.app.project)) - Number(Boolean(a.app.project)) ||
              a.app.title.localeCompare(b.app.title),
          )
      : [];
    return { hits, words, unknown };
  }
  const scored = pool
    .map(({ app, weights }) => {
      const found = words.filter((word) => weights.has(stemOf(word)));
      const score =
        (found.length / words.length) *
        found.reduce((sum, word) => sum + weights.get(stemOf(word))! * rarity(stemOf(word)), 0);
      return { app, score, words: found };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.app.title.localeCompare(b.app.title));
  const best = scored[0]?.score ?? 0;
  return { hits: scored.filter((hit) => hit.score >= best * 0.4), words, unknown };
}

/**
 * The library URL query that opens the page near a result: its type chips, and a search text
 * the page's own search (one string, looked for in titles, descriptions, topics and types)
 * finds at least one of the listed tools with. Topics have no control on the page and are left out.
 */
export function libraryQuery(selection: AppSelection, words: string[], listed: App[]) {
  const params = new URLSearchParams();
  // What the page's search looks through for one tool.
  const searched = (app: App) =>
    [app.title, app.description, app.topic.join(", "), app.type.join(", ")]
      .join("\n")
      .toLowerCase();
  const finds = (text: string) => listed.some((app) => searched(app).includes(text));
  // Words that only repeat a chosen type ("interactive maps") add nothing to its chip.
  const chosen = typeWords(selection);
  const useful = words.filter((word) => !chosen.has(stemOf(word)));
  // The whole description if the page finds it; else its most telling word: one that many of
  // the listed tools contain and few others do.
  const telling = (word: string) =>
    listed.filter((app) => searched(app).includes(word)).length * rarity(stemOf(word));
  const search = [useful.join(" "), ...[...useful].sort((a, b) => telling(b) - telling(a))]
    .filter(Boolean)
    .find(finds);
  if (search) params.set("q", search);
  if (selection.type?.length) params.set("type", selection.type.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

const summaryLength = 320;
/** A tool as shown in a reply; chips the search or the selection matched come first. */
export function appCard(app: App, selection: AppSelection = {}, words: string[] = []): AppCard {
  const stems = new Set(words.map(stemOf));
  const chips = appFacetKeys
    .flatMap((key) =>
      app[key].map((label) => ({
        key,
        label,
        matched:
          Boolean(selection[key]?.includes(label)) ||
          tokens(label).some((word) => stems.has(stemOf(word))),
      })),
    )
    .sort((a, b) => Number(b.matched) - Number(a.matched));
  const cut = app.description.slice(0, summaryLength);
  return {
    id: app.id,
    title: app.title,
    summary:
      app.description.length > summaryLength
        ? `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 200))}…`
        : app.description,
    path: app.path,
    url: `https://iamparis.eu${app.path}`,
    link: app.link,
    // A sentence about who built it is not a name.
    creator: app.creator && app.creator.length <= 70 ? app.creator : undefined,
    year: app.year,
    project: app.project,
    chips,
  };
}
