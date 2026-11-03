import { describe, expect, it } from "vitest";
import { handleTurn } from "./turn.ts";
import { canonicalUnit, curatedPick, namesStudy } from "../tools/curation.ts";
import type { Choose } from "../jev/client.ts";
import type { Conversation, Filters, ResultRow } from "../shared/types.ts";
import type { Results } from "../tools/results.ts";

/** A small "Where is the world headed?" study, with its scenario variants and duplicate regions. */
const catalog = {
  variable: [
    "Emissions|CO2",
    "Emissions|CO2|Energy|Demand|Transportation",
    "Emission Factor|CO2|Tailpipe|Diesel Car",
  ],
  region: ["World", "IND", "India"],
  modelName: ["gcam", "e3me"],
  scenario: ["Baseline", "PR_Baseline", "PR_CurPol_CP", "PR_CurPol_EI", "PR_NDC_CP", "CP_EI"],
};
type Field = keyof typeof catalog;
/** Tailpipe factors exist only in the transport study; "India" (the name) has no data. */
function has(row: Record<Field | "workspace_code", string>) {
  const transport = row.workspace_code === "transp-transf";
  return (
    transport === row.variable.startsWith("Emission Factor") &&
    row.region !== "India" &&
    !(row.modelName === "e3me" && row.scenario !== "PR_CurPol_CP")
  );
}
function combinations(filters: Filters) {
  let rows: Record<string, string>[] = [
    { workspace_code: filters.workspace_code?.[0] ?? "world-headed" },
  ];
  for (const field of Object.keys(catalog) as Field[])
    rows = rows.flatMap((r) =>
      (filters[field] ?? catalog[field]).map((value) => ({ ...r, [field]: value })),
    );
  return rows.filter((r) => has(r as Record<Field | "workspace_code", string>));
}
const api: Results = {
  async distinct(dimension, filters) {
    if (dimension === "workspace_code") return ["world-headed", "transp-transf"];
    return [...new Set(combinations(filters).map((r) => r[dimension]))].sort();
  },
  async rows(filters) {
    return combinations(filters).map((r): ResultRow => ({
      workspace_code: r.workspace_code,
      variable: r.variable,
      region: r.region,
      modelName: r.modelName,
      scenario: r.scenario,
      unit: "Mt CO2/yr",
      years: { "2030": 10, "2050": 5 },
    }));
  },
};
/** A classifier that confidently answers the given questions and says "not mentioned" otherwise. */
function jev(answers: Record<string, string>, calls: string[][] = []): Choose {
  return async (questions) => {
    calls.push(Object.keys(questions));
    return Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        {
          question: q.question,
          options: q.options,
          choice: answers[key],
          probabilities: answers[key] ? { [answers[key]]: 0.95 } : {},
          noneProbability: answers[key] ? 0.05 : 0.9,
          ms: 1,
          source: "jev",
        },
      ]),
    );
  };
}
const conversation = (): Conversation => ({ id: "test", title: "Test", messages: [] });

