import { describe, expect, it } from "vitest";
import { handleTurn } from "./turn.ts";
import type { Choose } from "../jev/client.ts";
import type { Conversation, Reply } from "../shared/types.ts";
import type { Results } from "../tools/results.ts";
import {
  appFacetOptions,
  apps,
  libraryQuery,
  matchesApp,
  namedApps,
  namedAppTypes,
  searchApps,
} from "../tools/apps.ts";

/** The tool search never touches the results service; a data request finds it empty. */
const api: Results = {
  async distinct() {
    return [];
  },
  async rows() {
    return [];
  },
};
/** No classifier configured: every question comes back with an error. */
const manual: Choose = async (questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([key, q]) => [
      key,
      {
        question: q.question,
        options: q.options,
        probabilities: {},
        ms: 0,
        source: "jev",
        error: "not configured",
      },
    ]),
  );
const conversation = (): Conversation => ({ id: "test", title: "Test", messages: [] });
const say = (c: Conversation, text: string) => handleTurn(c, { text }, api, manual);
const click = (c: Conversation, reply: Reply, option: string) =>
  handleTurn(c, { token: reply.token!, option }, api, manual);
const titles = (reply: Reply) => reply.apps?.map((app) => app.title) ?? [];
const named = (text: string) => namedApps(text).map((found) => found.app.title);

