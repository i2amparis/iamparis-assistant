import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { choose, type Choose, type Question } from "../jev/client.ts";
import {
  dimensions,
  type Conversation,
  type Decision,
  type Dimension,
  type FacetKey,
  type Filters,
  type ModelProfile,
  type Option,
  type Pending,
  type Reply,
  type TurnInput,
} from "../shared/types.ts";
import {
  answerOptions,
  linkOptions,
  links,
  matchOption,
  knownRegions,
  mentionsOption,
  namedPage,
  mentions,
  rankOptions,
  regionName,
  variableDescription,
  terms,
  workspaceOptions,
  workspaces,
} from "../tools/catalog.ts";
import { curatedPick, headlineScenarios, namesStudy, scenarioLabel } from "../tools/curation.ts";
import type { Results } from "../tools/results.ts";
import { facetNames } from "../tools/studies.ts";
import { buildPlan, requestedYears } from "./analysis.ts";
import { chartFilters, describeChart, draftFromChart, planPatch, usableChart } from "./chart.ts";
import { studyFlow } from "./studies.ts";

const routes: Option[] = [
  {
    id: "analysis",
    label: "Build an analysis",
    detail:
      "Show numbers: the values of a variable (emissions, energy, capacity…) for a region over years, across models and scenarios",
  },
  {
    id: "navigation",
    label: "Find a page",
    detail:
      "Where to find something on the site: a page about models or model comparison, studies, applications, data stories or documentation",
  },
  {
    id: "answer",
    label: "Explain a concept",
    detail: "Choose a curated definition about integrated assessment, climate, energy or scenarios",
  },
  {
    id: "model",
    label: "Describe a model",
    detail:
      "About one specific model (such as GCAM, TIMES or MUSE): what it is, who developed it, what type of model it is",
  },
  {
    id: "studies",
    label: "Find studies for me",
    detail:
      "Recommend which IAMPARIS studies are relevant to the user, from their role, employer, sector, country or topic of interest",
  },
];
/**
 * Someone describing themselves ("I work at the transport ministry", "as a policy advisor") or
 * asking which studies matter: a study search, decided before pages and data words are looked at.
 */
