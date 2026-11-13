import type { Question } from "../jev/client.ts";
import {
  facetKeys,
  type Conversation,
  type Decision,
  type FacetKey,
  type Option,
  type Pending,
  type Reply,
  type StudySelection,
} from "../shared/types.ts";
import {
  facetCandidates,
  facetLabel,
  facetNames,
  facetOptions,
  filterStudies,
  inEu,
  namedFacets,
  selectionQuery,
  studiesSnapshot,
  studyCard,
} from "../tools/studies.ts";
import { requestedYears } from "./analysis.ts";

/**
 * Picking studies for someone: the Results page's facet filter, driven by conversation.
 *
 * The user describes who they are or what they care about. Wording and the classifier fill the
 * sector, region and topic facets; code asks for what is still open, one question at a time, and
 * stops asking as soon as few enough studies remain. Nothing is generated: every study, label and
 * count comes from data/studies.json.
 */

/** With this many studies or fewer, show them instead of asking another question. */
const enough = 4;
/** Above this many, offer to narrow by topic. */
const topicAbove = 6;
const shown = 8;
/** Facets asked for, in order. A project is used only when named. */
const asked = ["sector", "region", "tag"] as const;
type Asked = (typeof asked)[number];

const classifierQuestions: Record<Asked, string> = {
  sector:
    "Which sector does the user work in or care about? Judge from their role, employer or interest. Choose none if no single sector is implied.",
  region:
    "Which country or region is the user in, or asking about? Choose none if no place is mentioned.",
  tag: "Which topic is the user most interested in? Choose none if the message names no listed topic.",
};
const userQuestions: Record<Asked, string> = {
  sector: "Which sector do you work on?",
  region: "Which region matters to you?",
  tag: "Is there a topic you care about most?",
};
/** Wording that asks for numbers rather than studies; never read as a change to the study search. */
const asksForData =
  /\b(how (much|many)|plot|chart|graph|values?|numbers?|emissions? (in|for|of)|capacity|generation|gdp|population)\b/i;
const anyOf =
  /\b(any|all|every|no particular|whatever)\s+(sector|region|country|countrie|place|topic|theme|project)s?\b/i;
const noPreference =
  /^\s*(any|all|either|both|no preference|doesn'?t matter|not sure|don'?t know|skip|none|no|nope)\b/i;
const extends_ = /\b(add|also|plus|as well|too|include|including|together with)\b/i;

export type StudyContext = {
  conversation: Conversation;
  trace: Decision[];
  /** One classifier request for every question; decisions are traced by the caller. */
  decide: (
    questions: Record<string, Question & { subject?: string }>,
    state: string,
  ) => Promise<Record<string, { choice?: string }>>;
  ask: (
    kind: Pending["kind"],
    question: string,
    options: Option[],
    extra?: { facet?: FacetKey; featured?: number },
  ) => Reply;
  /** Record a decision made by a rule in code, for the inspector. */
  note: (subject: string, what: string, reason: string, choice?: string) => void;
};

