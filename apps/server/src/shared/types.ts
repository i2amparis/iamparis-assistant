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
/** How a decision ended: what the code did with the answer, not just what the classifier said. */
export type Outcome =
  /** The choice was used. */
  | "accepted"
  /** The classifier chose, but policy refused it (the message does not name that value). */
  | "overruled"
  /** No option won clearly enough: the user is asked, best guess first. */
  | "unsure"
  /** "Not mentioned": policy may assume a default. */
  | "none"
  /** The classifier could not be asked or answered invalidly. */
  | "error";
export type Decision = {
  question: string;
  /** What was being decided ("task", "variable", "sector"…), for the inspector's step titles. */
  subject?: string;
  options: Option[];
  choice?: string;
  probabilities: Record<string, number>;
  ms: number;
  /**
   * Who decided: a classifier (hosted Jev, local-jev or Ollama), the user's click, an exact or
   * curated wording match, or a policy rule in code.
   */
  source: "jev" | "local-jev" | "ollama" | "user" | "match" | "policy";
  model?: string;
  confidence?: number;
  noneProbability?: number;
  error?: string;
  /** Model tokens this decision used (local Ollama only). */
  tokens?: { input: number; output: number };
  outcome?: Outcome;
  /** Why it ended that way, in words ("61% is below the 72% threshold", "phrase “German”"). */
  reason?: string;
  /** The text the question was asked about. */
  state?: string;
  /** Options that existed before ranking kept the closest for the classifier. */
  offered?: number;
  /** The acceptance gate applied to a classifier answer. */
  thresholds?: { confidence: number; margin: number };
};
/** The Results page's study facets (https://iamparis.eu/results). */
export const facetKeys = ["sector", "region", "tag", "project"] as const;
export type FacetKey = (typeof facetKeys)[number];
/** Chosen values per facet: OR within a facet, AND between facets. */
export type StudySelection = Partial<Record<FacetKey, string[]>>;
/** What the assistant knows about whom it is picking studies for. */
export type Brief = {
  selection: StudySelection;
  /** Everything the user said about themselves and their interest. */
  goal: string;
  /** Facets the user answered or waved off ("any region"), so they are not asked again. */
  settled: FacetKey[];
  /** How each value was understood ("“German”", "inferred from your role", "you chose"). */
  evidence: Partial<Record<FacetKey, string>>;
  /** Understood values already explained to the user. */
  explained?: FacetKey[];
  /** A list has been shown: later changes update it without further questions. */
  listed?: boolean;
};
export type StudyCard = {
  code: string;
  title: string;
  summary: string;
  /** Site path of the study's explainer, and the same page as an absolute URL. */
  path: string;
  url: string;
  projects: string[];
  status?: string;
  /** The study's first research question, when recorded. */
  question?: string;
  facets: { key: FacetKey; id: string; label: string; matched: boolean }[];
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
  kind: "route" | "navigation" | "answer" | "dimension" | "review" | "chart" | "model" | "studies";
  options: Option[];
  dimension?: Dimension;
  /** The study facet being asked for; absent on a list of studies awaiting a change. */
  facet?: FacetKey;
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
  kind:
    | "ask"
    | "answer"
    | "navigation"
    | "review"
    | "result"
    | "error"
    | "help"
    | "insight"
    | "studies";
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
  /** Studies picked for the user, and the facet selection that picked them. */
  studies?: StudyCard[];
  selection?: { key: FacetKey; label: string; values: { id: string; label: string }[] }[];
  /** The conversation state this turn left behind, for the inspector. */
  state?: { draft?: Draft; brief?: Brief; pending?: Pick<Pending, "kind" | "dimension" | "facet"> };
  /** How long the whole turn took on the server. */
  ms?: number;
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
  /** The study search in progress: who it is for and which facets are chosen. */
  brief?: Brief;
  pending?: Pending;
  /** The model last described, so "who developed it?" can be answered. */
  subject?: { kind: "model"; id: string };
};
export type TurnInput = ({ text: string } | { token: string; option: string }) & {
  context?: PageContext;
};
