import {
  type ChartContext,
  type ChartPatch,
  type Draft,
  type Filters,
  type Plan,
  type ResultRow,
} from "../shared/types.ts";
import { workspaces } from "../tools/catalog.ts";

const seriesDimensions = ["variable", "region", "modelName", "scenario"] as const;
const maxListedSeries = 8;

/** A chart can be read only when it points at a catalogued study and has at least one filter. */
export function usableChart(chart?: ChartContext): chart is ChartContext {
  return Boolean(
    chart?.workspace &&
    workspaces.some((w) => w.code === chart.workspace) &&
    seriesDimensions.some((d) => chart.filters[d]?.length),
  );
}

/** Results-service filters equivalent to the chart's own query. */
export function chartFilters(chart: ChartContext): Filters {
  const filters: Filters = { workspace_code: [chart.workspace!] };
  for (const d of seriesDimensions) if (chart.filters[d]?.length) filters[d] = chart.filters[d];
  return filters;
}

/** Start an analysis draft from what is already on the user's chart. */
export function draftFromChart(chart: ChartContext, goal: string): Draft {
  const [start, end] = chart.years ?? [];
  const years =
    start !== undefined && end !== undefined && end >= start && end - start <= 200
      ? Array.from({ length: end - start + 1 }, (_, i) => String(start + i))
      : [];
  return { filters: chartFilters(chart), years, goal };
}

/** The GraphMaker change that shows a validated plan. Study/workspace come from the catalogue. */
export function planPatch(plan: Plan): ChartPatch {
  const { workspace_code: _, ...filters } = plan.filters;
  return {
    title: plan.graphConfig.title,
    selectedStudy: plan.graphConfig.selectedStudy,
    selectedWorkspace: plan.graphConfig.selectedWorkspace,
    queryFilters: {
      ...filters,
      years: [Number(plan.years[0]), Number(plan.years.at(-1))],
    },
    visualizationType: plan.years.length === 1 ? "bar" : "line",
    groupByField: "scenario",
    stackField: "modelName",
  };
}

function format(value: number) {
  const size = Math.abs(value);
  return value.toLocaleString("en", {
    maximumFractionDigits: size >= 100 ? 0 : size >= 1 ? 2 : 3,
  });
}

/**
 * State facts about the observations behind the user's chart: span, change per series, peaks and
 * the spread in the final year. Every number comes from the returned rows; nothing is generated.
 */
export function describeChart(chart: ChartContext, input: ResultRow[]) {
  const [from, to] = chart.years ?? [-Infinity, Infinity];
  const units = chart.filters.unit;
  const series = input
    .filter(
      (row) =>
        (!units?.length || units.includes(row.unit)) &&
        seriesDimensions.every(
          (d) => !chart.filters[d]?.length || chart.filters[d]!.includes(row[d]),
        ),
    )
    .map((row) => ({
      row,
      points: Object.entries(row.years)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number(entry[0]) >= from && Number(entry[0]) <= to,
        )
        .map(([year, value]) => ({ year: Number(year), value }))
        .sort((a, b) => a.year - b.year),
    }))
    .filter((s) => s.points.length);
  if (!series.length)
    throw new Error(
      "No published observations match the chart's current filters and years. Change a filter and ask again.",
    );
  const varying = seriesDimensions.filter((d) => new Set(series.map((s) => s.row[d])).size > 1);
  const label = (row: ResultRow) =>
    varying.length ? varying.map((d) => row[d]).join(" · ") : row.scenario;
  const unitList = [...new Set(series.map((s) => s.row.unit))];
  const years = series.flatMap((s) => s.points.map((p) => p.year));
  const first = Math.min(...years);
  const last = Math.max(...years);
  const facts = [
    `${series.length} series in ${unitList.join(", ")}, ${first === last ? `in ${first}` : `covering ${first}–${last}`}.`,
  ];
  const ranked = [...series].sort((a, b) => b.points.at(-1)!.value - a.points.at(-1)!.value);
  for (const { row, points } of ranked.slice(0, maxListedSeries)) {
    const start = points[0];
    const end = points.at(-1)!;
    const peak = points.reduce((max, p) => (p.value > max.value ? p : max));
    const change =
      start.value !== 0 && points.length > 1
        ? ` (${end.value >= start.value ? "+" : ""}${Math.round(((end.value - start.value) / Math.abs(start.value)) * 100)}%)`
        : "";
    const peaked =
      peak.year !== start.year && peak.year !== end.year
        ? `, peaking at ${format(peak.value)} in ${peak.year}`
        : "";
    facts.push(
      points.length > 1
        ? `${label(row)}: ${format(start.value)} in ${start.year} → ${format(end.value)} in ${end.year}${change}${peaked}.`
        : `${label(row)}: ${format(start.value)} in ${start.year}.`,
    );
  }
  if (series.length > maxListedSeries)
    facts.push(`${series.length - maxListedSeries} more series are not listed.`);
  const atLast = series
    .map((s) => ({ row: s.row, value: s.points.find((p) => p.year === last)?.value }))
    .filter((s): s is { row: ResultRow; value: number } => s.value !== undefined);
  if (unitList.length === 1 && atLast.length > 1) {
    const high = atLast.reduce((a, b) => (b.value > a.value ? b : a));
    const low = atLast.reduce((a, b) => (b.value < a.value ? b : a));
    facts.push(
      `In ${last}, ${label(high.row)} is highest (${format(high.value)}) and ${label(low.row)} lowest (${format(low.value)}), a gap of ${format(high.value - low.value)} ${unitList[0]}.`,
    );
  }
  return {
    text: `Here is what ${chart.title ? `“${chart.title}”` : "your chart"} shows. Figures are the published observations for its filters; nothing is interpolated.`,
    facts,
  };
}
