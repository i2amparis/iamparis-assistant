import { handleTurn } from "../apps/server/src/turn/turn.ts";
import { liveResults } from "../apps/server/src/tools/results.ts";
import type { Conversation } from "../apps/server/src/shared/types.ts";
import type { Choose } from "../apps/server/src/jev/client.ts";
const conversation: Conversation = { id: "smoke", title: "Live smoke", messages: [] };
const manual: Choose = async (question, options) => ({
  question,
  options,
  probabilities: {},
  ms: 0,
  source: "jev",
});
const api = liveResults();
await handleTurn(conversation, { text: "CO2 emissions for the EU in 2050" }, api, manual);
for (const option of [
  "analysis",
  "eu-headed",
  "Emissions|CO2",
  "EU",
  "GCAM-PR 5.3",
  "PR_WWH_CP",
  "run",
]) {
  if (!conversation.pending?.options.some((o) => o.id === option))
    throw new Error(`Expected live option missing: ${option}`);
  const reply = await handleTurn(
    conversation,
    { token: conversation.pending.token, option },
    api,
    manual,
  );
  if (reply.kind === "error") throw new Error(reply.text);
  if (option === "run") {
    if (!reply.plan?.rows.length || !reply.plan.years.includes("2050"))
      throw new Error("No validated result");
    console.log(
      JSON.stringify(
        {
          checkedAt: reply.plan.validatedAt,
          filters: reply.plan.filters,
          years: reply.plan.years,
          series: reply.plan.rows.length,
          sample: reply.plan.rows[0].years,
        },
        null,
        2,
      ),
    );
  }
}
