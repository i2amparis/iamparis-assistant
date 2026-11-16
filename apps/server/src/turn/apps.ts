import type { Question } from "../jev/client.ts";
import {
  appFacetKeys,
  type AppSelection,
  type Conversation,
  type Decision,
  type Option,
  type Pending,
  type Reply,
} from "../shared/types.ts";
import {
  appCard,
  appFacetNames,
  appFacetOptions,
  apps,
  appsSnapshot,
  libraryPath,
  libraryQuery,
  namedApps,
  namedAppTypes,
  searchApps,
  type App,
} from "../tools/apps.ts";
import { namedSitePage } from "../tools/catalog.ts";
import { requestedYears } from "./analysis.ts";

/**
 * Finding a tool in the Application Library, driven by conversation.
 *
 * A tool named outright is answered with its library page. Otherwise the tools are ranked against
 * what the user describes and the closest are listed, each linking to its own library page and to
 * the tool itself. Nothing is generated: every title, description and count comes from
 * data/apps.json.
 */

const shown = 6;
/** Wording that asks for a tool: a general word for one, not the words in tool titles. */
const toolNoun =
  /\b(tools?|apps?|applications?|platforms?|dashboards?|calculators?|simulators?|emulators?|portals?|software|web ?sites?|(python|r) packages?|games?|data ?(sets?|bases?|platforms?|portals?|sources?))\b/i;
/** Whether the text uses a general word for a tool ("is there a dashboard for…"). */
export const asksForTool = (text: string) => toolNoun.test(text);
/** Wording that asks for numbers rather than tools; never read as a change to the tool search. */
const asksForData = /\b(how (much|many)|plot|values?|numbers?)\b/i;
/** How a follow-up to a list begins ("what about forests?", "only for cities"). */
const continues =
  /^\s*(and|also|only|just|or|what about|how about|same for|any(thing)? (for|on|about)|for|on|about|with|more (on|about))\b/i;
const startsAnew = /^\s*(what|where|who|why|how|when|define|explain|tell|show|plot|compare)\b/i;
const extends_ = /\b(add|also|plus|as well|too|include|including|together with)\b/i;

export type AppContext = {
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
    extra?: { featured?: number },
  ) => Reply;
  /** Record a decision made by a rule in code, for the inspector. */
  note: (subject: string, what: string, reason: string, choice?: string) => void;
};

