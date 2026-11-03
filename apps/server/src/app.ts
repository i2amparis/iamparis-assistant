import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { config } from "./config.ts";
import type { openStore } from "./db/store.ts";
import type { Choose } from "./jev/client.ts";
import { classifierStatus } from "./jev/provider.ts";
import type { Conversation } from "./shared/types.ts";
import type { Results } from "./tools/results.ts";
import { handleTurn } from "./turn/turn.ts";

const values = z.array(z.string().max(300)).max(100).optional();
const contextSchema = z
  .object({
    path: z.string().startsWith("/").max(500),
    title: z.string().max(200).optional(),
    chart: z
      .object({
        study: z.string().max(100).optional(),
        workspace: z.string().max(100).optional(),
        filters: z
          .object({
            variable: values,
            region: values,
            modelName: values,
            scenario: values,
            unit: values,
          })
          .default({}),
        years: z.tuple([z.number().int(), z.number().int()]).optional(),
        visualizationType: z.string().max(40).optional(),
        groupByField: z.string().max(40).optional(),
        title: z.string().max(200).optional(),
      })
      .optional(),
  })
  .optional();
const turnSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(4000), context: contextSchema }).strict(),
  z
    .object({ token: z.uuid(), option: z.string().min(1).max(2000), context: contextSchema })
    .strict(),
]);
const sessionSchema = z.uuid();
export const sessionHeader = "x-iamparis-session";

/**
 * Create the API. Browsers may call it only from configured origins; every conversation belongs to
 * the opaque session id the calling web app sends, and turns on one chat never run concurrently.
 */
export function createApp(
  store: ReturnType<typeof openStore>,
  results: Results,
  classify?: Choose,
) {
  const app = new Hono<{ Variables: { session: string } }>();
  const busy = new Set<string>();
  const originAllowed = (origin: string, self: string) =>
    origin === self || config.origins.has(origin);
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const origin = c.req.header("origin");
    if (!config.hosts.has(url.hostname) || (origin && !originAllowed(origin, url.origin)))
      return c.json({ error: "This origin is not allowed to use the assistant." }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (config.origins.has(origin) ? origin : null),
      allowHeaders: ["Content-Type", "X-IAMPARIS-Session"],
      allowMethods: ["GET", "POST"],
      maxAge: 600,
    }),
  );
  app.use(
    "/api/*",
    bodyLimit({ maxSize: 32000, onError: (c) => c.json({ error: "Message is too large." }, 413) }),
  );
  app.use("/api/conversations/*", async (c, next) => {
    const session = sessionSchema.safeParse(c.req.header(sessionHeader));
    if (!session.success) return c.json({ error: "Missing assistant session." }, 401);
    c.set("session", session.data);
    await next();
  });
  /** Conversations from other sessions are reported as missing, never as forbidden. */
  function owned(id: string, session: string) {
    const conversation = store.get(id);
    return conversation?.session === session ? conversation : undefined;
  }
  app.get("/api/status", async (c) =>
    c.json({
      ...(await classifierStatus()),
      results: "live",
      mode: "local",
    }),
  );
  app.get("/api/conversations", (c) => c.json(store.list(c.get("session"))));
  app.post("/api/conversations", (c) => {
    const conversation: Conversation = {
      id: randomUUID(),
      session: c.get("session"),
      title: "New conversation",
      messages: [],
    };
    store.save(conversation);
    return c.json(conversation, 201);
  });
  app.get("/api/conversations/:id", (c) => {
    const conversation = owned(c.req.param("id"), c.get("session"));
    return conversation ? c.json(conversation) : c.json({ error: "Conversation not found." }, 404);
  });
  app.post("/api/conversations/:id/turn", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Send a JSON message." }, 415);
    const parsed = turnSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Enter a message of up to 4,000 characters or choose a current option." },
        400,
      );
    const id = c.req.param("id");
    if (busy.has(id))
      return c.json({ error: "This conversation is already processing a turn." }, 409);
    if (busy.size >= 8) return c.json({ error: "The assistant is busy. Try again shortly." }, 429);
    const conversation = owned(id, c.get("session"));
    if (!conversation) return c.json({ error: "Conversation not found." }, 404);
    if (conversation.messages.length >= 200)
      return c.json({ error: "Start a new conversation to continue." }, 400);
    busy.add(id);
    try {
      const input = parsed.data;
      const text =
        "text" in input
          ? input.text
          : (conversation.pending?.options.find((o) => o.id === input.option)?.label ??
            "Expired choice");
      if (!conversation.messages.length) conversation.title = text.slice(0, 70);
      const reply = await handleTurn(conversation, input, results, classify);
      conversation.messages.push(
        { id: randomUUID(), role: "user", text },
        { id: randomUUID(), role: "assistant", text: reply.text, reply },
      );
      store.save(conversation);
      return c.json(conversation);
    } finally {
      busy.delete(id);
    }
  });
  app.onError((_error, c) =>
    c.json({ error: "The request could not be completed. Please retry." }, 500),
  );
  return app;
}
