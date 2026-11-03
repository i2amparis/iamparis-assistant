type GraphConfig = {
  title: string;
  dataSource: "api";
  selectedStudy: string;
  selectedWorkspace: string;
  visualizationType: "line";
  groupByField: "scenario";
  stackField: "modelName";
  queryFilters: Record<string, string[]>;
};

/** Parse a downloaded configuration before passing it to the platform's analysisHandoff store. */
export function parseAnalysisConfiguration(json: string): GraphConfig {
  if (json.length > 100000) throw new Error("The configuration is too large.");
  const value = JSON.parse(json);
  if (
    !value ||
    typeof value !== "object" ||
    value.dataSource !== "api" ||
    typeof value.title !== "string" ||
    value.title.length > 2000
  )
    throw new Error("Invalid analysis configuration.");
  if (
    typeof value.selectedStudy !== "string" ||
    !/^[a-z0-9-]+$/.test(value.selectedStudy) ||
    typeof value.selectedWorkspace !== "string" ||
    !/^[a-z0-9-]+$/.test(value.selectedWorkspace)
  )
    throw new Error("Invalid study selection.");
  const queryFilters: Record<string, string[]> = {};
  for (const key of ["workspace_code", "variable", "region", "modelName", "scenario", "years"]) {
    const values = value.queryFilters?.[key];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 250 ||
      values.some((v) => typeof v !== "string" || v.length > 2000 || !v.trim())
    )
      throw new Error(`Invalid ${key} filter.`);
    if (key === "years" && values.some((y) => !/^\d{4}$/.test(y)))
      throw new Error("Invalid years.");
    queryFilters[key] = [...new Set(values)] as string[];
  }
  if (
    queryFilters.workspace_code.length !== 1 ||
    queryFilters.workspace_code[0] !== value.selectedWorkspace
  )
    throw new Error("Study and workspace filters do not match.");
  return {
    title: value.title,
    dataSource: "api",
    selectedStudy: value.selectedStudy,
    selectedWorkspace: value.selectedWorkspace,
    visualizationType: "line",
    groupByField: "scenario",
    stackField: "modelName",
    queryFilters,
  };
}
