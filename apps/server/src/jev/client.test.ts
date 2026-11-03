import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@typesafe-ai/sdk", () => ({
  TypeSafeClient: class {
    systemOne = mock.call;
  },
}));
import { choose } from "./client.ts";
const pick = { question: "Pick", options: [{ id: "safe", label: "Safe" }] };
function respond(answers: Record<string, unknown>) {
  mock.call.mockReturnValue({
    withResponse: async () => ({
      data: { model: "jev-test", answers },
      response: new Response(null),
    }),
  });
}
beforeEach(() => vi.stubEnv("IAM_CLASSIFIER_PROVIDER", "typesafe"));
afterEach(() => {
  vi.unstubAllEnvs();
  mock.call.mockReset();
});
it("does not contact Jev without a key", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  expect((await choose({ pick }, "message")).pick.choice).toBeUndefined();
  expect(mock.call).not.toHaveBeenCalled();
});
it.each([
  ["o0", { o0: 0.9, none: 0.1 }, "safe"],
  ["o0", { o0: 0.6, none: 0.4 }, undefined],
  ["o0", { o0: 0.75, none: 0.7 }, undefined],
  ["invented", { invented: 1 }, undefined],
  ["none", { none: 0.99, o0: 0.01 }, undefined],
  ["o0", { o0: Infinity }, undefined],
])(
  "accepts only a confident, separated supplied choice (%s)",
  async (choice, probabilities, expected) => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only");
    respond({ pick: { choice, probabilities } });
    expect((await choose({ pick }, "message")).pick.choice).toBe(expected);
  },
);
it("answers several questions with one request", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-only");
  respond({
    first: { choice: "o0", probabilities: { o0: 0.95, none: 0.05 } },
    second: { choice: "none", probabilities: { o0: 0.1, none: 0.9 } },
  });
  const result = await choose({ first: pick, second: pick }, "message");
  expect(mock.call).toHaveBeenCalledTimes(1);
  expect(result.first.choice).toBe("safe");
  expect(result.second.choice).toBeUndefined();
  expect(result.second.noneProbability).toBe(0.9);
});
it("fails into manual choices without leaking upstream errors", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-only");
  mock.call.mockImplementation(() => {
    throw new Error("private upstream details");
  });
  const result = await choose({ pick }, "message");
  expect(result.pick.error).toContain("unavailable");
  expect(result.pick.error).not.toContain("private");
});
describe("Ollama provider", () => {
  /** Ollama's next-token probabilities, as letter → probability. */
  function ollama(...answers: Record<string, number>[]) {
    const fetch = vi.fn();
    for (const answer of answers)
      fetch.mockResolvedValueOnce(
        Response.json({
          model: "qwen3:4b",
          logprobs: [
            {
              top_logprobs: Object.entries(answer).map(([token, p]) => ({
                token,
                logprob: Math.log(p),
              })),
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  beforeEach(() => vi.stubEnv("IAM_CLASSIFIER_PROVIDER", "ollama"));
  afterEach(() => vi.unstubAllGlobals());
  it("reads a confident letter as the choice, from a pre-filled answer prompt", async () => {
    const fetch = ollama({ A: 0.9, Z: 0.05, First: 0.05 });
    const result = await choose({ pick }, "message");
    expect(result.pick).toMatchObject({ choice: "safe", source: "ollama", model: "qwen3:4b" });
    expect(result.pick.probabilities.safe).toBeCloseTo(0.947, 2);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({ raw: true, logprobs: true, options: { num_predict: 1 } });
    expect(body.prompt).toMatch(/A: Safe\nZ: None fits.*Answer:$/s);
  });
  it("applies the confidence policy and maps Z to none", async () => {
    const two = { question: "Pick", options: [...pick.options, { id: "other", label: "Other" }] };
    ollama({ A: 0.5, B: 0.45, Z: 0.05 }, { Z: 0.9, A: 0.1 });
    const result = await choose({ split: two, absent: pick }, "message");
    expect(result.split.choice).toBeUndefined();
    expect(result.split.probabilities).toMatchObject({ safe: 0.5, other: 0.45 });
    expect(result.absent.noneProbability).toBeCloseTo(0.9);
  });
  it("ignores letters beyond the offered options and reports a non-answer", async () => {
    ollama({ First: 0.9, C: 0.1 });
    const result = await choose({ pick }, "message");
    expect(result.pick.choice).toBeUndefined();
    expect(result.pick.error).toContain("did not answer");
  });
});