export function studyFlow({ conversation, trace, decide, ask, note }: StudyContext) {
  const brief = () => conversation.brief!;
  const count = (n: number) => `${n} ${n === 1 ? "study" : "studies"}`;
  const labels = (key: FacetKey, ids: string[] = []) =>
    ids.map((id) => facetLabel(key, id)).join(" or ");
  /** "sector Industry, region Germany or EU" for the current selection, as the page's chips read. */
  function describe(selection: StudySelection) {
    return (
      facetKeys
        .filter((key) => selection[key]?.length)
        .map((key) => `${facetNames[key]} ${labels(key, selection[key])}`)
        .join(", ") || "no filter"
    );
  }
  function settle(key: FacetKey) {
    if (!brief().settled.includes(key)) brief().settled.push(key);
  }

  /**
   * Fill facets from what the user wrote. A value named outright (label or curated phrase) is
   * taken without the classifier, and several may be named. The classifier is asked only for the
   * `infer` facets still open: all of them for a first description, the one being asked about for
   * an answer, none for a change to a list (it would read every message as naming something).
   */
  async function understand(text: string, infer: readonly Asked[]): Promise<FacetKey[]> {
    const changed: FacetKey[] = [];
    const extend = extends_.test(text);
    for (const key of facetKeys) {
      const named = namedFacets(key, text);
      if (!named.length) continue;
      const ids = named.map((n) => n.id);
      const evidence = named.map((n) => `“${n.phrase}”`).join(", ");
      trace.push({
        subject: facetNames[key],
        question: `Which ${facetNames[key]} does the message name?`,
        options: named.map((n) => ({ id: n.id, label: facetLabel(key, n.id), detail: n.phrase })),
        choice: ids[0],
        probabilities: {},
        ms: 0,
        source: "match",
        outcome: "accepted",
        reason: `Named in the message: ${evidence}. Labels and the phrases in data/curation.json count.`,
        state: text,
      });
      brief().selection[key] = extend
        ? [...new Set([...(brief().selection[key] ?? []), ...ids])]
        : ids;
      brief().evidence[key] = evidence;
      brief().explained = brief().explained?.filter((k) => k !== key);
      settle(key);
      changed.push(key);
    }
    const open = infer.filter(
      (key) => !brief().selection[key]?.length && !brief().settled.includes(key),
    );
    if (!open.length) return changed;
    const picks = await decide(
      Object.fromEntries(
        open.map((key) => [
          `study-${key}`,
          {
            subject: facetNames[key],
            question: classifierQuestions[key],
            // "Economy-wide" means no single sector: it is named or chosen, never inferred from
            // a message that simply says nothing about sectors.
            options: facetCandidates(key).filter((o) => o.id !== "economy-wide"),
          },
        ]),
      ),
      text,
    );
    for (const key of open) {
      const choice = picks[`study-${key}`]?.choice;
      if (!choice) continue;
      brief().selection[key] = [choice];
      // Inferred, not named: said to the user so a wrong guess is easy to correct.
      brief().evidence[key] = "inferred";
      changed.push(key);
    }
    return changed;
  }

  /**
   * When nothing matches, widen rather than return an empty list: first the region (a member
   * state to EU-wide studies, then global ones, then any region), then the topic, then the
   * sector. What someone works on matters more than where a study was run. Returns what to say.
   */
  function relax(): string | undefined {
    const selection = brief().selection;
    if (filterStudies(selection).length) return undefined;
    const before = describe(selection);
    const steps: [string, () => void][] = [];
    if (selection.region?.length) {
      const region = selection.region;
      if (region.some(inEu) && !region.includes("eu"))
        steps.push(["EU-wide studies are included", () => region.push("eu")]);
      if (!region.includes("global"))
        steps.push(["global studies are included", () => region.push("global")]);
      steps.push(["the region was dropped", () => delete selection.region]);
    }
    if (selection.tag?.length) steps.push(["the topic was dropped", () => delete selection.tag]);
    if (selection.project?.length)
      steps.push(["the project was dropped", () => delete selection.project]);
    if (selection.sector?.length)
      steps.push(["the sector was dropped", () => delete selection.sector]);
    const done: string[] = [];
    for (const [what, apply] of steps) {
      apply();
      done.push(what);
      if (filterStudies(selection).length) break;
    }
    // A dropped region makes the widenings before it moot.
    const said = done.includes("the region was dropped")
      ? done.filter((what) => !what.endsWith("studies are included"))
      : done;
    note(
      "widening",
      `No study matches ${before}.`,
      `Widened in a fixed order (region, then topic, then sector): ${said.join("; ")}. Now ${describe(selection)}.`,
    );
    return `No study matches ${before}, so ${said.join(" and ")}.`;
  }

  function askFacet(key: Asked, intro = ""): Reply {
    const selection = brief().selection;
    const matches = filterStudies({ ...selection, [key]: undefined }).length;
    let options = facetOptions(key, selection);
    // Topics by how many studies they would show; sectors and regions in the page's order.
    if (key === "tag")
      options = options
        .map((o, i) => ({ o, i, n: Number.parseInt(o.detail ?? "0", 10) }))
        .sort((a, b) => b.n - a.n || a.i - b.i)
        .map(({ o }) => o);
    options.push({
      id: "any",
      label: key === "tag" ? `Show all ${matches}` : `Any ${facetNames[key]}`,
      detail: count(matches),
    });
    const known = describe({ ...selection, [key]: undefined });
    return ask(
      "studies",
      [
        intro,
        known === "no filter" ? "" : `So far: ${known}.`,
        key === "tag" ? `That leaves ${count(matches)}.` : "",
        userQuestions[key],
      ]
        .filter(Boolean)
        .join(" "),
      options,
      { facet: key, featured: key === "tag" ? 6 : undefined },
    );
  }

  /**
   * Ask for the next open facet while many studies remain; otherwise show them. Questions belong
   * to the intake: once a list has been shown, changes update it and the user steers.
   */
  function advance(intro = ""): Reply {
    const widened = relax();
    const { selection, settled, listed } = brief();
    const matches = filterStudies(selection);
    if (listed) return show(widened);
    if (!widened)
      for (const key of ["sector", "region"] as const) {
        if (selection[key]?.length || settled.includes(key)) continue;
        if (matches.length <= enough) {
          note(
            "follow-up",
            `Not asking for the ${facetNames[key]}.`,
            `${count(matches.length)} left, which is at most ${enough}: shown without another question.`,
          );
          continue;
        }
        if (facetOptions(key, selection).length < 2) continue;
        note(
          "follow-up",
          `Asking for the ${facetNames[key]}.`,
          `${count(matches.length)} match so far and no ${facetNames[key]} is known.`,
        );
        return askFacet(key, intro);
      }
    if (
      !widened &&
      matches.length > topicAbove &&
      !selection.tag?.length &&
      !settled.includes("tag")
    ) {
      note(
        "follow-up",
        "Offering to narrow by topic.",
        `${count(matches.length)} match, more than ${topicAbove}.`,
      );
      return askFacet("tag", intro);
    }
    return show(widened);
  }

  /** The matching studies, most specific first, with the changes on offer. */
  function show(widened?: string): Reply {
    const { selection, evidence } = brief();
    const matches = filterStudies(selection)
      .map((study) => studyCard(study, selection))
      .sort(
        (a, b) =>
          b.facets.filter((f) => f.matched).length - a.facets.filter((f) => f.matched).length ||
          // A study about one place before one that also covers it.
          a.facets.filter((f) => f.key === "region").length -
            b.facets.filter((f) => f.key === "region").length ||
          a.title.localeCompare(b.title),
      );
    // Say once how each value was understood; inferred ones invite correction.
    const fresh = facetKeys.filter(
      (key) => selection[key]?.length && evidence[key] && !brief().explained?.includes(key),
    );
    const named = fresh.filter((key) => !["inferred", "chosen"].includes(evidence[key]!));
    const inferred = fresh.filter((key) => evidence[key] === "inferred");
    brief().explained = [...new Set([...(brief().explained ?? []), ...fresh])];
    brief().listed = true;
    const more = (region: string) =>
      filterStudies({ ...selection, region: [...(selection.region ?? []), region] }).length -
      matches.length;
    const countries = (selection.region ?? []).filter((r) => r !== "eu" && r !== "global");
    const options: Option[] = [
      ...(countries.length && countries.some(inEu) && more("eu") > 0
        ? [{ id: "add:eu", label: "Include EU-wide studies", detail: `${more("eu")} more` }]
        : []),
      ...(selection.region?.length && !selection.region.includes("global") && more("global") > 0
        ? [
            {
              id: "add:global",
              label: "Include global studies",
              detail: `${more("global")} more`,
            },
          ]
        : []),
      { id: "edit:sector", label: selection.sector?.length ? "Change sector" : "Choose a sector" },
      { id: "edit:region", label: selection.region?.length ? "Change region" : "Choose a region" },
      { id: "edit:tag", label: selection.tag?.length ? "Change topic" : "Narrow by topic" },
      { id: "reset", label: "Start over" },
    ];
    const reply = ask(
      "studies",
      [
        Object.keys(selection).some((key) => selection[key as FacetKey]?.length)
          ? `${count(matches.length)} ${matches.length === 1 ? "matches" : "match"} ${describe(selection)}.`
          : `All ${count(matches.length)}, with no filter.`,
        named.length
          ? `From your message: ${named.map((key) => `${facetNames[key]} ${labels(key, selection[key])} (${evidence[key]})`).join(", ")}.`
          : "",
        inferred.length
          ? `I took your ${inferred.map((key) => `${facetNames[key]} to be ${labels(key, selection[key])}`).join(" and your ")} from how you described yourself; change it if that is wrong.`
          : "",
        widened,
        matches.length > shown ? `The first ${shown} are listed.` : "",
        "Type a change, such as another country or a topic.",
      ]
        .filter(Boolean)
        .join(" "),
      options,
      { featured: Math.min(options.length, 4) },
    );
    const query = selectionQuery(selection);
    return {
      ...reply,
      kind: "studies",
      studies: matches.slice(0, shown),
      // Titles as plain facts too, for clients that do not draw study cards.
      facts: matches.slice(0, shown).map((s) => `${s.title} (${s.projects.join(", ")})`),
      selection: facetKeys
        .filter((key) => selection[key]?.length)
        .map((key) => ({
          key,
          label: facetNames[key],
          values: selection[key]!.map((id) => ({ id, label: facetLabel(key, id) })),
        })),
      source: `IAMPARIS Results page facets, snapshot of ${studiesSnapshot}`,
      url: `https://iamparis.eu/results${query}`,
      actions: [{ type: "navigate", label: "Open these in Results", path: `/results${query}` }],
    };
  }

  /** A new study search from the user's description of themselves or their interest. */
  async function start(request: string): Promise<Reply> {
    conversation.draft = undefined;
    conversation.brief = { selection: {}, goal: request, settled: [], evidence: {} };
    const understood = await understand(request, asked);
    return advance(
      understood.length ? "" : "I can pick the IAMPARIS studies most relevant to you.",
    );
  }

  /** A clicked option: a facet value, "any", or one of the changes offered under a list. */
  async function choose(option: string, facet?: FacetKey): Promise<Reply> {
    const selection = brief().selection;
    if (facet) {
      if (option === "any") delete selection[facet];
      else {
        selection[facet] = [option];
        brief().evidence[facet] = "chosen";
      }
      settle(facet);
      return advance();
    }
    if (option === "reset") {
      conversation.brief = { selection: {}, goal: "", settled: [], evidence: {} };
      return advance("Starting again.");
    }
    if (option.startsWith("add:")) {
      selection.region = [...new Set([...(selection.region ?? []), option.slice(4)])];
      return advance();
    }
    if (option.startsWith("edit:")) {
      const key = option.slice(5) as Asked;
      // Counts ignore the facet's own value, as on the page, so every alternative is offered.
      brief().settled = brief().settled.filter((k) => k !== key);
      return askFacet(key);
    }
    throw new Error("Choose one of the current options.");
  }

  /**
   * Free text while a study question or list is open. Returns nothing when the message is not
   * about the study search, so it is handled as a new request.
   */
  async function typed(text: string, pending: Pending): Promise<Reply | undefined> {
    const facet = pending.facet as Asked | undefined;
    const cleared = anyOf.exec(text);
    if (cleared) {
      const word = cleared[2].toLowerCase();
      const key: FacetKey = /countr|place|region/.test(word)
        ? "region"
        : /topic|theme/.test(word)
          ? "tag"
          : (word as FacetKey);
      delete brief().selection[key];
      settle(key);
      note("change", `“${cleared[0]}” clears the ${facetNames[key]}.`, "Wording rule in code.");
      return advance();
    }
    if (facet && noPreference.test(text)) return choose("any", facet);
    // A list is open: numbers and data wording start a new request instead of a filter change.
    if (!facet && (requestedYears(text).length || asksForData.test(text))) {
      note(
        "request type",
        "A new request, not a change to the study search.",
        "The message asks for numbers or names years.",
      );
      return undefined;
    }
    const changed = await understand(text, facet ? [facet] : []);
    if (!changed.length) return undefined;
    brief().goal = `${brief().goal}
User: ${text}`.trim();
    return advance();
  }

  return { start, choose, typed };
}
