// Pass-through proxy in front of Ollama that records every /api/generate request the assistant
// makes (prompt and options) and the reply's first-token distribution, one JSON object per line.
//   node capture-proxy.mjs <out.jsonl> [listen=11435] [upstream=http://127.0.0.1:11434]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [out, listen = "11435", upstream = "http://127.0.0.1:11434"] = process.argv.slice(2);
if (!out) throw new Error("usage: capture-proxy.mjs <out.jsonl> [port] [upstream]");

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const response = await fetch(upstream + req.url, {
    method: req.method,
    headers: { "Content-Type": req.headers["content-type"] ?? "application/json" },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const text = await response.text();
  if (req.url === "/api/generate" && response.ok) {
    const request = JSON.parse(body.toString());
    const reply = JSON.parse(text);
    appendFileSync(
      out,
      JSON.stringify({
        prompt: request.prompt,
        options: request.options,
        top: reply.logprobs?.[0]?.top_logprobs?.map((t) => [t.token, t.logprob]),
        prompt_eval_count: reply.prompt_eval_count,
      }) + "\n",
    );
  }
  res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "" });
  res.end(text);
}).listen(Number(listen), "127.0.0.1", () => console.log(`capture proxy on ${listen} -> ${upstream}`));
