export const dimensions = [
  "workspace_code",
  "variable",
  "region",
  "modelName",
  "scenario",
] as const;
export type Dimension = (typeof dimensions)[number];
export type Filters = Partial<Record<Dimension, string[]>>;
export type Option = { id: string; label: string; detail?: string };
export type Decision = {
  question: string;
  options: Option[];
  choice?: string;
  probabilities: Record<string, number>;
  ms: number;
  source: "jev" | "local-jev" | "ollama" | "user" | "match";
  model?: string;
  confidence?: number;
  noneProbability?: number;
  error?: string;
  /** Model tokens this decision used (local Ollama only). */
  tokens?: { input: number; output: number };
};
export type Draft = {
  filters: Filters;
  years: string[];
  goal: string;
  /** Dimensions filled by a default because the user named none (all models, World, …). */
  assumed?: Dimension[];
  /** Assumptions already explained to the user. */
  explained?: Dimension[];
  /** A one-off explanation for the next result, such as a study switch. */
  notice?: string;
};
export type Pending = {
  token: string;
  kind: "route" | "navigation" | "answer" | "dimension" | "review" | "chart" | "model";
  options: Option[];
  dimension?: Dimension;
  compare?: boolean;
  request?: string;
};
/** A model as documented in the IAMPARIS model registry (the CMS). */
export type ModelProfile = {
  id: string;
  name: string;
  longName?: string;
  institute?: string;
  type?: string;
  description?: string;
};
export type ResultRow = {
  modelName: string;
  scenario: string;
  region: string;
  variable: string;
  unit: string;
  years: Record<string, number | null>;
  workspace_code?: string;
};
export type Plan = {
  version: 1;
  validatedAt: string;
  filters: Filters;
  years: string[];
  graphConfig: {
    title: string;
    dataSource: "api";
    selectedStudy: string;
    selectedWorkspace: string;
    visualizationType: "line";
    groupByField: "scenario";
    stackField: "modelName";
    queryFilters: Record<string, string[]>;
  };
  rows: ResultRow[];
};
/** Filters on the host page's GraphMaker; `years` there is an inclusive [start, end] range. */
export const chartFields = ["variable", "region", "modelName", "scenario", "unit"] as const;
export type ChartContext = {
  study?: string;
  workspace?: string;
  filters: Partial<Record<(typeof chartFields)[number], string[]>>;
  years?: [number, number];
  visualizationType?: string;
  groupByField?: string;
  title?: string;
};
/** What the user is looking at in the IAMPARIS web app, sent with each turn. */
export type PageContext = { path: string; title?: string; chart?: ChartContext };
export type ChartPatch = {
  title?: string;
  selectedStudy?: string;
  selectedWorkspace?: string;
  queryFilters?: Record<string, (string | number)[]>;
  visualizationType?: string;
  groupByField?: string;
  stackField?: string;
};
/**
 * A closed set of things the host page may do for the user. The page executes them through its
 * own handlers; nothing here carries code or arbitrary URLs. Every action waits for the user's click.
 */
export type ClientAction =
  | { type: "navigate"; label: string; path: string }
  | { type: "chart.apply"; label: string; patch: ChartPatch };
export type Reply = {
  kind: "ask" | "answer" | "navigation" | "review" | "result" | "error" | "help" | "insight";
  text: string;
  title?: string;
  source?: string;
  url?: string;
  options?: Option[];
  /** How many leading options to show as suggestions; the rest stay behind search. */
  featured?: number;
  token?: string;
  filters?: Filters;
  years?: string[];
  plan?: Plan;
  facts?: string[];
  actions?: ClientAction[];
  trace: Decision[];
};
export type Message = { id: string; role: "user" | "assistant"; text: string; reply?: Reply };
export type Conversation = {
  id: string;
  /** Opaque per-browser id shared with the web app; only that session can read the chat. */
  session?: string;
  title: string;
  messages: Message[];
  draft?: Draft;
  pending?: Pending;
  /** The model last described, so "who developed it?" can be answered. */
  subject?: { kind: "model"; id: string };
};
export type TurnInput = ({ text: string } | { token: string; option: string }) & {
  context?: PageContext;
};
