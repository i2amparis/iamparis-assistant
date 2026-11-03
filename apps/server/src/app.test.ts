import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openStore } from "./db/store.ts";
import type { Conversation } from "./shared/types.ts";
const stores: ReturnType<typeof openStore>[] = [];
const session = "6f0c1d8e-2a41-4c1b-9a51-0d6c3f6e2b10";
const json = { "Content-Type": "application/json", "X-IAMPARIS-Session": session };
function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  return createApp(store, { distinct: async () => [], rows: async () => [] }, async (questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        { question: q.question, options: q.options, probabilities: {}, ms: 0, source: "jev" },
      ]),
    ),
  );
}
async function create(app: ReturnType<typeof setup>, id = session) {
  const response = await app.request("http://localhost/api/conversations", {
    method: "POST",
    headers: { "X-IAMPARIS-Session": id },
  });
  return (await response.json()) as Conversation;
}
afterEach(() => stores.splice(0).forEach((s) => s.close()));
describe("API boundary", () => {
  it("blocks external hosts and origins", async () => {
    const app = setup();
    expect((await app.request("http://evil.example/api/status")).status).toBe(403);
    expect(
      (
        await app.request("http://localhost/api/status", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("answers CORS preflight for the web app origin", async () => {
    const response = await setup().request("http://localhost/api/conversations", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-iamparis-session",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
  it("requires a session and hides other sessions' conversations", async () => {
    const app = setup();
    expect((await app.request("http://localhost/api/conversations")).status).toBe(401);
    const c = await create(app);
    const other = "0b8f8f1e-79d4-4d6f-8c1f-4f0f5d2f9c11";
    const foreign = await app.request(`http://localhost/api/conversations/${c.id}`, {
      headers: { "X-IAMPARIS-Session": other },
    });
    expect(foreign.status).toBe(404);
    const listed = await app.request("http://localhost/api/conversations", {
      headers: { "X-IAMPARIS-Session": other },
    });
    expect(await listed.json()).toEqual([]);
  });
  it("validates bodies and saves conversation state", async () => {
    const app = setup();
    const c = await create(app);
    const route = `http://localhost/api/conversations/${c.id}/turn`;
    expect(
      (await app.request(route, { method: "POST", headers: json, body: '{"text":""}' })).status,
    ).toBe(400);
    const response = await app.request(route, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "Help me analyse emissions", context: { path: "/analysis" } }),
    });
    expect(response.status).toBe(200);
    const saved = (await (
      await app.request(`http://localhost/api/conversations/${c.id}`, { headers: json })
    ).json()) as Conversation;
    expect(saved.messages).toHaveLength(2);
    expect(saved.pending?.kind).toBe("review");
  });
  it("rejects malformed page context", async () => {
    const app = setup();
    const c = await create(app);
    const response = await app.request(`http://localhost/api/conversations/${c.id}/turn`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "hi", context: { path: "https://evil.example" } }),
    });
    expect(response.status).toBe(400);
  });
  it("rejects oversized input", async () => {
    const response = await setup().request("http://localhost/api/conversations/test/turn", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "a".repeat(33000) }),
    });
    expect(response.status).toBe(413);
  });
});