describe("application catalogue", () => {
  it("gives every tool its own library page and a link to the tool", () => {
    expect(apps.length).toBeGreaterThan(100);
    for (const app of apps) {
      expect(app.path).toBe(`/application_library/${app.id}`);
      if (app.link) expect(app.link).toMatch(/^https?:\/\//);
    }
  });
  it("finds a tool by its title, its abbreviation or the name before a dash", () => {
    expect(named("open Climate Watch application")).toEqual(["Climate Watch"]);
    expect(named("find edgar in the application library")).toEqual([
      "EDGAR (Emissions Database for Global Atmospheric Research)",
    ]);
    expect(named("is pyam listed?")).toEqual(["pyam – Analysis and Visualization"]);
    // The longer name wins over the one it contains.
    expect(named("METEOR Explorer")).toEqual(["METEOR Explorer"]);
  });
  it("reads everyday words as a name only when written as the library writes them", () => {
    expect(named("show electricity power for all regions")).toEqual([]);
    expect(named("how will demand rise in the EU")).toEqual([]);
    expect(named("the NASA POWER project")).toHaveLength(1);
    expect(named("CO2 emissions in the EU in 2050")).toEqual([]);
  });
  it("names a type by a label of several words or a curated phrase, not an everyday word", () => {
    expect(namedAppTypes("interactive maps about forests").map((t) => t.id)).toEqual([
      "Interactive Maps",
    ]);
    expect(namedAppTypes("a game about the power grid").map((t) => t.id)).toEqual(["Game"]);
    expect(namedAppTypes("tools for scenario analysis in a report")).toEqual([]);
  });
  it("ORs values within a facet and ANDs facets, with counts that match", () => {
    const maps = apps.filter((app) => matchesApp(app, { type: ["Interactive Maps"] }));
    const either = apps.filter((app) =>
      matchesApp(app, { type: ["Interactive Maps", "Raw Data"] }),
    );
    expect(either.length).toBeGreaterThan(maps.length);
    const selection = { type: ["Interactive Maps"], topic: ["Finance"] };
    for (const app of apps.filter((a) => matchesApp(a, selection))) {
      expect(app.type).toContain("Interactive Maps");
      expect(app.topic).toContain("Finance");
    }
    for (const option of appFacetOptions("topic", { type: ["Interactive Maps"] }))
      expect(option.detail).toBe(
        `${apps.filter((a) => matchesApp(a, { type: ["Interactive Maps"], topic: [option.label] })).length} tools`.replace(
          /^1 tools$/,
          "1 tool",
        ),
      );
  });
  it("ranks tools against a description and drops the words that only ask", () => {
    const result = searchApps("Is there a tool to explore countries' NDCs?");
    expect(result.words).toEqual(["explore", "country", "ndc"]);
    expect(result.hits[0].app.title).toBe("NDC Explorer");
    // A tool about both words outranks one with a single word in its title.
    const water = searchApps("tool for water risk").hits.map((hit) => hit.app.title);
    expect(water.indexOf("Aqueduct")).toBeGreaterThanOrEqual(0);
    expect(water.indexOf("Aqueduct")).toBeLessThan(water.indexOf("Global Surface Water Explorer"));
    expect(searchApps("is there an app for that").hits).toEqual([]);
    expect(searchApps("tool for xylophones")).toMatchObject({ hits: [], unknown: ["xylophone"] });
  });
  it("builds a library URL the page's own search and chips reproduce", () => {
    const maps = { type: ["Interactive Maps"] };
    const result = searchApps("interactive maps about forests", maps);
    const listed = result.hits.slice(0, 6).map((hit) => hit.app);
    expect(libraryQuery(maps, result.words, listed)).toBe("?q=forest&type=Interactive+Maps");
    // Words that only repeat the chosen type are not searched for.
    expect(libraryQuery(maps, ["interactive", "map"], listed)).toBe("?type=Interactive+Maps");
    expect(libraryQuery({}, [], listed)).toBe("");
  });
});

describe("tool search", () => {
  it("answers a named tool with its library page", async () => {
    const c = conversation();
    const reply = await say(c, "where can I find Aqueduct?");
    expect(reply.kind).toBe("apps");
    expect(titles(reply)).toEqual(["Aqueduct"]);
    expect(reply.apps![0].link).toMatch(/^https:\/\//);
    expect(reply.actions).toEqual([
      { type: "navigate", label: "Open its library page", path: reply.apps![0].path },
    ]);
    expect(reply.options).toBeUndefined();
    expect(c.pending).toBeUndefined();
    expect(reply.trace.map((d) => d.subject)).toEqual(["task", "tool"]);
  });
  it("lists the closest tools for a description and narrows by type", async () => {
    const c = conversation();
    const first = await say(c, "Is there a tool to explore countries' NDCs?");
    expect(first.kind).toBe("apps");
    expect(titles(first)[0]).toBe("NDC Explorer");
    expect(first.text).toContain("“ndc”");
    expect(first.facts).toHaveLength(first.apps!.length);
    expect(first.actions?.[0]).toMatchObject({
      type: "navigate",
      path: "/application_library?q=ndc",
    });
    const narrow = first.options!.find((o) => o.id.startsWith("type:"))!;
    const second = await click(c, first, narrow.id);
    expect(second.kind).toBe("apps");
    expect(second.selection).toEqual([
      {
        key: "type",
        label: "type",
        values: [{ id: narrow.id.slice(5), label: narrow.id.slice(5) }],
      },
    ]);
    // The count on the button is the count that follows.
    expect(second.text.startsWith(narrow.detail!)).toBe(true);
    expect(second.options!.map((o) => o.id)).toContain("type:any");
  });
  it("reads a follow-up as a change to the search, and data wording as a new request", async () => {
    const c = conversation();
    await say(c, "are there apps with interactive maps for water?");
    expect(c.finder?.selection.type).toEqual(["Interactive Maps"]);
    const forests = await say(c, "what about forests?");
    expect(forests.kind).toBe("apps");
    expect(titles(forests)).toContain("Global Forest Watch (GFW)");
    // The type set earlier is kept.
    for (const app of forests.apps!)
      expect(app.chips.some((chip) => chip.label === "Interactive Maps")).toBe(true);
    const data = await say(c, "CO2 emissions in the EU in 2050");
    expect(data.kind).not.toBe("apps");
    expect(c.finder).toBeUndefined();
  });
  it("widens the type rather than returning nothing", async () => {
    const reply = await say(conversation(), "is there a game about python packages?");
    expect(reply.kind).toBe("apps");
    expect(reply.text).toContain("every type is included");
    expect(reply.selection).toEqual([]);
  });
  it("offers the topics when there is nothing to search by", async () => {
    const c = conversation();
    const menu = await say(c, "hello");
    expect(menu.options!.map((o) => o.label)).toContain("Find a tool");
    const topics = await click(c, menu, "apps");
    expect(topics.kind).toBe("ask");
    expect(topics.actions?.[0]).toMatchObject({ path: "/application_library" });
    const finance = await click(c, topics, "topic:Finance");
    expect(finance.kind).toBe("apps");
    expect(finance.text).toContain("topic Finance");
    for (const app of finance.apps!)
      expect(app.chips.some((chip) => chip.label === "Finance" && chip.matched)).toBe(true);
    const all = await click(c, finance, "topics").then((r) => click(c, r, "topic:any"));
    expect(all.text).toContain(`All ${apps.length} tools`);
  });
  it("leaves this site's own pages and the study search alone", async () => {
    const page = await say(conversation(), "where is the scenario metadata tool?");
    expect(page.kind).toBe("navigation");
    expect(page.title).toBe("Scenario Metadata Tool");
    // The library named with nothing to search it for is the page itself.
    for (const text of ["where can I find the application library?", "open application library"]) {
      const library = await say(conversation(), text);
      expect(library.kind).toBe("navigation");
      expect(library.actions?.[0]).toMatchObject({ path: "/application_library" });
    }
    // GraphMaker is this site's chart builder, named by a curated phrase: its page.
    const graphmaker = await say(conversation(), "where is the GraphMaker tool?");
    expect(graphmaker.kind).toBe("navigation");
    expect(graphmaker.actions?.[0]).toMatchObject({ path: "/analysis" });
    // A "tool" the library does not have is not answered with a list of other tools.
    const missing = await say(conversation(), "where is the Frobnicator tool?");
    expect(missing.kind).toBe("ask");
    expect(missing.text).toContain("No tool in the library mentions “frobnicator”");
    const c = conversation();
    const studies = await say(
      c,
      "I work on industry policy at the German economics ministry. Which studies matter to me?",
    );
    expect(studies.kind).not.toBe("apps");
    expect(c.brief).toBeDefined();
    // Asking for studies and tools together stays a study search.
    const both = await say(conversation(), "Which studies and tools are relevant for me?");
    expect(both.kind).not.toBe("apps");
    expect(both.trace.some((d) => d.choice === "studies")).toBe(true);
    // A request for a tool is not an answer to the study search.
    const tool = await say(c, "is there a tool for forests?");
    expect(tool.kind).toBe("apps");
  });
});