describe("curated policy", () => {
  it("shows the study's main scenarios, by name, when none is named", async () => {
    const c = conversation();
    const reply = await handleTurn(
      c,
      { text: "CO2 emissions in the world" },
      api,
      jev({ route: "analysis", variable: "Emissions|CO2", region: "World" }),
    );
    expect(reply.kind).toBe("result");
    expect(c.draft!.filters.scenario).toEqual(["PR_CurPol_CP", "PR_NDC_CP"]);
    expect(reply.text).toContain("Current policies (PR_CurPol_CP), NDC pledges (PR_NDC_CP)");
    expect(reply.text).toContain("the study's main scenarios");
  });
  it("names only the assumed models that report the shown scenarios", async () => {
    const c = conversation();
    await handleTurn(
      c,
      { text: "CO2 emissions in the world" },
      api,
      jev({ route: "analysis", variable: "Emissions|CO2", region: "World" }),
    );
    // e3me reports current policies only; it still has rows, so it stays.
    expect(c.draft!.filters.modelName).toEqual(["e3me", "gcam"]);
    await handleTurn(c, { text: "only NDC" }, api, jev({ request: "refine" }));
    expect(c.draft!.filters.scenario).toEqual(["PR_NDC_CP"]);
    expect(c.draft!.filters.modelName).toEqual(["gcam"]);
  });
  it("picks a scenario from a curated phrase without asking the classifier", async () => {
    const calls: string[][] = [];
    const c = conversation();
    await handleTurn(
      c,
      { text: "CO2 emissions in the world under current policies" },
      api,
      jev({ route: "analysis", variable: "Emissions|CO2", region: "World" }, calls),
    );
    // CP_EI is also "current policies"; the study's headline scenario breaks the tie.
    expect(c.draft!.filters.scenario).toEqual(["PR_CurPol_CP"]);
    expect(calls.flat()).not.toContain("scenario");
  });
  it("keeps the detail a curated variable phrase names", async () => {
    const c = conversation();
    await handleTurn(
      c,
      { text: "CO2 emissions from transport in India" },
      api,
      jev({ route: "analysis", region: "India" }),
    );
    expect(c.draft!.filters.variable).toEqual(["Emissions|CO2|Energy|Demand|Transportation"]);
    // "India" has no data here, but the same region under its code does.
    expect(c.draft!.filters.region).toEqual(["IND"]);
  });
  it("uses a specialised study only when the request names it", async () => {
    const c = conversation();
    await handleTurn(
      c,
      { text: "CO2 emissions from transport" },
      api,
      jev({ route: "analysis", study: "transp-transf" }),
    );
    expect(c.draft!.filters.workspace_code).toEqual(["world-headed"]);
    const named = conversation();
    await handleTurn(
      named,
      { text: "diesel car emission factors in the transport transformation" },
      api,
      jev({ route: "analysis", study: "transp-transf" }),
    );
    expect(named.draft!.filters.workspace_code).toEqual(["transp-transf"]);
  });
  it("ignores a model the follow-up never names", async () => {
    const c = conversation();
    await handleTurn(
      c,
      { text: "CO2 emissions in the world" },
      api,
      jev({ route: "analysis", variable: "Emissions|CO2", region: "World" }),
    );
    const reply = await handleTurn(
      c,
      { text: "only current policies" },
      api,
      jev({ request: "refine", modelName: "e3me" }),
    );
    expect(reply.kind).toBe("result");
    expect(c.draft!.filters.scenario).toEqual(["PR_CurPol_CP"]);
    expect(c.draft!.filters.modelName).toEqual(["e3me", "gcam"]);
  });
  it("says when a named scenario has no data and shows the main ones instead", async () => {
    const c = conversation();
    const reply = await handleTurn(
      c,
      { text: "CO2 emissions in the world under the PR_CurPol_EI scenario" },
      api,
      jev({ route: "analysis", variable: "Emissions|CO2", region: "World", modelName: "e3me" }),
    );
    // e3me was not named, so it is not taken; PR_CurPol_EI exists only for gcam.
    expect(c.draft!.filters.scenario).toEqual(["PR_CurPol_EI"]);
    expect(reply.kind).toBe("result");
  });
});

describe("curation data", () => {
  it("reads unit spellings as one unit", () => {
    expect(canonicalUnit("EJ/y")).toBe("EJ/yr");
    expect(canonicalUnit("EJ/yr")).toBe("EJ/yr");
  });
  it("prefers the longest curated phrase", () => {
    const options = ["Emissions|CO2", "Emissions|CO2|Energy|Demand|Transportation"].map((id) => ({
      id,
      label: id,
    }));
    expect(curatedPick("variable", options, "transport emissions of CO2")?.id).toBe(
      "Emissions|CO2|Energy|Demand|Transportation",
    );
    expect(curatedPick("variable", options, "CO2 emissions")).toBeUndefined();
  });
  it("treats the general studies as always named", () => {
    expect(namesStudy("world-headed", "anything")).toBe(true);
    expect(namesStudy("post-glasgow", "carbon price after Glasgow")).toBe(true);
    expect(namesStudy("post-glasgow", "carbon price")).toBe(false);
  });
});
