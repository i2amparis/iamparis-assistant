import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { openStore } from "./db/store.ts";
import { liveResults } from "./tools/results.ts";
const store = openStore(process.env.DATABASE_PATH || "../../data/conversations.db");
const app = createApp(store, liveResults());
app.use("/*", serveStatic({ root: "../web/dist" }));
const server = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 8788),
});
console.log("IAMPARIS Chat: http://127.0.0.1:" + (process.env.PORT || 8788));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