const describesUser =
  /\b(i\s*(am|'m|’m)\s+(an?|the|in|at|with|from|working|responsible|based)\b|i\s+(work|advise|represent|lead|manage)\b|my\s+(role|job|background|work|team|ministry|department|agency|country|region|sector|organi[sz]ation|company|city)\b|we\s+(work|regulate|advise)\b|as\s+an?\s+[\w\s-]{0,30}(maker|advis[eo]r|analyst|regulator|planner|official|officer|servant|minister|journalist|student|researcher|consultant|investor|mayor)\b)/i;
const asksForStudies =
  /\b(which|what|any|relevant|recommend|suggest|curate|pick|find|show)\b[^.?!]*\bstud(y|ies)\b[^.?!]*\b(for|about|on|covering|relevant|matter|should|cover|deal)\b|\b(relevant|useful|matter)s?\s+(for|to)\s+(me|us|my)\b|\bwhat should i (read|look at)\b/i;
/** What each classifier question decides, as the inspector names it. */
const subjects: Record<string, string> = {
  route: "task",
  study: "study",
  variable: "variable",
  region: "region",
  modelName: "model",
  scenario: "scenario",
  request: "request type",
  action: "chart action",
  model: "model",
  target: "page or definition",
  answer: "answer",
};
const asksAboutModel =
  /\b(tell me about|what is|what's|describe|explain|information on|assumptions?|who (developed|develops|built|made|created|runs))\b/i;
/**
 * A model named in the text: the full registry name, else its family ("REMIND" for REMIND-MFA),
 * preferring the model called exactly that, then the shortest name.
 */
function modelByName(models: ModelProfile[], text: string): ModelProfile | undefined {
  const exact = matchOption(
    models.map((m) => ({ id: m.id, label: m.name })),
    text,
  );
  if (exact) return models.find((m) => m.id === exact.id);
  const family = (m: ModelProfile) => m.name.split(/[\s-]/)[0];
  const named = models.filter(
    (m) =>
      family(m).length >= 3 &&
      new RegExp(`\\b${family(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
  );
  return named.sort(
    (a, b) =>
      Number(b.name === family(b)) - Number(a.name === family(a)) || a.name.length - b.name.length,
  )[0];
}
/** Which part of a model profile a follow-up asks for. */
function modelFacet(text: string) {
  if (/\bwho\b|develop|institut|organi[sz]ation|team|built|made/i.test(text)) return "developer";
  if (/\btype\b|kind of|what sort/i.test(text)) return "type";
  return undefined;
}
/** Offered only while the user has a readable chart open in the web app. */
const chartRoute: Option = {
  id: "chart",
  label: "Work with my current chart",
  detail:
    "Describe, analyse or summarise the chart the user is looking at, or change its filters or chart type",
};
const chartOptions: Option[] = [
  {
    id: "describe",
    label: "Describe what my chart shows",
    detail: "Summarise trends, peaks, differences and values in the current chart",
  },
  {
    id: "modify",
    label: "Change my chart's filters",
    detail: "Use a different variable, region, model, scenario or years in the current chart",
  },
  {
    id: "type",
    label: "Switch between line and bar chart",
    detail: "Change the chart type or visualisation",
  },
];
export const dimensionLabels: Record<Dimension, string> = {
  workspace_code: "study",
  variable: "variable",
  region: "region",
  modelName: "model",
  scenario: "scenario",
};
/** What an open question was about, for the inspector's step title. */
const subjectOfPending = (pending: Pending) =>
  pending.facet
    ? facetNames[pending.facet]
    : pending.dimension
      ? dimensionLabels[pending.dimension]
      : pending.kind === "route"
        ? "task"
        : pending.kind === "review" || pending.kind === "studies"
          ? "change"
          : pending.kind;
type SeriesDimension = Exclude<Dimension, "workspace_code">;
const seriesDimensions: SeriesDimension[] = ["variable", "region", "modelName", "scenario"];
const dimensionQuestions: Record<Dimension, string> = {
  workspace_code:
    "Which IAMPARIS study fits the user's data request? Choose none if no study is implied.",
  variable:
    "Which variable does the user ask about? Energy produced or supplied (generation, how much power comes from a source) is Secondary Energy; installed capacity is Capacity; new installations are Capacity Additions. CO2 is not all greenhouse gases. Prefer the aggregate unless a sector or source is named. Choose none if unclear.",
  region: "Which region does the user ask about? Choose none if no region is mentioned.",
  modelName: "Which model does the user name? Choose none if no model is named.",
  scenario: "Which scenario does the user name? Choose none if no scenario is named.",
};
const requestKinds: Option[] = [
  {
    id: "refine",
    label: "Change the current data query",
    detail: "a different variable, region, model, scenario or years, or adding to the comparison",
  },
  {
    id: "new",
    label: "A new unrelated request",
    detail: "find a page, explain a concept, or ask about different data",
  },
];
/** Policy: what to assume when the user names no value, instead of asking. */
const defaultStudy = (text: string) => (mentions(text, "eu") ? "eu-headed" : "world-headed");
const defaultRegions = ["World", "EU", "EU27", "Europe"];
const maxAssumedValues = 8;
const maxSeries = 24;
const featured = 4;
const refineOptions: Option[] = [
  { id: "edit:variable", label: "Change variable" },
  { id: "edit:region", label: "Change region" },
  { id: "compare", label: "Add a scenario" },
  { id: "edit:modelName", label: "Change model" },
  { id: "edit:scenario", label: "Change scenario" },
  { id: "edit:workspace_code", label: "Change study" },
  { id: "years", label: "Use all available years" },
];

/** Internal path for a catalogued IAMPARIS URL, so the web app can navigate without reloading. */
function sitePath(url: string) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Keyword routing for when no classifier is available or it is unsure. */
const dataWords =
  /\b(compare|show|plot|chart|graph|trend|data|projection|pathway|scenario|(19|20|21)\d\d|emission|co2|carbon|ghg|greenhouse|methane|energy|electricity|power|generation|capacity|solar|wind|nuclear|coal|oil|gas|hydrogen|biomass|gdp|gross domestic|population|price|investment|demand|consumption|production|supply|transport|buildings?|industry|land|forest|agricultur|temperature)/;

function guessRoute(text: string, chart: boolean) {
  const t = text.toLowerCase();
  if (
    chart &&
    /\b(this|my|current)\s+(chart|graph|plot|figure)|\bwhat i('m| am)? (see|looking)/.test(t)
  )
    return "chart";
  const asksMeaning =
    /^\s*(what(?:'s| is| are| does)|define|explain|meaning of|tell me about)\b/.test(t);
  const asksPlace = /\b(where|find|page|go to|take me|navigate|catalog(ue)?|link)\b/.test(t);
  if (asksMeaning && matchOption(answerOptions, text)) return "answer";
  if (asksPlace && matchOption(linkOptions, text)) return "navigation";
  if (describesUser.test(text) || asksForStudies.test(text)) return "studies";
  // Data words, or a named region ("electricity for India"), mean a data request.
  if (
    dataWords.test(t) ||
    /\b(world|global|europe|eu)\b/.test(t) ||
    matchOption(knownRegions, text)
  )
    return "analysis";
  if (asksMeaning) return "answer";
  if (asksPlace) return "navigation";
  return undefined;
}

const aboutOpenChart =
  /\b(this|my|the current|current)\s+(chart|graph|plot|figure|visuali[sz]ation)\b|\b(as|to|into) an? (bar|line) (chart|graph)\b|\bwhat i('m| am)? (see|looking at)\b/i;

function guessChartAction(text: string) {
  const t = text.toLowerCase();
  if (/\b(bar|line)\b|chart type/.test(t)) return "type";
  if (/describ|summar|analy[sz]|explain|trend|what .*show|tell me about/.test(t)) return "describe";
  return undefined;
}

function list(values: string[] = [], noun: string) {
  return values.length > 3 ? `${values.length} ${noun}s` : values.join(", ");
}
/** Scenarios by their readable name where curated: "Current policies (PR_CurPol_CP)". */
function scenarios(values: string[] = []) {
  return list(
    values.map((s) => (scenarioLabel(s) ? `${scenarioLabel(s)} (${s})` : s)),
    "scenario",
  );
}
const dimensionOf = (key: string) =>
  (dimensions as readonly string[]).includes(key) ? (key as Dimension) : undefined;

/**
 * Drop detail the user did not ask for: "carbon emissions" means Emissions|CO2, not
 * Emissions|CO2|Energy. A level is kept when its words appear in the text ("only solar" keeps
 * …|Solar) or when its parent has no data in the study.
 */
function plainest(variable: string, available: string[], text: string) {
  let current = variable;
  for (;;) {
    const parts = current.split("|");
    const parent = parts.slice(0, -1).join("|");
    const last =
      parts
        .at(-1)!
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [];
    if (parts.length < 2 || !available.includes(parent) || last.some((w) => mentions(text, w)))
      return current;
    current = parent;
  }
}

/**
 * Execute one turn: one classifier request answers every open question, code
 * decides what happens, and the user is asked only for what can be neither inferred nor assumed.
 */
export async function handleTurn(
  conversation: Conversation,
  input: TurnInput,
  api: Results,
  classify: Choose = choose,
): Promise<Reply> {
  const trace: Decision[] = [];
  const started = performance.now();
  const draftBefore = structuredClone(conversation.draft);
  const briefBefore = structuredClone(conversation.brief);
  const pendingBefore = structuredClone(conversation.pending);
  const text = "text" in input ? input.text.trim() : "";
  const chart = usableChart(input.context?.chart) ? input.context.chart : undefined;
  const availableRoutes = chart ? [...routes, chartRoute] : routes;

  function ask(
    kind: Pending["kind"],
    question: string,
    options: Option[],
    extra: { dimension?: Dimension; facet?: FacetKey; compare?: boolean; featured?: number } = {},
  ): Reply {
    conversation.pending = {
      token: randomUUID(),
      kind,
      options,
      dimension: extra.dimension,
      facet: extra.facet,
      compare: extra.compare,
      request: text || conversation.pending?.request,
    };
    return {
      kind: kind === "review" ? "review" : "ask",
      text: question,
      options,
      featured: extra.featured ?? (options === refineOptions ? 3 : undefined),
      token: conversation.pending.token,
      filters: conversation.draft?.filters,
      years: conversation.draft?.years,
      trace,
    };
  }

  /** Record a decision made by a rule in code, so the inspector shows why the turn went as it did. */
  function note(subject: string, what: string, reason: string, choice?: string) {
    trace.push({
      subject,
      question: what,
      options: choice
        ? [{ id: choice, label: routes.find((r) => r.id === choice)?.label ?? choice }]
        : [],
      choice,
      probabilities: {},
      ms: 0,
      source: "policy",
      outcome: "accepted",
      reason,
    });
  }

  /** Ask every question in one classifier request; exact wording matches fill what it leaves open. */
  /** `wording` overrides, per question, the text that exact wording matches are looked for in. */
  async function decide<K extends string>(
    asked: Record<K, Question>,
    state: string,
    wording: Partial<Record<K, string>> = {},
  ) {
    const result = {} as Record<
      K,
      { choice?: string; guess?: string; unspecified: boolean; curated?: boolean }
    >;
    const subjectOf = (key: K) => asked[key].subject ?? subjects[key] ?? key;
    // Curated phrases decide first, so the same wording always gives the same query.
    const study = conversation.draft?.filters.workspace_code?.[0];
    for (const key of Object.keys(asked) as K[]) {
      const dimension = key === "study" ? "workspace_code" : dimensionOf(key);
      const pick =
        dimension && curatedPick(dimension, asked[key].options, wording[key] ?? state, study);
      if (!pick) continue;
      trace.push({
        subject: subjectOf(key),
        question: asked[key].question,
        options: [pick],
        choice: pick.id,
        probabilities: {},
        ms: 0,
        source: "match",
        outcome: "accepted",
        reason: "A curated phrase in data/curation.json names it, so the classifier was not asked.",
        state: wording[key] ?? state,
      });
      result[key] = { choice: pick.id, unspecified: false, curated: true };
    }
    const keys = (Object.keys(asked) as K[]).filter((key) => !result[key]);
    const ranked = Object.fromEntries(
      keys.map((key) => [
        key,
        {
          question: asked[key].question,
          subject: subjectOf(key),
          options: rankOptions(asked[key].options, state).slice(0, config.maxCandidates),
        },
      ]),
    ) as Record<K, Question>;
    const decisions: Record<string, Decision> = keys.length ? await classify(ranked, state) : {};
    // A specialised study is used only when the request names it ("transport" is not a request
    // for the Transportation Transformation study's tailpipe factors). A model or scenario must be
    // named too: a small classifier reads "only current policies" as a request for some model.
    const usable = (key: K, id: string) => {
      if (key === "study") return namesStudy(id, wording[key] ?? state);
      if (key !== "modelName" && key !== "scenario") return true;
      const option = asked[key].options.find((o) => o.id === id);
      return Boolean(option && mentionsOption(option, wording[key] ?? state));
    };
    for (const key of keys) {
      const decision = decisions[key];
      if (decision) {
        decision.subject = subjectOf(key);
        decision.state = state;
        decision.offered = asked[key].options.length;
        trace.push(decision);
      }
      const offered = Boolean(
        decision?.choice && ranked[key].options.some((o) => o.id === decision.choice),
      );
      if (offered && usable(key, decision!.choice!)) {
        decision!.outcome = "accepted";
        result[key] = { choice: decision!.choice, unspecified: false };
        continue;
      }
      // What the code did with the answer: a confident pick can still be refused by policy.
      if (decision) {
        if (offered) {
          decision.outcome = "overruled";
          decision.reason =
            `${decision.reason ?? ""} Not used: ${key === "study" ? "a specialised study is used only when the message names it" : "the message does not name this value"}.`.trim();
        } else if (decision.choice) {
          decision.outcome = "error";
          decision.reason = "The classifier answered with an option that was not offered.";
        } else
          decision.outcome = decision.error
            ? "error"
            : (decision.noneProbability ?? 0) >= config.confidence
              ? "none"
              : "unsure";
      }
      const match = matchOption(asked[key].options, wording[key] ?? state);
      if (match && usable(key, match.id)) {
        trace.push({
          subject: subjectOf(key),
          question: asked[key].question,
          options: [match],
          choice: match.id,
          probabilities: {},
          ms: 0,
          source: "match",
          outcome: "accepted",
          reason: "Every word of its label or name appears in the message.",
          state: wording[key] ?? state,
        });
        result[key] = { choice: match.id, unspecified: false };
        continue;
      }
      // "Not mentioned" (or no classifier) lets policy assume a default; an unsure split asks,
      // leading with the classifier's best guess.
      const guess = Object.entries(decision?.probabilities ?? {})
        .filter(([id, p]) => p > 0 && ranked[key].options.some((o) => o.id === id))
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      result[key] = {
        guess,
        unspecified:
          !decision ||
          Boolean(decision.error) ||
          (decision.noneProbability ?? 0) >= config.confidence,
      };
    }
    return result;
  }

  const studies = studyFlow({ conversation, trace, decide, ask, note });

  function others(except: Dimension): Filters {
    const filters = { ...conversation.draft!.filters };
    delete filters[except];
    return filters;
  }

  /** Models also answer to their family name (GCAM for GCAM-PR 5.3), region codes to a name. */
  function values(options: string[], dimension?: Dimension) {
    return options.map((value) => {
      const detail =
        dimension === "modelName"
          ? value.split(/[\s-]/)[0]
          : dimension === "region"
            ? regionName(value)
            : dimension === "variable"
              ? variableDescription(value)
              : dimension === "scenario"
                ? scenarioLabel(value)
                : undefined;
      return detail && detail !== value
        ? { id: value, label: value, detail }
        : { id: value, label: value };
    });
  }

  function askFor(dimension: Dimension, options: Option[], why = "", guess?: string): Reply {
    const ranked = rankOptions(options, conversation.draft?.goal ?? text);
    const first = ranked.findIndex((o) => o.id === guess);
    if (first > 0) ranked.unshift(...ranked.splice(first, 1));
    return ask(
      "dimension",
      `${why}Which ${dimensionLabels[dimension]} do you mean?${ranked.length > featured ? " These are the closest matches; search for others." : ""}`,
      ranked,
      { dimension, featured },
    );
  }

  async function registry(): Promise<ModelProfile[]> {
    return (await api.models?.()) ?? [];
  }
  function modelOptions(models: ModelProfile[]): Option[] {
    return models.map((m) => ({
      id: m.id,
      label: m.name,
      detail: [m.longName, m.institute].filter(Boolean).join(" — ") || undefined,
    }));
  }
  /** A model profile from the registry, verbatim; a facet answers "who developed it?". */
  function profile(model: ModelProfile, facet?: "developer" | "type"): Reply {
    conversation.subject = { kind: "model", id: model.id };
    conversation.pending = undefined;
    conversation.draft = undefined;
    const name =
      model.longName && model.longName !== model.name
        ? `${model.name} (${model.longName})`
        : model.name;
    const text =
      facet === "developer"
        ? model.institute
          ? `${name} is developed by ${model.institute}.`
          : `The model registry does not list who develops ${name}.`
        : facet === "type"
          ? model.type
            ? `${name} is described as: ${model.type}.`
            : `The model registry does not list a model type for ${name}.`
          : (model.description ?? `The model registry has no description for ${name} yet.`);
    return {
      kind: "answer",
      title: name,
      text,
      facts: facet
        ? undefined
        : [
            model.institute && `Developed by ${model.institute}.`,
            model.type && `Model type: ${model.type}.`,
          ].filter((f): f is string => Boolean(f)),
      source: "IAMPARIS model registry",
      actions: [{ type: "navigate", label: "Open model page", path: `/models/${model.id}` }],
      trace,
    };
  }

  /** Drop selections the earlier ones no longer allow, so they are resolved again. */
  async function prune() {
    const draft = conversation.draft!;
    for (const d of seriesDimensions) {
      if (!draft.filters[d]?.length) continue;
      const before: Filters = {};
      for (const earlier of dimensions.slice(0, dimensions.indexOf(d)))
        if (draft.filters[earlier]?.length) before[earlier] = draft.filters[earlier];
      const available = new Set(await api.distinct(d, before));
      const kept = draft.filters[d]!.filter((v) => available.has(v));
      if (kept.length) draft.filters[d] = kept;
      else delete draft.filters[d];
    }
  }

  /** Fill the draft from the request, assume what was not named, and run as soon as it is complete. */
  async function resolve(): Promise<Reply> {
    const draft = conversation.draft!;
    if (!draft.filters.workspace_code?.length) {
      const { study } = await decide(
        { study: { question: dimensionQuestions.workspace_code, options: workspaceOptions } },
        draft.goal,
      );
      // Studies mean little to most users: without a confident pick, use a general one and say so.
      draft.filters.workspace_code = [study.choice ?? defaultStudy(draft.goal)];
      if (!study.choice) {
        draft.assumed = [...(draft.assumed ?? []), "workspace_code"];
        note(
          "study",
          "No study named: a general one is assumed.",
          "World study unless the message mentions the EU or Europe.",
          draft.filters.workspace_code[0],
        );
      }
    }
    const missing = seriesDimensions.filter((d) => !draft.filters[d]?.length);
    const available = Object.fromEntries(
      await Promise.all(
        missing.map(async (d) => [d, await api.distinct(d, draft.filters)] as const),
      ),
    ) as Record<SeriesDimension, string[]>;
    const open = missing.filter((d) => available[d].length > 1);
    for (const d of missing)
      if (available[d].length === 1) {
        draft.filters[d] = available[d];
        note(
          dimensionLabels[d],
          `Only one ${dimensionLabels[d]} has data here.`,
          "Taken without asking.",
          available[d][0],
        );
      }
    const picks = open.length
      ? await decide(
          Object.fromEntries(
            open.map((d) => [
              d,
              { question: dimensionQuestions[d], options: values(available[d], d) },
            ]),
          ) as Record<SeriesDimension, Question>,
          draft.goal,
        )
      : ({} as Partial<
          Record<
            SeriesDimension,
            { choice?: string; guess?: string; unspecified: boolean; curated?: boolean }
          >
        >);
    for (const d of open)
      if (picks[d]?.choice) {
        // A curated phrase names its variable exactly ("transport emissions"); keep its detail.
        const value =
          d === "variable" && !picks[d]!.curated
            ? plainest(picks[d]!.choice!, available.variable, draft.goal)
            : picks[d]!.choice!;
        if (value !== picks[d]!.choice)
          note(
            "variable",
            `${picks[d]!.choice} is more detailed than the message asks for.`,
            "Detail whose words the message does not use is dropped when the parent has data.",
            value,
          );
        draft.filters[d] = [value];
      }
    const beforePrune = structuredClone(draft.filters);
    await prune();
    for (const d of seriesDimensions) {
      const lost = (beforePrune[d] ?? []).filter((v) => !draft.filters[d]?.includes(v));
      if (lost.length)
        note(
          dimensionLabels[d],
          `${lost.join(", ")} has no data with the selections before it.`,
          "Dropped and resolved again: study, variable, region, model and scenario are checked in that order.",
        );
    }
    // A named model or scenario without data here is said once, then assumed like an unnamed one,
    // rather than asked about among values the user never mentioned.
    for (const d of ["modelName", "scenario"] as const) {
      const lost = picks[d]?.choice;
      if (!lost || draft.filters[d]?.length) continue;
      const name =
        d === "scenario" && scenarioLabel(lost) ? `${scenarioLabel(lost)} (${lost})` : lost;
      draft.notice = [
        draft.notice,
        `${name} has no ${draft.filters.variable} data for ${draft.filters.region ?? "this region"}.`,
      ]
        .filter(Boolean)
        .join(" ");
      picks[d] = { unspecified: true };
    }
    for (const d of seriesDimensions) {
      if (draft.filters[d]?.length) continue;
      const options = await api.distinct(d, others(d));
      if (!options.length)
        return ask(
          "review",
          `No ${dimensionLabels[d]} has data with these selections. Change one of them.`,
          refineOptions.filter((o) => o.id !== "compare"),
        );
      if (options.length === 1) {
        draft.filters[d] = options;
        note(
          dimensionLabels[d],
          `Only one ${dimensionLabels[d]} has data with these selections.`,
          "Taken without asking.",
          options[0],
        );
        continue;
      }
      // Among values with data, a curated phrase or exact wording may now be unambiguous:
      // "China" is CHN once the name-only "China" region, without this variable, is gone.
      const offered = values(options, d);
      const named =
        curatedPick(d, offered, draft.goal, draft.filters.workspace_code?.[0]) ??
        matchOption(offered, draft.goal);
      if (named) {
        draft.filters[d] = [named.id];
        note(
          dimensionLabels[d],
          `Among the ${options.length} ${dimensionLabels[d]}s with data, the message names one.`,
          "A curated phrase or exact wording that was ambiguous before the other selections narrowed the list.",
          named.id,
        );
        continue;
      }
      // A region named outright but without data here ("Africa", "Greece" for solar capacity)
      // moves to a study that has it, as a follow-up would; failing that it is said and assumed.
      const known = d === "region" ? matchOption(knownRegions, draft.goal) : undefined;
      const outside = known && !options.includes(known.id) ? known : undefined;
      if (outside) {
        const moved = await moveToStudyWith(outside.id, draft.years);
        if (moved) return moved;
      }
      const unspecified = Boolean(outside) || (picks[d]?.unspecified ?? true);
      if (d === "variable" || !unspecified) {
        note(
          "follow-up",
          `Asking for the ${dimensionLabels[d]}.`,
          d === "variable" && unspecified
            ? "A variable is never assumed."
            : "The classifier was undecided between options, so the user is asked, best guess first.",
        );
        return askFor(d, offered, "", picks[d]?.guess);
      }
      if (d === "region") {
        const fallback = defaultRegions.find((r) => options.includes(r));
        // A region was named but matches several ("Africa_Eastern", …): ask rather than guess.
        if (!fallback || offered.some((o) => mentionsOption(o, draft.goal)))
          return askFor(d, offered);
        if (outside)
          draft.notice = `No study has ${draft.filters.variable} data for ${outside.detail ?? outside.id}, so this shows ${fallback}.`;
        draft.filters.region = [fallback];
        note(
          "region",
          outside ? "The named region has no data in any study." : "No region named.",
          `Assumed the first of ${defaultRegions.join(", ")} with data.`,
          fallback,
        );
      } else if (
        d === "scenario" &&
        headlineScenarios(draft.filters.workspace_code?.[0], options).length
      ) {
        // The study's main scenario family, rather than every variant it publishes.
        draft.filters.scenario = headlineScenarios(draft.filters.workspace_code?.[0], options);
        note(
          "scenario",
          "No scenario named.",
          `Assumed the study's headline scenarios from data/curation.json: ${draft.filters.scenario.join(", ")}.`,
        );
      } else {
        // Every model fits while the lines stay readable; that is checked once scenarios are known.
        if (options.length > (d === "modelName" ? maxSeries : maxAssumedValues)) {
          note(
            "follow-up",
            `Asking for the ${dimensionLabels[d]}.`,
            `${options.length} have data, too many to assume them all.`,
          );
          return askFor(d, values(options, d));
        }
        draft.filters[d] = options;
        note(
          dimensionLabels[d],
          `No ${dimensionLabels[d]} named.`,
          `Assumed all ${options.length} with data.`,
        );
      }
      draft.assumed = [...new Set([...(draft.assumed ?? []), d])];
    }
    const series = (draft.filters.modelName?.length ?? 1) * (draft.filters.scenario?.length ?? 1);
    if (series > maxSeries && draft.assumed?.includes("modelName")) {
      const options = draft.filters.modelName!;
      delete draft.filters.modelName;
      draft.assumed = draft.assumed.filter((a) => a !== "modelName");
      return askFor("modelName", values(options, "modelName"), `That would be ${series} lines. `);
    }
    return run();
  }

  /** Validate and preview the draft; validation problems keep the draft and offer changes. */
  async function run(): Promise<Reply> {
    const draft = conversation.draft!;
    let rows = await api.rows(draft.filters);
    // Models the user did not pick may report other units: keep the unit most of them use.
    const byUnit = new Map<string, Set<string>>();
    for (const r of rows) byUnit.set(r.unit, (byUnit.get(r.unit) ?? new Set()).add(r.modelName));
    let unitNote = "";
    if (byUnit.size > 1 && draft.assumed?.includes("modelName")) {
      const [unit, models] = [...byUnit].sort((a, b) => b[1].size - a[1].size)[0];
      const dropped = draft.filters.modelName!.filter((m) => !models.has(m));
      draft.filters.modelName = draft.filters.modelName!.filter((m) => models.has(m));
      rows = rows.filter((r) => r.unit === unit);
      unitNote = `${dropped.length} model${dropped.length === 1 ? " reports" : "s report"} other units than ${unit} and ${dropped.length === 1 ? "is" : "are"} left out.`;
      note(
        "units",
        `Models report ${byUnit.size} different units.`,
        `Kept ${unit}, used by most models; left out ${dropped.join(", ")}.`,
      );
    }
    // Name only the assumed models and scenarios that have rows left.
    for (const d of ["modelName", "scenario"] as const)
      if (draft.assumed?.includes(d) && rows.length)
        draft.filters[d] = draft.filters[d]!.filter((v) => rows.some((r) => r[d] === v));
    let plan;
    try {
      plan = buildPlan(draft, rows);
    } catch (error) {
      return ask("review", (error as Error).message, refineOptions);
    }
    const f = draft.filters;
    const span = plan.years.length > 1 ? `${plan.years[0]}–${plan.years.at(-1)}` : plan.years[0];
    // Explain each assumption once, not again on every follow-up.
    const notice = draft.notice;
    delete draft.notice;
    // One sentence for everything assumed, rather than one per dimension.
    const assumed = (draft.assumed ?? [])
      .filter((d) => !draft.explained?.includes(d))
      .map((d) =>
        d === "workspace_code"
          ? `the “${workspaces.find((w) => w.code === f.workspace_code?.[0])?.title}” study`
          : d === "region"
            ? `${f.region}`
            : d === "scenario" &&
                headlineScenarios(f.workspace_code?.[0], f.scenario ?? []).length ===
                  f.scenario?.length
              ? "the study's main scenarios"
              : `all ${dimensionLabels[d]}s with data`,
      );
    const notes = assumed.length ? [`Not named, so assumed: ${assumed.join(", ")}.`] : [];
    draft.explained = [...(draft.assumed ?? [])];
    const reply = ask(
      "review",
      [
        `${f.variable} in ${list(f.region, "region")}, ${span}: ${plan.rows.length} series from ${list(f.modelName, "model")} and ${scenarios(f.scenario)}.`,
        notice,
        ...notes,
        unitNote,
        "Type a change, such as a model, scenario or “2030 to 2050”.",
      ]
        .filter(Boolean)
        .join(" "),
      refineOptions,
      // Typing a change is the main path; three shortcuts, the rest behind "Other…".
      { featured: 3 },
    );
    return {
      ...reply,
      kind: "result",
      plan,
      url: "https://iamparis.eu/analysis",
      actions: [
        {
          type: "chart.apply",
          label: chart ? "Apply to my chart" : "Open in GraphMaker",
          patch: planPatch(plan),
        },
      ],
    };
  }

  /**
   * Move the query to a study that has the region for the same variable, preferring the general
   * "headed" studies, and say so. Models and scenarios are resolved again in the new study. The
   * same region under another code ("India" and IND) in the current study is used first, silently.
   */
  async function moveToStudyWith(region: string, years: string[]): Promise<Reply | undefined> {
    const draft = conversation.draft!;
    const current = draft.filters.workspace_code![0];
    const order = [
      ...new Set([current, "world-headed", "eu-headed", ...workspaces.map((w) => w.code)]),
    ];
    const name = (r: string) => (regionName(r) ?? r).toLowerCase();
    const found = await Promise.all(
      order.map(async (code) =>
        (
          await api
            .distinct("region", { workspace_code: [code], variable: draft.filters.variable })
            .catch((): string[] => [])
        ).find((r) => r === region || name(r) === name(region)),
      ),
    );
    const index = found.findIndex(Boolean);
    if (index < 0) return undefined;
    const [code, twin] = [order[index], found[index]!];
    note(
      "study",
      `${regionName(region) ?? region} has no data for this variable in the current selection.`,
      code === current
        ? `The same region is published here as ${twin}.`
        : `Moved to the first study that has it, general studies first: ${code}.`,
      code,
    );
    if (code === current) {
      draft.filters.region = [twin];
      if (years.length) draft.years = years;
      await prune();
      return resolve();
    }
    const title = (c: string) => workspaces.find((w) => w.code === c)?.title;
    conversation.draft = {
      filters: { workspace_code: [code], variable: draft.filters.variable, region: [twin] },
      years: years.length ? years : draft.years,
      goal: draft.goal,
      notice: `${regionName(region) ?? region} is not in “${title(current)}”, so this uses “${title(code)}”.`,
    };
    return resolve();
  }

  /**
   * Apply a typed change to the current draft in one classifier request: whether it is a change at
   * all, and which value of each dimension is now wanted. Returns nothing for a new request.
   */
  async function refine(request: string): Promise<Reply | undefined> {
    const draft = conversation.draft;
    if (!draft?.filters.workspace_code?.length) return undefined;
    const study: Filters = { workspace_code: draft.filters.workspace_code };
    const available = Object.fromEntries(
      await Promise.all(
        seriesDimensions.map(async (d) => [d, await api.distinct(d, study)] as const),
      ),
    ) as Record<SeriesDimension, string[]>;
    const picks = await decide(
      {
        request: {
          question: "Does the user change the current data query, or make a new unrelated request?",
          options: requestKinds,
        },
        ...Object.fromEntries(
          seriesDimensions.map((d) => [
            d,
            {
              // The current value is stated in the question, not the message, so the classifier
              // does not mistake it for what the user asks: "none" means keep it.
              question: `The current ${dimensionLabels[d]} is ${draft.filters[d]?.join(", ") ?? "not set"}. Which ${dimensionLabels[d]} does the user want now?${d === "variable" ? ' Narrowing words such as "only solar" select a more specific variable.' : ""} Choose none if the message does not change the ${dimensionLabels[d]}.`,
              options: values(available[d], d),
            },
          ]),
        ),
      } as Record<"request" | SeriesDimension, Question>,
      request,
      {
        request,
        region: request,
        modelName: request,
        scenario: request,
        // A variable named outright wins; otherwise narrowing words combine with the current
        // one: "only solar" on Secondary Energy|Electricity matches …|Electricity|Solar.
        variable: matchOption(values(available.variable), request)
          ? request
          : `${request} ${draft.filters.variable?.join(" ").replace(/\|/g, " ") ?? ""}`,
      },
    );
    const years = requestedYears(request);
    const changes = seriesDimensions.filter(
      (d) => picks[d].choice && draft.filters[d]?.join() !== picks[d].choice,
    );
    // A region this study lacks ("same for Germany" in the EU study) may exist in another one.
    if (picks.request.choice !== "new" && !changes.includes("region")) {
      const outside = matchOption(knownRegions, request);
      if (outside && !available.region.includes(outside.id)) {
        const moved = await moveToStudyWith(outside.id, years);
        if (moved) return moved;
      }
    }
    // Nothing recognisable to change: treat it as a new request rather than asking what to change.
    if (picks.request.choice === "new" || (!changes.length && !years.length)) return undefined;
    const extend = /\b(add|also|compare|versus|vs|plus|as well)\b/i.test(request);
    const before = structuredClone(draft);
    for (const d of changes) {
      const value =
        d === "variable" && !picks[d].curated
          ? plainest(picks[d].choice!, available.variable, request)
          : picks[d].choice!;
      draft.filters[d] =
        extend && d !== "variable" ? [...new Set([...(draft.filters[d] ?? []), value])] : [value];
      draft.assumed = draft.assumed?.filter((a) => a !== d);
    }
    if (years.length) draft.years = years;
    draft.goal += `\nUser: ${request}`;
    await prune();
    // A requested value without data keeps the previous query and says why, never a silent revert.
    const missing = changes.find((d) => !draft.filters[d]?.includes(picks[d].choice!));
    if (missing) {
      const value = picks[missing].choice!;
      conversation.draft = before;
      if (missing === "region") {
        const moved = await moveToStudyWith(value, years);
        if (moved) return moved;
      }
      const study = workspaces.find((w) => w.code === before.filters.workspace_code?.[0])?.title;
      return ask(
        "review",
        `There is no ${before.filters.variable} data for ${regionName(value) ?? value} in “${study}”, so your query is unchanged. Try another ${dimensionLabels[missing]} or variable.`,
        refineOptions,
      );
    }
    return resolve();
  }

  async function execute(
    kind: Pending["kind"],
    selected: string,
    dimension?: Dimension,
    compare = false,
    facet?: FacetKey,
  ): Promise<Reply> {
    const request = conversation.pending?.request || text;
    if (kind === "studies") return studies.choose(selected, facet);
    if (kind === "route") {
      if (selected === "studies") return studies.start(request);
      conversation.brief = undefined;
      if (selected === "analysis") {
        conversation.draft = {
          // Stay in the study the user is already charting.
          filters: chart ? { workspace_code: [chart.workspace!] } : {},
          years: requestedYears(request),
          goal: request || "Help me build an analysis",
        };
        return resolve();
      }
      conversation.draft = undefined;
      if (selected === "chart") {
        const { action } = await decide(
          {
            action: {
              question: "What does the user want to do with the chart they are viewing?",
              options: chartOptions,
            },
          },
          request,
        );
        const next = action.choice ?? guessChartAction(request) ?? (chart ? "modify" : undefined);
        if (next) return execute("chart", next);
        return ask("chart", "What would you like to do with your chart?", chartOptions);
      }
      if (selected === "model") {
        const options = modelOptions(await registry());
        const { model } = await decide(
          { model: { question: "Which model does the user ask about?", options } },
          request,
        );
        const picked = options.find((o) => o.id === model.choice);
        if (picked && mentionsOption(picked, request)) return execute("model", picked.id);
        return ask("model", "Which model do you mean?", rankOptions(options, request), {
          featured,
        });
      }
      const navigation = selected === "navigation";
      const options = navigation ? linkOptions : answerOptions;
      const { target } = await decide(
        {
          target: {
            question: navigation
              ? "Which IAMPARIS destination directly satisfies this navigation request?"
              : "Which curated definition directly answers the user's question? Choose none if no definition answers it.",
            options,
          },
        },
        request,
      );
      // A definition is returned only when the question names its term.
      const grounded =
        target.choice &&
        (navigation ||
          mentionsOption(
            options.find((o) => o.id === target.choice)!,
            request,
          ));
      if (grounded) return execute(navigation ? "navigation" : "answer", target.choice!);
      return ask(
        navigation ? "navigation" : "answer",
        navigation ? "Which page are you looking for?" : "Which topic do you mean?",
        rankOptions(options, request),
        { featured },
      );
    }
    if (kind === "navigation") {
      const link = links.find((l) => l.id === selected)!;
      conversation.pending = undefined;
      return {
        kind: "navigation",
        title: link.title,
        text: link.fallback_instruction || "Open this page on IAMPARIS.",
        url: link.url,
        source: "IAMPARIS curated link catalogue",
        actions: [{ type: "navigate", label: "Go to page", path: sitePath(link.url) }],
        trace,
      };
    }
    if (kind === "model") {
      const model = (await registry()).find((m) => m.id === selected);
      if (!model) throw new Error("That model is no longer in the registry.");
      return profile(model, modelFacet(request));
    }
    if (kind === "answer") {
      const term = terms[Number(selected.replace("term", ""))];
      conversation.pending = undefined;
      return {
        kind: "answer",
        title: term.term,
        text: term.definition,
        source: term.source,
        trace,
      };
    }
    if (kind === "chart") {
      if (!chart) throw new Error("Open a chart in Analysis first, then ask again.");
      if (selected === "describe") {
        conversation.pending = undefined;
        const summary = describeChart(chart, await api.rows(chartFilters(chart)));
        return {
          kind: "insight",
          title: chart.title,
          text: summary.text,
          facts: summary.facts,
          source: "IAMPARIS results API",
          trace,
        };
      }
      if (selected === "type") {
        conversation.pending = undefined;
        const asked = request.toLowerCase();
        const type = /\bbar/.test(asked)
          ? "bar"
          : /\bline/.test(asked)
            ? "line"
            : chart.visualizationType === "bar"
              ? "line"
              : "bar";
        return {
          kind: "answer",
          text: `Your chart can be shown as a ${type} chart with the same filters.`,
          actions: [
            {
              type: "chart.apply",
              label: `Show as ${type} chart`,
              patch: { visualizationType: type },
            },
          ],
          trace,
        };
      }
      if (selected === "modify") {
        conversation.draft = draftFromChart(chart, request);
        return (
          (await refine(request)) ??
          ask("review", "What would you like to change in your chart?", refineOptions)
        );
      }
    }
    if (kind === "dimension" && dimension) {
      const draft = conversation.draft!;
      if (dimension === "workspace_code") {
        if (draft.filters.workspace_code?.[0] !== selected) {
          draft.filters = {};
          draft.assumed = [];
        }
      } else {
        const available = await api.distinct(dimension, others(dimension));
        if (!available.includes(selected))
          throw new Error(
            "That option is no longer available. Change another filter and try again.",
          );
      }
      draft.filters[dimension] =
        compare && dimension === "scenario"
          ? [...new Set([...(draft.filters.scenario ?? []), selected])]
          : [selected];
      draft.assumed = draft.assumed?.filter((a) => a !== dimension);
      draft.goal += `\nUser selected ${dimensionLabels[dimension]}: ${selected}`;
      await prune();
      return resolve();
    }
    if (kind === "review") {
      const draft = conversation.draft!;
      if (selected === "years") {
        draft.years = [];
        return run();
      }
      if (selected === "compare") {
        const options = (await api.distinct("scenario", others("scenario"))).filter(
          (v) => !draft.filters.scenario?.includes(v),
        );
        if (!options.length)
          return ask(
            "review",
            "No other scenario is available for this variable, region and model.",
            refineOptions,
          );
        return ask("dimension", "Which scenario should I add?", values(options), {
          dimension: "scenario",
          compare: true,
          featured,
        });
      }
      if (selected.startsWith("edit:")) {
        const d = selected.slice(5) as Dimension;
        if (d === "workspace_code") return askFor(d, workspaceOptions);
        delete draft.filters[d];
        draft.assumed = draft.assumed?.filter((a) => a !== d);
        return askFor(d, values(await api.distinct(d, draft.filters), d));
      }
    }
    throw new Error("Choose one of the current options.");
  }

  async function newRequest(): Promise<Reply> {
    conversation.pending = undefined;
    conversation.draft = undefined;
    conversation.brief = undefined;
    // With a chart open, "this chart" or a chart type is about that chart: no classifier needed.
    if (chart && aboutOpenChart.test(text)) return execute("route", "chart");
    // Someone describing themselves, or asking which studies matter, wants studies picked.
    if (describesUser.test(text) || asksForStudies.test(text)) {
      note(
        "task",
        describesUser.test(text)
          ? "The message describes who the user is."
          : "The message asks which studies are relevant.",
        "Studies are picked for them. A wording rule in code; the classifier was not asked.",
        "studies",
      );
      return studies.start(text);
    }
    // "Who developed it?" right after a model profile is about that model.
    if (
      conversation.subject?.kind === "model" &&
      /\b(it|its|this model|that model|they)\b/i.test(text)
    ) {
      const model = (await registry()).find((m) => m.id === conversation.subject!.id);
      if (model) return profile(model, modelFacet(text));
    }
    // A named model with "tell me about" or "who developed" is a model question.
    if (asksAboutModel.test(text)) {
      const named = modelByName(await registry(), text);
      if (named) return execute("model", named.id);
    }
    // A study or application named outright opens its page.
    const page = namedPage(text);
    if (page) return execute("navigation", page.id);
    // The study rides along with the route so an analysis can start without a second request.
    const picks = await decide(
      {
        route: {
          question:
            "Which supported IAMPARIS task is the user requesting? Choose none for greetings or unrelated questions.",
          options: availableRoutes,
        },
        study: { question: dimensionQuestions.workspace_code, options: workspaceOptions },
      },
      text,
    );
    const route = picks.route.choice ?? guessRoute(text, Boolean(chart));
    // Still unclear: a page from the site's catalogue ("post Glasgow results") before the menu.
    if (!route) {
      const { target } = await decide(
        {
          target: {
            question: "Which IAMPARIS page does the user ask for? Choose none if no page fits.",
            options: linkOptions,
          },
        },
        text,
      );
      const link = linkOptions.find((o) => o.id === target.choice);
      if (link && mentionsOption(link, text)) return execute("navigation", link.id);
    }
    if (route === "analysis") {
      // Without a confident study pick, stay in the charted study or use a general one.
      const study = picks.study.choice ?? chart?.workspace ?? defaultStudy(text);
      conversation.draft = {
        filters: { workspace_code: [study] },
        years: requestedYears(text),
        goal: text,
        assumed: picks.study.choice || chart ? [] : ["workspace_code"],
      };
      return resolve();
    }
    if (route && !picks.route.choice)
      note(
        "task",
        "No confident classifier pick for the task.",
        "Keyword rules in code chose it.",
        route,
      );
    if (route) return execute("route", route);
    return ask(
      "route",
      chart
        ? "I can work with your current chart, show IAMPARIS data, find a page, explain a concept, or pick studies for you."
        : "I can show IAMPARIS data, find a page, explain a concept, or pick the studies relevant to you.",
      availableRoutes,
    );
  }

  async function respond(): Promise<Reply> {
    try {
      if (
        /^(cancel|stop|reset|start over)$/i.test(text) ||
        ("option" in input &&
          input.option === "cancel" &&
          input.token === conversation.pending?.token)
      ) {
        conversation.draft = undefined;
        conversation.brief = undefined;
        conversation.pending = undefined;
        return {
          kind: "help",
          text: "Cancelled. You can ask for data, find a page, ask about a concept, or have studies picked for you.",
          trace,
        };
      }
      if ("option" in input) {
        const pending = conversation.pending;
        if (
          !pending ||
          pending.token !== input.token ||
          !pending.options.some((o) => o.id === input.option)
        )
          return {
            kind: "error",
            text: "That button has expired. Use the choices on the newest reply.",
            trace,
          };
        trace.push({
          subject: subjectOfPending(pending),
          question: "The user clicked one of the offered options.",
          options: pending.options.filter((o) => o.id === input.option),
          choice: input.option,
          probabilities: {},
          ms: 0,
          source: "user",
          outcome: "accepted",
        });
        return await execute(
          pending.kind,
          input.option,
          pending.dimension,
          pending.compare,
          pending.facet,
        );
      }
      // Typed or suggested commands that name a task exactly need no classifier call.
      const command = [...availableRoutes, ...(chart ? chartOptions : [])].find(
        (o) => o.label.toLowerCase() === text.toLowerCase(),
      );
      if (command) {
        conversation.pending = undefined;
        conversation.draft = undefined;
        return await execute(chartOptions.includes(command) ? "chart" : "route", command.id);
      }
      const pending = conversation.pending;
      if (pending) {
        // "2" picks the second offered option, as numbered in the panel.
        const number = /^\s*#?(\d{1,2})[.)]?\s*$/.exec(text);
        const exact = number
          ? pending.options[Number(number[1]) - 1]
          : pending.options.find(
              (o) =>
                o.label.toLowerCase() === text.toLowerCase() ||
                o.id.toLowerCase() === text.toLowerCase(),
            );
        if (exact) {
          trace.push({
            subject: subjectOfPending(pending),
            question: number
              ? "The user typed the number of an offered option."
              : "The user typed an offered option's label.",
            options: [exact],
            choice: exact.id,
            probabilities: {},
            ms: 0,
            source: "user",
            outcome: "accepted",
          });
          return await execute(
            pending.kind,
            exact.id,
            pending.dimension,
            pending.compare,
            pending.facet,
          );
        }
        if (pending.kind === "studies") {
          const picked = await studies.typed(text, pending);
          if (picked) return picked;
        } else if (pending.kind === "review") {
          const refined = await refine(text);
          if (refined) return refined;
        } else {
          const { answer } = await decide(
            {
              answer: {
                question: `Which of the offered options does the user choose?${pending.dimension ? ` They were asked for the ${dimensionLabels[pending.dimension]}.` : ""} Choose none if the message is about something else.`,
                options: pending.options,
              },
            },
            text,
            // "only solar", typed when asked for the variable, reads with the original request.
            pending.kind === "dimension"
              ? { answer: `${conversation.draft?.goal ?? ""} ${text}` }
              : {},
          );
          if (answer.choice) {
            // A typed answer is the request now, not the message that raised the question.
            pending.request = text;
            return await execute(pending.kind, answer.choice, pending.dimension, pending.compare);
          }
          const refined = pending.kind === "dimension" ? await refine(text) : undefined;
          if (refined) return refined;
        }
      }
      return await newRequest();
    } catch (error) {
      conversation.draft = draftBefore;
      conversation.brief = briefBefore;
      conversation.pending = pendingBefore;
      return {
        kind: "error",
        text:
          error instanceof Error && !error.message.startsWith("[")
            ? error.message
            : "The data service returned an unexpected response. Your selections have been kept; try again.",
        options: pendingBefore?.options,
        token: pendingBefore?.token,
        filters: draftBefore?.filters,
        trace,
      };
    }
  }

  const reply = await respond();
  // What the turn left behind, so the inspector can show the state the next message meets.
  reply.state = structuredClone({
    draft: conversation.draft,
    brief: conversation.brief,
    pending: conversation.pending && {
      kind: conversation.pending.kind,
      dimension: conversation.pending.dimension,
      facet: conversation.pending.facet,
    },
  });
  reply.ms = Math.round(performance.now() - started);
  return reply;
}