export function appFlow({ conversation, trace, decide, ask, note }: AppContext) {
  const finder = () => conversation.finder!;
  const count = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;
  const quoted = (words: string[]) => words.map((word) => `“${word}”`).join(", ");
  /** "type Interactive Maps, topic Finance" for the current selection. */
  const describe = (selection: AppSelection) =>
    appFacetKeys
      .filter((key) => selection[key]?.length)
      .map((key) => `${appFacetNames[key]} ${selection[key]!.join(" or ")}`)
      .join(", ");
  const source = `IAMPARIS Application Library, snapshot of ${appsSnapshot}`;
  const browse = (query = "") => ({
    url: `https://iamparis.eu${libraryPath}${query}`,
    actions: [
      {
        type: "navigate" as const,
        label: query ? "Open this search in the library" : "Open the Application Library",
        path: `${libraryPath}${query}`,
      },
    ],
  });

  /**
   * Whether a new message asks for a tool: it names one from the library, or uses a word for
   * tools without naming a page of this site. A message that says "library" and nothing to
   * search by is a request for the library page itself.
   */
  function wanted(text: string) {
    if (namedApps(text).length) return true;
    // "The Scenario Metadata Tool" is a page of this site, not a library entry.
    if (!toolNoun.test(text) || namedSitePage(text)) return false;
    return (
      !/\blibrary\b/i.test(text) ||
      namedAppTypes(text).length > 0 ||
      searchApps(text).words.length > 0
    );
  }

  /** Tools named in the message, recorded for the inspector. */
  function named(text: string): App[] {
    const found = namedApps(text);
    if (found.length)
      trace.push({
        subject: "tool",
        question: "Which tool from the Application Library does the message name?",
        options: found.map(({ app, phrase }) => ({
          id: String(app.id),
          label: app.title,
          detail: phrase,
        })),
        choice: String(found[0].app.id),
        probabilities: {},
        ms: 0,
        source: "match",
        outcome: "accepted",
        reason: `Named in the message: ${quoted(found.map((f) => f.phrase))}. A tool's title, its abbreviation or the name before a dash counts.`,
        state: text,
      });
    return found.map((f) => f.app);
  }

  /** Set the type filter from the message's wording; returns whether it changed. */
  function readTypes(text: string) {
    const types = namedAppTypes(text);
    if (!types.length) return false;
    const ids = types.map((type) => type.id);
    trace.push({
      subject: "type",
      question: "Which type of tool does the message name?",
      options: types.map((type) => ({ id: type.id, label: type.id, detail: type.phrase })),
      choice: ids[0],
      probabilities: {},
      ms: 0,
      source: "match",
      outcome: "accepted",
      reason: `Named in the message: ${quoted(types.map((t) => t.phrase))}. Labels of several words and the phrases in data/curation.json count.`,
      state: text,
    });
    finder().selection.type = extends_.test(text)
      ? [...new Set([...(finder().selection.type ?? []), ...ids])]
      : ids;
    return true;
  }

  /** One tool: what the library says about it, its library page and the tool itself. */
  function one(app: App): Reply {
    conversation.pending = undefined;
    conversation.finder = undefined;
    const card = appCard(app);
    return {
      kind: "apps",
      text: [
        `${app.title} is in the Application Library${card.creator ? `, by ${card.creator}` : ""}.`,
        "Its library page describes it and links to the tool.",
      ].join(" "),
      apps: [card],
      facts: [app.title],
      source,
      url: card.url,
      actions: [{ type: "navigate", label: "Open its library page", path: app.path }],
      trace,
    };
  }

  function askTopic(intro = ""): Reply {
    const selection = { ...finder().selection, topic: undefined };
    const total = searchApps("", selection).hits.length || apps.length;
    const reply = ask(
      "apps",
      [
        intro,
        `The Application Library lists ${count(apps.length)} for climate and energy data.`,
        describe(selection) ? `So far: ${describe(selection)}.` : "",
        "Which topic are you looking for? You can also describe what you need or name a tool.",
      ]
        .filter(Boolean)
        .join(" "),
      [
        ...appFacetOptions("topic", selection),
        { id: "topic:any", label: `Show all ${total}`, detail: count(total) },
      ],
      { featured: 7 },
    );
    return { ...reply, source, ...browse() };
  }

  /** The tools given, as cards, with a way on. Used when several tools are named at once. */
  function several(found: App[]): Reply {
    const reply = ask(
      "apps",
      `${count(found.length)} in the Application Library carry those names. Each opens its library page.`,
      [{ id: "topics", label: "Browse by topic" }],
      { featured: 1 },
    );
    return {
      ...reply,
      kind: "apps",
      apps: found.map((app) => appCard(app)),
      facts: found.map((app) => app.title),
      source,
      ...browse(),
    };
  }

  /**
   * The tools closest to the description, with the type chips that narrow them. With `whole`,
   * no description and no filter lists the library itself, in the page's order.
   */
  function show(intro = "", whole = false): Reply {
    const { query, selection } = finder();
    let result = searchApps(query, selection);
    let widened = "";
    // A type nothing matches is dropped rather than returning an empty list.
    if (!result.hits.length && selection.type?.length && result.words.length) {
      const types = selection.type.join(" or ");
      delete selection.type;
      result = searchApps(query, selection);
      if (result.hits.length) {
        widened = `No ${types} tool matches ${quoted(result.words)}, so every type is included.`;
        note("widening", widened, "The type filter is dropped before returning nothing.");
      }
    }
    const { words, unknown } = result;
    const everything = whole && !words.length && !describe(selection);
    const hits = everything
      ? [...apps]
          .sort(
            (a, b) =>
              Number(Boolean(b.project)) - Number(Boolean(a.project)) ||
              a.title.localeCompare(b.title),
          )
          .map((app) => ({ app, score: 0, words: [] as string[] }))
      : result.hits;
    if (!hits.length)
      return askTopic(
        [intro, words.length || unknown.length ? "No tool in the library matches that." : ""]
          .filter(Boolean)
          .join(" "),
      );
    if (words.length)
      note(
        "search",
        `Ranked the library against ${quoted(words)}.`,
        `A word counts most in a title, then in the type or topic, then in the description; rare words count more. ${count(hits.length)} score at least 40% of the best.${unknown.length ? ` Not found anywhere: ${quoted(unknown)}.` : ""}`,
      );
    const listed = hits.slice(0, shown);
    // Types that would narrow the list, as the page's chips do; none once a type is set.
    const narrowing: Option[] = selection.type?.length
      ? [{ id: "type:any", label: "Any type" }]
      : appFacetOptions("type")
          // Counted by running the search with the type set, so the number is what follows.
          .map((option) => ({
            ...option,
            n: searchApps(query, { ...selection, type: [option.label] }).hits.length,
          }))
          .filter(({ n }) => n > 0 && n < hits.length)
          .sort((a, b) => b.n - a.n)
          .slice(0, 3)
          .map(({ id, label, n }) => ({ id, label: `Only ${label}`, detail: count(n) }));
    const options: Option[] =
      hits.length > 1 || selection.type?.length
        ? [
            ...narrowing,
            { id: "topics", label: selection.topic?.length ? "Change topic" : "Browse by topic" },
          ]
        : [{ id: "topics", label: "Browse by topic" }];
    const filter = describe(selection);
    const reply = ask(
      "apps",
      [
        intro,
        words.length
          ? `${count(hits.length)} in the Application Library ${hits.length === 1 ? "matches" : "match"} ${quoted(words)}${filter ? `, ${filter}` : ""}.`
          : everything
            ? `All ${count(hits.length)} in the Application Library.`
            : `${count(hits.length)} in the Application Library: ${filter}.`,
        widened,
        hits.length > shown ? `The ${words.length ? "closest" : "first"} ${shown} are listed.` : "",
        "Each opens its library page. Describe what you need differently, or name a tool.",
      ]
        .filter(Boolean)
        .join(" "),
      options,
      { featured: options.length },
    );
    return {
      ...reply,
      kind: "apps",
      apps: listed.map((hit) => appCard(hit.app, selection, hit.words)),
      // Titles as plain facts too, for clients that do not draw tool cards.
      facts: listed.map((hit) =>
        [hit.app.title, hit.app.type.slice(0, 2).join(", ")].filter(Boolean).join(" — "),
      ),
      selection: appFacetKeys
        .filter((key) => selection[key]?.length)
        .map((key) => ({
          key,
          label: appFacetNames[key],
          values: selection[key]!.map((value) => ({ id: value, label: value })),
        })),
      source,
      ...browse(
        libraryQuery(
          selection,
          words,
          listed.map((hit) => hit.app),
        ),
      ),
    };
  }

  /**
   * A new tool search. Returns nothing when the message gives nothing to search by and
   * `otherwise` is "pass", so the caller can treat it as some other request.
   */
  async function start(request: string, otherwise: "ask" | "pass" = "ask") {
    const found = named(request);
    if (found.length === 1) {
      conversation.draft = undefined;
      conversation.brief = undefined;
      return one(found[0]);
    }
    const before = conversation.finder;
    conversation.finder = { query: request, selection: {} };
    const typed = readTypes(request);
    const { words } = searchApps(request);
    let inferred = "";
    if (!typed && !words.length && !found.length) {
      if (otherwise === "pass") {
        conversation.finder = before;
        return undefined;
      }
      // Nothing to search by: the classifier may still read a topic from the wording.
      const picks = await decide(
        {
          "app-topic": {
            subject: "topic",
            question:
              "Which topic is the user looking for a tool on? Choose none if the message names no listed topic.",
            options: appFacetOptions("topic"),
          },
        },
        request,
      );
      const topic = picks["app-topic"]?.choice?.replace(/^topic:/, "");
      // Inferred, not named: said to the user so a wrong guess is easy to correct.
      if (topic) {
        finder().selection.topic = [topic];
        inferred = `I took the topic to be ${topic}; change it if that is wrong.`;
      } else {
        conversation.draft = undefined;
        conversation.brief = undefined;
        const { unknown } = searchApps(request);
        return askTopic(
          unknown.length
            ? `No tool in the library mentions ${quoted(unknown)}.`
            : "I can find a tool for you.",
        );
      }
    }
    conversation.draft = undefined;
    conversation.brief = undefined;
    return found.length > 1 ? several(found) : show(inferred);
  }

  /** A clicked option: a type or topic, or one of the changes offered under a list. */
  async function choose(option: string): Promise<Reply> {
    conversation.finder ??= { query: "", selection: {} };
    const { selection } = finder();
    if (option === "topics") return askTopic();
    for (const key of appFacetKeys) {
      if (!option.startsWith(`${key}:`)) continue;
      const value = option.slice(key.length + 1);
      if (value === "any") delete selection[key];
      else selection[key] = [value];
      // A topic chosen from the list replaces a description that found nothing.
      if (key === "topic" && !searchApps(finder().query, selection).hits.length)
        finder().query = "";
      return show("", true);
    }
    throw new Error("Choose one of the current options.");
  }

  /**
   * Free text while a tool question or list is open. Returns nothing when the message is not
   * about the tool search, so it is handled as a new request.
   */
  async function typed(text: string): Promise<Reply | undefined> {
    const found = named(text);
    if (found.length === 1) return one(found[0]);
    // Numbers and data wording start a new request instead of a change to the search.
    if (requestedYears(text).length || asksForData.test(text)) return undefined;
    conversation.finder ??= { query: "", selection: {} };
    const changed = readTypes(text);
    const { words } = searchApps(text);
    const short = text.trim().split(/\s+/).length <= 4 && !startsAnew.test(text);
    if (words.length && (continues.test(text) || short || toolNoun.test(text))) {
      note(
        "change",
        "The message describes what to look for instead.",
        "It continues the tool search: a follow-up phrase, a few words, or a word for tools.",
      );
      finder().query = text;
      return show();
    }
    return changed ? show() : undefined;
  }

  return { wanted, start, choose, typed };
}
