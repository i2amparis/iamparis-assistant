import { dimensions, type Draft, type Plan, type ResultRow } from "../shared/types.ts";
import { workspaces } from "../tools/catalog.ts";

/** Extract literal years and bounded year ranges without inventing a time horizon. */
export function requestedYears(text: string): string[] {
  const range = text.match(/\b((?:19|20|21)\d{2})\s*(?:to|through|[-–])\s*((?:19|20|21)\d{2})\b/i);
  if (range) {
    const start = Number(range[1]),
      end = Number(range[2]);
    if (end < start || end - start > 200)
      throw new Error("Choose a year range in ascending order, at most 200 years long.");
    return Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
  }
  return [...new Set(text.match(/\b(?:19|20|21)\d{2}\b/g) ?? [])];
}

/** Validate each selected scenario and requested year against returned observations before export. */
export function buildPlan(draft: Draft, input: ResultRow[]): Plan {
  const rows = input.filter((row) =>
    dimensions.every((d) => !draft.filters[d]?.length || draft.filters[d]!.includes(row[d] ?? "")),
  );
  if (!rows.length)
    throw new Error(
      "No published data matches this combination. Change a selection and try again.",
    );
  for (const scenario of draft.filters.scenario ?? []) {
    if (!rows.some((row) => row.scenario === scenario))
      throw new Error(`No data remains for ${scenario}. Change the scenario selection.`);
  }
  const units = new Set(rows.map((row) => row.unit));
  if (units.size > 1)
    throw new Error(
      "These results use different units. Narrow the selection before comparing them.",
    );
  const available = [
    ...new Set(
      rows.flatMap((row) =>
        Object.entries(row.years)
          .filter(([, value]) => value !== null)
          .map(([year]) => year),
      ),
    ),
  ].sort();
  const years = draft.years.length
    ? available.filter((year) => draft.years.includes(year))
    : available;
  if (!years.length)
    throw new Error(
      "There are no published observations for the requested years. Change the years or select all available years.",
    );
  if (
    draft.years.length &&
    (draft.years.length < 3 ||
      draft.years.some(
        (year, index) => index > 0 && Number(year) !== Number(draft.years[index - 1]) + 1,
      )) &&
    draft.years.some((year) => !available.includes(year))
  )
    throw new Error(
      "A requested year has no published observations. Choose available years; values are never interpolated.",
    );
  for (const scenario of draft.filters.scenario ?? []) {
    if (
      !rows.some(
        (row) =>
          row.scenario === scenario && years.some((year) => typeof row.years[year] === "number"),
      )
    )
      throw new Error(`No observations for ${scenario} in the requested years.`);
  }
  const workspace = workspaces.find((w) => w.code === draft.filters.workspace_code?.[0]);
  if (!workspace) throw new Error("Choose a published study first.");
  return {
    version: 1,
    validatedAt: new Date().toISOString(),
    filters: structuredClone(draft.filters),
    years,
    graphConfig: {
      title: `${draft.filters.variable?.join(", ")} · ${draft.filters.region?.join(", ")}`,
      dataSource: "api",
      selectedStudy: new URL(workspace.explorer_url).pathname.split("/")[2],
      selectedWorkspace: workspace.code,
      visualizationType: "line",
      groupByField: "scenario",
      stackField: "modelName",
      queryFilters: { ...draft.filters, years },
    },
    rows: rows.map((row) => ({
      ...row,
      years: Object.fromEntries(years.map((year) => [year, row.years[year] ?? null])),
    })),
  };
}
