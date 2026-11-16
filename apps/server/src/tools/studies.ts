import { readFileSync } from "node:fs";
import {
  facetKeys,
  type FacetKey,
  type Option,
  type StudyCard,
  type StudySelection,
} from "../shared/types.ts";
import { says } from "./catalog.ts";

/**
 * The Results page's study filter (https://iamparis.eu/results), for the assistant.
 *
 * `data/studies.json` is a snapshot of every study with the sector / region / topic / project
 * facets the page derives (built by scripts/build_study_catalogue.mjs from the frontend's own
 * taxonomy code). The functions here apply the page's filter rule to it: values within one facet
 * are OR-ed, facets are AND-ed, and an option's count is how many studies it would show given
 * every other active facet.
 */
type FacetValue = { id: string; label: string; group?: string; eu?: boolean };
export type Study = {
  code: string;
  slug: string;
  title: string;
  summary: string;
  path: string;
  questions: string[];
  status?: string;
  models: number;
  search: string;
} & Record<FacetKey, string[]>;
type Catalogue = {
  generated_on: string;
  facets: Record<FacetKey, FacetValue[]>;
  studies: Study[];
};
type Phrases = { facets: Record<FacetKey, Record<string, string[]>> };

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../data/${name}.json`, import.meta.url), "utf8"));
const catalogue = read("studies") as Catalogue;
const phrases = (read("curation") as Phrases).facets;

export const studies = catalogue.studies;
export const studiesSnapshot = catalogue.generated_on;
export const facetNames: Record<FacetKey, string> = {
  sector: "sector",
  region: "region",
  tag: "topic",
  project: "project",
};

/** A facet value's display label ("south-africa" → "South Africa"). */
export function facetLabel(key: FacetKey, id: string) {
  return catalogue.facets[key].find((f) => f.id === id)?.label ?? id;
}

/** Whether a study passes the selection; `ignore` leaves one facet out, to count its own options. */
export function matchesSelection(study: Study, selection: StudySelection, ignore?: FacetKey) {
  return facetKeys.every((key) => {
    const chosen = selection[key];
    if (key === ignore || !chosen?.length) return true;
    return study[key].some((id) => chosen.includes(id));
  });
}

export const filterStudies = (selection: StudySelection) =>
  studies.filter((study) => matchesSelection(study, selection));

/**
 * Every value of one facet with the number of studies it would show given the other facets,
 * in the page's display order. Values that would show nothing are left out.
 */
export function facetCounts(key: FacetKey, selection: StudySelection) {
  const counted = studies.filter((study) => matchesSelection(study, selection, key));
  return catalogue.facets[key]
    .map((value) => ({
      ...value,
      count: counted.filter((study) => study[key].includes(value.id)).length,
    }))
    .filter((value) => value.count > 0);
}

/** A facet's values as choices for the user, each with the number of studies it would show. */
export function facetOptions(key: FacetKey, selection: StudySelection = {}): Option[] {
  return facetCounts(key, selection).map((value) => ({
    id: value.id,
    label: value.label,
    detail: `${value.count} ${value.count === 1 ? "study" : "studies"}`,
  }));
}

/**
 * Facet values the text names outright: by label ("Germany", "circular economy") or by a curated
 * phrase from data/curation.json ("German", "steelmaker", "energy ministry"). Several values of
 * one facet may be named. The phrase that matched is returned as evidence for the inspector.
 */
export function namedFacets(key: FacetKey, text: string): { id: string; phrase: string }[] {
  const found: { id: string; phrase: string }[] = [];
  for (const value of catalogue.facets[key]) {
    const hit = [value.label, ...(phrases[key]?.[value.id] ?? [])]
      .filter((phrase) => says(text, phrase))
      .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)[0];
    if (hit) found.push({ id: value.id, phrase: hit });
  }
  return found;
}

/** A facet's values as the classifier reads them: the label and the everyday words for it. */
export function facetCandidates(key: FacetKey): Option[] {
  return catalogue.facets[key].map((value) => ({
    id: value.id,
    label: value.label,
    detail: (phrases[key]?.[value.id] ?? []).slice(0, 8).join(", ") || undefined,
  }));
}

/** Whether a region is an EU member state, so a search for it can widen to EU-wide studies. */
export const inEu = (region: string) =>
  Boolean(catalogue.facets.region.find((value) => value.id === region)?.eu);

/** The Results page URL query that shows this selection ("sector=industry&region=germany"). */
export function selectionQuery(selection: StudySelection) {
  const params = facetKeys
    .filter((key) => selection[key]?.length)
    .map((key) => `${key}=${selection[key]!.map(encodeURIComponent).join(",")}`);
  return params.length ? `?${params.join("&")}` : "";
}

/** A study as shown in a reply, with the selected facet values it matched listed first. */
export function studyCard(study: Study, selection: StudySelection): StudyCard {
  const chips = (key: FacetKey) =>
    study[key].map((id) => ({
      key,
      id,
      label: facetLabel(key, id),
      matched: Boolean(selection[key]?.includes(id)),
    }));
  return {
    code: study.code,
    title: study.title,
    summary: study.summary,
    path: study.path,
    url: `https://iamparis.eu${study.path}`,
    projects: study.project.map((id) => facetLabel("project", id)),
    status: study.status,
    question: study.questions[0],
    facets: [
      ...chips("sector"),
      ...chips("region"),
      ...chips("tag").sort((a, b) => Number(b.matched) - Number(a.matched)),
    ],
  };
}
