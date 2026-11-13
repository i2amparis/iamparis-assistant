import { describe, expect, it } from "vitest";
import { handleTurn } from "./turn.ts";
import type { Choose } from "../jev/client.ts";
import type { Conversation, Reply } from "../shared/types.ts";
import type { Results } from "../tools/results.ts";
import {
  facetCounts,
  facetOptions,
  filterStudies,
  namedFacets,
  selectionQuery,
  studies,
} from "../tools/studies.ts";

/** The study search never touches the results service; a data request finds it empty. */
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
/** A classifier that answers the named questions and says "not mentioned" for the rest. */
const classifier =
  (answers: Record<string, string>): Choose =>
  async (questions) =>
    Object.fromEntries(
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
const conversation = (): Conversation => ({ id: "test", title: "Test", messages: [] });
const say = (c: Conversation, text: string, classify: Choose = manual) =>
  handleTurn(c, { text }, api, classify);
const click = (c: Conversation, reply: Reply, option: string) =>
  handleTurn(c, { token: reply.token!, option }, api, manual);

describe("study filter", () => {
  it("ORs values within a facet and ANDs facets, like the Results page", () => {
    const industry = filterStudies({ sector: ["industry"] });
    const transport = filterStudies({ sector: ["transport"] });
    const either = filterStudies({ sector: ["industry", "transport"] });
    expect(either).toHaveLength(new Set([...industry, ...transport]).size);
    const german = filterStudies({ sector: ["industry"], region: ["germany"] });
    expect(german.length).toBeGreaterThan(0);
    for (const study of german) {
      expect(study.sector).toContain("industry");
      expect(study.region).toContain("germany");
    }
    expect(filterStudies({})).toHaveLength(studies.length);
  });
  it("counts each option against the other facets, not its own", () => {
    const selection = { sector: ["industry"], region: ["germany"] };
    // Picking Germany must not zero out the other regions that have industry studies.
    for (const option of facetCounts("region", selection))
      expect(option.count).toBe(
        filterStudies({ sector: ["industry"], region: [option.id] }).length,
      );
    expect(facetCounts("region", selection).length).toBeGreaterThan(1);
    expect(
      facetOptions("sector", selection).every((o) => /^\d+ stud(y|ies)$/.test(o.detail!)),
    ).toBe(true);
  });
  it("names facet values by label or curated phrase, several at once", () => {
    expect(namedFacets("region", "the German and Polish governments").map((n) => n.id)).toEqual([
      "germany",
      "poland",
    ]);
    expect(namedFacets("sector", "I work for a steelmaker").map((n) => n.id)).toEqual(["industry"]);
    expect(namedFacets("region", "Europe").map((n) => n.id)).toEqual(["eu"]);
    expect(namedFacets("sector", "hello there")).toEqual([]);
  });
  it("writes the selection as the Results page's URL query", () => {
    expect(selectionQuery({ sector: ["industry"], region: ["germany", "eu"] })).toBe(
      "?sector=industry&region=germany,eu",
    );
    expect(selectionQuery({})).toBe("");
  });
});

describe("picking studies for someone", () => {
  it("reads sector and region from a described background and lists the studies", async () => {
    const c = conversation();
    const reply = await say(
      c,
      "I work on industry policy at the German economics ministry. Which studies matter to me?",
    );
    expect(reply.kind).toBe("studies");
    expect(c.brief?.selection).toMatchObject({ sector: ["industry"], region: ["germany"] });
    expect(reply.studies!.length).toBe(
      filterStudies({ sector: ["industry"], region: ["germany"] }).length,
    );
    expect(reply.actions?.[0]).toEqual({
      type: "navigate",
      label: "Open these in Results",
      path: "/results?sector=industry&region=germany",
    });
    expect(reply.text).toContain("sector Industry");
    // Not the page of a study whose title happens to share the words.
    expect(reply.trace[0]).toMatchObject({ source: "policy", subject: "task", choice: "studies" });
    expect(reply.trace.find((d) => d.subject === "region")).toMatchObject({
      source: "match",
      outcome: "accepted",
      choice: "germany",
    });
  });
  it("asks for the sector, then the region, when nothing is known", async () => {
    const c = conversation();
    const first = await say(c, "I'm a policy maker, which studies are relevant for me?");
    expect(first.kind).toBe("ask");
    expect(c.pending).toMatchObject({ kind: "studies", facet: "sector" });
    expect(first.options!.at(-1)).toMatchObject({ id: "any", label: "Any sector" });
    // The sector with the most studies leaves too many to list: the region is asked next.
    const widest = first
      .options!.filter((o) => o.id !== "any")
      .sort((a, b) => Number.parseInt(b.detail!, 10) - Number.parseInt(a.detail!, 10))[0];
    const second = await click(c, first, widest.id);
    expect(second.kind).toBe("ask");
    expect(c.pending).toMatchObject({ kind: "studies", facet: "region" });
    expect(second.text).toContain(`sector ${widest.label}`);
    // A typed answer works like a click.
    const third = await say(c, "the EU");
    expect(c.brief?.selection.region).toEqual(["eu"]);
    expect(["ask", "studies"]).toContain(third.kind);
  });
  it("shows few studies without asking further", async () => {
    const c = conversation();
    const reply = await say(c, "I work at the transport ministry");
    expect(reply.kind).toBe("studies");
    expect(c.brief?.selection.sector).toEqual(["transport"]);
    expect(reply.trace.some((d) => d.subject === "follow-up" && d.source === "policy")).toBe(true);
  });
  it("takes an implied sector from the classifier and says it was inferred", async () => {
    const c = conversation();
    const reply = await say(
      c,
      "I run a logistics company with a large truck fleet, which studies should I read?",
      classifier({ "study-sector": "transport" }),
    );
    expect(c.brief?.selection.sector).toEqual(["transport"]);
    expect(c.brief?.evidence.sector).toBe("inferred");
    expect(reply.text).toContain("I took your sector to be Transport");
  });
  it("never infers “economy-wide” from a message that names no sector", async () => {
    const c = conversation();
    const asked: string[] = [];
    const reply = await say(c, "I am a journalist", async (questions, state) => {
      asked.push(...(questions["study-sector"]?.options.map((o) => o.id) ?? []));
      return classifier({})(questions, state);
    });
    expect(asked).not.toContain("economy-wide");
    expect(reply.kind).toBe("ask");
  });
  it("widens the region rather than return nothing, and says so", async () => {
    const c = conversation();
    expect(filterStudies({ sector: ["buildings"], region: ["greece"] })).toHaveLength(0);
    const reply = await say(c, "I work on buildings policy for the Greek government");
    expect(reply.kind).toBe("studies");
    expect(reply.studies!.length).toBeGreaterThan(0);
    expect(c.brief?.selection.region).toEqual(["greece", "eu"]);
    expect(reply.text).toContain("EU-wide studies are included");
    expect(reply.trace.some((d) => d.subject === "widening")).toBe(true);
  });
  it("applies typed changes and the offered ones to the list", async () => {
    const c = conversation();
    const first = await say(c, "I work on industry policy at the German economics ministry");
    const poland = await say(c, "what about Poland?");
    expect(poland.kind).toBe("studies");
    expect(c.brief?.selection).toMatchObject({ sector: ["industry"], region: ["poland"] });
    const wider = await click(c, poland, "add:eu");
    expect(c.brief?.selection.region).toEqual(["poland", "eu"]);
    expect(wider.studies!.length).toBeGreaterThan(poland.studies!.length);
    const any = await say(c, "any region");
    expect(c.brief?.selection.region).toBeUndefined();
    expect(any.studies!.length).toBe(Math.min(8, filterStudies({ sector: ["industry"] }).length));
    expect(first.token).not.toBe(any.token);
  });
  it("leaves the study search for a data request", async () => {
    const c = conversation();
    await say(c, "I work on industry policy at the German economics ministry");
    const reply = await say(c, "How much CO2 does Germany emit in 2050?");
    expect(reply.kind).toBe("review");
    expect(c.brief).toBeUndefined();
    expect(c.draft?.filters.workspace_code).toBeDefined();
  });
  it("records the state each turn leaves for the inspector", async () => {
    const c = conversation();
    const reply = await say(c, "I'm a policy maker, which studies are relevant for me?");
    expect(reply.state).toMatchObject({
      brief: { selection: {}, settled: [] },
      pending: { kind: "studies", facet: "sector" },
    });
    expect(typeof reply.ms).toBe("number");
  });
});
