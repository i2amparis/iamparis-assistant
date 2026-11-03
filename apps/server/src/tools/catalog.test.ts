import { expect, it } from "vitest";
import { matchOption, rankOptions } from "./catalog.ts";
it("keeps aggregate CO2 available ahead of unrelated sector detail", () => {
  const options = [
    "Emissions|CO2|Energy|Demand|Industry|Cement",
    "Emissions|CO2",
    "Capacity|Electricity|Solar",
  ].map((label) => ({ id: label, label }));
  expect(rankOptions(options, "Help me compare CO2 emissions in Europe in 2050")[0].id).toBe(
    "Emissions|CO2",
  );
});
it("matches short codes only as written, by alias or by name", () => {
  const regions = [
    { id: "CAN", label: "CAN", detail: "Canada" },
    { id: "EU", label: "EU" },
    { id: "ITA", label: "ITA", detail: "Italy" },
  ];
  expect(matchOption(regions, "where can I compare models")).toBeUndefined();
  expect(matchOption(regions, "solar in Canada")?.id).toBe("CAN");
  expect(matchOption(regions, "emissions in CAN")?.id).toBe("CAN");
  expect(matchOption(regions, "emissions in Europe")?.id).toBe("EU");
  expect(matchOption(regions, "co2 in the eu")?.id).toBe("EU");
});
