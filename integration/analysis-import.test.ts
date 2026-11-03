import { expect, it } from "vitest";
import { parseAnalysisConfiguration } from "./analysis-import.ts";
const config = {
  title: "Emissions",
  dataSource: "api",
  selectedStudy: "paris-reinforce",
  selectedWorkspace: "eu-headed",
  queryFilters: {
    workspace_code: ["eu-headed"],
    variable: ["Emissions|CO2"],
    region: ["EU"],
    modelName: ["GCAM"],
    scenario: ["Baseline"],
    years: ["2050"],
  },
};
it("imports known fields only and refuses mismatched or unsafe shapes", () => {
  expect(
    parseAnalysisConfiguration(JSON.stringify({ ...config, rawData: "ignored" })),
  ).not.toHaveProperty("rawData");
  expect(() =>
    parseAnalysisConfiguration(JSON.stringify({ ...config, selectedWorkspace: "other" })),
  ).toThrow("match");
  expect(() => parseAnalysisConfiguration(JSON.stringify({ ...config, queryFilters: {} }))).toThrow(
    "filter",
  );
});
